const activeDownloads = new Map();

chrome.runtime.sendMessage({ action: 'offscreenReady' }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.action) {
    case 'startDownload':  startDownload(msg.data);                                break;
    case 'pauseDownload':  activeDownloads.get(msg.data.id)?.pause();              break;
    case 'resumeDownload': activeDownloads.get(msg.data.id)?.resume();             break;
    case 'cancelDownload':
      activeDownloads.get(msg.data.id)?.cancel();
      activeDownloads.delete(msg.data.id);
      break;
  }
});

function startDownload(entry) {
  const dl = new ChunkedDownload(entry);
  activeDownloads.set(entry.id, dl);
  dl.start().catch(err => {
    console.error(`[DA] ${entry.id} error:`, err);
    sendToSW('downloadError', { id: entry.id, error: err.message });
  });
}

// ── ChunkedDownload ───────────────────────────────────────────────────────────

class ChunkedDownload {
  constructor({ id, url, filename, numChunks, headers }) {
    this.id = id;
    this.url = url;
    this.filename = filename;
    this.numWorkers = numChunks || 4;
    this.headers = headers || {};

    this.totalBytes = 0;
    this.workerBytes = [];        // bytes downloaded per worker (for lane display)
    this.abortControllers = [];   // one AbortController per worker slot
    this.piecesTotal = 0;
    this.piecesDone = 0;
    this._paused = false;
    this._cancelled = false;
    this._pauseResolvers = [];
    this.startTime = null;
    this.lastReportTime = 0;
    this.lastReportedBytes = 0;
  }

  pause()  { this._paused = true; }
  cancel() { this._cancelled = true; this.abortControllers.forEach(c => c?.abort()); }
  resume() {
    this._paused = false;
    this._pauseResolvers.forEach(r => r());
    this._pauseResolvers = [];
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  async start() {
    this.startTime = Date.now();

    const { contentLength, acceptsRanges, resolvedFilename } = await this._probe();
    if (resolvedFilename && !this.filename) this.filename = resolvedFilename;
    this.totalBytes = contentLength;

    const useQueue = acceptsRanges && contentLength > 0 && this.numWorkers > 1;
    this.workerBytes = new Array(useQueue ? this.numWorkers : 1).fill(0);

    console.log(`[DA] ${this.id}: range=${acceptsRanges} size=${contentLength} queue=${useQueue}`);

    sendToSW('modeUpdate', {
      id: this.id,
      activeChunks: useQueue ? this.numWorkers : 1,
      reason: !acceptsRanges ? 'no-range' : contentLength === 0 ? 'unknown-size' : 'ok'
    });

    let mergedBuffer;
    if (useQueue) {
      try {
        mergedBuffer = await this._downloadQueue(contentLength);
      } catch (err) {
        if (this._cancelled) return;
        console.warn(`[DA] ${this.id}: queue failed (${err.message}), falling back to single`);
        this.workerBytes = [0];
        this.piecesTotal = 0;
        this.piecesDone = 0;
        sendToSW('modeUpdate', { id: this.id, activeChunks: 1, reason: 'chunk-failed' });
        mergedBuffer = await this._downloadSingle();
      }
    } else {
      mergedBuffer = await this._downloadSingle();
    }

    if (this._cancelled) return;
    this._reportProgress(true);
    await this._save(mergedBuffer);
  }

  // ── Probe ─────────────────────────────────────────────────────────────────

  async _probe() {
    const ctrl = new AbortController();
    let res;
    try {
      res = await fetch(this.url, {
        headers: { ...this.headers, Range: 'bytes=0-1' },
        signal: ctrl.signal
      });
    } catch (e) {
      console.warn(`[DA] probe error: ${e.message}`);
      return { contentLength: 0, acceptsRanges: false, resolvedFilename: '' };
    }

    const cd = res.headers.get('Content-Disposition') || '';
    const resolvedFilename = this._parseFilename(cd, res.url);

    console.log(`[DA] probe: HTTP ${res.status}  Content-Range: "${res.headers.get('Content-Range')}"  CL: "${res.headers.get('Content-Length')}"`);

    if (res.status !== 206) {
      const cl = parseInt(res.headers.get('Content-Length') || '0', 10);
      ctrl.abort();
      return { contentLength: cl, acceptsRanges: false, resolvedFilename };
    }

    // Parse total size from Content-Range: bytes 0-1/TOTAL
    const cr = res.headers.get('Content-Range') || '';
    const crMatch = cr.match(/\/(\d+)$/);
    ctrl.abort();

    if (crMatch) {
      return { contentLength: parseInt(crMatch[1], 10), acceptsRanges: true, resolvedFilename };
    }

    // 206 but no Content-Range → HEAD fallback
    console.warn('[DA] probe: 206 without Content-Range, trying HEAD');
    const hCtrl = new AbortController();
    try {
      const hRes = await fetch(this.url, { method: 'HEAD', headers: this.headers, signal: hCtrl.signal });
      const cl = parseInt(hRes.headers.get('Content-Length') || '0', 10);
      console.log(`[DA] HEAD Content-Length: ${cl}`);
      return { contentLength: cl, acceptsRanges: cl > 0, resolvedFilename };
    } catch (e) {
      console.warn(`[DA] HEAD error: ${e.message}`);
      return { contentLength: 0, acceptsRanges: false, resolvedFilename };
    }
  }

  // ── Queue-based parallel download ─────────────────────────────────────────
  //
  // The file is split into many small pieces. N workers pull pieces from a
  // shared counter. Fast workers pick up more pieces; a slow worker never
  // stalls the others because they simply move on to the next piece.

  async _downloadQueue(totalBytes) {
    const pieceSize = this._calcPieceSize(totalBytes);
    const numPieces = Math.ceil(totalBytes / pieceSize);
    this.piecesTotal = numPieces;
    this.piecesDone = 0;

    console.log(`[DA] queue: ${numPieces} pieces × ${this._fmtBytes(pieceSize)}, ${this.numWorkers} workers`);

    const results = new Array(numPieces);
    // JS is single-threaded → nextPiece++ is race-free across async functions.
    let nextPiece = 0;
    let anyFailed = false;

    const runWorker = async (workerIdx) => {
      while (!anyFailed) {
        await this._checkPause();
        if (this._cancelled || anyFailed) return;

        const pi = nextPiece++;
        if (pi >= numPieces) return; // queue exhausted for this worker

        const start = pi * pieceSize;
        const end   = Math.min(start + pieceSize - 1, totalBytes - 1);

        try {
          results[pi] = await this._fetchPiece(pi, start, end, workerIdx);
          this.piecesDone++;
          this._reportProgress();
        } catch (e) {
          if (!this._cancelled) {
            anyFailed = true;
            // Abort all other workers' in-flight requests.
            this.abortControllers.forEach((c, i) => { if (i !== workerIdx) c?.abort(); });
          }
          throw e;
        }
      }
    };

    await Promise.all(
      Array.from({ length: this.numWorkers }, (_, i) => runWorker(i))
    );

    return this._concat(results);
  }

  // ── Piece fetch ───────────────────────────────────────────────────────────

  async _fetchPiece(pieceIdx, start, end, workerIdx) {
    const controller = new AbortController();
    this.abortControllers[workerIdx] = controller; // replace previous piece's controller

    const res = await fetch(this.url, {
      headers: { ...this.headers, Range: `bytes=${start}-${end}` },
      signal: controller.signal
    });

    if (res.status !== 206) {
      throw new Error(`Range request failed (HTTP ${res.status}) for piece ${pieceIdx}`);
    }

    return this._readStream(res.body, workerIdx);
  }

  // ── Single-connection fallback ────────────────────────────────────────────

  async _downloadSingle() {
    const controller = new AbortController();
    this.abortControllers[0] = controller;
    const res = await fetch(this.url, { headers: this.headers, signal: controller.signal });
    return this._readStream(res.body, 0);
  }

  // ── Stream reader (shared) ────────────────────────────────────────────────

  async _readStream(body, workerIdx) {
    const reader = body.getReader();
    const pieces = [];
    while (true) {
      await this._checkPause();
      if (this._cancelled) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value);
      this.workerBytes[workerIdx] = (this.workerBytes[workerIdx] || 0) + value.byteLength;
      this._reportProgress();
    }
    return this._concat(pieces);
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  async _save(data) {
    const blob    = new Blob([data]);
    const blobUrl = URL.createObjectURL(blob);

    // chrome.downloads is not available in offscreen documents.
    // Trigger the download via a temporary <a download> element instead.
    const a = document.createElement('a');
    a.href     = blobUrl;
    a.download = this.filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
    sendToSW('downloadComplete', { id: this.id, chromeDownloadId: null, filename: this.filename });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _calcPieceSize(totalBytes) {
    // Target: numWorkers × 4 pieces for good load balancing.
    // Clamped to [256 KB … 8 MB] to avoid tiny requests or monolithic chunks.
    const ideal = Math.ceil(totalBytes / (this.numWorkers * 4));
    const MIN = 256 * 1024;
    const MAX = 8 * 1024 * 1024;
    return Math.max(MIN, Math.min(MAX, ideal));
  }

  _reportProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastReportTime < 1000) return;

    const downloadedBytes = this.workerBytes.reduce((s, v) => s + v, 0);
    const timeSinceLast   = Math.max((now - this.lastReportTime) / 1000, 0.001);
    const speed           = (downloadedBytes - this.lastReportedBytes) / timeSinceLast;

    this.lastReportTime     = now;
    this.lastReportedBytes  = downloadedBytes;

    // Lane fill: each worker's share vs. "fair share" (totalBytes / numWorkers).
    // Capped at 1.0 so fast workers don't overflow their lane.
    const fairShare = this.totalBytes > 0
      ? Math.ceil(this.totalBytes / this.workerBytes.length)
      : 0;

    sendToSW('progressUpdate', {
      id: this.id,
      downloadedBytes,
      totalBytes:   this.totalBytes,
      speed,
      piecesTotal:  this.piecesTotal,
      piecesDone:   this.piecesDone,
      chunkStates:  this.workerBytes.map((bytes, i) => ({ index: i, bytes, total: fairShare }))
    });
  }

  async _checkPause() {
    if (!this._paused) return;
    await new Promise(resolve => this._pauseResolvers.push(resolve));
  }

  _concat(pieces) {
    const total = pieces.reduce((s, p) => s + p.byteLength, 0);
    const out   = new Uint8Array(total);
    let offset  = 0;
    for (const p of pieces) {
      out.set(p instanceof Uint8Array ? p : new Uint8Array(p), offset);
      offset += p.byteLength;
    }
    return out;
  }

  _parseFilename(cd, url) {
    if (cd) {
      const rfc   = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
      if (rfc)   return decodeURIComponent(rfc[1].trim());
      const plain = cd.match(/filename=["']?([^"';\r\n]+)["']?/i);
      if (plain) return plain[1].trim();
    }
    try {
      const path = new URL(url).pathname;
      return decodeURIComponent(path.split('/').filter(Boolean).pop() || 'download');
    } catch { return 'download'; }
  }

  _fmtBytes(b) {
    if (b < 1024)        return `${b} B`;
    if (b < 1048576)     return `${(b/1024).toFixed(0)} KB`;
    return `${(b/1048576).toFixed(1)} MB`;
  }
}

function sendToSW(action, data) {
  chrome.runtime.sendMessage({ action, data }).catch(() => {});
}
