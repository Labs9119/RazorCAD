"""Updater tests, runnable without a desktop GUI: python -m unittest discover -s tests -p test_updater.py.

Load only the updater definitions from the desktop entry point, so these checks also run on Linux
without importing pywebview or starting its HTTP server. tests/update_e2e.py runs a real setup.
"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


def updater_namespace():
    source = ast.parse((ROOT / 'razorcad.py').read_text(encoding='utf-8'))
    api = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Api')
    methods = [n for n in api.body if isinstance(n, ast.FunctionDef) and n.name in ('start_update', 'update_result', 'run_setup')]
    ns = dict(os=os, re=re, json=json, time=time, subprocess=subprocess, NO_WINDOW=0, APP_VERSION='1.0.0', SETUP_ANSWER_SECONDS=5,
              RELEASE_DOWNLOADS='https://github.com/Labs9119/RazorCAD/releases/download/',
              version_key=lambda v: tuple(int(x) for x in re.findall(r'\d+', v)),
              install_info=Mock(return_value={'installed': True, 'folder': r'C:\Apps\RazorCAD', 'allUsers': False}),
              download_verified=Mock(), update_setup_running=Mock(return_value=False))
    exec(compile(ast.Module(body=methods, type_ignores=[]), 'razorcad.py', 'exec'), ns)
    return ns


def setup_module():
    if 'winreg' not in sys.modules:
        try:
            import winreg  # noqa: F401
        except ImportError:
            sys.modules['winreg'] = Mock()
    spec = importlib.util.spec_from_file_location('razorcad_setup', ROOT / 'installer' / 'setup.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeApi(types.SimpleNamespace):
    """The settings Api keeps in update.json, in memory."""
    def __init__(self):
        super().__init__(state={}, _setup=None)

    def _update_state(self):
        return self.state

    def update_settings(self, changes=None):
        self.state.update(changes or {})


class AppSideTests(unittest.TestCase):
    def setUp(self):
        self.ns = updater_namespace()
        self.url = self.ns['RELEASE_DOWNLOADS'] + 'v1.1.0/RazorCAD-Setup-1.1.0.exe'
        self.api = FakeApi()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for patcher in (patch.object(tempfile, 'gettempdir', return_value=self.temp.name), patch.object(subprocess, 'Popen')):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.launch = subprocess.Popen

    def start(self):
        return self.ns['start_update'](self.api, self.url, 123, 'sha256:abc')

    def answer(self):
        """The setup writing its status file as soon as it starts."""
        def run(args, **kwargs):
            Path(next(a for a in args if a.startswith('/STATUS='))[8:]).write_text('{"state": "started"}')
            return Mock(poll=Mock(return_value=None))
        self.launch.side_effect = run

    def test_setup_is_started_directly_with_a_clean_frozen_environment(self):
        self.answer()
        with patch.dict(os.environ, {'_PYI_APPLICATION_HOME_DIR': 'old-extracted-bundle', 'PYINSTALLER_RESET_ENVIRONMENT': '0'}):
            self.assertTrue(self.start()['ok'])
            self.assertEqual(self.launch.call_args.kwargs['env']['PYINSTALLER_RESET_ENVIRONMENT'], '1')
            self.assertEqual(os.environ['PYINSTALLER_RESET_ENVIRONMENT'], '0')
        args = self.launch.call_args.args[0]
        self.assertTrue(args[0].endswith('RazorCAD-Setup-1.1.0.exe'))
        self.assertEqual(args[1:3], ['/UPDATE', r'/D=C:\Apps\RazorCAD'])
        self.assertNotIn('/ALLUSERS', args)
        self.assertEqual(self.api.state['pending']['to'], '1.1.0')

    def test_a_folder_with_quotes_is_one_argument(self):
        self.answer()
        self.ns['install_info'].return_value = {'installed': True, 'folder': "C:\\Jos\u00e9's Apps\\RazorCAD [test]", 'allUsers': True}
        self.assertEqual(self.start(), {'ok': True, 'allUsers': True})
        args = self.launch.call_args.args[0]
        self.assertIn("/D=C:\\Jos\u00e9's Apps\\RazorCAD [test]", args)
        self.assertIn('/ALLUSERS', args)

    def test_setup_blocked_at_start_keeps_the_application_open(self):
        self.launch.side_effect = OSError('Operation did not complete: the file contains a virus')
        result = self.start()
        self.assertNotIn('ok', result)
        self.assertIn('contains a virus', result['error'])
        self.assertTrue(result['setup'])
        self.assertIsNone(self.api.state['pending'])

    def test_setup_killed_before_it_answers_keeps_the_application_open(self):
        self.launch.return_value = Mock(poll=Mock(return_value=1))
        result = self.start()
        self.assertNotIn('ok', result)
        self.assertIn('Security software', result['error'])
        self.assertIsNone(self.api.state['pending'])

    def test_setup_that_never_answers_keeps_the_application_open(self):
        self.ns['SETUP_ANSWER_SECONDS'] = 0.2
        self.launch.return_value = Mock(poll=Mock(return_value=None))
        self.assertNotIn('ok', self.start())

    def test_download_failure_does_not_start_the_setup(self):
        self.ns['download_verified'].side_effect = OSError('incomplete download')
        self.assertIn('Download failed', self.start()['error'])
        self.launch.assert_not_called()
        self.assertNotIn('pending', self.api.state)

    def test_old_status_file_is_not_taken_for_an_answer(self):
        folder = Path(self.temp.name) / 'RazorCAD-update'
        folder.mkdir()
        (folder / 'update-status.json').write_text('{"state": "failed"}')
        self.launch.return_value = Mock(poll=Mock(return_value=1))
        self.assertNotIn('ok', self.start())

    def result(self, status=None, version='1.0.0', running=False):
        path = Path(self.temp.name) / 'update-status.json'
        if status:
            path.write_text(json.dumps(status))
        self.api.state['pending'] = {'to': '1.1.0', 'setup': r'C:\t\setup.exe', 'status': str(path)}
        self.ns['APP_VERSION'] = version
        self.ns['update_setup_running'].return_value = running
        return self.ns['update_result'](self.api)

    def test_nothing_to_tell_without_an_update(self):
        self.assertIsNone(self.ns['update_result'](self.api))

    def test_new_version_running_is_a_finished_update(self):
        self.assertIsNone(self.result(version='1.1.0'))
        self.assertIsNone(self.api.state['pending'])

    def test_setup_still_waiting_is_not_a_failure(self):
        self.assertEqual(self.result({'state': 'waiting'}, running=True), {'state': 'installing', 'to': '1.1.0'})
        self.assertIsNotNone(self.api.state['pending'])

    def test_failed_setup_reports_why(self):
        r = self.result({'state': 'failed', 'error': 'The disk is full'})
        self.assertEqual((r['state'], r['to'], r['error']), ('failed', '1.1.0', 'The disk is full'))
        self.assertTrue(r['log'].endswith('update.log'))
        self.assertEqual(self.api._setup, r'C:\t\setup.exe')
        self.assertIsNone(self.api.state['pending'])

    def test_setup_that_vanished_is_still_reported(self):
        self.assertEqual(self.result()['state'], 'failed')

    def test_cancelled_update_is_not_a_failure(self):
        self.assertIsNone(self.result({'state': 'cancelled'}))

    def test_run_setup_needs_the_downloaded_file(self):
        self.assertFalse(self.ns['run_setup'](self.api))
        self.api._setup = str(Path(self.temp.name) / 'setup.exe')
        self.assertFalse(self.ns['run_setup'](self.api))
        Path(self.api._setup).write_text('setup')
        self.assertTrue(self.ns['run_setup'](self.api))
        self.assertEqual(self.launch.call_args.args[0], [self.api._setup])
        self.launch.side_effect = OSError('blocked')
        self.assertFalse(self.ns['run_setup'](self.api))


class LinkedFileTests(unittest.TestCase):
    """Bodies to Parts writes files where a link says: only RazorCAD's own kinds, and a new one never over a file."""
    def setUp(self):
        source = ast.parse((ROOT / 'razorcad.py').read_text(encoding='utf-8'))
        api = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Api')
        method = next(n for n in api.body if isinstance(n, ast.FunctionDef) and n.name == 'write_linked')
        self.written = []
        self.ns = dict(os=os, OWN_EXTS=('.rcad', '.rasm', '.rdrw', '.rdrt'), write_atomic=lambda path, text: Path(path).write_text(text))
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'razorcad.py', 'exec'), self.ns)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def write(self, name, create):
        return self.ns['write_linked'](None, str(Path(self.temp.name) / name), 'text', create)

    def test_a_new_file_is_never_written_over(self):
        self.assertTrue(self.write('a.rcad', True))
        self.assertIsNone(self.write('a.rcad', True))

    def test_an_update_needs_the_file_to_be_there(self):
        self.assertIsNone(self.write('a.rcad', False))
        self.write('a.rcad', True)
        self.assertTrue(self.write('a.rcad', False))

    def test_only_razorcads_own_kinds_of_file(self):
        self.assertIsNone(self.write('a.exe', True))
        self.assertIsNone(self.write('missing/a.rcad', True))


class SetupSideTests(unittest.TestCase):
    def setUp(self):
        self.setup = setup_module()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name) / 'app'
        self.folder.mkdir()
        self.payload = Path(self.temp.name) / 'payload'
        self.payload.mkdir()
        for name, text in (('RazorCAD.exe', 'new'), ('version.txt', '1.1.0\n'), ('razorcad.ico', 'i'), ('README.md', 'r'), ('LICENSE.txt', 'l'), ('THIRD-PARTY-NOTICES.md', 't')):
            (self.payload / name).write_text(text)
        (self.folder / 'RazorCAD.exe').write_text('old')
        (self.folder / 'version.txt').write_text('1.0.0')
        for patcher in (patch.object(self.setup, 'payload', side_effect=lambda name: str(self.payload / name)),
                        patch.object(self.setup, 'webview2_version', return_value='1'), patch.object(self.setup, 'dotnet_release', return_value=10 ** 6),
                        patch.object(self.setup, 'shortcut_paths', side_effect=AssertionError('no shortcuts in an update'))):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.opts = {'dir': str(self.folder), 'all_users': False, 'desktop': False, 'startmenu': False, 'assoc': False, 'entry': False}
        self.said = []

    def steps(self, cancelled=None):
        return self.setup.update_steps(self.opts, cancelled or threading.Event(), lambda state, text: self.said.append(state), lambda text: None)

    def test_update_installs_and_verifies(self):
        self.assertEqual(self.steps(), str(self.folder / 'RazorCAD.exe'))
        self.assertEqual(self.said, ['waiting', 'installing'])
        self.assertEqual((self.folder / 'RazorCAD.exe').read_text(), 'new')
        self.assertEqual((self.folder / 'version.txt').read_text(), '1.1.0\n')

    def test_waits_while_the_program_runs(self):
        answers = iter((True, True, False))
        with patch.object(self.setup, 'in_use', side_effect=lambda path: next(answers)), patch.object(self.setup.time, 'sleep') as sleep:
            self.steps()
        self.assertEqual(sleep.call_count, 2)

    def test_cancel_while_waiting_changes_nothing(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch.object(self.setup, 'in_use', return_value=True):
            self.assertIsNone(self.steps(cancelled))
        self.assertEqual((self.folder / 'RazorCAD.exe').read_text(), 'old')
        self.assertNotIn('installing', self.said)

    def test_a_program_left_unchanged_is_a_failure(self):
        with patch.object(self.setup, 'install'), self.assertRaisesRegex(RuntimeError, 'version 1.0.0'):
            self.steps()
        (self.folder / 'version.txt').write_text('1.1.0')
        with patch.object(self.setup, 'install'), self.assertRaisesRegex(RuntimeError, 'not replaced'):
            self.steps()

    def test_failed_copy_puts_the_old_program_back(self):
        with patch.object(self.setup.shutil, 'copyfile', side_effect=OSError('disk full')), self.assertRaises(OSError):
            self.steps()
        self.assertEqual((self.folder / 'RazorCAD.exe').read_text(), 'old')

    @unittest.skipUnless(os.name == 'nt', 'a running program is locked on Windows')
    def test_in_use_sees_a_running_program(self):
        exe = self.folder / 'ping-copy.exe'
        exe.write_bytes((Path(os.environ['SystemRoot']) / 'System32' / 'PING.EXE').read_bytes())
        self.assertFalse(self.setup.in_use(str(exe)))
        self.assertFalse(self.setup.in_use(str(self.folder / 'missing.exe')))
        program = subprocess.Popen([str(exe), '-n', '20', '127.0.0.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        try:
            self.assertTrue(self.setup.in_use(str(exe)))
        finally:
            program.kill()
            program.wait()

    def test_status_file_is_replaced_whole(self):
        path = Path(self.temp.name) / 'status.json'
        self.setup.write_status(str(path), 'failed', error='The disk is full')
        self.assertEqual(json.loads(path.read_text())['error'], 'The disk is full')
        self.assertFalse(Path(str(path) + '.tmp').exists())

    def test_update_keeps_the_shortcuts_and_s_still_installs(self):
        with patch.object(self.setup, 'run_update') as update, patch.object(self.setup, 'install') as install, \
                patch.object(sys, 'argv', ['setup.exe', '/update', r'/D=C:\Apps\RazorCAD', r'/status=C:\t\Status.json']):
            self.setup.main()
        opts, status = update.call_args.args
        self.assertEqual((opts['dir'], opts['desktop'], opts['startmenu'], status), (r'C:\Apps\RazorCAD', False, False, r'C:\t\Status.json'))
        install.assert_not_called()
        with patch.object(self.setup, 'run_update') as update, patch.object(self.setup, 'install') as install, \
                patch.object(sys, 'argv', ['setup.exe', '/S', r'/D=C:\Apps\RazorCAD']):
            self.setup.main()
        update.assert_not_called()
        self.assertEqual(install.call_args.args[0]['dir'], r'C:\Apps\RazorCAD')


if __name__ == '__main__':
    unittest.main()
