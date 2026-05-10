const downloads = new Map();

// ── Native Messaging Host ─────────────────────────────────────────────────────
// The native host (dist/download_accelerator_host) uses requests + HTTP/1.1,
// opening genuine separate TCP connections — unlike fetch() over HTTP/2.

let nativePort = null;
let _nativeConnecting = null; // pending Promise while we're settling
let _folderPickResolve = null; // waiting sendResponse for pickFolder

function connectNative() {
  if (_nativeConnecting) return _nativeConnecting;

  _nativeConnecting = new Promise(resolve => {
    let port;
    try {
      port = chrome.runtime.connectNative('com.downloadaccelerator.native_host');
    } catch (e) {
      console.log('[DA] Native host not available:', e.message);
      _nativeConnecting = null;
      resolve(false);
      return;
    }

    // Give the native process up to 400 ms to either send a first message
    // or disconnect (which happens instantly when the host can't be launched).
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      _nativeConnecting = null;
      if (ok) {
        nativePort = port;
        console.log('[DA] Native host connected');
        notifyPopup({ action: 'nativeStatus', data: { available: true } });
      }
      resolve(ok);
    };

    port.onDisconnect.addListener(() => {
      nativePort = null;
      const err = chrome.runtime.lastError?.message || 'unknown';
      console.error('[DA] Native host disconnected:', err, '| Extension ID:', chrome.runtime.id);
      notifyPopup({ action: 'nativeStatus', data: { available: false, error: err, extensionId: chrome.runtime.id } });
      // Resolve any pending folder-pick promise so the SW doesn't hang
      if (_folderPickResolve) {
        _folderPickResolve({ folder: null });
        _folderPickResolve = null;
      }
      settle(false);
    });

    port.onMessage.addListener(msg => {
      settle(true); // first message proves the host is alive
      handleNativeMessage(msg);
    });

    // If neither disconnect nor message within 400 ms, assume it's alive
    // (host may not send anything until the first download command).
    setTimeout(() => settle(true), 400);
  });

  return _nativeConnecting;
}

async function ensureNativeConnected() {
  if (nativePort) return true;
  return connectNative();
}

function handleNativeMessage(msg) {
  switch (msg.action) {

    case 'folderPicked':
      if (_folderPickResolve) {
        // host sends either 'folder' or 'path'; empty string counts as cancel
        const picked = msg.folder || msg.path || null;
        _folderPickResolve({ folder: picked || null });
        _folderPickResolve = null;
      }
      break;

    case 'probeResult':
      updateState(msg.id, {
        totalBytes:   msg.totalBytes,
        activeChunks: msg.activeConnections,
        modeReason:   msg.acceptsRanges ? 'ok' : 'no-range',
        filename:     msg.filename,
        savePath:     msg.savePath,
        nativeMode:   true,
      });
      break;

    case 'progress': {
      const entry = downloads.get(msg.id);
      if (!entry) break;

      const downloaded = msg.downloadedBytes;
      const total      = msg.totalBytes;
      const now        = Date.now();
      const elapsed    = (now - (entry._lastProgressTime || entry.startedAt)) / 1000 || 0.001;
      const speed      = (downloaded - (entry._lastBytes || 0)) / elapsed;
      entry._lastProgressTime = now;
      entry._lastBytes        = downloaded;

      const fairShare   = msg.fairShare || 0;
      const chunkStates = (msg.workerBytes || []).map((bytes, i) => ({
        index: i, bytes, total: fairShare
      }));

      updateState(msg.id, {
        downloadedBytes: downloaded,
        totalBytes:      total,
        speed,
        eta:             speed > 0 && total > 0 ? Math.round((total - downloaded) / speed) : null,
        piecesDone:      msg.piecesDone || 0,
        piecesTotal:     msg.piecesTotal || 0,
        chunkStates,
        state:           'running',
      });
      break;
    }

    case 'complete':
      updateState(msg.id, {
        state:    'completed',
        filename: msg.filename,
        savePath: msg.savePath,
        speed:    0,
        eta:      0,
      });
      chrome.notifications.create({
        type:    'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title:   'Download complete',
        message: msg.filename || 'File saved',
      });
      break;

    case 'error':
      handleError({ id: msg.id, error: msg.error });
      break;
  }
}

// ── Offscreen document (fallback when native host not installed) ───────────────

let offscreenCreated    = false;
let _offscreenReadyResolve = null;
let _offscreenReadyPromise = new Promise(r => { _offscreenReadyResolve = r; });

async function ensureOffscreen() {
  if (offscreenCreated) return _offscreenReadyPromise;
  offscreenCreated = true;
  try {
    await chrome.offscreen.createDocument({
      url:          chrome.runtime.getURL('offscreen/offscreen.html'),
      reasons:      ['BLOBS'],
      justification: 'Parallel chunk download via fetch + Range requests',
    });
  } catch (e) {
    if (!e.message?.includes('single offscreen document')) {
      offscreenCreated = false;
      throw e;
    }
    _offscreenReadyResolve?.();
  }
  return _offscreenReadyPromise;
}


// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({
    id:       'pdm-download-link',
    title:    'Download with Download Accelerator',
    contexts: ['link'],
  });
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
  }
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'pdm-download-link' && info.linkUrl) {
    startDownloadWithFolderPicker(info.linkUrl);
  }
});

async function startDownloadWithFolderPicker(url) {
  const nativeOk = await ensureNativeConnected();
  if (nativeOk && nativePort) {
    const { targetDir: storedDir } = await chrome.storage.local.get({ targetDir: null });
    const targetDir = await new Promise(resolve => {
      _folderPickResolve = ({ folder }) => resolve(folder ?? null);
      nativePort.postMessage({ action: 'pickFolder', defaultDir: storedDir });
    });
    if (targetDir === null) return; // user cancelled dialog
    chrome.storage.local.set({ targetDir });
    startDownload({ url, targetDir });
  } else {
    startDownload({ url, targetDir: null });
  }
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    // ── From offscreen ──────────────────────────────────────────────────────
    case 'offscreenReady':
      _offscreenReadyResolve?.();
      break;

    case 'progressUpdate':
      handleOffscreenProgress(msg.data);
      break;

    case 'modeUpdate':
      updateState(msg.data.id, {
        activeChunks: msg.data.activeChunks,
        modeReason:   msg.data.reason,
      });
      break;

    case 'downloadComplete':
      updateState(msg.data.id, {
        state:           'completed',
        chromeDownloadId: msg.data.chromeDownloadId,
        filename:        msg.data.filename,
        speed:           0,
        eta:             0,
      });
      chrome.notifications.create({
        type:    'basic',
        iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title:   'Download abgeschlossen',
        message: msg.data.filename || 'Datei gespeichert',
      });
      break;

    case 'downloadError':
      handleError(msg.data);
      break;

    // ── From popup ──────────────────────────────────────────────────────────
    case 'startDownload':
      startDownload(msg.data).then(id => sendResponse({ id }));
      return true;

    case 'pauseDownload':
      pauseDownload(msg.data.id);
      break;

    case 'resumeDownload':
      resumeDownload(msg.data.id);
      break;

    case 'cancelDownload':
      cancelDownload(msg.data.id);
      break;

    case 'removeDownload':
      downloads.delete(msg.data.id);
      updateBadge();
      break;

    case 'getDownloads':
      sendResponse({ downloads: [...downloads.values()] });
      return true;

    case 'getNativeStatus':
      ensureNativeConnected().then(ok => sendResponse({ available: ok, extensionId: chrome.runtime.id }));
      return true;

    case 'retryNative':
      nativePort = null;
      _nativeConnecting = null; // force fresh reconnect attempt
      ensureNativeConnected().then(ok => sendResponse({ available: ok }));
      return true;

    case 'pickFolder':
      if (!nativePort) { sendResponse({ folder: null }); return true; }
      _folderPickResolve = sendResponse;
      nativePort.postMessage({ action: 'pickFolder' });
      return true;

    case 'openFile':
      if (msg.data.chromeDownloadId) chrome.downloads.open(msg.data.chromeDownloadId);
      break;

    case 'openFolder':
      if (nativePort && msg.data.savePath) {
        nativePort.postMessage({ action: 'openFolder', path: msg.data.savePath });
      }
      break;

    case 'showInFolder':
      if (msg.data.chromeDownloadId) chrome.downloads.show(msg.data.chromeDownloadId);
      break;

    // ── From content script ─────────────────────────────────────────────────
    case 'interceptedDownload':
      startDownloadWithFolderPicker(msg.data.url);
      break;
  }
});

// ── Download control ──────────────────────────────────────────────────────────

let nextId = 1;

async function gatherCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies.length) return '';
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

async function startDownload({ url, filename, numChunks, headers, targetDir }) {
  const settings = await chrome.storage.local.get({ numChunks: 8, maxParallel: 3, targetDir: null });
  targetDir = targetDir || settings.targetDir || null;
  const id = String(nextId++);

  const entry = {
    id,
    url,
    filename:    filename || extractFilenameFromUrl(url),
    numChunks:   numChunks ?? settings.numChunks,
    activeChunks: null,
    modeReason:  null,
    nativeMode:  false,
    savePath:    null,
    state:       'pending',
    totalBytes:  0,
    downloadedBytes: 0,
    speed:       0,
    eta:         null,
    error:       null,
    chromeDownloadId: null,
    piecesTotal: 0,
    piecesDone:  0,
    startedAt:   Date.now(),
    _lastProgressTime: Date.now(),
    _lastBytes:  0,
  };

  downloads.set(id, entry);
  notifyPopup({ action: 'downloadAdded', data: publicEntry(entry) });
  updateBadge();

  const nativeOk = await ensureNativeConnected();
  if (nativeOk && nativePort) {
    const cookieHeader = await gatherCookieHeader(url);
    const mergedHeaders = { ...(headers || {}) };
    if (cookieHeader) mergedHeaders['Cookie'] = cookieHeader;
    nativePort.postMessage({
      action:      'download',
      id,
      url,
      filename:    entry.filename,
      connections: entry.numChunks,
      headers:     mergedHeaders,
      targetDir:   targetDir || null,
    });
    updateState(id, { state: 'running', nativeMode: true });
  } else {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'startDownload', data: entry }).catch(() => {});
    updateState(id, { state: 'running' });
  }

  return id;
}

function pauseDownload(id) {
  const entry = downloads.get(id);
  if (!entry) return;
  if (entry.nativeMode && nativePort) {
    nativePort.postMessage({ action: 'pause', id });
  } else {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'pauseDownload', data: { id } }).catch(() => {});
  }
  updateState(id, { state: 'paused' });
}

function resumeDownload(id) {
  const entry = downloads.get(id);
  if (!entry) return;
  if (entry.nativeMode && nativePort) {
    nativePort.postMessage({ action: 'resume', id });
  } else {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'resumeDownload', data: { id } }).catch(() => {});
  }
  updateState(id, { state: 'running' });
}

function cancelDownload(id) {
  const entry = downloads.get(id);
  if (!entry) return;
  if (entry.nativeMode && nativePort) {
    nativePort.postMessage({ action: 'cancel', id });
  } else {
    chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancelDownload', data: { id } }).catch(() => {});
  }
  downloads.delete(id);
  notifyPopup({ action: 'downloadRemoved', data: { id } });
  updateBadge();
}

// ── State helpers ─────────────────────────────────────────────────────────────

function updateBadge() {
  const active = [...downloads.values()].filter(
    e => e.state === 'running' || e.state === 'pending' || e.state === 'paused'
  ).length;
  if (active > 0) {
    chrome.action.setBadgeText({ text: String(active) });
    chrome.action.setBadgeBackgroundColor({ color: '#4361ee' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function updateState(id, patch) {
  const entry = downloads.get(id);
  if (!entry) return;
  Object.assign(entry, patch);
  notifyPopup({ action: 'downloadUpdated', data: publicEntry(entry) });
  updateBadge();
}

function publicEntry(e) {
  // Strip internal tracking fields before sending to popup
  const { _lastProgressTime, _lastBytes, ...pub } = e;
  return pub;
}

function handleOffscreenProgress({ id, downloadedBytes, totalBytes, speed, chunkStates, piecesTotal, piecesDone }) {
  const entry = downloads.get(id);
  if (!entry) return;
  const eta = speed > 0 && totalBytes > 0 ? Math.round((totalBytes - downloadedBytes) / speed) : null;
  updateState(id, { downloadedBytes, totalBytes, speed, eta, chunkStates, piecesTotal, piecesDone, state: 'running' });
}

function handleError({ id, error }) {
  updateState(id, { state: 'error', error });
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage({ target: 'popup', ...msg }).catch(() => {});
}

function extractFilenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() || 'download');
  } catch { return 'download'; }
}
