# RazorCAD's geometry kernel: sources and how to rebuild it

RazorCAD's geometry kernel is `app/vendor/replicad/replicad_single.wasm` and `replicad_multi.wasm` (with their loaders
`replicad_single.js` and `replicad_multi.js`): Open CASCADE Technology (OCCT) 8.0.1 compiled to WebAssembly by
taucad's opencascade.js, with replicad's bindings and RazorCAD's own. This folder has everything RazorCAD changes or
adds, and the steps to build the same kernel again.

The kernel shipped now is **k14**:

| File | SHA-256 (start) | Size |
|---|---|---|
| `replicad_single.wasm` | `03019fe0943d9ac2…` | 27.8 MB |
| `replicad_multi.wasm` | `3c65145a55eb17c9…` | 26.9 MB |

## What it is made of

- **Open CASCADE Technology 8.0.1** (LGPL-2.1 with the Open CASCADE Exception 1.0), as pinned by taucad/opencascade.js
  v3.1.0 (commit `341fa789f49ce73db76a0209d89ae518cc64a52d`, Emscripten 6.0.5), **with two RazorCAD patches**
  (`occt_patches/`). Both are speed changes that give the same results:
  - `patch_lab_mesh_classifier.py` (BRepMesh_Classifier): a point of a face being meshed is tested only against the
    wires whose own box can hold it, instead of walking every wire's polygon.
  - `patch_lab_class3d_lazy.py` (BRepClass3d_SolidExplorer, BRepClass3d_SClassifier): a solid classifier makes each
    face's intersector only when it is first needed, and skips the faces the probing line cannot meet.

  Each script states the OCCT source files it changes, checks their SHA-256 before changing them, and can be run again
  safely. They are run by taucad's own patch step during the image build (`build_image.sh`).
- **taucad/opencascade.js v3.1.0** (LGPL-2.1): the build system and binding generator, built with link-time
  optimisation (`OCJS_LTO=1`). Not changed otherwise.
- **replicad** (MIT) at commit `a0bc495676b65ef79ad8ab496238fa145fd0ff67`: its bindings list and its six wrappers
  (`brep-io`, `edge-mesh-extractor`, `geom2d-io`, `mesh-extractor`, `shape-caster`, `shape-hasher`), unchanged.
- **RazorCAD's additions** (in `build-config/`; the comments in the two `.yml` files mark each one):
  - classes bound for JavaScript: `gp_Cone`, `gp_Torus`, `BRepClass3d_SClassifier`, `BRepClass3d_SolidClassifier`,
    `TopAbs_State`;
  - `wrappers/lab-tool-check.cpp`: whether the solids of a compound touch or overlap (BOPAlgo_CheckerSI);
  - `wrappers/lab-mesh-extractor.cpp`: many bodies meshed in one parallel call, triangles extracted face by face;
  - `wrappers/lab-shape-info.cpp`: faces' surfaces and edges' points of many bodies at once, face boxes, exact
    volumes and areas;
  - `tools/native/surface-patch.cpp` (`RazorCADSurfacePatch`): guided surfaces and G2 lofts (see `tools/native/README.md`);
  - `wrappers/lab-pmi.cpp` (`LabDefeature`, `LabPMI`): exact defeaturing (BRepAlgoAPI_Defeaturing), and AP242 STEP
    files with semantic PMI (datums, geometric tolerances, dimensions) written and read;
  - the stack and free functions exported by name (`_emscripten_stack_get_current`, `__emscripten_stack_restore`,
    `___libc_free`), and the exception helpers taucad v3.1.0 needs.
- The loaders (`.js`) are patched after linking by `tools/patch_surface_kernel_loader.py`: RazorCAD's object-lifetime
  hooks, and in the multi-threaded one the thread count and the threads' worker address.

## Rebuilding it

On Linux (or WSL on Windows) with Docker and buildx, from the repository's folder:

```sh
bash tools/kernel/build_image.sh single     # OCCT + opencascade.js from source, patched (about 40 min)
bash tools/kernel/build_image.sh multi
bash tools/kernel/link_kernel.sh single     # the bindings linked (about 16 min): tools/kernel/dist/
bash tools/kernel/link_kernel.sh multi
python tools/patch_surface_kernel_loader.py tools/kernel/dist/replicad_single.js app/vendor/replicad/replicad_single.js
python tools/patch_surface_kernel_loader.py tools/kernel/dist/replicad_multi.js app/vendor/replicad/replicad_multi.js --multi
cp tools/kernel/dist/replicad_single.wasm tools/kernel/dist/replicad_multi.wasm app/vendor/replicad/
```

The scripts fetch taucad/opencascade.js from GitHub (and, through its Dockerfile, OCCT, Emscripten and its other
dependencies at the versions it pins). Work files go to `~/razorcad-kernel` (`WORK=...` to change it).

To use your own modified OCCT, change or add patches in `occt_patches/` (and list them in `build_image.sh`), or put
your own `replicad_single.wasm` / `replicad_multi.wasm` with matching loaders in `app/vendor/replicad/`: they are
plain files, and `build.bat` bundles them into `RazorCAD.exe`.

## Checking a rebuilt kernel

- `python tests/run_tests.py --jobs 4`: the whole suite (`kernel-defeaturing-and-pmi` needs `LabDefeature` and
  `LabPMI`).
- `python tools/native/run_probe.py app/vendor/replicad --resolution 16` (and 32, 128), and
  `python tools/native/run_loft_probe.py app/vendor/replicad --require-lifetime-hooks` (with `--multi`,
  `--hard-cases`).
