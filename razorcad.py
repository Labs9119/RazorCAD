"""RazorCAD desktop application.

Opens the RazorCAD interface in its own native window (Microsoft Edge WebView2)
and provides native services to it: Open/Save dialogs, exports, the recent-files
list (in %APPDATA%\\RazorCAD), auto-save files kept next to each saved part, and crash
reports (%APPDATA%\\RazorCAD\\crashes, see crashreport.py). Build RazorCAD.exe with build.bat.

Copyright (C) 2026 Labs9119 and the RazorCAD contributors.
Licensed under the GNU General Public License v3.0 or later: see LICENSE.
"""
import base64
import ctypes
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# The embedded server must send correct types for ES modules and the OpenCascade WASM kernel
mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('application/wasm', '.wasm')

import webview  # noqa: E402
import webview.http as _webview_http  # noqa: E402


# The window's pages are cross-origin isolated (the multi-threaded geometry kernel needs shared memory): every file
# pywebview's server sends carries the headers for it. The pages only load RazorCAD's own files.
def _isolated_static_file(*args, _orig=_webview_http.bottle.static_file, **kwargs):
    r = _orig(*args, **kwargs)
    try:
        r.set_header('Cross-Origin-Opener-Policy', 'same-origin')
        r.set_header('Cross-Origin-Embedder-Policy', 'require-corp')
        r.set_header('Cross-Origin-Resource-Policy', 'same-origin')
    except AttributeError:
        pass
    return r


_webview_http.bottle.static_file = _isolated_static_file

# pywebview's server (wsgiref's WSGIServer) waits with 5 connections at most; Windows refuses the next ones, and the
# window opens RazorCAD's hundred or so script files at once. On a PC with 4 processor threads, busy compiling the
# geometry kernel, a start then failed now and then: a script not loaded, no part, no kernel (1 to 4 starts in 6).
_webview_http.WSGIServer.request_queue_size = 128

from crashreport import CrashReporter, _pid_alive  # noqa: E402
from kernelsig import kernel_signature  # noqa: E402

APP_NAME = 'RazorCAD'
# RazorCAD's own file extensions (JSON inside), so Windows can open them with RazorCAD.
FILE_TYPES = (('.rcad', 'RazorCAD.Part', 'RazorCAD Part'),
              ('.rasm', 'RazorCAD.Assembly', 'RazorCAD Assembly'),
              ('.rdrw', 'RazorCAD.Drawing', 'RazorCAD Drawing'),
              ('.rdrt', 'RazorCAD.DrawingTemplate', 'RazorCAD Drawing Template'))
TEMPLATE_TYPES = ('RazorCAD Drawing Template (*.rdrt)', 'All files (*.*)')
OWN_EXTS = tuple(t[0] for t in FILE_TYPES)
PART_TYPES = ('RazorCAD Part (*.rcad)', 'All files (*.*)')
DRAWING_TYPES = ('RazorCAD Drawing (*.rdrw)', 'All files (*.*)')
ASSEMBLY_TYPES = ('RazorCAD Assembly (*.rasm)', 'All files (*.*)')
PDF_TYPES = ('PDF Document (*.pdf)', 'All files (*.*)')
STL_TYPES = ('STL Mesh (*.stl)', 'All files (*.*)')
STEP_TYPES = ('STEP File (*.step;*.stp)', 'All files (*.*)')
DXF_TYPES = ('DXF Drawing (*.dxf)', 'All files (*.*)')
MACRO_TYPES = ('RazorCAD macro (*.js)', 'All files (*.*)')
IMPORT_TYPES = ('STEP IGES STL OBJ or 3MF (*.step;*.stp;*.igs;*.iges;*.stl;*.obj;*.3mf)', 'STEP File (*.step;*.stp)', 'IGES File (*.igs;*.iges)', 'STL Mesh (*.stl)', 'OBJ Mesh (*.obj)', '3MF Model (*.3mf)', 'All files (*.*)')
# files imported (as a new part, or into one) rather than opened as RazorCAD documents
IMPORT_EXTS = ('.step', '.stp', '.igs', '.iges', '.stl', '.obj', '.3mf')
OBJ_TYPES = ('OBJ Mesh (*.obj)', 'All files (*.*)')
THREEMF_TYPES = ('3MF Model (*.3mf)', 'All files (*.*)')
DXF_OPEN_TYPES = ('DXF Drawing (*.dxf)', 'All files (*.*)')
IMAGE_TYPES = ('Pictures (*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp)', 'All files (*.*)')
IMAGE_MIME = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'bmp': 'image/bmp', 'gif': 'image/gif', 'webp': 'image/webp'}
# (pywebview only accepts letters, digits and spaces in a filter's description: no commas or dashes)
OPEN_TYPES = ('All supported files (*.rcad;*.rasm;*.rdrw;*.rdrt;*.step;*.stp;*.igs;*.iges;*.stl;*.obj;*.3mf)',
              'RazorCAD Part (*.rcad)', 'RazorCAD Assembly (*.rasm)',
              'RazorCAD Drawing (*.rdrw)', 'RazorCAD Drawing Template (*.rdrt)', 'STEP IGES STL OBJ or 3MF (*.step;*.stp;*.igs;*.iges;*.stl;*.obj;*.3mf)', 'All files (*.*)')


def documents_dir():
    """The user's Documents folder (Windows' own setting: it may be in OneDrive)."""
    if os.name == 'nt':
        try:
            import ctypes.wintypes as wt
            buf = ctypes.c_wchar_p()
            fid = (ctypes.c_byte * 16)(*bytes.fromhex('d0 9a d3 fd 8f 23 af 46 ad b4 6c 85 48 03 69 c7'.replace(' ', '')))  # FOLDERID_Documents
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(buf)) == 0:
                path = buf.value
                ctypes.windll.ole32.CoTaskMemFree(buf)
                if path and os.path.isdir(path):
                    return path
        except Exception:
            pass
    return os.path.join(os.path.expanduser('~'), 'Documents')


def templates_dir():
    """Documents\\RazorCAD\\Templates: where drawing templates are kept (and listed from)."""
    path = os.path.join(documents_dir(), APP_NAME, 'Templates')
    if os.environ.get('RAZORCAD_DATA_DIR'):
        path = os.path.join(data_dir(), 'Templates')  # (tests: inside their own data folder)
    os.makedirs(path, exist_ok=True)
    return path


def resource_dir():
    # PyInstaller unpacks bundled files to sys._MEIPASS
    return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))


def data_dir():
    # RAZORCAD_DATA_DIR lets tests run without touching the user's own autosave
    # (Windows: %APPDATA%\RazorCAD; Linux: $XDG_DATA_HOME/RazorCAD, i.e. ~/.local/share/RazorCAD)
    if os.name == 'nt':
        base = os.environ.get('APPDATA') or os.path.expanduser('~')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    path = os.environ.get('RAZORCAD_DATA_DIR') or os.path.join(base, APP_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def write_atomic(path, data, binary=False):
    tmp = path + '.tmp'
    with open(tmp, 'wb' if binary else 'w', **({} if binary else {'encoding': 'utf-8'})) as f:
        f.write(data)
    os.replace(tmp, path)


MAX_RECENT = 12
MODEL_CACHE_MB = 1024


# ---- this version, and newer ones on GitHub (Help ▸ Check for Updates)
def read_version():
    try:
        with open(os.path.join(resource_dir(), 'version.txt'), encoding='utf-8') as f:
            return f.read().strip()
    except OSError:
        return ''


APP_VERSION = read_version()
RELEASES_API = 'https://api.github.com/repos/Labs9119/RazorCAD/releases?per_page=20'
REPO_URL = 'https://github.com/Labs9119/RazorCAD'


RELEASE_DOWNLOADS = REPO_URL + '/releases/download/'
UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\RazorCAD'


def install_info():
    """Where this RazorCAD was installed by its setup: { installed, folder, allUsers } (installed False: a copy run
    on its own, which updates by downloading the new setup by hand)."""
    if not getattr(sys, 'frozen', False) or os.name != 'nt':
        return {'installed': False}
    import winreg
    here = os.path.normcase(os.path.dirname(os.path.abspath(sys.executable)))
    for root, all_users in ((winreg.HKEY_CURRENT_USER, False), (winreg.HKEY_LOCAL_MACHINE, True)):
        try:
            with winreg.OpenKey(root, UNINSTALL_KEY) as k:
                loc = winreg.QueryValueEx(k, 'InstallLocation')[0]
        except OSError:
            continue
        if loc and os.path.normcase(os.path.abspath(loc)) == here:
            return {'installed': True, 'folder': loc, 'allUsers': all_users}
    return {'installed': False}


def download_verified(url, path, size=None, digest=None, timeout=60):
    """Downloads url to path, checking its size and SHA-256 (digest 'sha256:<hex>', as GitHub gives it). The
    file only appears at path once it checks out."""
    import hashlib
    part = path + '.part'
    h = hashlib.sha256()
    n = 0
    req = urllib.request.Request(url, headers={'User-Agent': 'RazorCAD/' + (APP_VERSION or 'dev')})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(part, 'wb') as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            n += len(chunk)
    try:
        if size and n != int(size):
            raise RuntimeError('the download is incomplete (%d of %d bytes)' % (n, int(size)))
        if digest and str(digest).lower().startswith('sha256:') and h.hexdigest() != str(digest)[7:].lower():
            raise RuntimeError('the download does not match the release (SHA-256 differs)')
    except Exception:
        os.remove(part)
        raise
    os.replace(part, path)
    return n


def update_script(setup, folder, all_users, log, pid, expected_version=''):
    """Wait for this installation to close, install and verify replacement before restarting.

    PyInstaller's one-file parent can outlive the Python process. Waiting only for
    pid races that parent's executable lock and extraction-directory cleanup.
    """
    q = lambda value: "'" + str(value).replace("'", "''") + "'"
    args = ["'/S'", q('"/D=' + folder + '"')] + (["'/ALLUSERS'"] if all_users else [])
    run = 'Start-Process -FilePath %s -ArgumentList %s -Wait -PassThru%s' % (q(setup), ','.join(args), ' -Verb RunAs' if all_users else '')
    template = r'''$ErrorActionPreference = 'Stop'
$log = __LOG__
$application = __APPLICATION__
$versionFile = __VERSION_FILE__
$expected = __EXPECTED__
function Write-UpdateLog($text) {
    Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $text) -Encoding UTF8 -ErrorAction SilentlyContinue
}
function Fail-Update($message) {
    Write-UpdateLog ('FAILED: ' + $message)
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show($message + "`n`nUpdate log: " + $log, 'RazorCAD update failed') | Out-Null
    } catch { }
    exit 1
}
Write-UpdateLog ('Starting update to ' + $expected + ' in ' + $application)
try {
    Get-Process -Id __PID__ -ErrorAction SilentlyContinue | Wait-Process -Timeout 120 -ErrorAction Stop
} catch { Fail-Update ('RazorCAD did not close: ' + $_) }
try {
    $deadline = (Get-Date).AddSeconds(120)
    while ($true) {
        $running = @(Get-Process -Name __PROCESS_NAME__ -ErrorAction SilentlyContinue | Where-Object {
            try { !$_.Path -or $_.Path -eq $application } catch { $true }
        })
        if ($running.Count -eq 0) { break }
        if ((Get-Date) -gt $deadline) { Fail-Update ('RazorCAD is still running. Close its other windows and run setup again.') }
        Start-Sleep -Milliseconds 200
    }
} catch { Fail-Update ('Could not wait for RazorCAD to close: ' + $_) }
try {
    $before = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash
    $env:PYINSTALLER_RESET_ENVIRONMENT = '1'
    $p = __RUN__
    Write-UpdateLog ('setup exit ' + $p.ExitCode)
    if ($p.ExitCode -ne 0) { Fail-Update ('The installer failed with exit code ' + $p.ExitCode + '. Run the downloaded setup manually for more details.') }
    if (!(Test-Path -LiteralPath $application -PathType Leaf)) { Fail-Update 'The installer did not create RazorCAD.exe.' }
    $after = (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash
    if ($before -eq $after) { Fail-Update 'The installer left the application executable unchanged. The update was not applied.' }
    if ($expected) {
        $installed = (Get-Content -LiteralPath $versionFile -Raw).Trim() -replace '^v', ''
        if ($installed -ne $expected) { Fail-Update ('Installed version ' + $installed + ' differs from expected version ' + $expected + '.') }
    }
} catch { Fail-Update ('The update could not be installed: ' + $_) }
try {
    $env:PYINSTALLER_RESET_ENVIRONMENT = '1'
    Start-Process -FilePath $application -WorkingDirectory __FOLDER__
    Write-UpdateLog ('Verified replacement and restarted version ' + $expected)
} catch { Fail-Update ('The update was installed, but RazorCAD could not restart: ' + $_) }
'''
    values = {'__LOG__': q(log), '__APPLICATION__': q(os.path.join(folder, APP_NAME + '.exe')),
              '__VERSION_FILE__': q(os.path.join(folder, 'version.txt')), '__EXPECTED__': q(expected_version),
              '__PID__': str(int(pid)), '__PROCESS_NAME__': q(APP_NAME), '__RUN__': run, '__FOLDER__': q(folder)}
    # One substitution pass: path text is data even if it contains a placeholder.
    return re.sub(r'__[A-Z_]+__', lambda match: values[match.group()], template)


def issue_url(title, body):
    """A new-issue page of RazorCAD's GitHub repository with the title and text filled in (shortened to fit a URL)."""
    import urllib.parse
    q = lambda t, b: f'{REPO_URL}/issues/new?' + urllib.parse.urlencode({'title': t, 'body': b})
    url = q(title, body)
    while len(url) > 7000 and len(body) > 500:
        body = body[:int(len(body) * 0.85)] + '\n\n(shortened)'
        url = q(title, body)
    return url


def version_key(v):
    """'0.12.0-beta' → comparable tuple; a pre-release (alpha < beta < rc) comes before its release."""
    m = re.match(r'v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([A-Za-z]+)\.?(\d*))?', str(v or '').strip())
    if not m:
        return (-1,)
    rank = {'alpha': 0, 'a': 0, 'beta': 1, 'b': 1, 'rc': 2}.get((m.group(4) or '').lower(), 3 if not m.group(4) else 1)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0), rank, int(m.group(5) or 0))


# ---- Claude Code CLI (Ask Claude on the user's own Claude subscription instead of an API key)
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def find_claude_cli(configured=None):
    """Path of the Claude Code CLI, or None: the path set in Claude settings, `claude` on PATH, the
    native installer's ~/.local/bin, npm's global folder, else the newest copy bundled with the Claude
    desktop app (claude-code\\<version>\\<build>\\claude.exe under its %APPDATA%\\Claude folder; the
    Microsoft Store version keeps that folder in %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming,
    and only the desktop app itself sees it at %APPDATA%)."""
    home = os.path.expanduser('~')
    appdata = os.environ.get('APPDATA') or os.path.join(home, 'AppData', 'Roaming')
    local = os.environ.get('LOCALAPPDATA') or os.path.join(home, 'AppData', 'Local')
    for path in (configured, shutil.which('claude'), os.path.join(home, '.local', 'bin', 'claude.exe'),
                 os.path.join(appdata, 'npm', 'claude.cmd')):
        if path and os.path.isfile(path):
            return path
    roots = [os.path.join(appdata, 'Claude', 'claude-code')]
    try:
        roots += [os.path.join(local, 'Packages', p, 'LocalCache', 'Roaming', 'Claude', 'claude-code')
                  for p in os.listdir(os.path.join(local, 'Packages')) if p.lower().startswith('claude_')]
    except OSError:
        pass
    found = []
    for bundled in roots:
        try:
            for ver in os.listdir(bundled):
                for build in os.listdir(os.path.join(bundled, ver)):
                    exe = os.path.join(bundled, ver, build, 'claude.exe')
                    if os.path.isfile(exe):
                        found.append((tuple(int(n) for n in re.findall(r'\d+', ver)), exe))
        except OSError:
            pass
    return max(found)[1] if found else None


def claude_cli_env():
    """Environment for running the CLI: on the subscription sign-in (no API key from the environment),
    not as a child of another Claude Code session, and without the user's CLAUDE.md files / memory."""
    env = dict(os.environ)
    for k in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'):
        env.pop(k, None)
    env.update(CLAUDE_CODE_DISABLE_CLAUDE_MDS='1', CLAUDE_CODE_DISABLE_AUTO_MEMORY='1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
    return env


def claude_cli_prompt(messages):
    """The Messages API conversation as one prompt (the CLI takes a single message): earlier turns in
    a transcript, then the latest user message."""
    *earlier, last = messages
    text = lambda m: m['content'] if isinstance(m['content'], str) else '\n'.join(
        b.get('text', '') for b in m['content'] if b.get('type') == 'text')
    if not earlier:
        return text(last)
    turns = '\n'.join('<%s>\n%s\n</%s>' % (m['role'], text(m), m['role']) for m in earlier)
    return ('<conversation_so_far>\n%s\n</conversation_so_far>\n\nThe earlier turns of this conversation are above. '
            'Answer this latest message:\n\n%s' % (turns, text(last)))


def split_ext(name):
    """(stem, extension): RazorCAD's own extensions (.rcad, .rasm, .rdrw) whole; others as usual."""
    low = name.lower()
    for ext in OWN_EXTS:
        if low.endswith(ext):
            return name[:-len(ext)], name[-len(ext):]
    return os.path.splitext(name)


THUMB_CLSID = '{4F6B9D2E-7C1A-4E58-9B3D-2A61C0E5F7A1}'           # shell/RazorCADThumbs.cs
THUMB_SHELLEX = '{e357fccd-a995-4576-b01f-234630154e96}'           # IThumbnailProvider
_THUMB_RE = re.compile(rb'^\s*\{\s*"thumbnail"\s*:\s*"(data:image/(?:png|jpeg);base64,[A-Za-z0-9+/=]+)"')


def read_thumbnail(path):
    """The preview picture saved at the start of a RazorCAD file (a data: URL), or None."""
    try:
        with open(path, 'rb') as f:
            head = f.read(2 * 1024 * 1024)
        m = _THUMB_RE.match(head.lstrip(b'\xef\xbb\xbf'))
        return m.group(1).decode('ascii') if m else None
    except OSError:
        return None


def part_stem(name):
    """File name without its extension and without any .autosave suffixes."""
    stem = split_ext(name)[0]
    while stem.lower().endswith('.autosave'):
        stem = stem[:-len('.autosave')]
    return stem


def autosave_ext(name):
    """The extension an auto-save keeps: the file's own (a part of any other name: .rcad)."""
    ext = split_ext(name)[1]
    return ext if ext.lower() in OWN_EXTS else '.rcad'


def autosave_path(path):
    """Auto-save file kept next to a part: Bracket.rcad -> Bracket.autosave.rcad
    (an auto-save never gets an auto-save of its own)."""
    folder, name = os.path.split(path)
    return os.path.join(folder, part_stem(name) + '.autosave' + autosave_ext(name))


def is_autosave(path):
    stem, ext = split_ext(os.path.basename(path))
    return ext.lower() in OWN_EXTS and stem.lower().endswith('.autosave')


def original_of(path):
    """The part an auto-save file belongs to: Bracket.autosave.rcad -> Bracket.rcad."""
    folder, name = os.path.split(path)
    return os.path.join(folder, part_stem(name) + autosave_ext(name))


# ---- opening files from Windows (double-click, Open with): RazorCAD.exe "file.rcad"
# A second RazorCAD started for a file hands it to the one already running (through a folder in the
# data folder), which opens it in a new tab and comes to the front; if none answers it opens it itself.
def open_requests_dir():
    path = os.path.join(data_dir(), 'open-requests')
    os.makedirs(path, exist_ok=True)
    return path


def other_session_running():
    try:
        names = os.listdir(data_dir())
    except OSError:
        return False
    for name in names:
        if name.startswith('session-') and name.endswith('.lock'):
            try:
                pid = int(name[len('session-'):-len('.lock')])
            except ValueError:
                continue
            if pid != os.getpid() and _pid_alive(pid):
                return True
    return False


def hand_to_running(paths, wait=8.0):
    """Ask a running RazorCAD to open these files. True if it took them (this one can then quit)."""
    folder = open_requests_dir()
    reqs = []
    for i, p in enumerate(paths):
        req = os.path.join(folder, 'open-%d-%d-%d.req' % (os.getpid(), int(time.time() * 1000), i))
        write_atomic(req, p)
        reqs.append(req)
    if os.name == 'nt':
        try:
            ctypes.windll.user32.AllowSetForegroundWindow(-1)  # (ASFW_ANY: it may come to the front)
        except Exception:
            pass
    end = time.time() + wait
    while time.time() < end:
        if not any(os.path.exists(r) for r in reqs):
            return True
        time.sleep(0.1)
    for r in reqs:
        remove_quietly(r)
    return False


def take_requests():
    """Paths other RazorCAD launches asked this one to open (the requests are removed)."""
    out = []
    try:
        folder = open_requests_dir()
        for name in sorted(os.listdir(folder)):
            if not name.endswith('.req'):
                continue
            req = os.path.join(folder, name)
            try:
                with open(req, encoding='utf-8') as f:
                    p = f.read().strip()
                os.remove(req)
            except OSError:
                continue
            if p:
                out.append(p)
    except OSError:
        pass
    return out


def paths_from_args(argv):
    return [os.path.abspath(a) for a in argv[1:] if not a.startswith('--') and os.path.isfile(a)]


# ---- Windows file types: .rcad / .rasm / .rdrw open with this
# RazorCAD.exe (for the current user)
def register_file_types(exe):
    import winreg
    base = r'Software\Classes'
    for ext, progid, desc in FILE_TYPES:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + '\\' + progid) as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, desc)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + '\\' + progid + r'\DefaultIcon') as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, '"%s",0' % exe)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + '\\' + progid + r'\shell\open\command') as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, '"%s" "%%1"' % exe)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + '\\' + ext) as k:
            winreg.SetValueEx(k, '', 0, winreg.REG_SZ, progid)
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + '\\' + ext + r'\OpenWithProgids') as k:
            winreg.SetValueEx(k, progid, 0, winreg.REG_SZ, '')
    register_thumbnails()
    try:
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)  # SHCNE_ASSOCCHANGED: Explorer refreshes icons
    except Exception:
        pass


def thumbnail_dll():
    """The thumbnail handler (shell/RazorCADThumbs.cs, built by build.bat) where Explorer can load it:
    copied out of RazorCAD.exe to %LOCALAPPDATA%\\RazorCAD\\shell (by content, so an updated one gets a
    new name and one in use is never overwritten). None when it isn't bundled."""
    import hashlib
    src = os.path.join(resource_dir(), 'shell', 'RazorCADThumbs.dll')
    if not os.path.isfile(src):
        return None
    with open(src, 'rb') as f:
        data = f.read()
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    folder = os.path.join(base, APP_NAME, 'shell')
    os.makedirs(folder, exist_ok=True)
    dst = os.path.join(folder, 'RazorCADThumbs-%s.dll' % hashlib.sha256(data).hexdigest()[:10])
    if not os.path.isfile(dst):
        write_atomic(dst, data, binary=True)
    return dst


def register_thumbnails(dll=None):
    """Explorer previews of .rcad / .rasm / .rdrw (a .NET COM class: mscoree loads the DLL)."""
    import winreg
    dll = dll or thumbnail_dll()
    if not dll:
        return False
    cls = r'Software\Classes\CLSID' + '\\' + THUMB_CLSID
    vals = {'': 'mscoree.dll', 'ThreadingModel': 'Both', 'Class': 'RazorCAD.Shell.ThumbnailProvider',
            'Assembly': 'RazorCADThumbs, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null',
            'RuntimeVersion': 'v4.0.30319', 'CodeBase': 'file:///' + dll.replace('\\', '/')}
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, cls) as k:
        winreg.SetValueEx(k, '', 0, winreg.REG_SZ, 'RazorCAD Thumbnail Provider')
    for sub in (r'\InprocServer32', r'\InprocServer32\1.0.0.0'):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, cls + sub) as k:
            for name, val in vals.items():
                if sub.endswith('1.0.0.0') and name in ('', 'ThreadingModel'):
                    continue
                winreg.SetValueEx(k, name, 0, winreg.REG_SZ, val)
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, cls + r'\Implemented Categories\{62C8FE65-4EBB-45e7-B440-6E39B2CDBF29}'):
        pass
    for ext, _, _ in FILE_TYPES:
        for base in (r'Software\Classes' + '\\' + ext, r'Software\Classes\SystemFileAssociations' + '\\' + ext):
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r'\ShellEx' + '\\' + THUMB_SHELLEX) as k:
                winreg.SetValueEx(k, '', 0, winreg.REG_SZ, THUMB_CLSID)
    return True


def ensure_file_types():
    """At start (RazorCAD.exe only): .rcad / .rasm / .rdrw open with
    this RazorCAD when they aren't set up yet (or the RazorCAD they were set to is gone), and their Explorer
    previews are on. A type set to another RazorCAD.exe that still exists is left to it (Help ▸ Open Files
    With RazorCAD switches it)."""
    if os.name != 'nt' or not getattr(sys, 'frozen', False) or os.environ.get('RAZORCAD_DATA_DIR'):
        return None  # (tests run with their own data folder: they leave Windows' settings alone)
    reg = registered_exe()
    if not reg or not os.path.isfile(reg):
        register_file_types(sys.executable)  # (also the previews)
        return 'registered'
    if os.path.normcase(os.path.abspath(reg)) == os.path.normcase(os.path.abspath(sys.executable)) and not all(ext_registered(e, p) for e, p, _ in FILE_TYPES):
        register_file_types(sys.executable)  # (a file type added since: drawing templates)
        return 'registered'
    if not thumbnails_registered():
        register_thumbnails()
        try:
            ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
        except Exception:
            pass
        return 'previews'
    return None


def thumbnails_registered():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, '.rcad\\ShellEx\\' + THUMB_SHELLEX) as k:
            if winreg.QueryValueEx(k, '')[0].upper() != THUMB_CLSID.upper():
                return False
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, 'CLSID\\' + THUMB_CLSID + '\\InprocServer32') as k:
            code = winreg.QueryValueEx(k, 'CodeBase')[0]
        return os.path.isfile(code[len('file:///'):].replace('/', '\\'))
    except Exception:
        return False


def ext_registered(ext, progid):
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, ext) as k:
            return winreg.QueryValueEx(k, '')[0] == progid
    except Exception:
        return False


def registered_exe():
    """The RazorCAD.exe that .rcad files are registered to open with (None if not registered)."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r'RazorCAD.Part\shell\open\command') as k:
            cmd = winreg.QueryValueEx(k, '')[0]
        return cmd.split('"')[1] if cmd.startswith('"') else cmd.split(' ')[0]
    except Exception:
        return None


def remove_quietly(path):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def first(result):
    if not result:
        return None
    return result if isinstance(result, str) else result[0]


class Api:
    """Methods callable from JavaScript as window.pywebview.api.<name>()."""

    def __init__(self, crash=None):
        self._window = None
        self._dirty = False
        self._force_close = False
        self._close_pending = 0  # when the interface was asked to confirm closing
        self._close_ack = False
        self._has_file = False
        self._crash = crash
        self._dialog_lock = threading.Lock()  # one file dialog at a time (see _file_dialog)
        self._open_queue = []     # files given on the command line, for the interface to open
        self._ui_ready = False    # (the interface has asked for them: later requests are pushed to it)

    # --- file dialogs ------------------------------------------------------

    def _file_dialog(self, *args, **kwargs):
        """A Windows file dialog, one at a time. While one is open another request (a second Open, Import or Save
        As, from the menu, a shortcut or the start window) gets None at once, as if cancelled: two dialogs open
        together both stop answering and can't be closed."""
        if not self._dialog_lock.acquire(blocking=False):
            return None
        try:
            return self._window.create_file_dialog(*args, **kwargs)
        finally:
            self._dialog_lock.release()

    # --- recent files -----------------------------------------------------

    def _recent_file(self):
        return os.path.join(data_dir(), 'recent.json')

    def _load_recent(self):
        try:
            with open(self._recent_file(), encoding='utf-8') as f:
                items = json.load(f)
        except (OSError, ValueError):
            return []
        return [p for p in items if isinstance(p, str)]

    def _add_recent(self, path):
        path = os.path.abspath(path)
        items = [p for p in self._load_recent() if os.path.normcase(p) != os.path.normcase(path)]
        items.insert(0, path)
        write_atomic(self._recent_file(), json.dumps(items[:MAX_RECENT], indent=1))

    def remove_recent(self, path):
        items = [p for p in self._load_recent() if os.path.normcase(p) != os.path.normcase(path)]
        write_atomic(self._recent_file(), json.dumps(items, indent=1))
        return True

    def get_start_info(self):
        """Recent parts for the start window, and an unsaved session left by older versions."""
        recent = []
        for p in self._load_recent():
            exists = os.path.exists(p)
            auto = autosave_path(p)
            modified = os.path.getmtime(p) if exists else None
            has_auto = exists and os.path.exists(auto) and os.path.getmtime(auto) > (modified or 0)
            recent.append({'path': p, 'name': os.path.basename(p), 'folder': os.path.dirname(p),
                           'exists': exists, 'modified': modified * 1000 if modified else None, 'autosave': has_auto,
                           'thumb': read_thumbnail(p) if exists else None})
        legacy = os.path.join(data_dir(), 'autosave.json')
        old = None
        if os.path.exists(legacy):
            old = {'modified': os.path.getmtime(legacy) * 1000}
        return {'recent': recent, 'legacy': old}

    # --- auto-save (next to the saved part) ----------------------------------
    def save_autosave(self, content, path):
        if not path:
            return None  # parts are only auto-saved once they have been saved
        target = autosave_path(path)
        write_atomic(target, content)
        return target

    def discard_autosave(self, path):
        remove_quietly(autosave_path(path))
        return True

    def load_legacy_session(self):
        """The single session auto-save written by earlier versions (%APPDATA%\\RazorCAD\\autosave.json)."""
        legacy = os.path.join(data_dir(), 'autosave.json')
        if not os.path.exists(legacy):
            return None
        with open(legacy, encoding='utf-8') as f:
            return f.read()

    def retire_legacy_session(self):
        """Keep the old session file but stop offering it (renamed, not deleted)."""
        legacy = os.path.join(data_dir(), 'autosave.json')
        if os.path.exists(legacy):
            os.replace(legacy, os.path.join(data_dir(), 'autosave-recovered-%s.json' % time.strftime('%Y%m%d-%H%M%S')))
        return True

    # --- files ------------------------------------------------------------
    def save_file(self, name, content, path='', old_path='', kind='part'):
        if not path:
            types = {'drawing': DRAWING_TYPES, 'assembly': ASSEMBLY_TYPES, 'template': TEMPLATE_TYPES}.get(kind, PART_TYPES)
            extra = {'directory': templates_dir()} if kind == 'template' else {}
            path = first(self._file_dialog(webview.FileDialog.SAVE, save_filename=name, file_types=types, **extra))
            if not path:
                return None
        write_atomic(path, content)
        self._saved_here = getattr(self, '_saved_here', set()) | {os.path.normcase(os.path.abspath(path))}
        if kind == 'template':
            return path  # (templates are listed in the New Drawing dialog, not with the recent files)
        # the part is saved: its auto-save (and that of the file it was saved from) is no longer needed
        remove_quietly(autosave_path(path))
        if old_path and os.path.normcase(old_path) != os.path.normcase(path):
            remove_quietly(autosave_path(old_path))
        self._add_recent(path)
        return path

    # --- an assembly's parts and sub-assemblies, each saved as a file of its own beside it ----------------
    # Only beside an assembly file saved in this session, and only plain .rcad / .rasm file names (no paths);
    # they are not added to the recent files.
    def _beside(self, main_path, name):
        main = os.path.normcase(os.path.abspath(str(main_path or '')))
        if main not in getattr(self, '_saved_here', set()) or not main.endswith('.rasm'):
            return None
        name = str(name or '')
        if not re.fullmatch(r'[^\\/:*?"<>|\x00-\x1f]+\.(rcad|rasm)', name, re.I) or name != name.strip() or name.startswith('.'):
            return None  # (a plain file name only: no folders in it)
        return os.path.join(os.path.dirname(os.path.abspath(str(main_path))), name)

    def beside_exists(self, main_path, names):
        out = []
        for n in names or []:
            p = self._beside(main_path, n)
            if p and os.path.exists(p):
                out.append(os.path.basename(p))
        return out

    def save_beside(self, main_path, name, content):
        path = self._beside(main_path, name)
        if not path:
            return None
        write_atomic(path, content)
        remove_quietly(autosave_path(path))
        return path

    def save_binary(self, name, b64, kind='stl'):
        types = {'stl': STL_TYPES, 'step': STEP_TYPES, 'dxf': DXF_TYPES, 'pdf': PDF_TYPES, 'obj': OBJ_TYPES, '3mf': THREEMF_TYPES, 'js': MACRO_TYPES}.get(kind, ('All files (*.*)',))
        path = first(self._file_dialog(webview.FileDialog.SAVE, save_filename=name, file_types=types))
        if not path:
            return None
        write_atomic(path, base64.b64decode(b64), binary=True)
        return path

    def pick_folder(self):
        folder = first(self._file_dialog(webview.FileDialog.FOLDER))
        if not folder:
            return None
        self._picked_folder = os.path.abspath(folder)
        return folder

    def save_into(self, folder, name, b64):
        # only into the folder the user just picked, and only a plain file name (no paths)
        picked = getattr(self, '_picked_folder', None)
        if not picked or os.path.normcase(os.path.abspath(folder)) != os.path.normcase(picked):
            return None
        name = os.path.basename(str(name or ''))
        if not name or name in ('.', '..') or not os.path.isdir(picked):
            return None
        path = os.path.join(picked, name)
        write_atomic(path, base64.b64decode(b64), binary=True)
        return path

    # --- Claude (modelling assistant) --------------------------------------
    # The Anthropic API key is kept here, in the data folder; the page never sees it. The request is
    # made from Python (a background thread of the bridge), so the window stays responsive.
    def _claude_path(self):
        return os.path.join(data_dir(), 'claude.json')

    def _claude_cfg(self):
        try:
            with open(self._claude_path(), encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}

    # ---- user preferences (toolbar layout, ...): prefs.json in the data folder (the web view runs in
    # private mode, so its own storage does not last from one session to the next)
    def _prefs_path(self):
        return os.path.join(data_dir(), 'prefs.json')

    def get_prefs(self):
        try:
            with open(self._prefs_path(), encoding='utf-8') as f:
                v = json.load(f)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}

    def set_prefs(self, text):
        try:
            v = json.loads(text)
            if not isinstance(v, dict):
                return False
            write_atomic(self._prefs_path(), json.dumps(v, indent=1))
            return True
        except Exception:
            return False

    # backend 'api' (the user's API key) or 'cli' (the Claude Code CLI, on the user's Claude subscription).
    # ready: a request can be sent (a key is saved / the CLI was found; whether the CLI is signed in is
    # only known by asking it: claude_cli_check).
    def claude_status(self):
        cfg = self._claude_cfg()
        backend = 'cli' if cfg.get('backend') == 'cli' else 'api'
        cli = find_claude_cli(cfg.get('cliPath')) if backend == 'cli' else None
        return {'hasKey': bool(cfg.get('key')), 'model': cfg.get('model') or '', 'backend': backend,
                'cli': cli or '', 'ready': bool(cli) if backend == 'cli' else bool(cfg.get('key'))}

    def claude_set(self, key=None, model=None, clear=False, backend=None):
        cfg = self._claude_cfg()
        if clear:
            cfg.pop('key', None)
        elif key:
            cfg['key'] = str(key).strip()
        if model:
            cfg['model'] = str(model)
        if backend in ('api', 'cli'):
            cfg['backend'] = backend
        write_atomic(self._claude_path(), json.dumps(cfg))
        try:
            os.chmod(self._claude_path(), 0o600)
        except Exception:
            pass
        return self.claude_status()

    def claude_cli_check(self):
        """For Claude settings: where the CLI is, its version and whether it is signed in to a Claude subscription."""
        cli = find_claude_cli(self._claude_cfg().get('cliPath'))
        if not cli:
            return {'cli': '', 'version': '', 'loggedIn': False, 'authMethod': ''}
        out = {'cli': cli, 'version': '', 'loggedIn': False, 'authMethod': ''}
        try:
            run = lambda *a: subprocess.run([cli, *a], capture_output=True, text=True, encoding='utf-8', errors='replace',
                                            timeout=30, env=claude_cli_env(), creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
            out['version'] = run('--version').stdout.strip().split(' ')[0]
            st = json.loads(run('auth', 'status', '--json').stdout or '{}')
            out['loggedIn'] = bool(st.get('loggedIn'))
            out['authMethod'] = st.get('authMethod') or ''
        except Exception as e:
            out['error'] = str(e)
        return out

    def claude_cli_login(self):
        """Opens a console running `claude auth login`: the user signs in to their Claude subscription in the browser."""
        cli = find_claude_cli(self._claude_cfg().get('cliPath'))
        if not cli:
            return False
        subprocess.Popen([cli, 'auth', 'login', '--claudeai'], env=claude_cli_env(),
                         creationflags=getattr(subprocess, 'CREATE_NEW_CONSOLE', 0))
        return True

    def _claude_cli_messages(self, cfg, body):
        cli = find_claude_cli(cfg.get('cliPath'))
        if not cli:
            return {'error': {'message': 'Claude Code was not found on this PC (install it, or choose the API key in Ask Claude ▸ settings).'}}
        work = os.path.join(data_dir(), 'claude-cli')  # an empty folder: no project files or CLAUDE.md for the CLI to pick up
        os.makedirs(work, exist_ok=True)
        system = body.get('system') or ''
        if isinstance(system, list):
            system = '\n'.join(b.get('text', '') for b in system)
        write_atomic(os.path.join(work, 'system.txt'), system)
        cmd = [cli, '-p', '--output-format', 'json', '--system-prompt-file', os.path.join(work, 'system.txt'),
               '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence']
        if body.get('model'):
            cmd += ['--model', body['model']]
        try:
            r = subprocess.run(cmd, input=claude_cli_prompt(body['messages']), capture_output=True, text=True, encoding='utf-8',
                               errors='replace', timeout=600, cwd=work, env=claude_cli_env(), creationflags=NO_WINDOW)
        except subprocess.TimeoutExpired:
            return {'error': {'message': 'Claude Code did not answer within 10 minutes.'}}
        except Exception as e:
            return {'error': {'message': 'Could not run Claude Code: %s' % e}}
        try:
            res = json.loads(r.stdout)
        except Exception:
            return {'error': {'message': 'Claude Code failed: %s' % ((r.stderr or r.stdout).strip()[:2000] or 'exit code %s' % r.returncode)}}
        text = res.get('result') or ''
        if res.get('is_error'):
            if 'not logged in' in text.lower() or '/login' in text:
                text = 'Claude Code is not signed in to your Claude subscription (Ask Claude ▸ settings ▸ Sign In).'
            return {'error': {'message': text or 'Claude Code request failed'}}
        return {'content': [{'type': 'text', 'text': text}], 'model': body.get('model'), 'stop_reason': res.get('stop_reason')}

    def claude_messages(self, body_json):
        cfg = self._claude_cfg()
        if cfg.get('backend') == 'cli':
            return json.dumps(self._claude_cli_messages(cfg, json.loads(body_json)))
        key = cfg.get('key')
        if not key:
            return json.dumps({'error': {'message': 'No Anthropic API key is set (Ask Claude ▸ settings).'}})
        body = json.loads(body_json)
        req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=json.dumps(body).encode('utf-8'), method='POST', headers={
            'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return r.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            text = e.read().decode('utf-8', 'replace')
            try:
                msg = json.loads(text).get('error', {}).get('message') or text
            except Exception:
                msg = text
            return json.dumps({'error': {'status': e.code, 'message': msg[:2000]}})
        except Exception as e:
            return json.dumps({'error': {'message': 'Could not reach Claude: %s' % e}})

    def open_import(self):
        path = first(self._file_dialog(webview.FileDialog.OPEN, file_types=IMPORT_TYPES))
        if not path:
            return None
        return self._read_import(path)

    def _read_import(self, path):
        name = os.path.basename(path)
        ext = name.lower().rsplit('.', 1)[-1]
        if ext in ('stl', 'obj', '3mf'):
            with open(path, 'rb') as f:
                return {'name': name, 'format': ext, 'data': base64.b64encode(f.read()).decode('ascii')}
        with open(path, encoding='utf-8', errors='replace') as f:
            return {'name': name, 'format': 'iges' if ext in ('igs', 'iges') else 'step', 'data': f.read()}

    def open_dxf(self):
        """A DXF file's text (for importing into a sketch), or None."""
        path = first(self._file_dialog(webview.FileDialog.OPEN, file_types=DXF_OPEN_TYPES))
        if not path:
            return None
        with open(path, encoding='utf-8', errors='replace') as f:
            return {'name': os.path.basename(path), 'text': f.read()}

    def open_image(self):
        """A picture (for a sketch picture or a decal): { name, mime, data (base64) }, or None. Up to 40 MB."""
        path = first(self._file_dialog(webview.FileDialog.OPEN, file_types=IMAGE_TYPES))
        if not path:
            return None
        ext = os.path.basename(path).lower().rsplit('.', 1)[-1]
        if ext not in IMAGE_MIME:
            raise ValueError('That is not a PNG, JPEG, BMP, GIF or WebP picture')
        if os.path.getsize(path) > 40 << 20:
            raise ValueError('That picture is too big (over 40 MB)')
        with open(path, 'rb') as f:
            return {'name': os.path.basename(path), 'mime': IMAGE_MIME[ext], 'data': base64.b64encode(f.read()).decode('ascii')}

    def open_file(self):
        """Open a part, or a STEP/STL file (the interface then offers a new part or inserting it)."""
        path = first(self._file_dialog(webview.FileDialog.OPEN, file_types=OPEN_TYPES))
        if not path:
            return None
        if path.lower().endswith(IMPORT_EXTS):
            return self._read_import(path)
        return self.open_path(path)

    def open_macro(self):
        """A macro file (.js, up to 1 MB): { name, content }."""
        path = first(self._file_dialog(webview.FileDialog.OPEN, file_types=MACRO_TYPES))
        if not path:
            return None
        if os.path.getsize(path) > 1 << 20:
            raise ValueError('That file is too big for a macro')
        with open(path, encoding='utf-8-sig') as f:
            return {'name': os.path.basename(path), 'content': f.read()}

    def read_text(self, path):
        """The text of a part file (a drawing keeping its parts up to date); None if it can't be read."""
        try:
            if not path or not str(path).lower().endswith(OWN_EXTS) or not os.path.isfile(path):
                return None
            with open(path, encoding='utf-8-sig') as f:
                return f.read()
        except Exception:
            return None

    def open_path(self, path):
        """Read a part; also return its auto-save when that is newer than the file.

        Opening an auto-save file itself recovers it into its part: the part keeps its own path
        (saving writes the part, auto-saves go to the one auto-save file next to it).
        A STEP / IGES / STL / OBJ / 3MF file (opened from Windows) is read for importing: { name, format, data }."""
        if not os.path.exists(path):
            raise FileNotFoundError('The file no longer exists: ' + path)
        if path.lower().endswith(IMPORT_EXTS):
            return self._read_import(path)
        if is_autosave(path):
            original = original_of(path)
            with open(path, encoding='utf-8-sig') as f:
                out = {'name': os.path.basename(original), 'content': f.read(), 'path': original, 'fromAutosave': True}
            self._add_recent(original)
            return out
        with open(path, encoding='utf-8-sig') as f:
            out = {'name': os.path.basename(path), 'content': f.read(), 'path': path}
        auto = autosave_path(path)
        if os.path.exists(auto) and os.path.getmtime(auto) > os.path.getmtime(path):
            with open(auto, encoding='utf-8-sig') as f:
                out['autosave'] = {'content': f.read(), 'modified': os.path.getmtime(auto) * 1000}
        self._add_recent(path)
        return out

    # --- the model as last built (app/js/modelcache.js) ------------------
    # %LOCALAPPDATA%\RazorCAD\modelcache\k<signature>\<sha256>.bin: one folder per geometry kernel (a hash of its
    # code, kernelsig.py: a new kernel may build differently, so older folders are removed; a RazorCAD build that
    # leaves the kernel alone keeps them), at most MODEL_CACHE_MB in all.
    def _model_cache_dir(self):
        if getattr(self, '_mcache', None):
            return self._mcache
        base = os.path.join(os.environ.get('LOCALAPPDATA') or data_dir(), APP_NAME, 'modelcache')
        if os.environ.get('RAZORCAD_DATA_DIR'):
            base = os.path.join(data_dir(), 'modelcache')  # (tests: inside their own data folder)
        try:
            build = 'k' + kernel_signature(os.path.join(resource_dir(), 'app'))
        except OSError:
            build = 'b%d' % int(os.path.getmtime(sys.executable)) if getattr(sys, 'frozen', False) else 'dev'
        folder = os.path.join(base, build)
        os.makedirs(folder, exist_ok=True)
        for old in os.listdir(base):
            if old != build:
                shutil.rmtree(os.path.join(base, old), ignore_errors=True)
        self._mcache = folder
        return folder

    def read_model_cache(self, key):
        if not re.fullmatch(r'[0-9a-f]{64}', str(key or '')):
            return None
        path = os.path.join(self._model_cache_dir(), key + '.bin')
        try:
            with open(path, 'rb') as f:
                data = f.read()
            os.utime(path, None)  # (recently used: kept longest)
            return base64.b64encode(data).decode('ascii')
        except OSError:
            return None

    def write_model_cache(self, key, b64):
        if not re.fullmatch(r'[0-9a-f]{64}', str(key or '')):
            return False
        folder = self._model_cache_dir()
        write_atomic(os.path.join(folder, key + '.bin'), base64.b64decode(b64), binary=True)
        try:
            files = sorted((os.path.join(folder, n) for n in os.listdir(folder) if n.endswith('.bin')), key=os.path.getmtime, reverse=True)
            total = 0
            for f in files:
                total += os.path.getsize(f)
                if total > MODEL_CACHE_MB * 1048576:
                    remove_quietly(f)
        except OSError:
            pass
        return True

    # --- the PC, for how many geometry kernels may work at once (app/js/machine.js) ---
    def system_info(self):
        class MemoryStatus(ctypes.Structure):
            _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong), ('ullTotalPhys', ctypes.c_ulonglong),
                        ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                        ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong), ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]
        out = {'threads': os.cpu_count() or 4, 'totalMB': None, 'freeMB': None}
        try:
            m = MemoryStatus()
            m.dwLength = ctypes.sizeof(MemoryStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                out['totalMB'] = m.ullTotalPhys // 1048576
                out['freeMB'] = m.ullAvailPhys // 1048576
        except (AttributeError, OSError):
            pass
        return out

    # --- drawing templates (app/js/drawtemplates.js) ----------------------
    def _template_info(self, path):
        try:
            with open(path, encoding='utf-8-sig') as f:
                doc = json.load(f)
            if doc.get('kind') != 'drawingTemplate' or not isinstance(doc.get('sheets'), list):
                return None
            return {'path': path, 'name': doc.get('name') or os.path.splitext(os.path.basename(path))[0],
                    'description': doc.get('description') or '', 'sheets': doc['sheets'], 'thumb': doc.get('thumbnail'),
                    'modified': os.path.getmtime(path) * 1000}
        except Exception:
            return None

    def list_templates(self, extra=None):
        """Templates in Documents\\RazorCAD\\Templates, and template files picked elsewhere before (extra)."""
        folder = templates_dir()
        out, seen = [], set()
        paths = [os.path.join(folder, n) for n in sorted(os.listdir(folder)) if n.lower().endswith('.rdrt')]
        for p in paths + [p for p in (extra or []) if isinstance(p, str)]:
            key = os.path.normcase(os.path.abspath(p))
            if key in seen or not os.path.isfile(p):
                continue
            seen.add(key)
            info = self._template_info(p)
            if info:
                out.append(info)
        return {'folder': folder, 'templates': out}

    def read_template(self, path):
        info = self._template_info(path) if path and os.path.isfile(path) else None
        if not info:
            return None
        with open(path, encoding='utf-8-sig') as f:
            return {'path': path, 'content': f.read()}

    def pick_template(self):
        path = first(self._file_dialog(webview.FileDialog.OPEN, file_types=TEMPLATE_TYPES, directory=templates_dir()))
        return self.read_template(path) if path else None

    def open_templates_folder(self):
        os.startfile(templates_dir())
        return True

    # --- files opened from Windows ---------------------------------------
    def take_open_requests(self):
        """Files to open: those on the command line, then ones other launches handed over."""
        self._ui_ready = True
        out, self._open_queue = self._open_queue, []
        return out + take_requests()

    def _watch_requests(self):
        # (a thread) files handed over by other launches: pushed to the interface, window to the front
        while True:
            time.sleep(0.4)
            if not self._ui_ready or self._window is None:
                continue
            paths = take_requests()
            if not paths:
                continue
            if self._crash:
                self._crash.event('Asked to open: ' + ', '.join(paths))
            try:
                self.bring_to_front()
            except Exception:
                pass
            try:
                # (not awaited: openRequested may wait on dialogs)
                self._window.evaluate_js('window.app && void window.app.openRequested(%s)' % json.dumps(paths))
            except Exception as e:
                if self._crash:
                    self._crash.event('Could not pass the files to the interface: %r' % e)

    def bring_to_front(self):
        """This window to the front (restored if minimized; a maximized window stays maximized)."""
        if os.name != 'nt':
            return False
        user32 = ctypes.windll.user32
        found = []
        proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def each(hwnd, _):
            pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(pid))
            if pid.value == os.getpid() and user32.IsWindowVisible(ctypes.c_void_p(hwnd)) and user32.GetWindowTextLengthW(ctypes.c_void_p(hwnd)):
                found.append(hwnd)
            return True
        user32.EnumWindows(proc(each), 0)
        for hwnd in found[:1]:
            h = ctypes.c_void_p(hwnd)
            if user32.IsIconic(h):
                user32.ShowWindow(h, 9)  # SW_RESTORE
            user32.SetForegroundWindow(h)
        return bool(found)

    # --- updates: the newest RazorCAD release on GitHub (only github.com is asked; nothing is sent about you)
    def _update_path(self):
        return os.path.join(data_dir(), 'update.json')

    def update_settings(self, changes=None):
        try:
            with open(self._update_path(), encoding='utf-8') as f:
                s = json.load(f)
        except (OSError, ValueError):
            s = {}
        if changes:
            s.update({k: v for k, v in changes.items() if k in ('auto', 'skip', 'last')})
            write_atomic(self._update_path(), json.dumps(s))
        return {'auto': s.get('auto', True), 'skip': s.get('skip', ''), 'last': s.get('last', 0), 'version': APP_VERSION}

    def check_update(self, force=False):
        """{ current, latest, newer, skipped, url, name, published } or { error }; None when not due (at
        most one automatic check a day, none when turned off)."""
        s = self.update_settings()
        if not force and (not s['auto'] or time.time() - s['last'] < 86400):
            return None
        req = urllib.request.Request(RELEASES_API, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'RazorCAD/' + (APP_VERSION or 'dev')})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                releases = json.loads(r.read().decode('utf-8'))
        except Exception as e:  # (offline, GitHub busy…)
            return {'error': str(getattr(e, 'reason', e)), 'current': APP_VERSION}
        self.update_settings({'last': time.time()})
        releases = [x for x in releases if isinstance(x, dict) and not x.get('draft') and x.get('tag_name')]
        if not releases:
            return {'current': APP_VERSION, 'latest': '', 'newer': False}
        best = max(releases, key=lambda x: version_key(x['tag_name']))
        latest = best['tag_name'].lstrip('vV')
        setup = next((a for a in best.get('assets') or [] if re.fullmatch(r'RazorCAD-Setup-[\w.\-]+\.exe', a.get('name') or '')), None)
        return {'current': APP_VERSION, 'latest': latest, 'newer': version_key(latest) > version_key(APP_VERSION),
                'skipped': latest == s['skip'], 'url': best.get('html_url') or REPO_URL + '/releases',
                'name': best.get('name') or latest, 'published': best.get('published_at') or '',
                'setup': {'url': setup.get('browser_download_url'), 'size': setup.get('size'), 'digest': setup.get('digest')} if setup else None,
                'installed': install_info().get('installed', False)}

    def start_update(self, url, size=None, digest=None):
        """Update now: downloads the new setup (checked against the release), then a helper runs it silently into this
        installation, waits, and starts RazorCAD again; the app closes itself after this returns ok."""
        url = str(url or '')
        name = url.rsplit('/', 1)[-1]
        if not url.startswith(RELEASE_DOWNLOADS) or not re.fullmatch(r'RazorCAD-Setup-[\w.\-]+\.exe', name):
            return {'error': 'Not a RazorCAD setup from its GitHub releases'}
        info = install_info()
        if not info.get('installed'):
            return {'error': 'This copy of RazorCAD was not installed with its setup: download the new setup instead.'}
        import tempfile
        folder = os.path.join(tempfile.gettempdir(), 'RazorCAD-update')
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, name)
        try:
            download_verified(url, path, size, digest)
        except Exception as e:
            return {'error': 'Download failed: %s' % getattr(e, 'reason', e)}
        expected = name[len('RazorCAD-Setup-'):-4].lstrip('vV')
        script = update_script(path, info['folder'], info['allUsers'], os.path.join(folder, 'update.log'), os.getpid(), expected)
        helper = os.path.join(folder, 'install-update.ps1')
        # The helper outlives this one-file application. On restart PyInstaller must extract the new
        # executable, rather than reuse this process's old (or already removed) _MEI directory.
        env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT='1')
        flags = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | NO_WINDOW
        try:
            # Windows PowerShell 5 reads non-ASCII paths correctly with a UTF-8 BOM.
            with open(helper, 'w', encoding='utf-8-sig') as stream:
                stream.write(script)
            subprocess.Popen(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper],
                             env=env, creationflags=flags, close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as e:
            return {'error': 'The update helper could not start: %s' % e}
        return {'ok': True, 'allUsers': info['allUsers']}

    def open_url(self, url):
        """Opens a RazorCAD page (its GitHub pages only) in the web browser."""
        url = str(url or '')
        if not (url == REPO_URL or url.startswith(REPO_URL + '/')):
            return False
        import webbrowser
        return webbrowser.open(url)

    def file_types_info(self):
        exe = sys.executable if getattr(sys, 'frozen', False) else None
        reg = registered_exe() if os.name == 'nt' else None
        return {'exe': exe, 'registered': reg,
                'current': bool(exe and reg and os.path.normcase(os.path.abspath(reg)) == os.path.normcase(os.path.abspath(exe))),
                'thumbnails': thumbnails_registered() if os.name == 'nt' else False,
                'exts': [t[0] for t in FILE_TYPES]}

    def register_file_types(self):
        """Make .rcad / .rasm / .rdrw open with this RazorCAD.exe (for this Windows user)."""
        if os.name != 'nt':
            raise RuntimeError('On Linux the desktop opens RazorCAD files through razorcad.desktop (installed with the AppImage)')
        if not getattr(sys, 'frozen', False):
            raise RuntimeError('File types can only be registered from RazorCAD.exe')
        register_file_types(sys.executable)
        return self.file_types_info()

    # --- crash reports ----------------------------------------------------
    def log_event(self, text):
        if self._crash:
            self._crash.event(text)
        return True

    def remember_part(self, text):
        if self._crash:
            self._crash.remember_part(text)
        return True

    def report_error(self, report):
        """An error from the user interface or the geometry kernel: write a crash report."""
        if not self._crash:
            return None
        details = {k: report.get(k) for k in ('stack', 'state', 'extra', 'breadcrumbs', 'userAgent', 'uiTime') if report.get(k) is not None}
        return self._crash.write(str(report.get('kind') or 'ui-error'), str(report.get('message') or ''), details, part=report.get('part'))

    def get_crash_info(self):
        if not self._crash:
            return {'folder': None, 'recent': []}
        return {'folder': self._crash.dir, 'recent': self._crash.recent()}

    def crash_reports(self):
        """The crash reports kept, newest first (for Help ▸ Report a Problem)."""
        return self._crash.all_reports() if self._crash else []

    def crash_issue(self, name=''):
        """A crash report (by its folder name; none: a plain problem report) as the text of a GitHub issue:
        { title, body, url }, personal details taken out. Nothing is sent: the user reads it, and the page opens
        in their browser only when they choose to."""
        from crashreport import issue_text, scrub, system_info
        import urllib.parse
        if name:
            if not self._crash:
                return {'error': 'No crash reports'}
            folder = os.path.join(self._crash.dir, os.path.basename(str(name)))
            if not os.path.isdir(folder):
                return {'error': 'That report is no longer there'}
            title, body = issue_text(folder)
        else:
            s = system_info()
            title = 'Problem: '
            body = ('**What happened** (and what you expected):\n\n\n\n**Steps to repeat it**\n\n1. \n\n'
                    f'**Report**\n\n- RazorCAD: {s.get("version") or "?"}\n- Windows: {scrub(s.get("platform"))}\n')
        return {'title': title, 'body': body, 'url': issue_url(title, body)}

    def mark_crashes_seen(self):
        if self._crash:
            self._crash.mark_seen()
        return True

    def open_crash_folder(self, name=''):
        if not self._crash:
            return False
        target = os.path.join(self._crash.dir, name) if name else self._crash.dir
        os.startfile(target if os.path.isdir(target) else self._crash.dir)
        return True

    # --- window -----------------------------------------------------------
    def set_title(self, title):
        self._window.set_title(title)
        return True

    def set_dirty(self, dirty, has_file=False):
        self._dirty = bool(dirty)
        self._has_file = bool(has_file)
        return True

    # --- fonts for sketch text (read from the PC's font folder; nothing is bundled)
    def _font_dirs(self):
        win = os.environ.get('WINDIR', r'C:\Windows')
        local = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'Windows', 'Fonts')
        return [os.path.join(win, 'Fonts'), local]

    def fonts_available(self, files):
        """Which of these font file names exist on this PC."""
        out = []
        for name in files or []:
            if any(os.path.isfile(os.path.join(d, os.path.basename(name))) for d in self._font_dirs()):
                out.append(name)
        return out

    def read_font(self, name):
        """A TrueType font file (by file name only) as base64, or None."""
        name = os.path.basename(str(name))
        if not name.lower().endswith(('.ttf', '.otf')):
            return None
        for d in self._font_dirs():
            path = os.path.join(d, name)
            if os.path.isfile(path):
                with open(path, 'rb') as f:
                    return base64.b64encode(f.read()).decode('ascii')
        return None

    # --- closing with unsaved parts: the interface asks (Save all / Close without saving / Cancel)
    def close_ack(self):
        self._close_ack = True
        return True

    def close_cancel(self):
        self._close_pending = 0
        return True

    def close_app(self):
        self._force_close = True
        self._window.destroy()
        return True


def main():
    # opened for files (double-click / Open with): a RazorCAD already running opens them instead
    paths = paths_from_args(sys.argv)
    if paths and other_session_running() and hand_to_running(paths):
        return
    crash = CrashReporter(data_dir())
    crash.start()  # also turns sessions that ended abnormally into crash reports
    api = Api(crash)
    api._open_queue = paths
    threading.Thread(target=api._watch_requests, daemon=True).start()

    def setup_types():
        try:
            done = ensure_file_types()
            if done:
                crash.event('File types: ' + done)
        except Exception as e:
            crash.event('File types not set up: %r' % e)
    threading.Thread(target=setup_types, daemon=True).start()
    index = os.path.join(resource_dir(), 'app', 'index.html')
    window = webview.create_window(
        APP_NAME, index, js_api=api,
        width=1440, height=900, min_size=(1000, 640), maximized=True,
        background_color='#E7EAEE',
    )
    api._window = window

    def on_closing():
        if api._force_close or not api._dirty:
            return True
        now = time.time()
        if api._close_pending and not api._close_ack and now - api._close_pending > 3:
            # the interface did not answer: ask here instead
            return window.create_confirmation_dialog(APP_NAME, 'There are unsaved changes that will be lost.\n\nClose RazorCAD anyway?')
        if api._close_pending and api._close_ack:
            return False  # the interface is already asking
        # let the interface ask which parts to save (it closes the window itself afterwards)
        api._close_pending = now
        api._close_ack = False
        threading.Thread(target=lambda: window.evaluate_js('window.app && window.app.confirmClose()'), daemon=True).start()
        return False

    window.events.closing += on_closing
    # Rendering: use the dedicated graphics card (on PCs with two), let the GPU rasterize, and
    # give the interface plenty of memory. (The geometry kernel has its own 4 GB address space.)
    extra = ('--force_high_performance_gpu --ignore-gpu-blocklist --enable-gpu-rasterization '
             '--enable-zero-copy --js-flags=--max-old-space-size=8192')
    current = os.environ.get('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '')
    os.environ['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = (current + ' ' + extra).strip()
    # The UI looks for "RazorCAD-Desktop" in the user agent to enable native file dialogs. Windows: Edge's WebView2;
    # Linux: what pywebview finds (WebKitGTK, or Qt WebEngine), which keeps its own user agent apart from the mark.
    if os.name == 'nt':
        gui = 'edgechromium'
        user_agent = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
                      'Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0 RazorCAD-Desktop')
    else:
        gui = os.environ.get('RAZORCAD_GUI') or None
        user_agent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 RazorCAD-Desktop'
    webview.start(gui=gui, http_server=True, debug='--debug' in sys.argv,
                  user_agent=user_agent, private_mode=True)
    crash.stop()  # reached only when the window closed normally


if __name__ == '__main__':
    main()
