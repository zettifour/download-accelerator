// File extensions we intercept
const DL_EXTENSIONS = new Set([
  'zip','rar','7z','tar','gz','bz2','xz','zst','lz','lzma','lzh','cab','arj',
  'tgz','tbz','tbz2','txz','tlz','tzst','taz','lz4','lha','ace','sit','sitx',
  'z','zz','zpaq','sz','br','pea','pak','arc','cpio','war','ear','uue','s7z',
  'exe','dmg','pkg','deb','rpm','msi','apk','msix','appimage','run','sh','bat','ps1',
  'mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts','mpeg','mpg','3gp',
  'mp3','wav','flac','aac','ogg','m4a','opus','wma','aiff',
  'iso','img','bin','nrg','vhd','vmdk',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp',
  'dmp','dump','log','db','sqlite','bak',
  'torrent',
  'jar','whl','gem',
]);

// Web-page extensions we do NOT intercept (navigation)
const WEB_EXTENSIONS = new Set([
  'html','htm','php','asp','aspx','jsp','cgi','shtml',
  'js','css','xml','json','rss','atom',
]);

function isDownloadLink(a) {
  if (a.hasAttribute('download')) return true;
  try {
    const pathname = new URL(a.href, location.href).pathname;
    const parts = pathname.split('.');
    if (parts.length < 2) return false;
    const ext = parts.pop().toLowerCase();
    if (WEB_EXTENSIONS.has(ext)) return false;
    return DL_EXTENSIONS.has(ext);
  } catch { return false; }
}

// ── Intercept setting (cached) ────────────────────────────────────────────────

let _interceptEnabled = false;
chrome.storage.local.get({ interceptDownloads: false }, r => {
  _interceptEnabled = r.interceptDownloads;
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.interceptDownloads !== undefined)
    _interceptEnabled = changes.interceptDownloads.newValue;
});

// Capture phase — fires before Chrome sees the click
document.addEventListener('click', e => {
  if (!_interceptEnabled) return;
  const a = e.target.closest('a[href]');
  if (!a || !isDownloadLink(a)) return;

  e.preventDefault();
  e.stopImmediatePropagation();

  chrome.runtime.sendMessage({ action: 'interceptedDownload', data: { url: a.href } });
}, true);

