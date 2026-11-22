"""Macro folder tests (razorcad.py: a .js file each, in Documents\\RazorCAD\\Macros or a folder chosen; GitHub issue 19),
runnable without a desktop GUI: python -m unittest discover -s tests -p test_macros.py.

Only the macro definitions are loaded from the desktop entry point (as test_plugins.py does), so pywebview isn't.
"""
import ast
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unittest

NAMES = {'macro_file_name', 'list_macros', 'write_macro', 'delete_macro', 'write_atomic'}
CONSTS = {'MACRO_HEADER'}


def macro_namespace():
    source = ast.parse((Path(__file__).resolve().parents[1] / 'razorcad.py').read_text(encoding='utf-8'))
    body = [n for n in source.body if (isinstance(n, ast.FunctionDef) and n.name in NAMES)
            or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in CONSTS for t in n.targets))]
    ns = dict(os=os, re=re, json=json)
    exec(compile(ast.Module(body=body, type_ignores=[]), 'razorcad.py', 'exec'), ns)
    return ns


class MacroFolderTests(unittest.TestCase):
    def setUp(self):
        self.ns = macro_namespace()
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_written_listed_and_deleted(self):
        ns, d = self.ns, self.dir
        # (a name Windows won't take as a file name: the file is named without those characters, the name kept inside)
        fn = ns['write_macro'](d, 'Plate: 3/4"?', 'await rc.rebuild();\n')
        self.assertEqual(fn, 'Plate_ 3_4_.js')
        ns['write_macro'](d, 'Second', 'rc.log(1);\n')
        listed = ns['list_macros'](d)
        self.assertEqual([m['name'] for m in listed], ['Plate: 3/4"?', 'Second'])
        self.assertEqual(listed[0]['code'], 'await rc.rebuild();\n')
        # (written again: the same file)
        ns['write_macro'](d, 'Second', 'rc.log(2);\n')
        self.assertEqual(len(os.listdir(d)), 2)
        self.assertTrue(ns['delete_macro'](d, 'Second'))
        self.assertFalse(ns['delete_macro'](d, 'Second'))
        self.assertEqual([m['name'] for m in ns['list_macros'](d)], ['Plate: 3/4"?'])

    def test_files_of_its_own(self):
        ns, d = self.ns, self.dir
        # a .js file put there by hand (no first line of RazorCAD's): its file name is its name; other files are left out
        with open(os.path.join(d, 'Bolt circle.js'), 'w', encoding='utf-8-sig') as f:
            f.write('rc.log("hi");\n')
        with open(os.path.join(d, 'notes.txt'), 'w', encoding='utf-8') as f:
            f.write('not a macro')
        listed = ns['list_macros'](d)
        self.assertEqual(listed, [{'name': 'Bolt circle', 'code': 'rc.log("hi");\n', 'file': 'Bolt circle.js'}])
        self.assertEqual(ns['list_macros'](os.path.join(d, 'gone')), [])


if __name__ == '__main__':
    unittest.main()
