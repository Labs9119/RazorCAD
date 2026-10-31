# RazorCAD

[![Tests](https://github.com/Labs9119/RazorCAD/actions/workflows/tests.yml/badge.svg)](https://github.com/Labs9119/RazorCAD/actions/workflows/tests.yml)

A parametric part modeler for Windows with a classic feature-tree interface. It has a feature history,
constraint-driven sketches, equations and live previews. Its solid modeling runs on the
**OpenCascade** B-rep kernel, the engine behind FreeCAD, via replicad.

**Website: [razorcad.com](https://razorcad.com)** · [Download](https://github.com/Labs9119/RazorCAD/releases) · [User manual online](https://razorcad.com/docs/)

------------------------------
Hey everyone! A quick heads-up about me and this project: I’m a Mechanical Engineer, not a professional coder. This software was built using incredible open-source libraries and a whole lot of help from Claude. It's still an early work-in-progress, so expect some bugs and hiccups along the way—I'm working hard to test features and fix problems as I find them.

I started this project because I struggled to find an open-source CAD tool that fitted my personal workflow. I wanted something tailored to how I work, but as it took shape, I realized others in the community might benefit from it too.

My ultimate vision is to give makers and professionals a powerful alternative to expensive proprietary CAD software, subscription traps, and paywalled tools. Down the road, I want to add built-in CAM and FEA capabilities (for CAM, I plan to get a CNC rig to thoroughly test everything first).

A small request: If you're using this to generate DXFs for manufacturing, please double-check your exported files initially until we know everything is rock solid!

I’m pouring a lot of time (and API tokens :P) into this. If you run into bugs or have feature requests, please drop them in the [issues](https://github.com/Labs9119/RazorCAD/issues/new/choose), or start a thread in [Discussions](https://github.com/Labs9119/RazorCAD/discussions) ([how to report and contribute](CONTRIBUTING.md))! And if you enjoy using the app and want to support its development, any small donation goes a long way toward keeping the momentum going. Thanks for trying it out!

------------------------------

## Running it

Double-click **`RazorCAD.exe`**. It is a single standalone executable: it runs offline and needs no
browser, Python or installation. It uses the Microsoft Edge WebView2 runtime, which comes with Windows 10 and 11.

- **File ▸ Open / Save / Save As** use the normal Windows file dialogs and save parts as `.rcad`, assemblies as `.rasm`
  and drawings as `.rdrw` files (JSON inside).
- **File ▸ Import STEP / STL** (Ctrl+I) adds the file as a body feature (`Imported…` in the tree). Every solid in a
  STEP file becomes its own body (a solid made of several separate shells is split into one body per shell), and
  loose surfaces become surface bodies, so each can be selected with the body filter. Tick *Merge touching bodies
  into one body* in the import feature to fuse them instead.
  The file's contents are stored inside the part file. STEP imports as an exact solid. An STL is converted
  to a solid made of its triangles; coplanar triangles are merged, and meshes up to 200,000 triangles are accepted.
- **File ▸ Export ▸ STEP / STL** writes the part: STEP as an exact B-rep (each body as its own named, coloured
  solid), STL as a binary mesh. A single body can be exported as STEP from its right-click menu (see Bodies).
- **Export Face as DXF**: click a flat face, then right-click ▸ *Export Face as DXF…* (or File ▸ Export ▸ Face as DXF).
  The face's outline (layer `OUTLINE`) and holes (layer `HOLES`) are written as a 2D drawing in millimetres, seen
  from outside the part, for laser/waterjet cutting or a 2D CAD program. Lines, arcs and circles are exact;
  other curves become fine polylines. The file is DXF R12, which practically every program can read.
- **Start window:** at launch RazorCAD shows a start window with **New Part**, **Open…**, the **Sample Part** and your
  **Recent Parts** (name, folder and date; missing files are greyed out and can be removed with ✕). Reopen it with
  File ▸ Recent Parts / Start….
- **Auto-save** starts once a part has been saved for the first time. While it has unsaved changes it is written
  next to the part file, at most every 20 seconds, as `Name.autosave.rcad` (the title bar shows the time of the last
  auto-save). Saving the part removes the auto-save. If RazorCAD closes with unsaved changes, opening the part again
  offers to **recover** the auto-saved version (it is also marked in the recent list). A part that was never saved is
  not auto-saved, and RazorCAD warns before closing it.
- The recent-files list is kept in `%APPDATA%\RazorCAD\recent.json`. Unsaved work left by earlier versions
  (`autosave.json` there) is offered once in the start window as **Recover Previous Session**.

### Installer for testers
`installer\build_installer.bat` builds `RazorCAD.exe` and then `..\RazorCAD Install\RazorCAD-Setup.exe`, a single setup program
with RazorCAD inside it (set the version in `version.txt` first), and copies `Read me first.txt` for testers next to it.
Setup installs for the current user (`%LOCALAPPDATA%\Programs\RazorCAD`, no administrator rights) or for all users
(Program Files), or into a chosen folder; installs the Microsoft Edge WebView2 Runtime and .NET Framework 4.8 from
Microsoft if they are missing; creates Start-menu/desktop shortcuts; and registers RazorCAD in Windows' Installed apps
with an uninstaller (which asks before removing settings and crash reports; part files are never touched). Running
setup again updates an existing installation. Silent install: `RazorCAD-Setup.exe /S [/D=folder] [/ALLUSERS] [/NODESKTOP] [/NOSTARTMENU]`;
silent uninstall: `uninstall.exe /S`. The source is `installer\setup.py`.

### Crash reports
RazorCAD writes a crash report whenever something goes wrong, to `%APPDATA%\RazorCAD\crashes\<date_time>_<kind>\`
(**Help ▸ Open Crash Reports Folder**). Each report folder holds:

- `report.json` — what happened: the kind of failure, the error message and stack trace (for native crashes, the
  tracebacks of all threads at the moment of the crash), what RazorCAD was doing (mode, open Property panel, sketch
  tool, selection, feature errors) and system information;
- `session.log` — the recent actions of that session (parts opened/saved, features started/accepted/cancelled,
  rebuild times and errors), newest last;
- `part.rcad` — the part that was open, so the problem can be reproduced (open it in RazorCAD).

Caught: errors in the user interface and the geometry kernel (`ui-error`, `kernel-error`, `kernel-worker-crash`),
uncaught exceptions in the desktop shell (`python-exception`), hard crashes of the process (`native-crash`, via
Python's faulthandler) and sessions that ended without closing normally — killed, frozen and ended, or a power
loss (`unexpected-shutdown`, found at the next launch). The start window mentions new reports. The newest 30 are kept.

### Rebuilding the executable
```
python -m pip install pywebview pyinstaller pillow
build.bat
```
`build.bat` bundles `app/` (including the 23 MB OpenCascade WebAssembly kernel) and `razorcad.py` into
`RazorCAD.exe` with PyInstaller. If RazorCAD is open, the running copy is renamed to `RazorCAD.old.exe` (Windows can't
overwrite a running program) and the new build is used from the next launch; the old copy is removed by the next build.
To work on the UI code, run `python serve.py` and open http://localhost:8765/ in a browser.
In that mode, files are downloaded instead of saved through dialogs.
Set the `RAZORCAD_DATA_DIR` environment variable to keep a test run's recent-files list separate from your own.

### Linux (experimental)
RazorCAD is made and tested on Windows, but the same app runs on Linux in WebKitGTK (or Qt WebEngine) through
pywebview. `build_linux.sh` builds `dist/RazorCAD`, and with `appimagetool` on the PATH an AppImage with a desktop entry
and the `.rcad` / `.rasm` / `.rdrw` file types. The **Linux build** workflow (Actions tab, **Run workflow**) builds the
AppImage on Ubuntu and smoke-tests it in a virtual display. On Linux the data folder is `~/.local/share/RazorCAD`.

## Navigating

| Action | Mouse / keys |
|---|---|
| Rotate (free, about the model center) | Middle-drag, or left-drag on the model outside a sketch |
| Pan | Shift + right-drag, or Ctrl + middle-drag |
| Zoom | Mouse wheel (toward the cursor), or Shift + middle-drag |
| Roll | Alt + middle-drag, or Alt + ← / → |
| Sketch tool wheel | In a sketch: hold the right button (or drag with it), move toward a tool, release |
| Rotate in steps | Arrow keys 15°, Shift + arrows 90° |
| Pan in steps | Ctrl + arrow keys |
| Standard views | Ctrl+1 … Ctrl+7, Ctrl+8 = Normal To (press again to flip to the back side) |
| Zoom to fit | F |

## Selecting and selection filters

In the part, a click selects whatever is under the cursor: a **vertex**, then an **edge**, then a **face**, then a
**plane**. The **selection filter** buttons in the heads-up toolbar limit what can be picked:

| Filter | Key | Picks |
|---|---|---|
| Faces | X | model faces |
| Edges | E | model edges |
| Vertices | V | corners (edge end points) |
| Solid Bodies | B | whole bodies (a click on any face picks its body) |
| Planes | | standard and reference planes |
| Clear filters | F5 | back to picking anything |

Several filters can be on at once. They also apply while picking references for a Reference Plane.

**Features in the tree:** hovering a feature in the Feature tree highlights what it made in the model in orange
(the faces of a boss, cut, fillet, chamfer, shell, pattern or moved body; a sketch's curves; a plane, axis or point;
a surface feature's surfaces); clicking it keeps that highlight in blue while it is selected.

**Selecting hidden bodies:** hold **Shift and right-click** to step through the bodies and surfaces under the cursor,
front to back; **Shift and left-click** steps back. The current one is shown in orange, through whatever is in front
of it. Then release Shift and **left-click** on the same spot to select it (Esc or a click elsewhere cancels). With
only the face filter on, or while a Property panel asks for faces (Shell, Offset Surface), it steps through faces
instead. While a Property panel asks for bodies (Combine, Split, Move/Copy, Knit, Thicken), the click adds the body.

**Progress:** operations that take more than a moment (opening a part, rebuilding, importing, meshing, exporting) show
a progress bar at the bottom left.
Right-click a selection for its actions: a face offers Sketch, Normal To, Export Face as DXF, Fillet and Chamfer;
an edge offers Fillet, Chamfer (started with that edge) and Reference Axis; a vertex offers Reference Point.
Faces, edges and bodies also offer **Body Properties** and **Export Body as STEP** for the body they belong to.

## Bodies

A part can contain several **solid bodies**. A boss that doesn't touch the existing material makes a new body;
untick **Merge result** in an Extrude or Revolve (or an import) to keep it separate even where it touches.
A cut that slices a body in two leaves two bodies. Fillets, chamfers, patterns and mirrors work on bodies as usual.

- The **Solid Bodies(n)** folder at the top of the Feature tree lists the bodies. Click one to select and
  highlight it; double-click (or right-click ▸ Rename) to name it. Unnamed bodies are called after the last feature
  that changed them.
- Right-click a body in the tree, or on the model, for **Body Properties…** and **Export as STEP…**.
- **Body Properties** holds the body's name, **material**, description and any number of **custom properties**
  (name/value pairs such as part number or finish), and shows the body's own mass, volume, area and center of mass.
- **Materials:** a body set to *Use part material* follows the part material (the Material item in the tree). A
  body given its own material keeps it when the part material changes, and is drawn in that material's colour.
  Mass Properties adds up every body with its own density and lists the bodies.
- Bodies are identified by the feature that created them, so names and materials stay attached when you change
  dimensions or features.

## Sketching

**Tool wheel:** while sketching, press and hold the right mouse button. After a moment, or as soon as you start to drag,
a wheel of sketch tools appears around the pointer. Keep the button held, move toward a tool (it highlights), and release
to activate it. Releasing in the center or pressing Esc cancels. A quick right click still opens the right-click menu.

Sketches are made of points, lines, arcs and circles held in place by **relations** and **dimensions**.
A numerical constraint solver keeps them satisfied. Geometry is **blue when under defined** and
**black when fully defined**. The Property panel shows the remaining degrees of freedom.

| Tool | Notes |
|---|---|
| **Line** (L) | Click a chain of points. Coincident, horizontal and vertical relations are added automatically. Snapping to a line's midpoint or onto a curve adds those relations too. Double-click, Enter or Esc ends the chain. |
| **Centerline** | Construction line, for symmetry or as a revolve axis |
| **Corner / Center Rectangle** (R) | Built with H/V relations; the center rectangle also adds construction diagonals with a midpoint relation |
| **Circle** (C), **Centerpoint Arc** (A) | The arc direction follows the mouse |
| **Straight Slot**, **Polygon** (P) | Built with tangent / equal relations; set the polygon side count in the Property panel |
| **Dimension** (D) | Click a line, circle or arc, or two entities, then click to place. Moving the mouse switches between horizontal, vertical and aligned. Two lines give an angle; a point and a line give a perpendicular distance. Values accept equations (`width/2`). A dimension that would over-define the sketch is added as a driven (reference) dimension. |
| **Trim** (T) | Power trim: hover over a segment and it highlights red; click to remove it up to the nearest intersections. Lines are shortened or split, circles become arcs, and the new end points get on-curve relations. |
| **Offset** (O) | Click a line, arc or circle: its whole connected chain is offset. You can also click a **model edge** (with *Select chain*, the connected edges lying in a plane parallel to the sketch, e.g. a face outline) or a curve of another sketch. Move the mouse to the side and distance you want and click, then type the exact distance. Corners are re-trimmed or extended. In the Property panel choose **Linked offset** (the offset follows its source, including model edges when the model changes, and one dimension drives the chain; relation "Offset ⇉") or untick it for a **single offset** (plain geometry, no link). |
| **Project Edges** (E) | Click a model edge, or an entity of an earlier sketch, to project it into this sketch. Projected geometry is *linked*: it updates when the source changes (relation "On Edge ⇲"). |
| **Construction Geometry** (Q) | Toggles the selected curves to or from construction geometry (ignored by features). Construction geometry is drawn dotted. |

**Circles and arcs:** dimension from a circle or arc to another circle, arc, point or line by clicking both. The
Modify box then offers **Center** (center to center), **Min** (nearest arc to arc) and **Max** (farthest). Min also
measures the gap between concentric circles, so offset arcs can be dimensioned. Switching the condition keeps the
geometry where it is and shows the newly measured value.

**Dimension to outside references:** while dimensioning, you can also click model edges, model vertices
or entities of earlier sketches. RazorCAD creates linked construction geometry for the reference and dimensions to it,
so the dimension follows the model. For example, "keep this hole 25 mm from the right edge" still holds after a width change.
The mouse pointer shows a dimension badge while Dimension is active, and similar badges for Trim and Convert.

### Relations
Select entities (Ctrl+click for several). The Property panel then lists the relations that apply:

| Selection | Relations offered |
|---|---|
| 1 line | Horizontal, Vertical, Fixed |
| 2+ points | Coincident, Horizontal, Vertical |
| 2+ lines | Parallel, Perpendicular, Collinear, Equal, Horizontal, Vertical |
| point + line | Coincident (on line), Midpoint |
| point + circle/arc | Coincident (on curve) |
| line + circle/arc | Tangent |
| circles/arcs | Equal, Concentric, Tangent |
| 2 points + line | Symmetric (about the line) |
| 3 lines | Symmetric (two lines about a centerline) |

Relations are shown as small green glyphs next to the geometry (toggle with **Display Relations**).
Click a glyph to select it, then press Delete to remove it. Hovering a glyph highlights the entities it ties together.
Relations that are redundant or conflict with existing ones are refused with a message.
Ctrl+Z / Ctrl+Y undo and redo inside a sketch.

Profiles are found automatically from all non-construction geometry and sent to the kernel as exact lines,
arcs and circles. Intersections are split, dangling lines are ignored, and nested loops become holes.
A full circle (or arcs that together make one) becomes a single closed curve, so an extruded circle has one
continuous cylindrical face. Faces that lie on the same surface are merged after extrudes, revolves, fillets and
chamfers. Seam edges, where a closed surface such as a cylinder, cone or fillet ring meets itself, are not drawn
and can't be picked.

## Features

**Previews:** while a feature's Property panel is open, the model is rolled back to just before that feature
and the feature is shown in colour: **yellow** for material it adds and **red** (seen
through the body) for material it removes. Fillets and chamfers show the material they add or shave off,
and reference geometry being edited is drawn in orange. Click ✔ to finish the feature.

- Extrude and Extrude Cut: Blind, Mid Plane, Through All, Through All – Both,
  **Up To Vertex** (click a model vertex or choose a reference point), **Up To Surface** and
  **Offset From Surface** (click a flat model face or choose a plane; angled surfaces are supported, and
  the extrusion is trimmed to the surface)
- Revolve and Revolve Cut, about the sketch axes or any line in the sketch (e.g. a centerline)
- Linear Pattern, Circular Pattern, Mirror. Pattern directions and the circular pattern axis can be X/Y/Z or any
  reference axis. A reference axis can also be the axis of a Revolve.
- **Reference Plane**: pick up to three references (faces, edges or vertices on the model; planes in the view;
  planes, axes or points in the tree) and the plane type follows:
  one plane/face → **offset** (distance, flip); two planes/faces → **mid plane** (halfway between parallel
  faces, or the bisector of angled ones); plane/face + edge/axis → **through the edge at an angle**
  (with Parallel 0° / Perpendicular 90° buttons); edge/axis (+ optional point) → **normal to the edge**
  (at its start, middle, end or the point); plane/face + point/vertex → **parallel through the point**;
  three points/vertices → **through three points**. Click a reference again to remove it.
- **Reference geometry**: **Axis** (two planes, two reference points, a straight or
  circular model edge, or a sketch line) and **Point** (coordinates that accept equations, a model vertex, an arc
  center or an edge midpoint). Axes are drawn as dashed lines and points as markers, and both follow the model when it changes.
- **Fillet** and **Chamfer**: open the feature and click edges on the model. The model is rolled back to just before
  the feature so every edge is pickable; tick **Preview** to see the result. Radius/distance accept equations.
  Edges are remembered by type, direction and position, and re-found after parameter changes
  (e.g. the sample part's fillets survive changing `width`). When a fillet can't be added on top of earlier
  fillets (typically a corner where several blends meet), RazorCAD automatically recomputes it together with
  the preceding fillets in one operation, so the kernel builds the corner blend.
- **Shell**: click the faces to remove and set the wall thickness (inward, or outward). Where a fillet (or chamfer)
  is smaller than the wall, the shell still works: the outside keeps the fillet and the inside gets a sharp corner
  there (the shell is made from the body without those small blends and cut out of the real body).
- **Combine**: **Add**, **Subtract** or **Common** solid bodies. The first body clicked is the main body.
- **Split Body**: select solid or surface bodies, then a sketch, plane, model face or surface splitting tool. Extend the tool when needed; with a planar tool, keep all pieces or one side.
- **Split Face**: select faces, then project a sketch (normal or along a vector) or intersect a plane, face or surface. Creates face boundaries while preserving each body.
- **Move/Copy Bodies**: move (or copy) solid and surface bodies either by **coordinates** (ΔX/ΔY/ΔZ plus a rotation
  about X/Y/Z or a reference axis, through the axis or the bodies' center; copies repeat the step) or with **mates**:
  Coincident, Distance, Parallel, Perpendicular, Angle and Concentric between an entity of the moving bodies (face,
  edge, vertex) and fixed geometry (another body, a plane, axis or point). Use *Flip alignment* to turn a mate around.
- **Imported body** (STEP / STL), usable as a base for further cuts, bosses, patterns and (for STEP) fillets
- Equations / global variables, usable in every value field
- Section View (capped), Mass Properties with materials, display styles, standard views

## Surfaces

The **Surfaces** tab builds surface bodies (zero-thickness faces), listed under **Surface Bodies** in the tree:

- **Extruded Surface** and **Revolved Surface** sweep the sketch's curves; open chains are fine.
- **Planar Surface** fills a closed sketch.
- **Offset Surface** offsets faces of any body.
- **Knit Surface** sews surfaces together. When they enclose a volume, *Try to form a solid* turns them into a solid.
- **Thicken** gives a surface a wall thickness (one side or both) and makes it a solid.

Lofted Surface can also use **Model edges**: select the trimmed boundary edges made by Split Face, add each connected chain as a profile, then loft only those portions. Model-edge profiles currently use free ends and automatic correspondence without guides.

Surfaces can split solid or surface bodies (Split Body), and can be moved or copied. Cuts and Combine only act on solid bodies.

## Project layout
```
RazorCAD.exe              the application (built by build.bat)
razorcad.py               desktop shell: native window, file dialogs, autosave (pywebview)
build.bat                builds RazorCAD.exe with PyInstaller
serve.py                 development server for the UI
app/index.html           UI layout
app/css/style.css
app/js/main.js           application controller (document, commands, selection, files)
app/js/model.js          feature definitions, undo history, sample part
app/js/kernel.worker.js  geometry kernel worker: replays the history with OpenCascade, STEP/STL, edge references
app/js/kernelclient.js   main-thread client for the worker (coalesces rebuilds)
app/js/sketchmodel.js    sketch data, builders, exact profiles, intersections, trim, projection, migration
app/js/solver.js         geometric constraint solver (Levenberg–Marquardt) + DOF analysis
app/js/sketcher.js       sketch mode: tools, auto-relations, Dimension, relations, trim, convert
app/js/geometry.js       sketch-plane frames and mass properties
app/js/viewport.js       3D view, camera, face/edge picking, section caps
app/js/cadcontrols.js    CAD-style rotate / pan / zoom / roll
app/js/toolwheel.js      right-button sketch tool wheel
app/js/ui.js             menus, Command ribbon, Feature tree, Property panel, dialogs
app/vendor/              three.js, three-mesh-bvh, replicad + OpenCascade WASM (bundled for offline use)
tools/make_icon.py       generates assets/razorcad.ico
```

## Limitations and next steps
- **Only edges made by an extrusion are named by what made them.** Those (the edges of extruded bosses, cuts and
  pockets, without draft or thin walls) are found again by the sketch curve or point they came from, even when
  another edge comes to lie where they were. Other edges (from revolves, sweeps, lofts, fillets…) are re-found by
  geometry and the faces beside them, so a large or ambiguous change can lose one; the feature then shows an
  error so you can re-pick.
- **Sketches on model faces follow the face along its normal** (when the part gets taller, the sketch goes up with
  it), not across it, and a face is found again by geometry like edges are. Sketches on faces from before
  version 0.20.1 stay where they are until they are put on the face again (Change Sketch Plane).
- **Snapping and dimensions to other sketches only see visible sketches** (not ones absorbed into features);
  Project Edges and Intersection Curve see those too. All of them see only sketches earlier in the history.
- **STL bodies with more than about 2,500 faces can't be filleted or chamfered**, and they don't offer pickable
  edges. Booleans on them work but are slower.
- **A fillet can't blend across two separate bodies that only touch.**

## License
RazorCAD is free software: you can redistribute it and/or modify it under the terms of the
[GNU General Public License v3.0](LICENSE) or (at your option) any later version. It comes with
no warranty. The parts, assemblies and drawings you make with RazorCAD are yours; the license
does not cover them.

RazorCAD includes third-party libraries under their own licenses (Open CASCADE under the LGPL-2.1,
replicad, three.js and others under MIT); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
