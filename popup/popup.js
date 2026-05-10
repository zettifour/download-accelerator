const downloads = new Map();
const settings = { numChunks: 8, maxParallel: 3 };
let nativeAvailable = false;

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get({ numChunks: 4, maxParallel: 3, interceptDownloads: false });
  Object.assign(settings, stored);
  document.getElementById('num-chunks-val').textContent  = settings.numChunks;
  document.getElementById('max-parallel-val').textContent = settings.maxParallel;
  document.getElementById('intercept-toggle').checked    = settings.interceptDownloads;
}

document.getElementById('btn-settings').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('hidden');
});

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.target === 'num-chunks' ? 'numChunks' : 'maxParallel';
    const min = 1, max = key === 'numChunks' ? 16 : 8;
    settings[key] = Math.min(max, Math.max(min, settings[key] + Number(btn.dataset.delta)));
    document.getElementById(`${btn.dataset.target}-val`).textContent = settings[key];
  });
});

document.getElementById('intercept-toggle').addEventListener('change', e => {
  settings.interceptDownloads = e.target.checked;
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  await chrome.storage.local.set(settings);
  document.getElementById('settings-panel').classList.add('hidden');
});

// ── Add download ──────────────────────────────────────────────────────────────

const urlInput = document.getElementById('url-input');
document.getElementById('btn-add').addEventListener('click', addDownload);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addDownload(); });

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url) { urlInput.value = url; addDownload(); }
});

async function addDownload() {
  const url = urlInput.value.trim();
  if (!url) return;
  try { new URL(url); } catch { flashInput(); return; }
  urlInput.value = '';
  await chrome.runtime.sendMessage({ action: 'startDownload', data: { url, numChunks: settings.numChunks } });
}

function flashInput() {
  urlInput.style.borderColor = 'var(--danger)';
  setTimeout(() => urlInput.style.borderColor = '', 800);
}

// ── Live updates from SW ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(msg => {
  if (msg.target !== 'popup') return;
  switch (msg.action) {
    case 'downloadAdded':   upsertCard(msg.data); break;
    case 'downloadUpdated': upsertCard(msg.data); break;
    case 'downloadRemoved': removeCard(msg.data.id); break;
    case 'nativeStatus':
      nativeAvailable = msg.data.available;
      if (msg.data.extensionId) _extensionId = msg.data.extensionId;
      updateNativeBadge(msg.data.error);
      break;
  }
});

let _extensionId = '';

function updateNativeBadge(error) {
  const badge = document.getElementById('native-badge');
  if (!badge) return;
  if (nativeAvailable) {
    badge.textContent = '⚡ Native';
    badge.className   = 'native-badge native-ok';
    badge.title       = 'Native Host active – true parallel TCP connections (HTTP/1.1)';
  } else {
    badge.textContent = '⚠ Browser Mode';
    badge.className   = 'native-badge native-warn';
    const hint = _extensionId ? `\nExtension ID: ${_extensionId}` : '';
    const errHint = error ? `\nError: ${error}` : '';
    badge.title = `Native Host not connected${hint}${errHint}\n→ Re-run install.sh with the correct ID`;
    if (_extensionId) console.log('[PDM] Extension ID:', _extensionId, error ? '| Error:' + error : '');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadSettings();
  const [{ downloads: list }, nativeRes] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getDownloads' }),
    chrome.runtime.sendMessage({ action: 'getNativeStatus' }),
  ]);
  nativeAvailable = nativeRes?.available ?? false;
  if (nativeRes?.extensionId) _extensionId = nativeRes.extensionId;
  updateNativeBadge();
  list.forEach(d => upsertCard(d));
})();

// ── Card management ───────────────────────────────────────────────────────────

function upsertCard(data) {
  downloads.set(data.id, data);
  const existing = document.getElementById(`dl-${data.id}`);
  if (existing) {
    updateCard(existing, data);
  } else {
    document.getElementById('download-list').prepend(buildCard(data));
  }
  document.getElementById('empty-state').classList.toggle('hidden', downloads.size > 0);
}

function removeCard(id) {
  downloads.delete(id);
  document.getElementById(`dl-${id}`)?.remove();
  document.getElementById('empty-state').classList.toggle('hidden', downloads.size > 0);
}

function buildCard(data) {
  const li = document.createElement('li');
  li.id = `dl-${data.id}`;
  li.className = `dl-card state-${data.state}`;
  li.innerHTML = cardHTML(data);
  li.dataset.laneCount = '0';
  attachActionListeners(li, data);
  return li;
}

function updateCard(el, data) {
  const pct = data.totalBytes > 0
    ? Math.round((data.downloadedBytes / data.totalBytes) * 100)
    : 0;

  // State class + buttons only on state change (avoids click-swallowing during re-render)
  if (el.dataset.state !== data.state) {
    el.dataset.state = data.state;
    el.className = `dl-card state-${data.state}`;
    el.querySelector('.dl-actions').innerHTML = actionButtonsHTML(data);
  }

  el.querySelector('.progress-fill').style.width = `${pct}%`;
  el.querySelector('.dl-stats').innerHTML = statsHTML(data, pct);

  // Re-render lanes when activeChunks arrives or changes
  const activeChunks = data.activeChunks ?? 0;
  if (activeChunks !== parseInt(el.dataset.laneCount || '0')) {
    rebuildLanes(el, data, activeChunks);
    el.dataset.laneCount = String(activeChunks);
  }

  // Update individual lane fills
  if (data.chunkStates?.length > 1) {
    const lanes = el.querySelector('.chunk-lanes');
    data.chunkStates.forEach(({ bytes, total }, i) => {
      const fill = lanes?.children[i]?.querySelector('.chunk-lane-fill');
      if (fill && total > 0) fill.style.width = `${Math.min(100, Math.round((bytes / total) * 100))}%`;
    });
  }
}

function rebuildLanes(el, data, activeChunks) {
  const wrap = el.querySelector('.dl-progress-wrap');
  wrap.querySelector('.chunk-lanes')?.remove();
  if (activeChunks > 1) {
    const div = document.createElement('div');
    div.className = 'chunk-lanes';
    div.innerHTML = Array.from({ length: activeChunks }, () =>
      `<div class="chunk-lane"><div class="chunk-lane-fill" style="width:0%"></div></div>`
    ).join('');
    wrap.appendChild(div);
  }
}

// ── Card HTML ─────────────────────────────────────────────────────────────────

function cardHTML(data) {
  const pct = data.totalBytes > 0
    ? Math.round((data.downloadedBytes / data.totalBytes) * 100)
    : 0;

  const subtitle = data.savePath
    ? `<div class="dl-url dl-path" title="${esc(data.savePath)}">${esc(data.savePath)}</div>`
    : `<div class="dl-url" title="${esc(data.url)}">${esc(data.url)}</div>`;

  return `
    <div class="dl-top">
      <div class="dl-icon">${fileEmoji(data.filename)}</div>
      <div class="dl-meta">
        <div class="dl-name" title="${esc(data.filename)}">${esc(data.filename)}</div>
        ${subtitle}
      </div>
      <div class="dl-actions">${actionButtonsHTML(data)}</div>
    </div>
    <div class="dl-progress-wrap">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="dl-stats">${statsHTML(data, pct)}</div>
  `;
}

function actionButtonsHTML(data) {
  const id = data.id;
  const pauseResume = data.state === 'paused'
    ? `<button class="action-btn success" data-action="resume" data-id="${id}" title="Fortsetzen">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg></button>`
    : data.state === 'running'
    ? `<button class="action-btn" data-action="pause" data-id="${id}" title="Pausieren">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>`
    : '';

  const open = data.state === 'completed' && data.chromeDownloadId
    ? `<button class="action-btn success" data-action="open" data-id="${id}" title="Open file">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>`
    : '';

  const remove = data.state === 'completed' || data.state === 'error'
    ? `<button class="action-btn danger" data-action="remove" data-id="${id}" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`
    : `<button class="action-btn danger" data-action="cancel" data-id="${id}" title="Cancel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;

  return pauseResume + open + remove;
}

function statsHTML(data, pct) {
  const badge = `<span class="badge badge-${data.state}">${stateLabel(data.state)}</span>`;

  // Mode badge: shown once activeChunks is known
  let modeBadge = '';
  if (data.activeChunks != null) {
    const nativePfx = data.nativeMode ? '⚡ ' : '';
    if (data.activeChunks > 1) {
      modeBadge = `<span class="badge badge-chunks">${nativePfx}${data.activeChunks} conn.</span>`;
    } else {
      const reasonMap = {
        'no-range':      '1 conn. (no range)',
        'unknown-size':  '1 conn. (unknown size)',
        'chunk-failed':  '1 conn. (fallback)',
      };
      modeBadge = `<span class="badge badge-single">${nativePfx}${reasonMap[data.modeReason] || '1 conn.'}</span>`;
    }
  }

  if (data.state === 'completed') {
    return `${badge}${modeBadge}<span>${formatBytes(data.totalBytes)}</span>`;
  }
  if (data.state === 'error') {
    return `${badge}<span>${esc(data.error || 'Unknown error')}</span>`;
  }

  const size  = data.totalBytes > 0
    ? `${formatBytes(data.downloadedBytes)} / ${formatBytes(data.totalBytes)} (${pct}%)`
    : formatBytes(data.downloadedBytes);
  const speed = data.speed > 0 ? formatBytes(data.speed) + '/s' : '';
  const eta   = data.eta   > 0 ? `ETA ${formatTime(data.eta)}` : '';

  return `${badge}${modeBadge}<span>${size}</span><span>${[speed, eta].filter(Boolean).join(' · ')}</span>`;
}

// ── Action wiring (event delegation — one listener on the list) ───────────────

document.getElementById('download-list').addEventListener('click', e => {
  // Button actions
  const btn = e.target.closest('.action-btn[data-action]');
  if (btn) {
    const id   = btn.dataset.id;
    const data = downloads.get(id);
    switch (btn.dataset.action) {
      case 'pause':   chrome.runtime.sendMessage({ action: 'pauseDownload',  data: { id } }); break;
      case 'resume':  chrome.runtime.sendMessage({ action: 'resumeDownload', data: { id } }); break;
      case 'cancel':  chrome.runtime.sendMessage({ action: 'cancelDownload', data: { id } }); break;
      case 'remove':
        chrome.runtime.sendMessage({ action: 'removeDownload', data: { id } });
        removeCard(id);
        break;
      case 'open':    chrome.runtime.sendMessage({ action: 'openFile', data: { chromeDownloadId: data?.chromeDownloadId } }); break;
    }
    return;
  }

  // Click on card body → open download folder
  const card = e.target.closest('.dl-card');
  if (card) {
    const id   = card.id.replace('dl-', '');
    const data = downloads.get(id);
    if (data?.savePath) {
      chrome.runtime.sendMessage({ action: 'openFolder', data: { savePath: data.savePath } });
    }
  }
});

function attachActionListeners() {} // no-op, kept for call-site compatibility

// ── Formatters ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  return `${(bytes / 1000 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatTime(seconds) {
  if (seconds < 60)   return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function stateLabel(state) {
  return { pending: 'Pending', running: 'Downloading', paused: 'Paused', completed: 'Done', error: 'Error' }[state] || state;
}

function fileEmoji(filename) {
  if (!filename) return '📄';
  const ext = filename.split('.').pop().toLowerCase();
  return {
    mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', webm:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵', aac:'🎵', ogg:'🎵',
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️',
    pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
    zip:'📦', rar:'📦', '7z':'📦', tar:'📦', gz:'📦',
    exe:'⚙️', dmg:'⚙️', pkg:'⚙️', apk:'⚙️', iso:'💿',
  }[ext] || '📄';
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
