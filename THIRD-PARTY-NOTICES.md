# Third-party notices

RazorCAD is licensed under the GNU General Public License v3.0 or later (see `LICENSE`).
It includes the third-party software listed below, each under its own license. The full license
texts are linked; each one also comes with that project's source.

## In the RazorCAD application (`app/vendor`)

| Component | Use | License |
|---|---|---|
| [Open CASCADE Technology](https://dev.opencascade.org/) | B-rep geometry kernel (compiled to WebAssembly in `replicad_single.wasm`, and with threads in `replicad_multi.wasm`) | [LGPL-2.1 with the Open CASCADE Exception 1.0](https://dev.opencascade.org/resources/licensing) |
| [opencascade.js](https://github.com/taucad/opencascade.js) (taucad v3.1.0) with [replicad-opencascadejs](https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs)'s bindings | Builds Open CASCADE for WebAssembly and makes its JavaScript bindings: single-thread (`replicad_single.js`, `.wasm`) and multi-threaded (`replicad_multi.js`, `.wasm`), built by RazorCAD from source (`tools/kernel/`) | [LGPL-2.1](https://github.com/donalffons/opencascade.js/blob/master/LICENSE) |
| [replicad](https://github.com/sgenoud/replicad) | CAD modelling library on top of Open CASCADE (`replicad.js`, `casting-*.js`) | [MIT](https://github.com/sgenoud/replicad/blob/main/LICENSE) |
| [opentype.js](https://github.com/opentypejs/opentype.js) | Font parsing for sketch text (bundled inside `replicad.js`) | [MIT](https://github.com/opentypejs/opentype.js/blob/master/LICENSE) |
| [three.js](https://threejs.org/) r169 | 3D display (`three.module.js`) | [MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE) |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | Fast picking and ray casting (`three-mesh-bvh.module.js`) | [MIT](https://github.com/gkjohnson/three-mesh-bvh/blob/master/LICENSE) |
| [DejaVu fonts](https://dejavu-fonts.github.io/) 2.x | DejaVu Sans, Sans Mono and Serif for sketch and drawing text (`app/fonts`, unmodified) | Bitstream Vera / Arev font licence, DejaVu changes public domain (`app/fonts/LICENSE_DEJAVU`) |

### Changes to the bundled libraries

RazorCAD builds its geometry kernel (`replicad_single.wasm`, `replicad_multi.wasm`) itself, from Open CASCADE 8.0.1
and opencascade.js v3.1.0, and changes the files below. The source of every change, the exact versions and the steps
to build the same kernel are in `tools/kernel/` (see its `README.md`).

- **Open CASCADE Technology (LGPL-2.1 with the Open CASCADE Exception)**, compiled into both `.wasm` files, is
  **modified** by two patches, both speed changes that give the same results: `tools/kernel/occt_patches/`
  `patch_lab_mesh_classifier.py` (BRepMesh_Classifier) and `patch_lab_class3d_lazy.py` (BRepClass3d_SolidExplorer,
  BRepClass3d_SClassifier). Each patch script contains the changed code and the checksums of the original files it
  applies to.
- The `.wasm` files also contain RazorCAD's own C++ (`tools/kernel/build-config/wrappers/lab-*.cpp` and
  `tools/native/surface-patch.cpp`, GPL-3.0-or-later like the rest of RazorCAD) and replicad's wrappers (MIT,
  unchanged), linked with the bindings listed in `tools/kernel/build-config/*.yml`.
- `app/vendor/replicad/replicad_single.js` and `replicad_multi.js` (opencascade.js bindings, LGPL-2.1): hooks so
  RazorCAD can free kernel objects (`razorcadDtors`, `razorcadOnHandle`); in the multi-threaded one, the number of
  threads a kernel starts and the processor count Open CASCADE sees, taken from `razorcadThreads`, and its threads
  loaded from the same address as itself. Made by `tools/patch_surface_kernel_loader.py` from the linked files. See
  `KERNEL-MEMORY-FINDINGS.md`.
- `app/vendor/replicad/replicad.js` and `casting-rs4QjB74.js` (replicad, MIT): temporary objects are freed
  straight after use. `iterTopo` in `casting-rs4QjB74.js` groups the shapes it has met by hash code, so
  listing faces and edges doesn't compare each with all the others. Each change is marked with a `RazorCAD:`
  comment or uses a `razorcad` name.

As the LGPL requires, you may replace these library files with your own modified versions: they are plain files in
this repository, and `build.bat` bundles them into `RazorCAD.exe`. `tools/kernel/README.md` says how to rebuild
them with your own changes. The Open CASCADE source is available from https://dev.opencascade.org/ and
https://github.com/Open-Cascade-SAS/OCCT, opencascade.js from https://github.com/taucad/opencascade.js.

## In RazorCAD.exe and the installer (bundled by PyInstaller)

| Component | Use | License |
|---|---|---|
| [Python](https://www.python.org/) 3.13 | Runtime of the desktop shell and installer | [PSF License 2.0](https://docs.python.org/3/license.html) |
| [pywebview](https://github.com/r0x0r/pywebview) 6.2 | Native window (Microsoft Edge WebView2) | [BSD-3-Clause](https://github.com/r0x0r/pywebview/blob/master/LICENSE) |
| [Python.NET (pythonnet)](https://github.com/pythonnet/pythonnet) and clr_loader | .NET access for the window layer | [MIT](https://github.com/pythonnet/pythonnet/blob/master/LICENSE) |
| [Bottle](https://bottlepy.org/) | pywebview's local web server | [MIT](https://github.com/bottlepy/bottle/blob/main/LICENSE) |
| proxy_tools | pywebview dependency | MIT |
| [cffi](https://github.com/python-cffi/cffi), [pycparser](https://github.com/eliben/pycparser) | pythonnet dependencies | MIT, BSD-3-Clause |
| [Tcl/Tk](https://www.tcl-lang.org/) | The installer window (tkinter) | [Tcl/Tk License (BSD-style)](https://www.tcl-lang.org/software/tcltk/license.html) |
| [PyInstaller](https://pyinstaller.org/) bootloader | Starts the bundled executables | [GPL-2.0 with the bootloader exception](https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt) (allows bundling programs under any license) |

## Not bundled

These are installed from Microsoft by the RazorCAD installer when they are missing, under Microsoft's own
license terms: the Microsoft Edge WebView2 Runtime and the .NET Framework. Fonts for sketch text are read
from the fonts Windows installs (`C:\Windows\Fonts`); none are bundled.
