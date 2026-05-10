#!/usr/bin/env python3
"""
Download Accelerator – Native Messaging Host
Cross-platform: macOS, Windows, Linux

Uses requests (urllib3/HTTP 1.1): each worker thread opens its own TCP
connection, giving true parallelism unlike browser fetch() over HTTP/2.
"""

import sys
import json
import struct
import platform
import subprocess
import threading
import math
import time
import re
from io import BytesIO
from pathlib import Path
from queue import Queue, Empty

import requests
from requests.adapters import HTTPAdapter

PLATFORM = platform.system()   # 'Darwin', 'Windows', 'Linux'


# ── Chrome Native Messaging protocol ─────────────────────────────────────────
# Each message: 4-byte little-endian uint32 length + UTF-8 JSON body.

_send_lock = threading.Lock()

def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    n    = struct.unpack('<I', raw)[0]
    body = sys.stdin.buffer.read(n)
    return json.loads(body.decode('utf-8'))

def send_message(msg):
    body  = json.dumps(msg, ensure_ascii=False).encode('utf-8')
    frame = struct.pack('<I', len(body)) + body
    with _send_lock:
        sys.stdout.buffer.write(frame)
        sys.stdout.buffer.flush()

# ── Download registry ─────────────────────────────────────────────────────────

_downloads = {}
_dl_lock   = threading.Lock()
_pick_lock = threading.Lock()

# ── Message handler ───────────────────────────────────────────────────────────

def handle(msg):
    action = msg.get('action', '')
    dl_id  = msg.get('id', '')

    if action == 'download':
        raw_dir = msg.get('targetDir')
        target  = str(Path(raw_dir).expanduser()) if raw_dir \
                  else str(Path.home() / 'Downloads')
        dl = Download(
            dl_id,
            url         = msg['url'],
            filename    = msg.get('filename', ''),
            connections = int(msg.get('connections', 8)),
            target_dir  = target,
            headers     = msg.get('headers') or {},
        )
        with _dl_lock:
            _downloads[dl_id] = dl
        threading.Thread(target=dl.run, daemon=True).start()

    elif action == 'pause':
        with _dl_lock: dl = _downloads.get(dl_id)
        if dl: dl.pause()

    elif action == 'resume':
        with _dl_lock: dl = _downloads.get(dl_id)
        if dl: dl.resume()

    elif action == 'cancel':
        with _dl_lock: dl = _downloads.pop(dl_id, None)
        if dl:
            dl.cancel()
            if dl.save_path:
                p = Path(dl.save_path)
                (p.parent / (p.name + '.part')).unlink(missing_ok=True)

    elif action == 'pickFolder':
        default_dir = msg.get('defaultDir')
        # Keep the request id, if the Chrome side sends one. This avoids
        # accepting stale folderPicked replies for a later download.
        threading.Thread(target=_pick_folder, args=(default_dir, dl_id), daemon=True).start()

    elif action == 'openFolder':
        path = msg.get('path', '')
        if path:
            p      = Path(path)
            folder = str(p.parent) if not p.is_dir() else str(p)
            _open_folder(folder)

# ── Platform helpers ──────────────────────────────────────────────────────────

def _pick_folder(default_dir=None, request_id=''):
    """Ask user to select a folder."""

    try:
        if PLATFORM == 'Darwin':
            # macOS
            script = 'POSIX path of (choose folder'
            if default_dir:
                dd = str(Path(default_dir).expanduser())
                script += f' default location POSIX file "{dd}"'
            script += ')'

            result = subprocess.check_output(
                ['osascript', '-e', script],
                text=True
            ).strip()

            send_message({
                'action': 'folderPicked',
                'path': result,
                'id': request_id
            })

        elif PLATFORM == 'Windows':

            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()

            # Fenster komplett verstecken
            root.withdraw()

            # Immer im Vordergrund
            root.attributes('-topmost', True)
            root.update()

            initial_dir = None

            if default_dir:
                try:
                    p = Path(default_dir).expanduser()

                    if p.is_file():
                        p = p.parent

                    if p.exists():
                        initial_dir = str(p)

                except Exception:
                    pass

            selected = filedialog.askdirectory(
                parent=root,
                initialdir=initial_dir,
                title='Select Download Folder'
            )

            root.destroy()

            if selected:
                send_message({
                    'action': 'folderPicked',
                    'path': selected,
                    'id': request_id
                })
            else:
                send_message({
                    'action': 'folderPicked',
                    'path': '',
                    'id': request_id
                })

        else:
            # Linux
            result = subprocess.check_output(
                ['xdg-user-dir', 'DOWNLOAD'],
                text=True
            ).strip()

            send_message({
                'action': 'folderPicked',
                'path': result,
                'id': request_id
            })

    except Exception as exc:

        try:
            send_message({
                'action': 'error',
                'error': f'pickFolder failed: {exc}'
            })
        except Exception:
            pass
            
            
def _open_folder(path: str):
    """Open a folder in the system file manager."""
    try:
        p = Path(path).expanduser()

        if PLATFORM == 'Darwin':
            subprocess.Popen(['open', str(p)])

        elif PLATFORM == 'Windows':
            folder_path = str(p.resolve(strict=False))

            if not Path(folder_path).exists():
                send_message({
                    'action': 'error',
                    'error': f'Folder does not exist: {folder_path}'
                })
                return

            DETACHED_PROCESS = 0x00000008
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            CREATE_NO_WINDOW = 0x08000000

            subprocess.Popen(
                ['explorer.exe', folder_path],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            )

        else:
            subprocess.Popen(['xdg-open', str(p)])

    except Exception as exc:
        send_message({
            'action': 'error',
            'error': f'openFolder failed: {exc}'
        })

# ── Download class ────────────────────────────────────────────────────────────

class Download:
    def __init__(self, dl_id, url, filename, connections, target_dir, headers):
        self.id          = dl_id
        self.url         = url
        self.filename    = filename
        self.connections = connections
        self.target_dir  = target_dir
        self.headers     = headers

        self._cancel  = threading.Event()
        self._resume  = threading.Event()
        self._resume.set()

        self.save_path    = None
        self.total_bytes  = 0
        self.worker_bytes = [0] * connections
        self.pieces_total = 0
        self.pieces_done  = 0
        self._last_report = 0.0

    def pause(self):  self._resume.clear()
    def resume(self): self._resume.set()
    def cancel(self): self._cancel.set(); self._resume.set()

    def wait_if_paused(self):
        while not self._resume.wait(timeout=0.2):
            if self._cancel.is_set():
                raise RuntimeError('cancelled')

    # ── Entry point ───────────────────────────────────────────────────────────

    def run(self):
        try:
            self._run()
        except Exception as exc:
            if not self._cancel.is_set():
                send_message({'action': 'error', 'id': self.id, 'error': str(exc)})
        finally:
            with _dl_lock:
                _downloads.pop(self.id, None)

    def _run(self):
        # ── Probe ─────────────────────────────────────────────────────────────
        s     = make_session()
        probe = s.get(self.url,
                      headers={**self.headers, 'Range': 'bytes=0-1'},
                      stream=True, timeout=30, allow_redirects=True)
        probe.close()

        filename    = self.filename or _extract_filename(probe, self.url)
        total_bytes = 0
        use_chunks  = False

        if probe.status_code == 206:
            m = re.search(r'/(\d+)$', probe.headers.get('Content-Range', ''))
            if m:
                total_bytes = int(m.group(1))
            else:
                head = s.head(self.url, headers=self.headers, timeout=30)
                total_bytes = int(head.headers.get('Content-Length', 0))
            use_chunks = total_bytes > 0 and self.connections > 1
        else:
            total_bytes = int(probe.headers.get('Content-Length', 0))

        self.total_bytes = total_bytes
        active_conn      = self.connections if use_chunks else 1
        save_path        = _unique_path(self.target_dir, filename)
        self.save_path   = str(save_path)

        send_message({
            'action':            'probeResult',
            'id':                self.id,
            'totalBytes':        total_bytes,
            'acceptsRanges':     use_chunks,
            'filename':          filename,
            'savePath':          str(save_path),
            'activeConnections': active_conn,
        })

        # ── Download to .part, rename when done ───────────────────────────────
        save_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = save_path.parent / (save_path.name + '.part')

        if total_bytes > 0:
            with open(temp_path, 'wb') as f:
                f.seek(total_bytes - 1)
                f.write(b'\x00')
        else:
            temp_path.touch()

        file_lock = threading.Lock()
        try:
            if use_chunks:
                self._download_queue(temp_path, total_bytes, file_lock)
            else:
                self.worker_bytes = [0]
                self._download_single(temp_path, file_lock)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

        actual = temp_path.stat().st_size if temp_path.exists() else 0
        if self.total_bytes == 0:
            self.total_bytes = actual
        temp_path.rename(save_path)

        self._report(force=True)
        send_message({
            'action':   'complete',
            'id':       self.id,
            'filename': filename,
            'savePath': str(save_path),
        })

    # ── Queue-based parallel download ─────────────────────────────────────────

    def _download_queue(self, save_path, total_bytes, file_lock):
        piece_size        = _calc_piece_size(total_bytes, self.connections)
        num_pieces        = math.ceil(total_bytes / piece_size)
        self.pieces_total = num_pieces
        self.pieces_done  = 0
        self.worker_bytes = [0] * self.connections

        q        = Queue()
        errors   = []
        err_lock = threading.Lock()

        for i in range(num_pieces):
            start = i * piece_size
            q.put((i, start, min(start + piece_size - 1, total_bytes - 1)))

        def worker(w_idx):
            session = make_session()
            while not self._cancel.is_set() and not errors:
                self.wait_if_paused()
                try:
                    _, start, end = q.get(timeout=0.5)
                except Empty:
                    break
                try:
                    data = self._fetch_range(session, start, end, w_idx)
                    with file_lock:
                        with open(save_path, 'r+b') as f:
                            f.seek(start)
                            f.write(data)
                    self.pieces_done += 1
                    self._report()
                except Exception as exc:
                    with err_lock: errors.append(exc)
                    self._cancel.set(); self._resume.set()
                finally:
                    q.task_done()

        threads = [threading.Thread(target=worker, args=(i,), daemon=True)
                   for i in range(self.connections)]
        for t in threads: t.start()
        for t in threads: t.join()
        if errors and not self._cancel.is_set():
            raise errors[0]

    # ── Single-connection download ─────────────────────────────────────────────

    def _download_single(self, save_path, file_lock):
        session = make_session()
        with session.get(self.url, headers=self.headers,
                         stream=True, timeout=30) as resp:
            resp.raise_for_status()
            offset = 0
            for chunk in resp.iter_content(chunk_size=65536):
                if self._cancel.is_set():
                    raise RuntimeError('cancelled')
                self.wait_if_paused()
                with file_lock:
                    with open(save_path, 'r+b') as f:
                        f.seek(offset); f.write(chunk)
                offset               += len(chunk)
                self.worker_bytes[0] += len(chunk)
                self._report()

    # ── Fetch one byte range ──────────────────────────────────────────────────

    def _fetch_range(self, session, start, end, w_idx):
        buf = BytesIO()
        with session.get(self.url,
                         headers={**self.headers, 'Range': f'bytes={start}-{end}'},
                         stream=True, timeout=60) as resp:
            if resp.status_code != 206:
                raise RuntimeError(f'HTTP {resp.status_code} for bytes={start}-{end}')
            for chunk in resp.iter_content(chunk_size=65536):
                if self._cancel.is_set():
                    raise RuntimeError('cancelled')
                self.wait_if_paused()
                buf.write(chunk)
                self.worker_bytes[w_idx] += len(chunk)
                self._report()
        return buf.getvalue()

    # ── Progress reporting (1 Hz) ─────────────────────────────────────────────

    def _report(self, force=False):
        now = time.monotonic()
        if not force and now - self._last_report < 1.0:
            return
        self._last_report = now
        downloaded = sum(self.worker_bytes)
        fair_share = (math.ceil(self.total_bytes / len(self.worker_bytes))
                      if self.total_bytes > 0 else 0)
        send_message({
            'action':          'progress',
            'id':              self.id,
            'downloadedBytes': downloaded,
            'totalBytes':      self.total_bytes,
            'piecesDone':      self.pieces_done,
            'piecesTotal':     self.pieces_total,
            'workerBytes':     list(self.worker_bytes),
            'fairShare':       fair_share,
        })

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_session():
    """One session = one connection pool = one TCP connection per worker."""
    s = requests.Session()
    a = HTTPAdapter(pool_connections=1, pool_maxsize=1)
    s.mount('http://',  a)
    s.mount('https://', a)
    return s

def _calc_piece_size(total_bytes, num_workers):
    ideal = math.ceil(total_bytes / (num_workers * 4))
    return max(256 * 1024, min(8 * 1024 * 1024, ideal))

def _unique_path(directory, filename):
    p = Path(directory) / filename
    n = 1
    while p.exists():
        p = Path(directory) / f'{p.stem} ({n}){p.suffix}'
        n += 1
    return p

def _extract_filename(response, url):
    cd = response.headers.get('Content-Disposition', '')
    if cd:
        m = re.search(r"filename\*=(?:UTF-8'')?([^;\s]+)", cd, re.I)
        if m:
            from urllib.parse import unquote
            return unquote(m.group(1).strip('"\''))
        m = re.search(r'filename=["\']?([^"\';\r\n]+)', cd, re.I)
        if m:
            return m.group(1).strip()
    from urllib.parse import urlparse, unquote
    return unquote(urlparse(url).path.rstrip('/').split('/')[-1]) or 'download'

# ── Main loop ─────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    while True:
        try:
            msg = read_message()
        except Exception:
            sys.exit(0)
        threading.Thread(target=handle, args=(msg,), daemon=True).start()
