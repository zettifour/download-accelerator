/**
 Download Accelerator – Native Messaging Host (macOS)
 Compiled with: swiftc -O -o dist/download_accelerator_host host.swift
 */

import Foundation

// ═══════════════════════════════════════════════════════════════════
// MARK: - Native Messaging
// ═══════════════════════════════════════════════════════════════════

private let _sendLock = NSLock()

func sendMessage(_ obj: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var length = UInt32(body.count).littleEndian
    var frame  = Data(bytes: &length, count: 4)
    frame.append(body)
    _sendLock.lock()
    FileHandle.standardOutput.write(frame)
    _sendLock.unlock()
}

func readMessage() -> [String: Any]? {
    let hdr = FileHandle.standardInput.readData(ofLength: 4)
    guard hdr.count == 4 else { return nil }
    let n = hdr.withUnsafeBytes { $0.load(as: UInt32.self).littleEndian }
    guard n > 0, n < 1_048_576 else { return nil }
    let body = FileHandle.standardInput.readData(ofLength: Int(n))
    guard body.count == Int(n) else { return nil }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - Registry
// ═══════════════════════════════════════════════════════════════════

private var _downloads: [String: Download] = [:]
private let _regLock   = NSLock()

// ═══════════════════════════════════════════════════════════════════
// MARK: - Error
// ═══════════════════════════════════════════════════════════════════

enum DLError: Error {
    case cancelled
    case http(Int, String)
    case io(String)

    var localizedDescription: String {
        switch self {
        case .cancelled:          return "cancelled"
        case .http(let c, let s): return "HTTP \(c): \(s)"
        case .io(let s):          return "IO error: \(s)"
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - Download
// ═══════════════════════════════════════════════════════════════════

final class Download {

    let id:          String
    let url:         URL
    let filename:    String
    let connections: Int
    let targetDir:   String
    let headers:     [String: String]

    private let cond      = NSCondition()
    private var _cancelled = false
    private var _paused    = false

    var savePath:      String? = nil
    var totalBytes:    Int     = 0
    var workerBytes:   [Int]   = []
    var piecesTotal:   Int     = 0
    var piecesDone:    Int     = 0
    private var _lastReport: TimeInterval = 0

    init(id: String, url: URL, filename: String, connections: Int,
         targetDir: String, headers: [String: String]) {
        self.id          = id
        self.url         = url
        self.filename    = filename
        self.connections = connections
        self.targetDir   = targetDir
        self.headers     = headers
    }

    // MARK: Control

    var isCancelled: Bool {
        cond.lock(); defer { cond.unlock() }
        return _cancelled
    }

    func pause() {
        cond.lock(); _paused = true; cond.unlock()
    }

    func resume() {
        cond.lock(); _paused = false; cond.broadcast(); cond.unlock()
    }

    func cancel() {
        cond.lock(); _cancelled = true; _paused = false; cond.broadcast(); cond.unlock()
    }

    func waitIfPaused() throws {
        cond.lock(); defer { cond.unlock() }
        while _paused && !_cancelled {
            cond.wait(until: Date(timeIntervalSinceNow: 0.2))
        }
        if _cancelled { throw DLError.cancelled }
    }

    // MARK: Entry point

    func run() {
        do {
            try _run()
        } catch DLError.cancelled {
            // silent
        } catch {
            if !isCancelled {
                sendMessage(["action": "error", "id": id,
                             "error": error.localizedDescription])
            }
        }
        _regLock.lock(); _downloads.removeValue(forKey: id); _regLock.unlock()
    }

    // MARK: Main logic

    private func _run() throws {
        // ── 1. Probe
        let (total, acceptsRanges, resolvedName) = try probe()
        totalBytes = total

        let fn        = filename.isEmpty ? resolvedName : filename
        let useChunks = acceptsRanges && total > 0 && connections > 1
        let nConn     = useChunks ? connections : 1
        workerBytes   = Array(repeating: 0, count: nConn)

        let sp = uniquePath(dir: targetDir, name: fn)
        savePath = sp

        sendMessage([
            "action":            "probeResult",
            "id":                id,
            "totalBytes":        total,
            "acceptsRanges":     useChunks,
            "filename":          fn,
            "savePath":          sp,
            "activeConnections": nConn
        ] as [String: Any])

        // ── 2. Create temp file
        let tmp = sp + ".part"
        let fm  = FileManager.default
        try fm.createDirectory(
            atPath: (sp as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        fm.createFile(atPath: tmp, contents: nil)

        if total > 0 {
            let fd = open(tmp, O_WRONLY)
            guard fd >= 0 else { throw DLError.io("Cannot open temp file") }
            ftruncate(fd, off_t(total))
            close(fd)
        }

        // ── 3. Download
        let fd = open(tmp, O_WRONLY)
        guard fd >= 0 else { throw DLError.io("Cannot open temp file for writing") }
        defer { close(fd) }

        if useChunks {
            try downloadParallel(fd: fd, totalBytes: total)
        } else {
            try downloadSingle(fd: fd)
        }

        if isCancelled { throw DLError.cancelled }

        // ── 4. Finalize
        let actual = (try? fm.attributesOfItem(atPath: tmp)[.size] as? Int) ?? 0
        if totalBytes == 0 { totalBytes = actual }
        try? fm.removeItem(atPath: sp)
        try fm.moveItem(atPath: tmp, toPath: sp)

        report(force: true)
        sendMessage(["action": "complete", "id": id,
                     "filename": fn, "savePath": sp])
    }

    // MARK: Probe

    private func probe() throws -> (Int, Bool, String) {
        let session = makeSession()
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.setValue("bytes=0-1", forHTTPHeaderField: "Range")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

        let (_, resp) = try syncData(req, session: session)
        let cd   = resp.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let rurl = resp.url?.absoluteString ?? url.absoluteString
        let name = extractFilename(cd: cd, url: rurl)

        if resp.statusCode == 206 {
            // Parse total from Content-Range: bytes 0-1/TOTAL
            if let cr = resp.value(forHTTPHeaderField: "Content-Range"),
               let slash = cr.lastIndex(of: "/") {
                let totalStr = String(cr[cr.index(after: slash)...])
                if let total = Int(totalStr), total > 0 {
                    return (total, true, name)
                }
            }
            // HEAD fallback
            var hReq = URLRequest(url: url, timeoutInterval: 30)
            hReq.httpMethod = "HEAD"
            for (k, v) in headers { hReq.setValue(v, forHTTPHeaderField: k) }
            let (_, hResp) = try syncData(hReq, session: session)
            let cl = Int(hResp.value(forHTTPHeaderField: "Content-Length") ?? "") ?? 0
            return (cl, cl > 0, name)
        } else {
            let cl = Int(resp.value(forHTTPHeaderField: "Content-Length") ?? "") ?? 0
            return (cl, false, name)
        }
    }

    // MARK: Parallel download

    private func downloadParallel(fd: Int32, totalBytes: Int) throws {
        let pieceSize = calcPieceSize(total: totalBytes, workers: connections)
        let numPieces = Int(ceil(Double(totalBytes) / Double(pieceSize)))
        piecesTotal = numPieces
        piecesDone  = 0

        var next    = 0
        let qLock   = NSLock()
        var errors: [Error] = []
        let eLock   = NSLock()
        let group   = DispatchGroup()

        for wIdx in 0 ..< connections {
            group.enter()
            DispatchQueue.global().async { [self] in
                defer { group.leave() }
                let session = makeSession()

                while true {
                    if self.isCancelled { return }
                    eLock.lock(); let hasErr = !errors.isEmpty; eLock.unlock()
                    if hasErr { return }

                    qLock.lock()
                    let pi = next
                    guard pi < numPieces else { qLock.unlock(); return }
                    next += 1
                    qLock.unlock()

                    let start = pi * pieceSize
                    let end   = min(start + pieceSize - 1, totalBytes - 1)

                    do {
                        try self.waitIfPaused()
                        let data = try self.fetchChunk(session: session,
                                                       start: start, end: end,
                                                       wIdx: wIdx)
                        // pwrite is thread-safe — no file lock needed
                        try data.withUnsafeBytes { ptr in
                            var rem = data.count, off = 0
                            while rem > 0 {
                                let n = pwrite(fd, ptr.baseAddress! + off,
                                               rem, off_t(start + off))
                                guard n > 0 else {
                                    throw DLError.io("pwrite errno \(errno)")
                                }
                                rem -= n; off += n
                            }
                        }
                        self.piecesDone += 1
                        self.report()
                    } catch DLError.cancelled {
                        return
                    } catch {
                        eLock.lock(); errors.append(error); eLock.unlock()
                        return
                    }
                }
            }
        }

        group.wait()
        if isCancelled { throw DLError.cancelled }
        if let e = errors.first { throw e }
    }

    // MARK: Single download

    private func downloadSingle(fd: Int32) throws {
        let session = makeSession()
        var req = URLRequest(url: url, timeoutInterval: 60)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

        let (data, resp) = try syncData(req, session: session)
        guard (200 ..< 300).contains(resp.statusCode) else {
            throw DLError.http(resp.statusCode, "download failed")
        }
        try data.withUnsafeBytes { ptr in
            var rem = data.count, off = 0
            while rem > 0 {
                let n = pwrite(fd, ptr.baseAddress! + off, rem, off_t(off))
                guard n > 0 else { throw DLError.io("pwrite errno \(errno)") }
                rem -= n; off += n
            }
        }
        workerBytes[0] = data.count
        report(force: true)
    }

    // MARK: Fetch chunk

    private func fetchChunk(session: URLSession,
                            start: Int, end: Int, wIdx: Int) throws -> Data {
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }

        let (data, resp) = try syncData(req, session: session)
        guard resp.statusCode == 206 else {
            throw DLError.http(resp.statusCode,
                               "expected 206 for bytes=\(start)-\(end)")
        }
        workerBytes[wIdx] += data.count
        return data
    }

    // MARK: Progress

    func report(force: Bool = false) {
        let now = Date().timeIntervalSinceReferenceDate
        guard force || now - _lastReport >= 1.0 else { return }
        _lastReport = now

        let downloaded = workerBytes.reduce(0, +)
        let fairShare  = totalBytes > 0
            ? Int(ceil(Double(totalBytes) / Double(workerBytes.count))) : 0
        let chunkStates = workerBytes.enumerated().map { i, b in
            ["index": i, "bytes": b, "total": fairShare] as [String: Any]
        }
        sendMessage([
            "action":          "progress",
            "id":              id,
            "downloadedBytes": downloaded,
            "totalBytes":      totalBytes,
            "piecesDone":      piecesDone,
            "piecesTotal":     piecesTotal,
            "workerBytes":     workerBytes,
            "fairShare":       fairShare,
            "chunkStates":     chunkStates
        ] as [String: Any])
    }
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - URLSession helpers
// ═══════════════════════════════════════════════════════════════════

func makeSession() -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpMaximumConnectionsPerHost = 1
    return URLSession(configuration: cfg)
}

func syncData(_ req: URLRequest,
              session: URLSession) throws -> (Data, HTTPURLResponse) {
    let sem = DispatchSemaphore(value: 0)
    var outData: Data?
    var outResp: HTTPURLResponse?
    var outErr:  Error?

    session.dataTask(with: req) { data, resp, err in
        outData = data
        outResp = resp as? HTTPURLResponse
        outErr  = err
        sem.signal()
    }.resume()
    sem.wait()

    if let err = outErr { throw err }
    guard let data = outData, let resp = outResp else {
        throw DLError.http(0, "No response")
    }
    return (data, resp)
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - Helpers
// ═══════════════════════════════════════════════════════════════════

func calcPieceSize(total: Int, workers: Int) -> Int {
    let ideal = Int(ceil(Double(total) / Double(workers * 4)))
    return max(256 * 1024, min(8 * 1024 * 1024, ideal))
}

func uniquePath(dir: String, name: String) -> String {
    let base = URL(fileURLWithPath: dir).appendingPathComponent(name)
    let ext  = base.pathExtension
    let stem = base.deletingPathExtension().lastPathComponent
    var path = base.path
    var n    = 1
    while FileManager.default.fileExists(atPath: path) {
        let newName = ext.isEmpty ? "\(stem) (\(n))"
                                  : "\(stem) (\(n)).\(ext)"
        path = URL(fileURLWithPath: dir).appendingPathComponent(newName).path
        n += 1
    }
    return path
}

func extractFilename(cd: String, url urlStr: String) -> String {
    if !cd.isEmpty {
        // filename*=UTF-8''encoded
        if let r = cd.range(of: "filename*=", options: .caseInsensitive) {
            var s = String(cd[r.upperBound...])
                        .components(separatedBy: ";")[0]
                        .trimmingCharacters(in: .whitespaces)
            if s.lowercased().hasPrefix("utf-8''") { s = String(s.dropFirst(7)) }
            let dec = s.removingPercentEncoding ?? s
            if !dec.isEmpty { return dec }
        }
        // filename="name"
        if let r = cd.range(of: "filename=", options: .caseInsensitive) {
            let s = String(cd[r.upperBound...])
                        .components(separatedBy: ";")[0]
                        .trimmingCharacters(in: .init(charactersIn: "\"' \r\n"))
            if !s.isEmpty { return s }
        }
    }
    // Fall back to URL path
    if let u = URL(string: urlStr) {
        let last = u.lastPathComponent
        if !last.isEmpty && last != "/" {
            return last.removingPercentEncoding ?? last
        }
    }
    return "download"
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - Platform actions
// ═══════════════════════════════════════════════════════════════════

func pickFolder(defaultDir: String?, requestId: String) {
    var script = "POSIX path of (choose folder"
    if let d = defaultDir {
        let exp = (d as NSString).expandingTildeInPath
        script += " default location POSIX file \"\(exp)\""
    }
    script += ")"

    let proc = Process()
    proc.executableURL  = URL(fileURLWithPath: "/usr/bin/osascript")
    proc.arguments      = ["-e", script]
    let pipe            = Pipe()
    proc.standardOutput = pipe
    proc.standardError  = Pipe()

    do {
        try proc.run()
        proc.waitUntilExit()
        let raw  = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = (String(data: raw, encoding: .utf8) ?? "")
                       .trimmingCharacters(in: .whitespacesAndNewlines)
        sendMessage(["action": "folderPicked", "path": path, "id": requestId])
    } catch {
        sendMessage(["action": "error",
                     "error": "pickFolder failed: \(error)"])
    }
}

func openFolder(_ path: String) {
    var isDir: ObjCBool = false
    let folder: String
    if FileManager.default.fileExists(atPath: path, isDirectory: &isDir),
       isDir.boolValue {
        folder = path
    } else {
        folder = (path as NSString).deletingLastPathComponent
    }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    proc.arguments     = [folder]
    try? proc.run()
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - Message handler
// ═══════════════════════════════════════════════════════════════════

func handle(_ msg: [String: Any]) {
    let action = msg["action"] as? String ?? ""
    let dlId   = msg["id"]     as? String ?? ""

    switch action {

    case "download":
        guard let urlStr = msg["url"] as? String,
              let url    = URL(string: urlStr) else { return }

        let rawDir    = msg["targetDir"] as? String
        let targetDir = rawDir.map { ($0 as NSString).expandingTildeInPath }
                     ?? (NSHomeDirectory() as NSString)
                            .appendingPathComponent("Downloads")

        let dl = Download(
            id:          dlId,
            url:         url,
            filename:    msg["filename"]    as? String         ?? "",
            connections: msg["connections"] as? Int            ?? 8,
            targetDir:   targetDir,
            headers:     msg["headers"]    as? [String:String] ?? [:]
        )
        _regLock.lock(); _downloads[dlId] = dl; _regLock.unlock()
        DispatchQueue.global().async { dl.run() }

    case "pause":
        _regLock.lock(); let dl = _downloads[dlId]; _regLock.unlock()
        dl?.pause()

    case "resume":
        _regLock.lock(); let dl = _downloads[dlId]; _regLock.unlock()
        dl?.resume()

    case "cancel":
        _regLock.lock()
        let dl = _downloads.removeValue(forKey: dlId)
        _regLock.unlock()
        dl?.cancel()
        if let sp = dl?.savePath {
            try? FileManager.default.removeItem(atPath: sp + ".part")
        }

    case "pickFolder":
        let defaultDir = msg["defaultDir"] as? String
        DispatchQueue.global().async {
            pickFolder(defaultDir: defaultDir, requestId: dlId)
        }

    case "openFolder":
        if let path = msg["path"] as? String, !path.isEmpty {
            openFolder(path)
        }

    default: break
    }
}

// ═══════════════════════════════════════════════════════════════════
// MARK: - Main loop
// ═══════════════════════════════════════════════════════════════════

DispatchQueue.global().async {
    while true {
        guard let msg = readMessage() else { exit(0) }
        DispatchQueue.global().async { handle(msg) }
    }
}

RunLoop.main.run()
