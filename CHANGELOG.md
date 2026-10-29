# RazorCAD changelog

Newest first. Each entry is stamped with the date and time (local time, NZDT) the change was built into RazorCAD.exe.
Entries before 2026-10-13 21:00 were reconstructed from the development log; later entries are added as each change is made.
Detailed status of the change-request documents: `Change requests\Progress.md`.

---

## 2026-10-29 22:49 — A feature that fails is not added to the tree

- ✔ on a feature that fails (no edges picked, a depth of 0, a shape the kernel can't make…) no longer adds it to
  the feature tree with an error: a dialog says why, and the panel stays open to put it right or ✕ to cancel. An
  edit that makes a feature fail is not kept either. Suppressed features are accepted as before.
- Tests: failing-feature-refused.

## 2026-10-29 22:46 — Structural Member: profiles face the same way round a frame

- Fixed: a member whose sketch line was drawn the other way round from the rest had its profile turned 180°
  (a channel in a U frame facing the wrong way). Along a chain of members every member now runs the same way (the
  way most of its length runs), so a channel or angle faces the same way round the whole frame.
- Fixed: in a frame standing up (a sketch on an upright plane) the upright members were turned 90° from the level
  ones. Every member's height now lies in the frame's plane, square to it, and each profile faces the same side
  out of the plane.
- Tests: member-orientation (tests/member-orientation-cases.js), a U of 75 PFC and a rectangle, flat and standing.

## 2026-10-29 22:11 — Lofted Bend: flanges with bolt holes

- **Flanges** group, as on a Transition: a flat bolting ring at the first and/or second profile, a flat sheet metal
  plate of its own out past the profile's plane (away from the other profile), round the profile with its gap
  closed straight across. Its opening is the inside of the part there (the profile, or the profile less the
  thickness when the material is inside it); width, thickness, hole diameter and the most the holes are apart are
  set. Holes at each corner of a line round the middle of the flange and evenly between. Profiles in a sketch,
  or a 3D sketch that lies flat.
- Tests: loft-flanges (tests/loft-flange-cases.js), by hand for either material side.

## 2026-10-29 21:53 — Transition / Reducer: flanges with bolt holes

- **Flanges** group: a flat bolting ring at the bottom and/or top end, each a flat sheet metal plate of its own
  (its flat pattern, holes and all, goes with the parts' for cutting), out past the end by its thickness. Its
  opening is the inside of the part there; width, thickness and bolt hole diameter are set. A round flange has
  its holes evenly on a bolt circle (the middle of the flange, or a diameter set), straddling X; a flat-sided one
  at the corners of a line round the middle of the flange and evenly along each side, at most a set distance apart.
- Tests: transition-flanges (tests/transition-flange-cases.js), each flange against its volume by hand.

## 2026-10-29 21:46 — Edges named by the extrusion that made them

- An edge picked for a fillet, chamfer or other feature that an extrusion made (a boss, cut or pocket from a
  sketch, without draft or thin walls) is named by the sketch curve it runs along and the level along the
  extrusion it is at (first, last, or its number), or the sketch point it runs from. After a change it is looked
  for by its name first: a fillet on one of several bosses from one sketch stays with its boss when the circles
  are moved, even when another boss comes to its old place. Other edges, and names that do not settle it, are
  found by where they were, as before. Names are added to a part's edges the first time it is rebuilt.
- README and manual: the limit on edge references changed to say which edges are named.
- Tests: edge-names (tests/edge-name-cases.js).

## 2026-10-29 21:41 — Sketches on model faces follow the face

- A sketch put on a flat face keeps the face (the point clicked on it and its normal). When the model changes so
  that the face moves, the sketch moves onto it along its normal, and what is built from it follows. The face is
  found again as fillet edges are (by direction and by where it was in the part, with the part's box to scale by).
  A face that is gone leaves the sketch where it was, with a note. Sketches on faces from before keep only their
  plane: Change Sketch Plane puts them on the face again.
- README and manual: the limit on sketches on faces changed to say so.
- Tests: face-sketch-follows (tests/face-sketch-cases.js).

## 2026-10-29 21:35 — 3D Print: printer bed sizes from the makers' own pages

- The Print Profile dialog's printers: every size but the Bambu Lab X1C's is now confirmed on the maker's own page
  or store, so the dialog no longer asks you to check them. The Bambu Lab H2D has the size one nozzle prints
  (325 × 320 × 325 mm), not the two nozzles' together.
- New in the list: Bambu Lab P2S, X2D and H2S, and Creality Ender-3 V3 Plus.

## 2026-10-29 19:48 — 3D sketches picked in the view for references, thin lofts and connectors on 3D profiles

- **Reference Axis**, **Point** and **Plane**: a click on a 3D sketch's point picks it, and for an axis a click on its
  line, circle or arc; picked ones are drawn orange. Earlier 3D sketches show while a reference is being made.
- **Loft**: a thin loft takes 3D sketch profiles (the solid loft's walls, square to its sides, sharp at the corners),
  and manual connectors attach to a 3D sketch profile's points or its circle's seam angle, from the panel or a click.
- Fixed: a loft from a 3D sketch profile that is not flat (a saddle) was left open at its ends, so it was a shell and
  not a solid; its ends are now closed (a surface through a profile that is not flat) and it is sewn into a solid.
- README: its list of limits brought up to date (Feature Scope limits cuts; Project Edges sees absorbed sketches).
- Tests: tests/test-weights.json counts the two newest tests (their GitHub times estimated from a local run, scaled by
  the median ratio of the other tests' times there and here, until the next refresh from a GitHub log).

## 2026-10-29 18:10 — 3D sketches for holes, bosses, patterns, helices, axes, lofts and runners

- **Hole**, **Boss**, **Snap Hook**, **Nut Pocket**, **Insert Hole** and **Screw Hole for Plastic** take a 3D sketch's
  points: each on a face of the part, the feature square to that face, so one 3D sketch places them on several faces,
  flat or curved.
- **Sketch Pattern** copies to a 3D sketch's points; **Helix** takes a 3D sketch's circle; **Reference Axis**, **Point**
  and **Plane** take a 3D sketch's lines, circles, arcs and points one by one; **Loft** takes a closed 3D chain as a
  profile (curved out of a plane, like a saddle); **Lofted Bend** an open 3D chain as an edge; **Sprue and Runners**
  a 3D sketch's lines. Each lists 3D sketches in its panel, and a click on one in the tree picks it.

## 2026-10-29 17:43 — Transition / Reducer on a 3D sketch line

- **Transition / Reducer** takes its axis from a line in a 3D sketch too: pick the 3D sketch in the panel or the
  tree, or start the tool while editing it. X is level, square to the line (the model's X axis when the line is
  upright), and Y points toward the top.

## 2026-10-29 16:59 — Tests: about 15 minutes on GitHub, and steadier

- The regression tests on GitHub run on 6 machines side by side (`run_tests.py --shard`), some 15 minutes instead of
  an hour; a release runs them once (the Tests workflow's), not twice.
- Tests no longer see what an earlier test left: marks on the model are cleared before each one, Rotate about the
  cursor sets its own view, and the surface curvature test starts its worker again if it stops without a result.

## 2026-10-29 14:09 — Version 0.20.0-beta
- Installer, user manual (113 pages) and website for 0.20.0-beta.
- Fixed: Check Printability's and DFM Check's numbered marks stayed on the screen when another part came to the front.

## 2026-10-29 08:46 — The 3D Print tab, and limits lifted (spline intersections, curved reference points, outward shells, G2 rings, loft connectors, freeform on any face, dished ends)

- **3D Print tab**: print profiles (printer and material: bed, nozzle, layer, overhang limit, bridge, clearances and
  fits, density; PLA, PETG, ABS and resin to start from, copies of your own), the build orientation (**Place on Bed**,
  **Auto-Orient** by least support, **Show Bed**), **Check Printability** (overhangs, bridges, walls, small holes and
  pins, closed hollows, bed contact and fit, warping, the support estimate, mass and filament; numbered on the model),
  **Overhang Map** and **Thickness Map**, **Export for Printing** (3MF or STL, laid out on the bed) and **Open in
  Slicer**.
- **Printer** in Print Profile: the bed from a list of 14 popular printers (Prusa, Bambu Lab, Creality, Elegoo,
  Anycubic); the sizes not confirmed on the maker's own page are marked to check.
- Print features: **Nut Pocket** (and captive slots), **Insert Hole**, **Screw Hole for Plastic**, **Printable Hole**
  (teardrop or flat top), **Bridging Layer** (steps or a skin), **First-Layer Chamfer**, **Printable Overhangs** (rounds
  facing down to 45° chamfers), **Fit Clearance**, **Print-in-Place Hinge**, **Split for Printing** (with dowel holes),
  **Calibrate Fits** (a test piece, the fits kept in the profile). A new manual chapter: Designing for 3D Printing.
- Limits lifted: Intersection Curve finds where a spline crosses the sketch plane; reference points where curved edges
  and faces meet; Shell hollows outward and has walls of their own thickness outward; G2 fillets on circular edges (a
  boss's foot or rim); lofts take several connectors per profile (a square's corners to a hexagon's); Freeform reshapes
  flat faces of any outline, with holes, and trimmed freeform faces; Convert to Sheet Metal lays a dished end (curved
  both ways) out flat as a blank, its stretch reported.

## 2026-10-29 06:12 — Version 0.19.0-beta
- Installer, user manual (107 pages) and website for 0.19.0-beta.

## 2026-10-29 05:46 — The k14 geometry kernel: exact defeaturing and STEP files with semantic PMI

- RazorCAD now ships the Kernel Lab's k14 kernel (k12, which it had, plus defeaturing and PMI; OpenCascade 8.0.1, both
  the single- and multi-threaded builds).
- **Delete / Resize Fillet**, **Defeature** and **Delete Face ▸ Heal** take faces out exactly: the faces round them are
  grown or shrunk to close the gap, so rounds that run into other rounds at a corner come out too. When the kernel
  cannot close a gap, the old way is used.
- **STEP export** writes datums, geometric tolerances and dimensions from the 3D annotations as semantic PMI (AP242), on
  the faces they point at; a STEP file with PMI opened in RazorCAD shows them as 3D annotations.
- Fixed with it: Delete Fillet refuses a face that is not a round or chamfer (a flat face, a hole's or a boss's side)
  instead of handing it to the defeaturing; Defeature counts a counterbored hole with its drill point as one hole, and
  says "fillets", not "fillet faces".
- The kernel's sources are in the repository: `tools/kernel/` has RazorCAD's two Open CASCADE patches, its own
  C++ additions, the build settings and scripts to build the same kernel again (`tools/kernel/README.md`), and
  `THIRD-PARTY-NOTICES.md` now says that Open CASCADE is modified, and how.
- Checked: the full suite (231 tests), the kernel probes (surface patches at 16, 32 and 128; guided lofts and hard
  cases, single- and multi-threaded, with the lifetime hooks), the defeaturing and PMI cases on one thread and on four,
  and the desktop window (a fillet deleted exactly, a STEP file written with its PMI).

## 2026-10-29 00:19 — The manual inside RazorCAD, freeform faces, G2 fillets, true-shape nesting, piping, ducts, moulds and more

- **The user manual inside RazorCAD**: Help ▸ User Manual, [F1] (at the feature being edited), the title bar's **?**
  or a Property panel's **?** open it in a panel at the right: search it, read a section with your words marked,
  drag its edge wider or narrower, close it (your files stay open). **⧉** puts it in a window of its own that can go
  onto another monitor; **⇤** docks it back. The command search (Ctrl+K) lists manual sections too.
- **Freeform**: a face pushed in or out by a grid of handles (dragged on the model), keeping contact, tangency (G1)
  or curvature (G2) at its edges. **Fillet ▸ Curvature continuous (G2)** on straight edges between flat faces.
  **Boundary Surface** tangent or curvature continuous to faces along its edges.
- **Nest Flat Patterns** by true outlines (parts into each other's gaps and holes, 90°, 45° or 15° turns).
- **Pipe Route** with tees and reducers and a **Spool Drawing**; **Duct Fitting** (elbows, cones, transitions,
  offsets, laterals) with flat patterns to DXF; **Harness Formboard** for cables.
- **Edit in Context** follows the assembly as it changes. **Render** with several passes (smoother edges).
- **Sheet metal forms**: beads, lances, embosses. **Moulds**: parting by a surface, side cores, sprue and runners.
- **Assemblies**: cam mate; clearance along a motion study; flexible sub-assemblies; Number Parts; Where Used.
- **Drawings**: broken-out sections; Compare With another drawing.
- **glTF (.glb) export**; **point clouds** (PLY, XYZ) with surfaces fitted to them.
- With the Kernel Lab's k14 geometry kernel (shipped in the entry above): exact defeaturing, and STEP files with semantic PMI
  written and read.

## 2026-10-29 00:08 — Edit in Context follows its own assembly when several are open

- A part edited in context brought its context bodies up to date from the first open assembly with a component of the
  same id (component ids such as c1 repeat from one assembly to another), so with two assemblies open it could follow
  the wrong one: the context stayed where it was, or a body went missing. The assembly now keeps an id of its own,
  stored with the context, and the part follows that assembly (context made before, or an assembly not saved since,
  still by the component).
- Test assembly-edit-in-context: another assembly with the same component ids open first; the part rebuilt before it is
  measured (it failed in the whole run, after other assembly tests).

## 2026-10-28 22:34 — Plastic parts and moulds, direct editing, library features, routing, in-context design, MBD, rendering, nesting, DFM and more
- **Patterns** with spacing and angle growing from copy to copy; **Table Driven Pattern** (x, y, angle rows, pasted
  from a spreadsheet). **Hole**: counterdrills. **Sheet metal**: bend tables by angle; **Nest Flat Patterns** on
  stock sheets (sets, turning, utilisation, one DXF).
- **Surface Extrude** drafts open contours; **Surface Revolve** goes up to a plane beside its axis.
- **Assemblies**: slot and path mates; component patterns and mirrored components; **Fasten All Holes**;
  **Edit in Context** (other parts as transparent reference bodies, left out where the part is used);
  **Positions**; **Collect Files** (the assembly and all its parts copied into one folder); a tolerance stack-up.
- **Plastic parts**: mounting bosses (draft, hole, ribs), snap hooks, lips and grooves, vents; **Core and Cavity**
  (parting at the largest section or a height, shrinkage); Thickness Analysis and Undercut Check.
- **Direct editing**: **Delete / Resize Fillet** (rounds, ring rounds, chamfers, convex or concave) and
  **Defeature** (fillets and holes up to a size, exactly).
- **Library features** (features with their sketches and variables, inserted on any plane or face); **linked sketch
  blocks** (rigid, follow the block, Explode Block); **sketch pictures** to trace over; **equation driven curves**.
- **Pipe Route** (DN15–DN300 or tubes, elbows or bends, flanges, pipes on the cut list) and **Cable** (bundles from
  their wires, cut length with slack).
- **3D annotations** (notes, toleranced dimensions, GD&T frames, datums, surface finish) on the model, carried in
  STEP as properties; **Tolerance Stack-Up** (worst case and RSS); **DFM Check** for machining.
- **Drawings**: alternate position views in phantom lines; general tables.
- **Render** (physically based looks per body, studio or sky light, floor shadow, PNG) and **decals**.
- **Revisions** of parts and assemblies, each keeping a copy to open again.

## 2026-10-28 20:48 — Face profiles, Revolve Up To, Surface Extrude ends and draft, Sweep scale, Loft and Patch by hand; Fillet, Shell, Hole, Pattern, sheet metal, mate and drawing options
- **Extrude / Revolve**: a flat model face can be a profile (holes and all, no sketch needed); the second side
  (or Two sides' second depth) can have a draft of its own; Revolve goes **Up To Vertex** or **Up To Surface** (a
  plane through the axis exactly, any other plane or face trimming the revolution).
- **Surface Extrude**: starts from an offset or a plane / face, ends up to a vertex or surface or offset from it
  (angled ones trim it), extrudes along an axis of its own, drafts closed contours, and takes model edges (open or
  closed chains) and flat faces as contours; **Surface Revolve** takes model edges and faces, and goes up to a vertex
  or a plane through its axis.
- **Sweep**: the profile scaled along the path to an end scale (evenly or eased, by the length along the path:
  checked to 1e-7 along a line and an arc, and on an unevenly parameterised spline), an eased twist, the profile
  kept square to faces the path runs on, and model edges as the path.
- **Loft**: a connector inside a curve (the profile gains a point there: a triangle lofted to a square without
  splitting the sketch), holes paired and started by hand, Thin lofts with connectors, CAD guide constraints with
  holes.
- **Filled Surface**: curves and points inside the opening it passes through (checked to 0.0001 mm), and a tangent
  reach for G1 edges.
- **Fillet / Chamfer**: full round, size by chord width, a size of its own for any edge, a face's edges in one
  click, vertex chamfers. **Shell**: walls of their own thickness, hollow bodies (no faces removed).
- **Hole**: up to next / vertex / surface and offset ends, a drill point angle, far-side countersinks, holes on
  curved faces (square to them), slots. **Patterns**: a total length, symmetric copies, the second direction for the
  feature only, instances to skip, circular rings.
- **Sheet metal**: bend allowance or bend deduction (for a 90° bend) as well as the K-factor; edge flanges along
  part of their edge (a width in the middle, or offsets from its ends).
- **Assemblies**: width, symmetric and screw mates; distance and angle mates with limits (free between a minimum
  and a maximum, held exactly at the one dragged past).
- **Drawings**: a hole table (tags, positions from the view's lower-left corner, sizes), section lines at an angle.
- 13 new tests: 143 kernel cases, each against exact or integrated geometry, 8 mate solver cases and the drawing's
  hole table and angled section, with the panels of each.

## 2026-10-28 16:43 — Extrude: a second side with its own end, drafts to and from angled planes, and Intersect
- **Second Side**: an extrusion with a one-sided end can go the other way from its start as well, to an end of its
  own (Blind, Through All, Up To Vertex, Up To Surface or Offset From Surface, with its own picker). It always goes
  the opposite way to the first side; an end on the first side's side of the profile is refused. Both sides share
  the start, the operation, Thin and the draft.
- **Draft to and from angled planes**: Up To and Offset From an angled surface now take a draft (the walls tilt
  about the profile and the angled end is trimmed with them), and so does a start on an angled surface (the walls
  tilt about it, so the profile's outline stays where the extrusion starts). Checked against the volumes
  integrated from the walls and planes (to 1e-6, the integration's own error; finer, 5e-7) and the corners where
  they must be; walls that would meet before the end are refused.
- **Intersect** (Extrude, Revolve, Sweep, Loft): keeps only the material inside the feature, in each body it
  overlaps (others stay as they are); with Feature Scope, a chosen body it misses is removed. Refused when it
  overlaps nothing, and in patterns and mirrors.
- New test `extrusion-sides-and-intersect` (21 kernel cases and the panel).

## 2026-10-28 16:11 — PCs with 2 or 3 processor threads: the open part's kernel on two threads
- A PC with fewer than 4 threads kept every kernel on one thread. The first part's kernel now gets two there (the
  others one; `machine.js` threadsPerKernel). Measured on this PC held to its cores, the 16 check-set parts:
  2 cores 18.2 → 12.8 s (edits 4.39 → 4.15 s), one core with hyper-threading 23.2 → 19.7 s (edits 5.52 → 4.89 s);
  the same geometry and meshes. Three threads on 2 cores were slower than two. The whole test suite passed with the
  browser held to one core and told it has 2 threads (426 s).
- Tried and left out: another memory allocator in the single-thread kernel (the same results, no quicker).

## 2026-10-28 13:08 — GitHub workflows on Node.js 24
- GitHub's build steps moved to the actions' Node.js 24 versions (checkout v5, setup-python v6, upload-artifact v6,
  cache v5): GitHub warned that the Node.js 20 ones are being retired. Only the runtime changes.

## 2026-10-28 13:08 — Browser version: the geometry kernel ready three times sooner on a first visit
- **One gzipped file a kernel**: the website sent each kernel uncompressed (25 MB, in two parts, fetched one after
  the other after two requests for a whole file that isn't there). It now publishes `replicad_*.wasm.gz` (7.9 MB,
  `tools/build_web_app.py`), which the kernel worker unpacks as it arrives and compiles while it downloads (and
  takes as it is from a host that sends it already unpacked).
- **The spare kernel waits**: the kernel started ahead for a second part downloaded the kernel at the same time as
  the first one (each at half the speed); it now starts once the first is ready, and gets it from the browser's cache.
- First visit, the kernel ready (a fresh browser, the website's own headers, 30 ms latency): 10 Mbit/s 46.9 → 11.5 s,
  50 Mbit/s 9.1 → 2.9 s, 100 Mbit/s 5.0 → 1.9 s (49.8 → 8.5 MB). The Windows app loads its kernel as before.
- Tried and left out: starting the kernel's download from the page, ahead of the app's scripts (the worker's request
  did not join it, so the kernel came twice).

## 2026-10-28 13:08 — Edits of parts with big imports twice as fast
- **An import's file sent once**: every rebuild sent the whole part to the kernel, imported files included (a
  342-body STEP: 18 MB, made into text, posted, read and made into text again by the kernel at each edit). Big feature
  data now goes to each kernel once and is named after that by a hash of its content (`kernelclient.js`
  packFeature; a kernel without it asks again). The stored feature states hold the name, not the file.
- **The picking index after the model is drawn**: it was rebuilt for the whole model before the model was shown;
  now just after (picks until then take the plain search, with the same hits).
- **Identical-body signatures kept**: bodies meshed as before keep their signature (by the kernel's mesh key).
- An edit of the 342-body part in the app, kernel to screen: 1,618 → 769 ms (kernel 681 → 524, the trip to and
  from it 636 → 146, showing it 415 → 69 ms). Other parts: as before (their time is the kernel's work).

## 2026-10-28 13:08 — Extrude and Extrude Cut: Draft
- **Draft angle** and **Draft outward**: the walls tilt about the plane the extrusion starts from, narrowing away from
  the profile (or widening); the walls of holes tilt the other way, so the material keeps one taper and a drafted cut
  narrows as it goes in. Mid Plane, Two sides and Through All – Both draft each side away from the profile. Up To and
  Offset From a surface take a draft when the surface is parallel to the profile. Walls that would meet before the
  end are refused, including a cone through its tip (which OpenCascade leaves as a valid double cone).
- Test `extrusion-draft`: 14 cases against the exact volumes of their frustums (square, circle, a square with a hole,
  cuts, both sides, offset start, rejections) and the panel's fields. From Claw267's list of open differences
  (`Manual/cad-behavior-alignment.md`, updated).

## 2026-10-28 12:19 — Version 0.18.2-beta
- Installer, user manual (94 pages) and website for 0.18.2-beta.

## 2026-10-28 11:16 — Measure: a face measured again answers at once
- Measure worked out a face's exact area (shown with it) every time the face was measured: 174 of 176 ms on a
  guided loft's B-spline patch. The area is now kept with the face, so only the first measure of a face pays for
  it: 20 point-to-face measures on one patch 3.5 s → 0.09 s, with the same distances and points.
  `loft-cad-guide-constraints` (101 measures) 24 s → 6.6 s.

## 2026-10-28 11:12 — From Claw267's pull requests #7, #8 and #9: automatic parallel and collinear relations, a steadier updater, STEP products with their own geometry
- **Sketching (#7)**: with automatic relations on, Line and Centerline infer **parallel** and **collinear** from
  other lines in the sketch (construction and projected lines too): the reference line is highlighted and a click
  keeps the relation. Starting near a line's extension snaps onto it. **Project / Intersect: Projection Source**
  limits picking to one earlier sketch or to model edges when several overlap in the view.
- **Updating (#8)**: the update waits until every copy of this RazorCAD has closed (the one-file program's launcher
  can outlive it), checks that the new program was really installed (its version) before starting it again, and
  says why when it fails, with a log in `%TEMP%\RazorCAD-update`. A fix to the updater works from the update after
  the one that brings it.
- **STEP assemblies (#9)**: a product with both its own solids and child components keeps its own geometry, as a
  part inside its assembly (it was left out).

## 2026-10-28 11:09 — Browser version: never an older cached kernel after an update
- The browser keeps the kernel's files a day (and so, for a while after a deploy, did the website's cache): after an
  update the new kernel worker could get the older kernel, and parts didn't build (0.18.1-beta's site check saw it:
  the multi-threaded kernel on 1 thread, the test part failing; the single-thread kernel didn't start). The worker
  now asks for the kernel's script and files by the kernel's signature (`?k=…`), its thread workers too (the
  multi-threaded loader starts them from its own address: `tools/patch_surface_kernel_loader.py`), so a cached
  file of another version is never used. Checked with a server that hands out an older kernel to unversioned
  requests: 0.18.1-beta's browser version fails there, this one builds with both kernels.
- `tools/patch_surface_kernel_loader.py` reads and writes UTF-8; `tools/native/run_loft_probe.py` fails loudly if the
  worker's kernel lines change, instead of testing the wrong kernel.

## 2026-10-28 10:01 — Version 0.18.1-beta
- Installer, user manual (93 pages) and website for 0.18.1-beta. The manual's kernel paragraphs (threads per kernel, how the kernels are built and published) brought up to date.

## 2026-10-28 08:55 — PCs with 4 or 5 processor threads: the open part's geometry kernel multi-threaded
- On a PC with 4 or 5 threads the first part's kernel now runs on all threads but one (it was the single-thread
  kernel below 6); the other kernels (more parts, assemblies, drawings) keep one thread. Held to 4 threads, one a
  core: the check set's full rebuilds 16.3 s → 9.2 s, edits 3.8 s → 2.8 s (the golf ball 5.8 → 2.6 s); on 2
  cores with 4 threads 17.7 s → 11.7 s. The same geometry and meshes (compared to the last digit); the test suite
  passes run as a 4-thread PC.

## 2026-10-28 08:37 — RazorCAD starts reliably on PCs with few processor threads
- **Start-up**: the desktop app's own web server let at most 5 connections wait, and Windows refuses the next ones;
  the window asks for RazorCAD's hundred or so script files at once. On a PC with 4 processor threads, busy
  compiling the geometry kernel, a start now and then got no part and no kernel (held to 4 threads here: 5 starts
  in 10 failed, 1 in 4 with 40 s to start). It now lets 128 wait: 10 starts in 10. `serve.py` the same.
- `tools/native`'s probes read and write their text files as UTF-8 (on Windows they read the worker with the
  system's code page and failed).

## 2026-10-28 08:00 — Guided lofts with CAD guide constraints built up to 16 times faster
- **The final guide check** of a loft with CAD guide constraints measured every check point (65 or more on each
  guide) against every face with OpenCascade's general distance search: 16 of 17 s on a tight G2 spline loft. A
  point now passes as soon as it is shown to be within 0.0001 mm of a face: first against the faces' edges (the guide
  points lie on the seams; each edge's own tolerance is added), then by the local search on the face; only the rest
  get the general search, as before, so a loft passes or fails as before. The tight G2 spline lofts of the hard-case
  tests: 16.1 s → 1.0 s and 16.7 s → 1.0 s (multi-threaded), about 52 s → 3.6 and 6.5 s single-threaded; a
  curved circular one 3.2 s → 0.4 s. `loft-g2-difficult-guides` 57 s → 20 s.
- **Lofts with guides and end conditions** (Adaptive approximation) skip faces far from each check point by their
  quick boxes, not their precise ones (a quick box holds its face, so no face the precise box keeps is skipped).

## 2026-10-28 07:42 — Tests: Midpoint Line and drawing in construction mode
- `midpoint-line-construction` draws a Midpoint Line by clicks (the other end mirrored, a Midpoint relation), then turns Construction Geometry on with nothing selected and draws a Midpoint Line and a rectangle as construction geometry (requests on discussion #4).

## 2026-10-28 07:37 — Site check: a kernel published in parts
- `tools/check_site.py` checks `replicad_multi.wasm.part0` when the kernel is published in parts (it failed on 0.18.0-beta's push, with the site working).

## 2026-10-28 07:09 — Version 0.18.0-beta
- Installer, user manual (93 pages) and website for 0.18.0-beta.

## 2026-10-28 06:55 — PR #6's later commits: G2 loft ends and patches, sketch offsets, shared Extrude/Revolve selection, reference constraints, planes along paths

Merged from Claw267's pull request #6 (16 more commits):

- **Loft and Lofted Surface**: G2 (curvature) at the ends against adjacent support faces, also with a compatible
  guide; **loft connectors** between the profiles that can be edited (start point, seam and direction) and are kept
  with the part.
- **Filled Surface**: G0, G1 or G2 for each boundary edge, checked on the finished faces; an option to pick a
  connected chain of boundary edges; support faces picked where an edge has two.
- **Planar Surface**: sketch regions (with their holes), individual sketch entities, or closed loops of model edges.
- **Extrude and Revolve, solid and surface**: one way of picking profiles, axes, directions and operations; two
  sides with their own depths or angles; Join, New body or Cut with a target body; an extrusion can start at an
  offset or from a reference surface.
- **Sweep and Surface Sweep**: profile, path and guide picked in the view, each with its own chain selection.
- **Sketching**: offsets of chains with splines, on one or both sides, kept parametric; tangency where a line and a
  spline meet; regions split by internal curves can be picked.
- **Reference planes, axes and points**: shared constraint definitions (up to three references, alternative
  solutions); planes and points at a distance along a sketch or model curve; a reference plane is drawn centred on
  the geometry that defines it, and sketch entities are listed one by one in its selectors.
- **Sketch tools** remember the variant used last (split buttons).

## 2026-10-28 06:50 — A faster geometry kernel (the Kernel Lab kernel)

- **Both geometry kernels rebuilt from source**: OpenCascade 8.0.1 with two speed fixes (the same results), a newer
  WebAssembly toolchain with whole-program optimisation, and PR #6's guided-surface code built in from its source.
- **Measured on 16 test parts** (Windows, against 0.17.4-beta's kernel): full rebuilds with the multi-threaded kernel
  14.2 s → 4.7 s, edits 5.5 s → 2.4 s; with the single-thread kernel 24.5 s → 13.6 s and 13.5 s → 3.5 s.
- Faces are meshed and read in parallel, sheet-metal folds are remembered between rebuilds, and picking a face
  checks the nearby ones first.
- **Cone and torus faces** are recognised as such (for mates and measuring).
- The browser version publishes each kernel in two parts (the website's host takes files up to 25 MiB).

## 2026-10-27 16:55 — The rest of PR #6: a geometry kernel with guided-surface tools, loft end conditions, guide constraints, extrude profiles picked in the view, Shell checks

Merged from Claw267's pull request #6 (the sweeps and the updater came in earlier today):

- **Geometry kernel rebuilt** (replicad_single / replicad_multi, the same OpenCascade with a small native addition,
  `tools/native/surface-patch.cpp`; how to rebuild it: `tools/native/README.md`). It adds patches built on guide
  networks and a quick local nearest point on a face, used by the features below. Everything else builds as before
  (the whole test suite, and the sheet-metal checks against real parts).
- **Loft and Lofted Surface: Start and End Conditions**: Free, Normal to profile, a Direction, or Tangent to adjacent
  faces (G1, faces picked in the view), with an Influence and Reverse; holes and Thin walls included; guide curves
  with them use Adaptive approximation.
- **Loft guide construction → CAD constraints (two profiles)**: the guide edges themselves bound the patches, with
  C0, G1 or G2 across the guide seams (checked to 0.0001 mm and 0.5°).
- **Guided lofts are checked against their guides** on the finished surface, with more sections added (16 to 128)
  until every sampled guide point is within 0.01 mm; otherwise an error asks for a profile near the tightest bend.
  The check measures each point against the loft's edges first (guides mostly run along them), which keeps it quick:
  the tutorial's guided loft builds in 0.6 s (4.7 s measured against the faces alone).
- **Extrude: profiles picked in the view** as for Loft: click inside closed regions or on contours, several coplanar
  ones from different sketches, a ring or the disk inside it; open contours make it Thin. Clicking a sketch in the
  tree takes all of it; parts made before extrude as they did.
- **Shell** checks the solid it makes and refuses an offset that just returns the original body; small fillets
  outside a thinner wall are kept with sharp corners inside (the note says so).
- **Midpoint**: one relation button for a point on a line's midpoint and for two lines' midpoints together.
- Measure between a point and a face uses the quick nearest point when it lands on the face.
- Tests: loft-cad-guide-constraints, surface-cad-guide-constraints, surface-differential-analysis,
  surface-guide-continuity, shell-valid-cavity, loft-end-guides-and-walls, loft-end-conditions,
  loft-guide-edit-regeneration, loft-g2-difficult-guides, extrude-contour-references, extrude-canvas-selection, and
  a stricter loft-guide-accuracy (with example parts in tests/data). The whole run takes about 85 s here (40 s
  before); GitHub's test job may now run up to 90 minutes.

## 2026-10-27 16:09 — Sweeps: a guide curve, Parallel orientation and a twist; the updater waits for RazorCAD to close (from PR #6)

From Claw267's pull request #6, taken on its own (without its rebuilt geometry kernel, the loft end conditions, the
loft guide constraints, extrude contour selection or the shell changes):

- **Sweep and Swept Surface: Guide (optional).** A second curve (sketch chain, 3D sketch, curve or helix) the profile
  follows. **Guide controls → Orientation** turns the profile to keep facing the guide at its own size; **Section
  size** scales it evenly so its edge stays on the guide (the guide starts on the profile's edge). The guide's
  contact is checked to 0.0001 mm, and geometry that doesn't fit gives an error rather than an ordinary sweep. A
  guided solid sweep takes one closed profile without holes or Thin; a swept surface takes an open or closed one.
- **Orientation**: Perpendicular to path (as before) or **Parallel to initial profile** (moved along the path without
  turning). **Twist angle** (with Perpendicular): the profile turns by the total angle along the path, evenly by
  distance (equations allowed; 0 is the usual sweep; needs an open path with no sharp corners).
- The panel names the fields Profile, Path and Guide in the view while the sweep is edited; a sketch clicked in the
  tree goes to the field last clicked, and the three can't be the same curve.
- **Updater**: the helper that runs the setup now waits (up to 2 minutes) for RazorCAD to close before installing,
  and the restarted RazorCAD unpacks the new version instead of reusing the old one's files. If the helper can't
  start, RazorCAD says so and stays open.
- Tests: sweep-orientation-and-twist, sweep-path-guide, surface-sweep-path-guide (with their case modules and example
  parts in tests/data), and tests/test_updater.py, now part of the whole run (`--only updater` on its own).

## 2026-10-27 06:32 — Tests: the sheet-metal tray's measure time limit fits GitHub's runner

- convert-sheet-corners checks that the tray's exact measure stays quick: 0.15 s on a desktop, 16 s before it was
  integrated span by span. GitHub's runner took 4.5 s (over the old 3 s limit) while everything else passed; the
  limit is now 10 s, which still catches the slow measure.

## 2026-10-27 05:51 — Tests: the variable-fillet point drag waits for the edges on slow machines

- The fillet-point-drag test (failing on GitHub's Windows runner, which runs the suite far slower than a desktop) now
  waits until the model shown for editing has its edges before it drags the point, and until the rebuild after the
  drag is done; it reports a failure in words instead of stopping with an error when the point is not found.

## 2026-10-26 21:14 — Version 0.17.4-beta
- Installer, user manual (85 pages) and website for 0.17.4-beta.

## 2026-10-26 14:38 — Developed sheets: the neutral layer on the inside of each face's curve
- Convert to Sheet Metal of a developed sheet (a square-to-round, a cone, a twisted strip) puts the neutral layer K·t from the inside of each curved face, found face by face: a square-to-round's cone and the bends of its rims curve opposite ways, and one side for the whole sheet put the layer on the wrong side of one of them, so the K-factor could not fit such parts. A face curving both ways along it keeps its overall side, as before; a point between faces curving opposite ways takes the mean.
- Checked on real parts from another CAD program: two square-to-rounds that differed now match it at K 0.27 (the K-factor those jobs used); 128 of 167 parts match (126 before), none worse. Tests: the regression suite (unchanged); the real parts are checked outside the repository.
- Tests: standard-parts-2 sets its view at once (the hole's end facing the camera is the one used).

## 2026-10-26 14:00 — An experimental Linux build
- `build_linux.sh` builds RazorCAD for Linux (`dist/RazorCAD`, and an AppImage with a desktop entry and the .rcad / .rasm / .rdrw file types when appimagetool is installed). The same app runs in WebKitGTK (or Qt WebEngine) through pywebview; on Linux its data folder is `~/.local/share/RazorCAD`.
- A **Linux build** workflow (started by hand from the Actions tab) builds the AppImage on Ubuntu and smoke-tests it in a virtual display: it starts and the geometry kernel gets ready.
- razorcad.py: the window engine and data folder chosen per system (Windows unchanged); file types are registered by the desktop entry on Linux.

## 2026-10-26 13:42 — Feature folders, and patterns of them
- Group features in the tree: right-click a feature ▸ **Add to New Folder…**, **Move to** a folder or **Remove from Folder**. A folder sits where its first feature is, with its features under it (open or closed); right-click it to rename or delete it (its features stay), or for a **Linear / Circular Pattern of the Folder**.
- A pattern's **More features** takes folders: it copies what is in the folder at each rebuild (a feature added to the folder later is copied too; the pattern is built again when the folder changes).
- Test: feature-folders.

## 2026-10-26 13:37 — Sketch Fillet where a spline meets a line or an arc
- **Sketch Fillet** rounds a corner where a fit-point spline meets a line or an arc. The spline is cut back to where the fillet touches it (its fit points before that dropped; the touch point becomes its end, with its tangent handle along the spline there, so the shape further on stays as it was). The fillet is tangent to the other curve and to the spline (a new **Tangent (spline)** relation keeps the spline's end handle square to the fillet's radius) and gets a radius dimension. Two splines, and control-point splines, are not rounded yet.
- Test: sketch-fillet-spline (with a line and with an arc: R5, tangent to both, the far fit points kept, the sketch solves).

## 2026-10-26 13:31 — A Settings window
- **File ▸ Settings…** and **Tools ▸ Settings…** (in parts, assemblies and drawings): theme, language, toolbar icon size and the Sketch toolbar's layout (expanded, or grouped in flyout menus); the units and up axis of what is shown (and for new parts); your own sheet metal gauges, which can be deleted here; and DXF Settings, Customize Shortcuts, Customize Toolbars, Claude Settings and the tour. Each change applies at once. (A tester couldn't find the settings: they were spread over the View, Tools and Help menus.)
- Test: settings-window.

## 2026-10-26 13:23 — Assemblies keep their own up axis
- An assembly has its own **Y up / Z up**, kept with it like a part's: View ▸ Up Axis, the status bar, or right-click its **Origin** in the tree (Undo takes it back). The tree shows the standard planes' axes (Top Plane XY with Z up) and the Origin which is up; the triad follows. A new assembly starts with the up axis used for new parts.
- A STEP file exported from an assembly shown Z up is written Z up (its top-level components turned with it, as a part's export is).
- Test: up-axis-assembly (Z up from the Origin's menu, the tree and status bar, the STEP file Z up, undone).

## 2026-10-26 13:18 — Variable fillet points dragged along their edges
- While a variable fillet (radii at the vertices) is edited, each point along an edge is marked on the model: press on a mark and drag it along its edge. The point's place (% or mm) follows the cursor, the mark moves with it, and the fillet rebuilds when you let go. The cursor shows a hand over a mark.
- Test: fillet-point-drag (a point dragged from 50 % to the quarter point: 25 %, the fillet rebuilt).

## 2026-10-26 13:01 — Version 0.17.3-beta
- Installer, user manual (85 pages) and website for 0.17.3-beta. The manual's section on picking source sketches for Project and Intersection moved under Project Edges (it had landed after the revision history, which stopped the PDF building).

## 2026-10-26 12:40 — Contributions from Claw267 merged (pull request #5)
- Merged: parametric sketch patterns with a docked panel and live preview, draggable dimension labels with explicit placement, Equal Curve Length and Coincident Midpoints relations, Sketch Fillet between arcs whose ends meet, projected splines kept as splines and small arcs easier to pick, rename of underdefined sketches, grouped sketch tools and slot variants, spline tangent handles, parameter autocomplete and the parameter manager in the Sketch toolbar, origin axes coloured as the user's X / Y / Z, a test fix, loft profiles and guides picked directly on the model (contours or regions of a sketch), and earlier sketch curves picked for plane intersections and projection (entries above, by Claw267).
- The Lofted Surface's guide curves take the same picks as its profiles: whole sketches, contours of them, or curves.
- Test standard-parts: the view set at once (it picks the hole's end facing the camera, and a view left over from a sketch faced neither end).
- Fixed in the merge: the sketch results sent back an empty pattern list for every sketch, which changed each sketch after every rebuild (a macro recorded a step nobody made, and switching back to a part's tab rebuilt it instead of reusing its features); now only a sketch with patterns sends them.
- Merged with the reasons for refused relations: worked out before solving, so a relation that would over-define the sketch says so and names what is in the way; one already satisfied is an information message.

## 2026-10-26 12:27 — Feature suggestions and bugs from the discussion board
- **Patterns copy more than one thing**: Linear, Circular, Sketch Driven, Curve Driven and Fill Patterns and Mirror take **More features** besides their Feature, each copied the same way. The Linear, Circular, Sketch Driven and Curve Driven Patterns also take **faces** clicked on the model (each brings the feature that made it: click a hole's wall to copy the hole) or **bodies** (copied whole to every place as new bodies, flat patterns too); Mirror takes bodies.
- **Measure**: snaps to sketch points, the midpoints of edges and the centres of circles and arcs (each can be turned off), marks the point a click would pick as you move, numbers the items picked on the model, can **keep the first item** to measure from it to each next click, and lists the distances measured.
- **Relations refused say why**: already satisfied (naming the relations that define the geometry that way) or would over-define the sketch (naming the relations or dimensions in the way, e.g. two horizontal lines a dimension apart made collinear); those relations are selected.
- **Guided Loft follows its guides more closely**: 16 sections between each two profiles instead of 6. An S-shaped guide that the loft drifted 0.28 mm from is now followed to within about 0.05 mm (a report on the board measured up to 1.1 mm on another S guide).
- **Fixed**: a loft profile with a spline that had to be turned round to match the other profiles had its Bézier pieces' control points left the wrong way (a different shape; caught by a report on the board).
- **Fixed**: Lofted Surface said "The profiles must all be open, or all closed" for closed profiles whose ends missed by a little; a sketch profile is now closed when its sketch says so, a curve when its ends meet to 0.001 mm, and the message names the profile that is open and how far apart its ends are.
- Tests: pattern-sources, measure-snaps, relation-diagnosis, loft-guide-accuracy, loft-bezier-reversed, surface-loft-closed-check.

## 2026-10-25 11:47 — Guide curves (rails) for the Lofted Surface
- **Lofted Surface** has **Guide Curves**, as the solid Loft has: sketches (one chain of curves) or curves (3D sketches, composite and projected curves, helices) the surface follows between the profiles, each running from the first profile to the last through every profile. One guide pulls the surface along it; two or more shape it across, each where it touches the profiles. Open and closed profiles both, sketches or 3D sketches; not with straight (ruled) sides.
- A guide may now cross a profile anywhere along it (the solid Loft too): where the two meet is found between the points they are measured at, not only at them.
- Test: surface-loft-guides (two open straight profiles and two arc guides: the surface spreads out to the arcs and fills the area they bound, to 0.03 %; a closed one with one guide bulges out to it on that side only; ruled with guides: a message).
## Unreleased — Sketch source selection and plane intersections
- Project Edges and Intersection Curve temporarily display earlier source sketches, including hidden/absorbed ones, without altering saved visibility. Spline helper lines are excluded from external curve picking.
- Intersection Curve now selects individual sketch curves or model section chains. Lines, circles and arcs produce linked plane intersections; coplanar geometry is retained. Source edits refresh intersections independently of ordinary projections. Non-coplanar spline intersections are explicitly unsupported.
- Verified on the supplied Part1 document: circle intersections follow a diameter edit from 80 to 100 mm. Four browser tests passed, including mouse selection, duplicate prevention, linked updates, projections and loft selection.

## Unreleased — Loft contour and guide selection
- Loft and Loft Cut accept individual sketch regions, including holes, through direct canvas selection. Surface Loft accepts open or closed sketch contours. Separate profile/guide lists support automatic chains, manual segment groups, ordering, removal and numbered highlights; source visibility is preserved.
- References retain source sketch and curve IDs, track dependencies and report missing/ambiguous contours. Existing whole-sketch and supported 3D curve references remain supported. Guide interpolation and boundary continuity algorithms are unchanged; new G1/G2 boundary and Align to Surface controls are not included.
- Validation: 22 browser regression tests passed, including contour references, selected guides, canvas selection, existing guided lofts and sketch regressions. Real mouse selection of two sections and two guides also verified.

## Unreleased — Distinct tangent-handle graphics
- Fit spline tangent controls use solid teal stems, direction arrows and round grips; fit points retain their square markers. Selected, hovered and constrained controls retain their corresponding state colours.
- Selection labels identify tangent grips and tangent-handle lines explicitly. Native mouse dragging and the fit spline regression test verified after the visual change.

## Unreleased — Sketch tool families, slot variants and fit spline tangent handles
- Customize Toolbars now offers Expanded or Grouped Sketch layouts, saved as a preference. Grouped mode gathers line, rectangle, arc, spline and slot variants into flyouts while preserving the expanded toolbar's ordering and hidden tools.
- Midpoint Line creates a line symmetrically about the first click and retains a Midpoint constraint. For construction can be enabled before drawing, through the drawing panel or Construction Geometry with no curves selected; previews and created geometry follow the mode. Existing selection-based construction toggling remains available.
- Slots include centre-to-centre, centre-point, overall-length, centre-point arc and three-point arc variants. Shared layouts drive previews and creation; outlines keep tangent/equal relations, have no unused helper freedoms, survive undo/redo and form extrudable profiles. Invalid widths, collinear arc inputs and overlapping major-arc caps are rejected.
- New Fit Point Splines have cubic tangent direction/strength handles at every fit point. Handles are ordinary constraint-aware points with construction lines; their freedoms are included in definition status. Fit-point dragging carries its handle, and copies, mirrors, blocks, patterns, projections and serialization preserve the shape. Existing stored splines and the 3D sketch spline tool keep their representation.
- Tests: sketch-grouped-tools, sketch-new-drawing-tools, sketch-fit-spline-handles, plus 15 existing expression, constraint, projection, pattern and solid regression tests. Native mouse dragging and the user's existing neck model also verified.

## Unreleased — Parameter name completion in expressions
- Sketch dimension editing, linear/path and circular sketch patterns, and feature expression fields suggest matching Equations parameters with their evaluated values while typing. Completion replaces only the identifier at the caret, preserving surrounding arithmetic.
- Choose with Up/Down and Tab or Enter, or click an entry. Escape dismisses suggestions first; completing a name does not confirm a dimension or dialog. Numeric arrow stepping remains available when no suggestions are open.
- Test: expression-parameter-completion (keyboard/mouse, embedded formulas, live pattern preview, dimension confirmation and undo/redo, modal key handling and popup cleanup); native browser keyboard interaction also verified.

## Unreleased — Persistent projection of small sketch arcs
- Project Edges respects curve-only picking for source sketches, so nearby endpoints and arc centres cannot replace a small arc with a projected point.
- Explicitly projecting an existing automatic reference promotes it to persistent profile geometry instead of reporting that it is already present or duplicating it.
- Test: sketch-project-small-arc (click near vertices, promote a temporary reference, enter/exit the source unchanged, source translation and target reopening); spline projection and shared-endpoint regression tests also pass.

## Unreleased — Coincident sketch midpoints
- Select two line segments and choose Coincident Midpoints to keep their centres together without creating helper points. Works with construction lines and spline control-polygon segments, preserves lengths and directions set by other constraints, and survives save/reopen and rotated copies.
- Test: sketch-coincident-midpoints (selection UI, source edits, no extra points, undo/redo, serialization and conflict rollback).

## Unreleased — Equal on several control-polygon segments
- Adding relations to several selected entities now keeps the useful relations and skips ones already implied by existing constraints. Equal on all four oblique legs of an eight-control-point spline no longer fails because one pair is already Equal.
- Already-constrained pairs get an informational message; true conflicts still reject the entire request without changing geometry or constraints. A failed single relation refreshes annotation references after restoring the sketch.
- Test: sketch-equal-control-polygon-batch (all six pairs, useful plus redundant relations, undo/redo and atomic rollback on conflicts).

## Unreleased — Clearer sketch dimensions and Equal Curve Length
- Linear and perpendicular dimensions use aligned, upright text, extension-line gaps and overruns, and outside arrows when space is tight. Moving a perpendicular dimension now moves its dimension line along the reference edge instead of leaving a floating label and a diagonal leader. Preview placement and later dragging still keep the text at the chosen position.
- Equal Curve Length constrains the actual length of arcs, splines, circles, ellipses and mixed curve selections. Lines retain their existing Equal relation. Circular-curve Equal is labelled Equal Radius to distinguish it from equal arc length. Spline lengths use the curve definition (including rational weights), not the displayed polyline.
- Tests: sketch-dimension-drafting-layout, sketch-equal-curve-length, dimension placement/creation and serialized rebuilds.

## Unreleased — Confirm dimension placement, including preselection
- Dimension accepts a preselected curve or pair of entities and waits for a placement click. An orange preview and cursor hint show the pending dimension; no constraint is created until confirmation and Esc cancels it.
- The label stays at the chosen click position, including radius, diameter and point-to-line annotations. Existing dimension dragging remains available for later adjustment.
- Test: sketch-dimension-confirm-placement.

## Unreleased — Drag sketch dimension annotations
- Drag a dimension's number with Select or Dimension to reposition the annotation, including linear, radius, diameter, angular and driven dimensions. A click still opens its value editor. Linear dimension lines follow the new offset; moved labels retain a leader to their dimension where needed.
- Annotation placement is saved with the sketch and supports undo/redo. Esc or pointer cancellation restores the position before the drag; geometry and dimension values do not change.
- Test: sketch-dimension-placement; mouse dragging also checked on the guitar-neck model.

## Unreleased — Hide stale projected sketches while editing their source
- Sketches that depend on the sketch being edited (including indirect dependencies) are hidden until the edit ends and they rebuild. Old projected arc segments no longer appear over a new fillet. Independent reference sketches remain visible; visibility settings are preserved.
- When a source fillet separates two previously joined arc endpoints, their projected endpoints separate too. The dependent sketch no longer gets conflicting projection constraints at the old corner.
- Tests: sketch-hide-dependent-projections (save, rebuild and cancel), sketch-projected-fillet-endpoints.

## Unreleased — Sketch Fillet between coincident arcs
- Sketch Fillet recognises arc endpoints joined by Coincident relations, including chains of coincidences and the origin. Construction geometry through a corner no longer hides the two regular curves to round.
- A failed fillet or chamfer leaves the sketch unchanged.
- Tests: sketch-fillet-coincident-arcs, sketch-fillet-arcs-click, sketch-fillet-arcs.

## Unreleased — Parametric sketch patterns and a side panel
- Pattern copies use the defined-geometry colour (black in the light theme, light in the dark theme); purple is reserved for projected geometry.
- Linear Sketch Pattern and its Along Path option now keep a pattern definition: copies update with source geometry, the path/direction, quantity and spacing (including expressions), and survive save/reopen and rebuild. Copies keep stable identifiers when parameters change; their shape is edited through the originals.
- The command opens in the Property panel with a live preview, source and path selection before or after launch, two straight directions where applicable, path rotation and accept/cancel. Existing patterns can be edited from Sketch Patterns in the panel; preview changes can be cancelled without modifying the sketch.
- Earlier patterns remain independent copies; recreate them to gain parametric links.
- Tests: sketch-pattern-parametric, sketch-pattern-curved-updates, sketch-pattern-panel, sketch-pattern-path.

## Unreleased — Sketch rename and spline projection
- Rename works on under-defined sketches marked with `(-)` in the feature tree, and identifies the selected feature even when names are duplicated.
- Project Edges from another sketch preserves a spline as one linked spline, including its degree and weights, instead of creating hundreds or thousands of line segments. Existing segment projections keep their previous representation.
- Tests: sketch-rename-underdefined, sketch-project-spline.

## Unreleased — Origin axis colours
- The origin now uses X red, Y green and Z blue in both up-axis settings, matching the corner triad. With Y up, the vertical origin axis is green.

## 2026-10-25 09:42 — Edge-Flange corner gap 0.5 mm by default
- A new Edge Flange's corner gap is 0.5 mm (was 0.1), as on the formed lid the square corner was matched to. Parts already made keep their gap; Closed Corner's own gap is unchanged (0.1).
- Test: flange-corner-default (the default gap; the wall's end at the other's inside face less 0.5 / √2).

## 2026-10-25 08:43 — Square corners exactly as formed; whole faces at closed corners
- A square (corner to corner) corner's bends now end in plain straight V cuts from the corner point, with no relief and no small round at the corner point: the bend region no longer looks wavy. Checked against the real lid: the same solid (no material in one that is not in the other; volumes equal to 4 parts in 100 million) with the same 38 faces.
- The flange's end face is no longer split near the corner: a closed corner's run-on of a wall came out a ten-millionth of a mm off the wall's edge (the wall's height was found by a point test), which left the end face in three pieces on some sheets (3 mm, for one). It now sits exactly on the edge.
- No zero-size sliver faces at a square corner (at the panel's corner and under the walls' ends): its V cut passes exactly through the bend line and the wall's end. (Overlap corners keep their V cutout as it was: its relief meets the small round at the corner point tangentially, and made exact the bends would no longer join quickly.)
- Tests: flange-corner-default (38 whole faces, 1.5 and 3 thick), convert-sheet-variants (precise volumes for the exact cases).

## 2026-10-25 08:16 — Edge-Flange corners: square ends by default
- Flanges picked together in an **Edge Flange** now meet **corner to corner with square ends** by default: each wall runs on up to the other wall's inside face and ends square, the walls' inside edges the gap apart (measured across the corner), and the small square at the outside of the corner is left open. The bends run on into the corner and end in a V cutout with a small relief between them, as they form from the flat. This is how a real formed lid's corners are made; the mitred corner of 0.17.1 is still there as **Mitred (meet on the diagonal)**.
- **Closed Corner** has the same corner as **Butt (square ends)**; the mitred one is now called **Mitre**.
- Parts saved with a mitred corner keep it. Convert to Sheet Metal knows RazorCAD's own square corners and makes them again exactly.
- Checked against a real lid folded in another CAD program (3 mm, inside radius 3, walls 43, gap 0.5): the wall ends are where that lid has them, and the volume is within 2 parts in 100 000 (the bend relief's shape differs).
- Tests: flange-corner-default (the default square; a wall's end square at the other's inside face less the gap's share), convert-sheet-variants (square corners converted exactly).

## 2026-10-25 06:57 — The up axis from the Origin in the feature tree
- Right-click **Origin** in the feature tree to choose **Y up** or **Z up**; the Origin shows the current one beside it (“Y up” / “Z up”).
- Test: up-axis-z (also: Z up chosen from the Origin's right-click menu).

## 2026-10-25 06:47 — The world's up axis: Y or Z
- Each part can be shown **Y up** (as before) or **Z up**: **View ▸ Up Axis**, or click **Y up / Z up** in the status bar. With Z up the **Top plane is XY**, the **Front plane XZ** and the **Right plane YZ**, and Z points up; the tree shows each plane's axes beside it. The choice is kept with the part and is used for new parts too.
- The model stays where it is: only what the axes are called changes, so switching never moves or breaks a feature. Everything that shows or takes world axes follows: the triad and the origin, X / Y / Z directions (patterns, axes, rotations), Move / Copy Bodies' ΔX ΔY ΔZ, a reference point's coordinates, Measure (points and ΔX ΔY ΔZ), Mass Properties (centre of mass, bounding box), 3D sketch coordinates and its Along X / Y / Z and On / Parallel to plane relations, and the Ask Claude panel.
- **Files** are written and read in the part's axes: a STEP, STL, OBJ or 3MF exported from a part shown Z up has Z up, and a file imported into it comes in Z up (the import keeps the axes it came in with, so changing the part's up axis later doesn't turn it).
- Assemblies and drawings show the up axis chosen for new parts (their components' own placements are not renamed yet).
- Test: up-axis-z (a plate exported Z up and read back into a part shown Y up and one shown Z up; the Top plane named XY; a Move's ΔY kept as RazorCAD's −ΔZ; directions and the triad).

## 2026-10-25 06:37 — Fixed: two file dialogs open at once froze both
- Reported on GitHub: several Open File dialogs could be opened together (File ▸ Open, Ctrl+O, the start window, Import, Save As…), and then none of them answered or could be closed, so RazorCAD had to be ended from outside. Only one file dialog is now open at a time: while one is open, another request does nothing (as if it were cancelled), and the open one closes with Cancel, its close button or Esc as usual.
- Checked: a second request while a dialog is open returns at once, and the next one after it closes opens normally.

## 2026-10-25 01:45 — Reference planes from sketch entities, sketch patterns along a curve, fillet points by clicking, fixes in the sketcher
From suggestions on GitHub (Discussions):
- **Reference planes from a sketch**: a line, a circle or arc (its axis) or a point of a sketch shown in the view can be picked as a reference, alone or with others (normal to the line, through the line and a point, through two lines, at an angle to a plane through the line…). The plane follows the sketch when it changes.
- **Linear Sketch Pattern along a line or curve**: select the line or curve with the entities (Ctrl+click it too) and choose it as direction 1: the copies go its way (a line), or follow it at the spacing measured along it (an arc, a circle, a spline), turned with it if wanted. Past an open curve's end no more copies are made.
- **Variable fillet points**: **Add by Clicking** puts a point where you click on one of the fillet's edges; a point's place can also be given in **mm from the edge's start** instead of %.
- Fixed: relation symbols of deleted geometry stayed on the screen (they were hidden but their own display style kept them showing); the numbers were right underneath.
- Fixed: where a control-point spline crosses its own control polygon, a click picked the spline, so the polygon's leg could not be dimensioned there (and a point was dimensioned instead, which came out driven): the leg is picked now.
- Tests: plane-sketch-refs, sketch-pattern-path, fillet-edge-points (a point given in mm), sketch-stale-labels, sketch-pick-polygon-leg.

## 2026-10-25 01:26 — Sketching: box selection, Control-Point Splines up to degree 7, Sketch Fillet on arcs
From suggestions on GitHub (Discussions):
- **Box selection** in sketches: drag from empty space with Select. Left to right is a **window** (solid box): what lies wholly inside it is selected. Right to left is **crossing** (dashed box): whatever it touches is selected. Ctrl or Shift adds to what is selected.
- **Control-Point Spline**: degrees up to **7**, and the degree can be chosen **before drawing**, in the panel while the tool is on (a spline with fewer control points gets one degree less than its control points).
- **Sketch Fillet** now rounds a corner where a **line meets an arc** or **two arcs** meet, not only two lines: the curves are cut back to a tangent arc with the radius dimension, as for lines.
- Tests: sketch-box-select (a window round a rectangle, crossing over a circle, Ctrl adding; and a spline drawn with the degree chosen first), ctrl-spline (degrees 6 and 7 against a plain de Boor evaluation), sketch-fillet-arcs (a line and an arc, two arcs: tangent to both, the sketch solving).

## 2026-10-25 01:14 — An example part and a tutorial for the new tools
- **File ▸ Open Example Part (Tutorial)** (and **Example Part** on the start window): a duct lofted from a closed control-point spline up to a circle on a plane moved up and turned with Placement, following a guide curve, with a variable fillet that has a point along its bottom edge; beside it a sheet metal tray whose edge flanges meet corner to corner.
- **Manual**: a new chapter, *Tutorial: a Guided Loft and a Sheet Metal Tray*, builds the same part step by step (also in the online manual).
- Test: example-part (it rebuilds with no errors: the loft with its guide, the fillet with its point, the tray's four corners closed).

## 2026-10-25 01:08 — Convert to Sheet Metal: a rip is one cut line in the flat pattern and its DXF, along the bend too
- Where a converted flange runs flush against the material beside it, the flat pattern no longer has a slot 0.001 mm wide (two lines a hair apart for the laser) but **one cut line**, on the cut-outs layer (HOLES), as a louver's slit is. It now runs on across the bend as well as along the flange, as far as the bend runs flush too, so the flange really comes free. The outline itself stays whole; the cut length counts the line once.
- Two flanges that unfold toward each other and fill a slot between them leave one cut line where they meet.
- Checked against real parts converted alongside another program's flats: a panel with five flanged slots now has the same flat as theirs (the slots fill with their flanges; the area within 0.1 %, the size within what their K-factor gives).
- Test: convert-flush-flange (also: along each side of the window the cut lines run end to end, none drawn twice).

## 2026-10-25 01:01 — Variable fillets: radii at points along the edges
- A **Variable size** fillet set **At vertices and points along edges** now also takes **points along the edges** (from a suggestion on GitHub): **Add Point**, choose the edge, where along it (a share of its length from its start, in %) and the radius there. The radius runs smoothly along the edge from its start through its points to its end, and each point is marked on the edge in the view while the fillet is edited.
- The fillet's note says how many points it has.
- Test: fillet-edge-points (a slot's top edge, lines and arcs in one run: a point a quarter of the way along a line with a radius of 6, on both lines; the fillet is bigger at the marked point than at the mirror point; a point past the edge's end refused).

## 2026-10-25 00:05 — Version 0.17.1-beta: installer, user manual and website
- **RazorCAD-Setup-0.17.1-beta.exe** built (in "RazorCAD Install", 45 MB, unsigned), with everything since 0.17.0-beta:
  - Edge-Flange: flanges picked together meet corner to corner (mitred) by default, not overlapped;
  - Control-Point Spline: closed smoothly, weights, control points inserted and removed; a spline through points converted to one;
  - loft guide curves move holes and a thin loft's inside with the outline;
  - Convert to Sheet Metal: flanges flush against the material beside them (no relief) ripped as they are made; a wrapped blade unrolled;
  - bug report and feature request forms on GitHub, and a contributing guide.
- **User manual** 0.17.1-beta (revision history), the PDF and the online manual rebuilt.
- **Website**: version 0.17.1-beta on the home page and its download links; the browser version rebuilt.
- Published on GitHub as a pre-release with the setup and the manual. 0.17.0-beta users get it through Update Now.

## 2026-10-24 23:18 — Convert to Sheet Metal: flanges that run flush against the material beside them; a wrapped blade unrolled
- A body drawn elsewhere often has a flange whose ends run right up against the material beside it, with no relief: a flange bent off a cross bar between the sides of a window, or off the edges of slots in a panel. Converting it stopped with "A bend needs a relief at its end". The flat is now ripped there, as the part is made: a cut of next to no width (0.001 mm) along each flange end, from the bend to the flange's edge, so the flange folds up free and the flat pattern (and its DXF) has the cut the laser needs.
- Checked against real parts converted alongside another program's flats: the two parts that failed this way now convert, with the outline the size of theirs.
- An unrolled (developed) sheet was refused as "curved both ways" when the mesh RazorCAD lays out folded back over itself in a few slivers near a trimmed edge of a face (an airfoil-shaped blade wrapped from one sheet): a fault of the mesh, not of the shape. Triangles turned against the surface there are now left out of that check, and the blade unrolls.
- Seams are looked for quickly on parts with many holes (straight edges far apart are passed over by their boxes).
- Test: convert-flush-flange (a plate with a window and a flange flush against its sides: one bend, the flat the plate's size, folded the same body as with reliefs at the flange's ends).

## 2026-10-24 22:28 — Control-point splines: closed smoothly, weights, control points added and taken out, splines converted; loft guides move holes and thin walls too
- A **Control-Point Spline** closed on its first point now runs round smoothly, with no join (a periodic spline, near its control points rather than through them). The **Closed** box in its panel opens or closes one already drawn.
- **Weights**: select a control point to set its weight. A larger weight pulls the curve toward it, a smaller one lets it go farther. Three control points at the corners of a square, degree 2 and a weight of 0.7071 on the middle one make a quarter circle (to within 0.00001 mm).
- **Insert After** and **Remove** (with a control point selected) add a control point half way along the next leg, or take one out and join its legs. Deleting a control point does the same; a deleted polygon leg comes back.
- **Convert to Control-Point Spline** (with a spline through points selected): a cubic control-point spline that runs through the same points; an open one keeps its ends, so what joins them stays joined.
- **Loft guide curves** now move the holes in the profiles, and a thin loft's inside, with the outline: a hole goes along with the shape round it, and thin walls keep their thickness. A thin loft's guide is drawn on the sketched line.
- Tests: ctrl-spline-more (closed for degree 2 to 5 against a plain de Boor evaluation, smooth where it comes round, extruded; the weighted quarter circle; converted open and closed through their points; a control point inserted and removed), loft-guides (a hole moving with one guide: the whole of it taken out; a thin loft with two guides: walls of about the thickness).

## 2026-10-24 22:17 — Reporting bugs and ideas on GitHub: forms and a contributing guide
- New issues on GitHub start from a **Bug report** form (version, steps, what was expected, screenshots or a part) or a **Feature request** form (what it should do and what it's for). Questions and open-ended ideas are pointed to Discussions; the manual is linked too. A plain issue can still be opened, so **Help ▸ Report a Problem** works as before.
- **CONTRIBUTING.md**: how to report a problem, where ideas go, running the app from source and the tests, and what a pull request needs. The README links to it.

## 2026-10-24 22:14 — Edge-Flange: flanges meet corner to corner by default
- Flanges picked together in an Edge-Flange (a tray's sides, say) now meet **corner to corner** where they meet: on the diagonal, mitred, the gap apart. Before, one flange ran on to cover the other's end (an overlap), which is not what a plain tray should get.
- Overlap and Open are still offered under Corners. Parts already made keep the corners they were made with.
- Test: flange-corner-default (the tray's four flanges with the defaults: four corners closed corner to corner, the same body as with Corner to corner chosen, not the overlap's).

## 2026-10-24 21:18 — Version 0.17.0-beta: installer, user manual and website
- **RazorCAD-Setup-0.17.0-beta.exe** built (in "RazorCAD Install", 45 MB, unsigned), with everything since 0.16.0-beta:
  - from the first suggestion on GitHub: the Control-Point Spline (degree 1 to 5, its control polygon dimensioned and constrained like any lines), the Midpoint relation on an arc, more reference planes (through an edge and a point, through two edges, at a distance along an edge, tangent to a cylindrical face) with placement for every plane, and loft guide curves;
  - Convert to Sheet Metal: square-to-round transitions, cones and closed tubes unrolled, butt corners and RazorCAD's own closed corners exact, a curved face picked either way round;
  - section views saved with the part or assembly;
  - STEP files written as surface models read as solids; big STEP imports meshed in several kernels at once;
  - STEP, IGES and mesh files opened from Windows are imported;
  - the browser version runs the multi-threaded kernel and no longer shows the browser's right-click menu over RazorCAD.
- **User manual** 0.17.0-beta (revision history), the PDF and the online manual rebuilt.
- **Website**: version 0.17.0-beta on the home page and its download links; the browser version rebuilt.
- Published on GitHub as a pre-release with the setup and the manual. 0.16.0-beta users get it through Update Now.

## 2026-10-24 20:54 — Control-point splines, an arc's midpoint, more reference planes, loft guide curves (from the first suggestion on GitHub)
- **Control-Point Spline** (Sketch tab, beside Spline): click control points; the curve is the B-spline they make, starting and ending on the first and last and passing near the others. Its **degree** (1 to 5, at most one less than the control points) is set in the panel when it is selected. Its control polygon is drawn dashed and is made of construction lines, so it takes dimensions and relations like any lines (horizontal, parallel, equal, an angle…); the curve leaves each end along the polygon's end leg, so a relation on that leg (tangent, collinear) sets its direction there. Drag the control points to reshape it. Degree 2 and 3 are exact; degree 4 and 5 are made of cubic pieces within 0.00001 mm of the curve. Copies and mirror images keep it a control-point spline; deleting it deletes its polygon.
- **Midpoint of an arc**: a point and an arc now offer the Midpoint relation (half way round the arc, from its start to its end), and drawing snaps to an arc's midpoint as it does to a line's.
- **Reference planes**, more ways to make one: through an edge or axis and a point (tick **Through the edge and the point**; else normal to the edge at the point, as before); through two edges or axes that meet or are parallel; normal to an edge at a distance along it; tangent to a cylindrical face, at an angle round it or parallel to a picked plane (either side). Every plane can also be placed exactly: moved along its normal, its axes turned in the plane (how a sketch on it lies), its normal reversed (**Placement**).
- **Loft guide curves**: a loft can follow one or more guide curves (sketches with one chain of curves, or curves), each running from the first profile to the last through every profile. One guide pulls the loft along it; several shape it round the outline, each where it touches the profiles. The profiles stay as they are (their corners stay corners); a guide drawn from the last profile to the first is turned round.
- Tests: sketch-arc-midpoint, ctrl-spline (the B-spline against a plain de Boor evaluation for degree 2 to 5, its polygon and a relation on it, a profile extruded), plane-more-types (every new plane and the placement), loft-guides (one guide pulls the side out to it, two shape both sides).

## 2026-10-24 06:05 — STEP, IGES and mesh files opened from Windows are imported
- A STEP, IGES, STL, OBJ or 3MF file opened from Windows (double-click, Open with, or RazorCAD.exe with the file on the command line, also when RazorCAD is already running) was read as a RazorCAD part and failed with "Could not open". It now opens as a new part holding the import, as File ▸ Open does.
- Checked from the command line with a STEP, an STL and an IGES file at once (three new parts), and with a STEP handed to a RazorCAD already running.

## 2026-10-23 19:38 — Browser version: no browser right-click menu over RazorCAD
- In the browser version, a right-click anywhere RazorCAD has no menu of its own (a panel, the feature tree's background, the ribbon, the menu bar, the status bar, or the end of a right-drag) opened the browser's own menu over the model. It no longer does: RazorCAD's own menus open where they belong, and elsewhere a right-click does nothing, as in the Windows app. Text fields and selected text keep the browser's menu, for cut, copy and paste.
- Regression test no-browser-menu.

## 2026-10-22 23:17 — Convert to Sheet Metal from a curved face: the thickness found whichever way the face is turned
- Converting from a curved face, the thickness is measured straight through the sheet from the face. It was measured one way along the face's normal only, and a face read from a file can have its normal turned the other way: the measure then missed the sheet's other side (a rolled band read as 724 mm thick). It is now measured both ways and the nearer face straight across taken.
- Rolled bands and plates from real projects checked against another CAD program's flat patterns: the size to 0.3 mm in 2175, the area to 0.03 %, every hole.

## 2026-10-22 23:02 — Convert to Sheet Metal: closed tubes unrolled; DXF import reads old-style polylines
- A closed tube (bends all the way round, as a rounded rectangle duct) converted the ordinary way lost one bend without a word: laid out face by face, the last bend joins two faces already placed and was left out, so the flat was one bend short. Such a sheet is now recognised and unrolled instead, cut open at a seam: a rounded rectangle 100 × 60 (R10), 50 deep, comes out at its exact area (0.0005 %). Bodies the ordinary way refuses (a bend with material on one side only, or with no relief at its end) are unrolled too when that works.
- DXF import (into sketches and drawings) read only the newer kind of polyline: old-style (R12) POLYLINE … VERTEX … SEQEND polylines, as RazorCAD's own flat pattern DXF has for its curved V corners and as much laser and older CAD software writes them, came in without those curves. They are now read, bulges (arcs) and all.
- Tests: convert-closed-tube; dxf-r12-polylines (RazorCAD's own flat pattern DXF of the test tray read back: 16 polylines, every end joined; 12 loose ends before).

## 2026-10-22 22:53 — Convert to Sheet Metal: square-to-round transitions, cones and other one-way curved shapes unrolled
- A body curved other than in plain cylindrical bends (a square-to-round transition or a reducer made in another program, whose curved faces are B-splines or cones) used to be refused. Its side of the sheet is now meshed finely, moved to the neutral layer (K·t from the inside of the curves), and laid out flat triangle by triangle, each edge keeping its length. A shape that closes on itself (a ring) is cut open where its triangles meet again out of place (a seam). The flat pattern is the unrolled outline with its holes; folded, the sheet is the body itself. A cut in it (a hole, a slot) is made in the body and the sheet unrolled again, so the cut is in the flat pattern too. Features that need real bends (flanges, hems, corners, forms…) refuse it as they refuse a lofted bend.
- A face curved both ways (a dished end, a sphere) can't be laid flat: refused, with the reason. A cone has no flat face: its curved face can be picked instead (the thickness is measured straight through the sheet).
- Checked against flat patterns made by another CAD program for real square-to-round transitions: the same outline and holes, the area to 0.04 %, the cut length to 0.03 %, the size to 0.4 mm in 878, with that program's K-factor (0.5, found from the flats). Regression test convert-developed: half a cone and a full ring (cut at a seam) unroll to their exact area (0.002 %); a hole cut in the half cone is in its flat; a spherical cap is refused.

## 2026-10-22 21:49 — STEP files written as surface models: their closed shells read as solids
- Some programs write a part as a surface model: closed shells with no solid round them. RazorCAD read those as surface bodies, so nothing that needs a solid worked on them (Convert to Sheet Metal, mass, cuts). A closed shell (every edge shared by two faces) now comes in as a solid, faces outward; a shell that isn't closed stays a surface.
- Found by comparing RazorCAD's sheet metal conversion with flat patterns made by another CAD program for real parts: square-to-round transitions written this way came in with no solid at all.
- Regression test step-closed-shells (a part's STEP rewritten as a surface model: one solid, the same volume).

## 2026-10-22 10:33 — Convert to Sheet Metal: butt corners exact too
- A butt corner converted from a STEP file kept a seam on the top of one wall, where its mitred run-on joined it: the file moves the walls by a ten-millionth of a mm, so the two tops did not count as one face. A sheet whose corners were made again as RazorCAD made them is now tidied with faces a millionth of a mm from one plane taken as one: the test tray with butt corners converts to 38 faces, as RazorCAD made it (it was 39), the same volume and area.
- convert-sheet-variants: every variant now the same faces and volume (the butt corner was allowed a millionth).

## 2026-10-22 10:27 — Regression tests: 30 s side by side
- The heaviest tests did most of the waiting. Tests that start kernels of their own (import-store, import-mesh-helpers) now give them the page's share of the processor threads, not 8 each (four pages at once had far more threads busy than the PC has); import-mesh-helpers uses 12 trays instead of 24 (10 MB of STEP, still a big import) and no longer builds a third time to show the automatic choice, which is measured rather than tested.
- import-store split into import-store-step and import-store-stl, and convert-sheet-variants into the corner variants and convert-sheet-others (the hem refused, two bodies), so they can run in different pages.
- 35–37 s → 30 s with 4 pages (three runs in a row, all passed); one page (`--jobs 1`) passes too.

## 2026-10-22 10:19 — The website checked as it is served, after each push
- `tools/check_site.py` checks the website at an address (razorcad.com by default): the home page, the manual and the browser version load; the browser version's files are served cross-origin isolated; in headless Edge the browser version starts, the page is isolated, and a kernel asked for 4 threads starts multi-threaded and builds a part. `--wait` first waits until the site serves the checkout's browser version (the host deploys a push a little later). Exit code 1 on any problem, each one listed.
- GitHub runs it after each push to main that changes the website (and once a week): `.github/workflows/site-check.yml`.
- Run against a local server of the website folder with the new headers: everything passes (the browser version's kernel multi-threaded, 8 threads). Against razorcad.com as it is now (before the push): it reports the missing isolation, as it should.

## 2026-10-22 09:21 — Convert to Sheet Metal: RazorCAD's own closed corners made again exactly
- A body folded by RazorCAD (for example its STEP export) has its closed corners recognised when converted: each corner's bends end short of the corner point by the V cutout's relief (or at it, for a closed mitre or a butt corner) and its walls run on past them as the corner made them. From those the corner is worked out (which wall covers the other's end, or both mitred; the gap) and closed as RazorCAD closes it: the bends formed over their own strips, the relief round and the curved V lines made again. It is kept only when the folded sheet has the body's volume, area and box; any other corner is traced from the body as before.
- The test tray (V cutout corners with their relief, gap 0.2): 63 faces as before, the volume the same (it was 67 faces); a closed mitre corner: the same faces and volume (it was 0.023 % off); a butt corner: the same volume to a millionth (it was 0.19 % off; a seam may stay where a wall's mitred run-on joins it, as the STEP file moves the wall by a ten-millionth of a mm). The flat patterns come out the size of RazorCAD's own (checked for the open, 120°, butt and mitre variants).
- Fixed: converting a body straight after modelling it (not through a STEP file) could stop with "disconnected wire" where a bend's traced outline didn't quite close; the outline is then traced as points.
- Tests: convert-sheet-corners (the four corners known, the same faces and volume), convert-sheet-variants (mitre exact, butt to a millionth).

## 2026-10-22 09:00 — Section views saved with the part or assembly
- A part or assembly saved with a section view on keeps it in its file (its planes, offsets, flips, a plane picked from a face, Sections 2 and 3); opening the file puts the cut on again, as after OK (the Section View button opens its panel). Saved without a cut, the file has none. The stored model's key leaves the section out, so a part saved with one still opens from the stored model.
- Each tab keeps its own cut: switching to another part or assembly shows that one's (or none), and coming back puts the cut on again (before, switching tabs took it away).
- Fixed: Section View on an assembly with nothing in it yet stopped with an error.
- Regression test section-saved (part file, the model's key, tabs, assembly file).

## 2026-10-22 08:54 — Big STEP imports meshed in several kernels at once
- A part whose bodies are still as a big STEP import made them (kept in the store of models built) has its meshing shared out: the part's kernel meshes for a moment to see how long the rest will take, and when the pool's free kernels would finish sooner (each first reads the import: the page hands them the text it just read or wrote), the bodies are shared out by faces between it and up to 7 of them, its own share sized so all finish together. Their meshes are used as its own; one that fails leaves its bodies to the part's kernel.
- Measured on 64 copies of a test part in one STEP (6784 faces): meshing 5.4 s alone, 1.8 s shared out (6 kernels helping); opened from the file the first time, 2.3 s instead of 6.1 s. A lighter file (64 sheet-metal trays, 1.7 s of meshing): 1.35 s. Small imports, and bodies changed by later features, are meshed as before.
- The page reads a big import from the store once for kernels asking together, and gives one just written straight to the next kernel asking (no wait for the store).
- Regression test import-mesh-helpers (24 trays in a 21 MB STEP: shared out, the mesh exactly the one a kernel makes alone, every vertex, triangle, face, edge and surface). Tests made independent of the ones before them for the side-by-side run: languages (a part in front, the Features tab), step-roundtrip (a kernel of its own); import-store reads from the store itself.

## 2026-10-22 08:33 — Regression tests run side by side: 27 s instead of 65 s
- `tests/run_tests.py` splits the run over several pages in the one browser (`--jobs N`; by default one per 6 processor threads, at most 4: 4 on this PC; GitHub's runner stays at 1). Each page has its own storage and geometry kernels and is told its share of the processor threads (else each started kernels for the whole PC, and some stopped while starting). The first page runs the parts and drawings; the UI tests are shared out by their usual times so the pages finish together. Results are listed in the usual order.
- The test server takes 128 waiting connections instead of Python's 5: pages loading side by side were refused some files (one page then waited 3 minutes; it was also behind the odd "connection refused" seen before). A file cut short when a page closes is no longer printed as an error.
- drawing-from-part makes its part when no test before it did.
- `--jobs 1` runs as before (60 s); timings are kept per number of jobs. A slowdown against a usual time of 0 ms no longer stops the report.

## 2026-10-22 08:16 — The browser version runs the multi-threaded kernel
- razorcad.com/app is served cross-origin isolated (`website/_headers`: COOP, COEP, CORP for `/app/*`), which shared memory needs, so each open part's kernel there is the multi-threaded one, as in the Windows app (half the processor threads beyond two, 2 to 8; a PC or browser that can't keeps the single-thread kernel).
- The browser version now carries both kernels (the multi-threaded one is 22 MB, under the host's 25 MiB a file).
- Checked in the browser build: the part kernel starts as replicad_multi with 8 threads, test parts rebuild with no errors; the website's other pages are not isolated, and the app loads nothing from other sites.
- Manual: the speed paragraph and the browser version's build.

## 2026-10-22 07:28 — Version 0.16.0-beta: installer, user manual and website
- **RazorCAD-Setup-0.16.0-beta.exe** built (in "RazorCAD Install", 45 MB, unsigned), with everything since 0.15.0-beta:
  - Section View: from a selected face or plane, a click moves it, an arrow to drag, in assemblies, two or three planes at once (quarter cuts), its panel opened again from the button;
  - the view turns about the point under the cursor;
  - faster: previews of cuts, big imported parts and assemblies, big imports (STEP, STL, OBJ, 3MF) kept and read back several times quicker, Measure on sheet metal, flat-face descriptions;
  - Convert to Sheet Metal: corners as the body has them (exact for parts drawn as sheet metal elsewhere), no material lost at butt corners;
  - the browser version keeps an assembly's parts.
- **User manual** 0.16.0-beta (revision history; the section view paragraph), the PDF and the online manual rebuilt.
- **Website**: version 0.16.0-beta on the home page and its download links; the browser version rebuilt.
- Published on GitHub as a pre-release with the setup and the manual. 0.15.0-beta users get it through Update Now.

## 2026-10-21 22:33 — Flat faces described four times quicker (meshing big parts)
- Every flat face's centre of area is worked out when a part is meshed (assemblies keep it in their mates). It is now worked out by the plain integration instead of the adaptive one: the same centre to about 0.00000001 mm, four times quicker (an imported dust collector's 3081 flat faces: 0.5 s instead of 2 s).
- Mates don't move: they find their faces by the plane (to 0.00001 mm) and keep the centre to 6 decimals, which come out the same (on the dust collector and the test parts, every one).
- Regression test: flat-face-centres (six test parts: every flat face the same centre to 1e-7 mm, and the same at 6 decimals).

## 2026-10-21 22:26 — Section View: two or three planes at once
- **Sections 2 and 3** in the Section View panel (tick "Use this section too"): with two or three planes, only what all of them cut away is removed: a quarter cut of a housing, a corner cut. Each plane has its own plane, offset and flip, and each cut face its own hatched cap (the hatch turned from plane to plane, so they read apart).
- The arrow, and a click on a flat face or a plane, move the section changed last (the panel says which). In parts and in assemblies.
- What any of the planes still shows can be picked; what all of them cut away can't.
- User manual: the section view paragraph.
- Regression test: section-planes (front and right planes on the test plate: only what both cut away is gone, both capped, nothing cut away picked, the arrow moves Section 2 only, unticked: one plane).
- (Looked at and left out: showing a huge import in an assembly first as a coarse mesh. On the plant layout's 64 MB import it would show 8 s sooner but be complete 17 s later: making the coarse mesh costs most of what the full one does.)

## 2026-10-21 22:16 — Dragging along a direction that points at you
- The Section View arrow, and items dragged in an exploded view, move along their direction as the screen shows it, as before. When that direction points (nearly) straight at you, so that it hardly shows on the screen, moving the mouse up the screen now moves them toward you and down away from you. Before, the drag barely moved them, or moved them unpredictably, until the view was turned.
- One rule for both (Viewport.dragAlong).
- The section-from-face test now also drags the arrow seen end on.

## 2026-10-21 22:13 — Big mesh imports (STL, OBJ, 3MF) kept too
- Big mesh imports are now kept in the store of models built as well, like big STEP imports: their triangles simplified and joined into a solid once, then read back from the store wherever the part is built again. 3DBenchy (225,706 triangles, simplified to 79,448): the import 2.6 s instead of 17.3 s, the whole build 9.7 s instead of 25.7 s; the same solid, and the note of how it was simplified kept.
- Kept with the triangle limit set in the import: a different limit makes a different solid, so it is read from the file again.
- The import-store test now also checks an STL (a finely divided sphere made in the test).

## 2026-10-21 21:49 — Section View in assemblies, and its panel opened again
- **Section View now works in assemblies** (Evaluate ▸ Section View, Tools ▸ Section View…): every component is cut (faces and edges) and capped on the cut, hatched; what is cut away can't be picked; a click on a component's flat face (or one selected when you start) cuts from it; the arrow drags the cut, as in a part. Before, it set a cut the assembly didn't show.
- **The Section View button opens the panel again** when a cut is on and its panel was closed with ✓ (it used to take the cut away). ✓ keeps the cut, ✗ removes it.
- OK and Cancel of Section View no longer rebuild anything (a section only changes the view); in an assembly tab that rebuild would have shown the last part instead of the assembly.
- User manual: the section view paragraph.
- Regression test: section-assembly (two blocks with a hole cut on the front plane: clipped, capped, nothing cut away picked; a top face clicked moves the cut; OK keeps it with the assembly still shown; the button opens the panel again; ✗ removes it).

## 2026-10-21 21:43 — Big STEP imports kept, and read back several times quicker
- **A big STEP import (over 2 MB) is now kept in the store of models built** (the desktop app's model cache on disk; the browser version's store) in OpenCascade's own format, keyed by the file's contents. The next time the part is built, wherever that is (an assembly's part kernels after the part was edited, drawing views, a kernel started later…), it is read back from there instead of from the STEP: an imported dust collector (18 MB, 342 bodies) in 0.7 s instead of 5.2 s, the same solids.
- The first time costs about 0.6 s more (writing the copy; it is stored in the background). A part's own tab already kept its feature states and is unchanged. Smaller files are read as before.
- How: the geometry kernel can now ask the program a question while it works (here: "is this import kept?", and "keep this one"); the answers come from the same store as the models, which belongs to this kernel build.
- Regression test: import-store (a 3 MB STEP: read from the file and kept, then by a fresh kernel from the store, the same solid).

## 2026-10-21 21:36 — Convert to Sheet Metal: every kind of corner, and no material lost
- **Fixed: converting a part with butt corners lost a third of its material** (the sheet metal tray: 32 % less, with a warning). New tests of the conversion found it: until now it had none but the corners test.
- **Each converted bend is now formed over its own zone in the flat** (its faces unrolled, edge by edge), not over a strip as long as its line. Its ends come out as the body has them, whatever they are: square, run on into a corner as a V cutout (the dust collector lid's), mitred into the next bend, butt. Before, run-ons were folded with the walls (corners sticking out) or, at butt and mitred corners, the bends ran into each other.
- **Folding a sheet into a solid never loses material quietly any more:** a fuse that loses material is made again the exact way, and one that goes wrong (inside out) is not used.
- Results (the tray written to STEP, read back and converted):
  - open corners, 120° flanges: exactly the same part (faces, volume, flat pattern);
  - closed corners (V cutout): the volume within 0.001 % (was 0.011 %); with mitred bends within 0.023 %; butt corners within 0.19 % (was 32 % short). Nothing outside the body; the flat pattern the same size. (RazorCAD's own closed corners have a small relief the conversion doesn't recreate, and come out with a few more faces.)
  - a hem: not converted, with the reason; a part of two bodies: the one converted, the other as it was.
  - the dust collector lid: still exactly the same part (38 faces, 76 edges, the same volume and area to a millionth, the same flat pattern).
- This replaces the corner records the conversion made earlier today (the zones cover them).
- Regression test: convert-sheet-variants (the cases above). The convert-sheet-corners test now checks the converted tray converted again is the same part (and runs in the part's kernel, 8 s → 4 s).

## 2026-10-21 21:18 — Test runs: the one console error explained
- Every test run reported one browser console error, "Failed to load resource: 404". It was the app looking once for the PC's fonts at _fonts/ (Arial Bold, for a text): outside the desktop app it asks the server once, and on a 404 uses its own fonts and stops asking. That is by design, and nothing was missing.
- The test runner now leaves that one look out of its error list, and shows where every other console error came from (the file and line; a worker's failed load said nothing else). A test run now ends with no console errors, so a new one stands out.

## 2026-10-21 20:57 — A geometry kernel that fails to start is tried again; steadier GitHub tests
- **A kernel that fails while starting is started again**, up to three times (e.g. when the memory for it is not there just then). Before, that kernel stayed dead: the app looked ready but nothing built in it, and an assembly's parts built in a dead extra kernel came back empty. A kernel that keeps failing (missing files) is given up on as before, not restarted in a loop.
- An extra kernel that could not start is dropped, so the next job starts a fresh one instead of waiting on the dead one.
- Kernel errors are logged with their message (they showed only "Event").
- **Tests (GitHub):** when RazorCAD doesn't get to Ready, the test run prints the status line and the browser errors, and loads the page once more before failing; failed downloads show their address. The parallel-kernels test checks the speed of a second kernel only on a PC with 8 threads or more: on the 4-thread GitHub runner the time varied too much and failed the run now and then.

## 2026-10-21 20:49 — Section View: from a face or plane, and an arrow to drag
- **Section View starts from what is selected:** a flat face, a standard or reference plane, or a sketch (its plane). The cut starts on it (offset 0), and the offset is measured from it. Without a selection it opens on the plane used last, as before.
- **While the panel is open, clicking a flat face or a plane moves the cut onto it.** The Plane list then shows it ("Selected face", or the plane's name) next to the standard planes.
- **A blue arrow on the cut, dragged to move it** along its normal: the offset box and slider follow, in round steps (1 mm, or finer when zoomed in). It stays the same size on the screen, turns amber under the cursor, and the view doesn't turn while it is dragged. It shows while the Section View panel is open; OK keeps the cut and takes the arrow away.
- The slider's range now runs over the model from the chosen plane, whichever plane it is.
- User manual: the section view paragraph.
- Regression test: section-from-face (starts on a selected side face; the arrow dragged 150 px moves the cut by that much, the view unchanged; a click on the top face moves the cut onto it; OK keeps the cut, without the arrow).

## 2026-10-21 20:31 — The view turns about the point under the cursor
- **Rotating the view now turns about the point under the cursor where the drag starts**, instead of the model's centre. Zoomed in on part of a large model, what you are looking at stays where it is while it turns, rather than swinging off the screen.
  - Started on the model: the point on its surface under the cursor (a part's bodies or an assembly's components; in a section view, only what is still shown).
  - Started over empty space: that spot, at the depth of the model's centre.
  - A small red dot shows the pivot while dragging.
- The same for middle-drag, left-drag (outside sketches) and Alt + middle-drag (roll). The arrow keys still turn about the model's centre.
- The user manual's and the shortcut list's descriptions updated.
- Regression test: rotate-about-cursor (zoomed in off the part's centre: the point under the cursor stays there to 0.5 px, on the part and over empty space; the dot shown while dragging; the arrow keys about the centre).

## 2026-10-21 19:55 — Measure: sheet metal with closed corners 100× quicker
- **Measuring a body with B-spline faces is far quicker.** The sheet metal tray (closed corners: their bend ends are B-spline faces) took 16 s to measure; now 0.15 s, with the same volume (23759.4208 mm³, the same to 0.0000001 mm³).
- The exact volume of such bodies is worked out by an adaptive integration. It took each B-spline face as a whole, and at the joins between the face's spans (18 on these corner faces) it kept refining without end. It now integrates span by span (as the sheet metal checks already did).
- Bodies of plain faces are measured as before. Imported NURBS bodies stay exact (the NURBS cylinder of the IGES test: 9424.78 mm³). The whole test run is about 9 s shorter, as several tests measure such bodies.
- The convert-sheet-corners test now also measures the tray (the exact volume, in under 3 s).

## 2026-10-21 17:45 — Convert to Sheet Metal: corners as the body has them
- **Fixed: converting a sheet metal body with closed corners spoiled its corners.** Sheet metal drawn in other CAD programs (and RazorCAD's own closed corners) forms each corner as a V cutout: the two bends run on past the corner point, each cut along a straight line in the flat up to its wall's end, so their ends are curved. The conversion folded those run-ons flat with the walls instead of round the bends:
  - small slanted faces stuck out below the base at every corner (0.79 mm on a dust collector lid of 3 mm sheet), and the bends ended square at the panel;
  - the lid came out with 54 faces and 628 edges instead of 38 and 76, up to 3 mm from the body at the corners.
- **Now** such corners become V cutout corners of the converted part, with no relief and each V line straight, as the body was formed. The lid converts to the same part: the same 38 faces (each of the same kind and size, to 0.001 mm²), the same volume and area, every point within 0.0004 mm (the fit of the curved bend ends). Its flat pattern is unchanged.
- RazorCAD's own closed corners (which have a small relief and a curved V line) convert much closer too: 63 faces as the body instead of 271, nothing outside it, within 0.28 mm at the corners instead of 1.5 mm.
- Regression test: convert-sheet-corners (the sheet metal tray written to STEP, read back and converted: the same faces, nothing outside the body; converted again: exactly the same part).

## 2026-10-21 17:12 — Big imported parts and assemblies open faster
- **Big imported parts build about 30-45% quicker.** Measured on copies of a real plant layout:
  - a 64 MB imported assembly in it (719 000 triangles): 33 s instead of 59.5 s;
  - an imported dust collector (342 bodies, 6642 faces): about 9.5 s instead of 13.3 s;
  - the layout assembly (26 parts) opens in about 37 s instead of about 62 s with nothing stored. Opened again, the stored meshes are used, as before.
- **How:**
  - The part's size, used to choose how finely it is meshed, came from the precise box of every face. It now comes from each face's quick box, with the precise box worked out only for the few faces that reach furthest. The result is identical to the last digit; for the dust collector, 76 precise face boxes instead of 6642 (0.1 s instead of 2.4 s).
  - Bodies added without merging (imports) no longer work out a box they don't use.
  - Edges are sampled for display with one curve evaluator each instead of one per point. The points are identical.
- **Assemblies:**
  - Parts are built biggest first, so the one that takes longest starts at once (2 s earlier in the layout).
  - The browser version now keeps an assembly's parts in its store of models as well, as the Windows app does on disk: the layout's dust collector assembly opened again in 0.5 s instead of 9.8 s.
  - The browser store keeps each model's size apart, so letting old models go no longer reads every stored model (an assembly writes many at once). The models stored by the browser version before are let go once (a store of models built before is only a cache).
- **Looked at and left alone:**
  - the faces' surfaces for mates (1 s on the dust collector): their centre points are stored in the mates, and working them out differently could move components;
  - meshing on several threads: OpenCascade's own mesher runs in parallel, but the mesh extractor repeats the work, so it was no quicker;
  - drawings: the impeller drawing (3 sheets, 9 views) opens in about 2 s.
- Regression tests: quick-part-box (the quick box against every face's precise box on five test parts), web-model-store (written and read back, sizes kept apart, nothing read under another kernel, an assembly's part built once then taken from the store).

## 2026-10-21 16:41 — Faster previews of cuts
- **Previews of cut features are 2-3x quicker.** Giant Golfball:
  - the last dimple opened for editing: about 0.9 s instead of 2.9 s, and about 0.35 s for each preview while it is edited;
  - a pattern of 19 dimples in the middle of the tree: about 1.4 s instead of 3.3 s.
- **How:**
  - The material a pattern or several tools remove (shown solid red) is now found in one intersection with all the tools, given to the geometry kernel as a list, instead of one intersection per tool. The body is prepared once, not once per tool: 1.7 s -> 0.2 s for the 19 dimples.
  - Previewing a feature now makes the cuts waiting before it in one step. That is the same step a full rebuild makes for "all but the last feature", so the preview takes it from there instead of making those cuts again. It also stays the same at every preview while the feature is edited.
  - The preview's mesh size now comes from the body before the feature, whose size is already known. Working out the size of the body after the cut took 0.3 s on the golf ball.
- **Fixed:** where pattern copies overlap each other, the preview showed a little too much removed material (the overlap counted once per copy: 7% too much in the test part). It now shows exactly what the pattern removes.
- **Development server:** it now also answers on the PC's IPv6 loopback address. Opened as "localhost", every connection used to wait about 0.3 s before reaching it, and pages and geometry kernels took 1.6-3.5 s to start. They start in about 0.15 s now. The program itself was never affected: it uses 127.0.0.1, and its kernels start in about 0.15 s.
- **Looked at and left out (no gain worth the code):**
  - warming up a new kernel, and compiling the geometry library once for all kernels: a kernel starts in about 0.15 s and its first rebuild is within 0.1 s of later ones;
  - cutting with all the tools as one compound instead of a list: 2-3x quicker on the golf ball, but wrong where tools overlap inside the body, and this kernel build has no quick way to check that. Possible with a future kernel build.
- Regression test: preview-cuts (a pattern of overlapping holes: its preview shows what it really removes, within 3%; the last cut previewed after a rebuild makes no waiting cut again).

## 2026-10-21 15:31 — A test that failed now and then: fixed
- The **cuts-together** regression test failed about 1 run in 5 (2 of 10 full runs). RazorCAD was right every time: the geometry matched the one-by-one build in the failing runs too.
- The test's check that editing the last cut redoes only its own cut told the edit's timing entries from the ones carried over from the saved state by name and milliseconds. These are small whole numbers, so they sometimes matched by chance, and the edit's own entry was skipped.
- The kernel now counts the cuts a rebuild really makes (not those remembered or carried over), and the test checks that number: the first build makes them, and the edit makes exactly 1. It passed 12 runs on its own and 5 full runs in a row.

## 2026-10-21 15:05 — Version 0.15.0-beta: installer, user manual and website
- **RazorCAD-Setup-0.15.0-beta.exe** built (in "RazorCAD Install", 45 MB: both geometry kernels), with everything since 0.14.0-beta: the multi-threaded geometry kernel, cuts made together, faster edits on big parts, and the fix for overlapping pattern copies.
- **User manual** 0.15.0-beta (revision history), the PDF and the online manual rebuilt.
- **Website**: version 0.15.0-beta on the home page and its download links; the geometry question says the Windows app runs the kernel multi-threaded; the browser version rebuilt (single-thread kernel).
- Published on GitHub as a pre-release with the setup and the manual. 0.14.0-beta users get it through Update Now.

## 2026-10-21 14:52 — Cuts made together
- **A run of cut features is now made in one boolean** instead of one cut after another, each on a body with more faces than the last.
  - Giant Golfball (178 dimples in 24 cut features): full rebuild 4.7 s → 2.5 s, and the cutting itself 3.4 s → 0.4 s.
  - The result is exactly the same (volume, area, faces and edges).
- **What waits:** extrude and revolve cuts with a blind, mid-plane or through end, holes (not tapped ones), and patterns and mirrors of cuts. Sketches go on in between.
  - A feature that needs the body as it really is makes the waiting cuts first: fillets, chamfers, shells, bosses, holes or ends that pick a face, revolves about a model edge, sheet metal.
  - So does the feature being previewed, and the end of the rebuild.
- **Edits stay quick:** the cuts are made in two steps, the last feature's apart from the others, and the result of each is remembered. Editing the last cut redoes only its own cut, and the faces left as they were keep their meshes: the golf ball's last dimple, about 0.7 s, as before.
- **Kept working:**
  - the state saved after each feature (the waiting cuts are part of it);
  - previews;
  - a feature's faces highlighted from the tree (found from its own tool);
  - section curves of a sketch drawn while cuts were waiting;
  - fillets that recompute earlier features;
  - a cut that fails (they are then made one by one, so the failing feature is named).
- **Fixed:** pattern copies that overlap each other (for example holes closer than their diameter) left material where they overlapped, because all the copies were cut as one compound. Several tools are now handed to Open CASCADE as a list, so overlaps are cut right, in patterns and in cuts made together.
- Regression test: cuts-together (a plate with holes, a slot, a pattern of overlapping holes and a hole feature, then a boss and one more cut: made together it is identical to one by one; editing the last cut redoes only its own cut; highlighting and section curves as before).

## 2026-10-21 14:35 — Faster edits on big parts
- **Editing a feature on a big part is about a third quicker.** Giant Golfball, its last dimple moved: about 0.75 s instead of 1.15 s.
  - **Body boxes from their faces:** a body's precise bounding box is now the union of its faces' boxes, each kept with its face, so after a feature only the new faces are boxed. The result is identical (checked on the golf ball: the same box to the last digit). It used to take 0.3 s on the golf ball every time it was meshed: 0.7 ms now.
  - **Faces and edges listed quickly:** listing a shape's faces, edges or vertices compared each one with every one met before (the golf ball's 367 edges: about 270 000 comparisons, 0.16 s). They are now grouped by hash code first: the same list, in the same order, in a few milliseconds. This helps everywhere the kernel lists topology.
- What is left of an edit is mostly meshing the faces the feature changed. On the golf ball that is the ball's big face with every dimple hole in it (17 500 triangles, 0.43 s), meshed by Open CASCADE as one face.

## 2026-10-21 13:56 — Multi-threaded geometry kernel
- **Each open part's kernel now runs multi-threaded.** Open CASCADE splits booleans (cuts, joins and the features built on them) and meshing over several threads. It uses replicad's multi-threaded build of the same kernel (the same Open CASCADE bindings, commit a0bc495), so parts build exactly as before: the same volumes, areas, faces and edges.
  - Measured: a sheet metal tray 4.5 s → 2.0 s; the feature-states test (13 parts) 8.4 s → 4.5 s; the Giant Golfball 6.0 s → 4.7 s; the whole regression run 56 s → 51 s. Small parts are about the same.
  - Threads per kernel come from the PC: half its threads beyond two, 2 to 8. On the golf ball 4 threads gave 4.9 s and 8 gave 4.7 s; 16 or 22 were no faster and only slower to start. A PC with fewer than 6 threads keeps the single-thread kernel.
  - The kernels for assemblies and drawings stay single-threaded: they already build several parts side by side.
  - A multi-threaded kernel takes longer to start (about 3.8 s with 8 threads, against 1.3 s) and an idle one uses about 210 MB instead of 90 MB. The spare kernel started ahead hides most of the start.
- Threads need shared memory, so RazorCAD's pages are now **cross-origin isolated**: the desktop app's built-in server, `serve.py` and the tests' server send the headers for it. Where a page isn't isolated, the single-thread kernel is used, as before.
- The browser version on the website keeps the single-thread kernel (built in its own folder, RazorCAD Web), so nothing changes there.
- The session log and crash reports say which kernel started ("Geometry kernel ready: multi-threaded, 8 threads").
- RazorCAD.exe carries both kernels (34 MB instead of 27 MB). `tools/patch_replicad_multi.py` makes RazorCAD's changes to replicad's published `replicad_multi.js` (the same two memory hooks as the single-thread one, and the thread count); THIRD-PARTY-NOTICES lists them.
- User manual: Speed on your PC and the kernel builds (For Developers).
- Rolling back: the 0.14.0-beta build with the single-thread kernel is in RazorCAD Backups, with how to roll back.

## 2026-10-21 13:33 — The browser version built in its own folder
- `tools/build_web_app.py` now builds the browser version in **RazorCAD Web** (next to the project folder, outside it) and copies it from there into website/app for publishing. It always uses the single-thread geometry kernel: a multi-threaded kernel needs cross-origin isolation, which the website's host may not give. Without that folder (another PC, GitHub) it builds straight into website/app, as before.
- A backup of 0.14.0-beta (RazorCAD.exe, the setup, the kernel files and the source as a git bundle) is in **RazorCAD Backups**, with how to roll back.

## 2026-10-21 10:25 — Version 0.14.0-beta: installer, user manual and website
- **RazorCAD-Setup-0.14.0-beta.exe** built (in "RazorCAD Install"), with everything since 0.13.0-beta:
  - standard parts and fastener sets, assembly holes and cuts with fasteners, motion studies, collision detection, equations shared with the parts, bill of materials with mass and cost, STEP export of assemblies, Speed Mode;
  - Auto Dimension (with its options), Check Drawing, DXF drawings on the sheet, BOM table columns;
  - fillets set at each vertex and setback corners, curvature-continuous 3D splines and loft continuity, etch lines, Compare With, IGES import, part properties;
  - macros (also recorded in assemblies and drawings), languages, the dark theme, keyboard use and screen-reader labels, Update Now, Report a Problem, the fonts that come with RazorCAD, the browser version;
  - faster rebuilds and meshing, big parts reopening ready, and geometry kernels sized to the PC.
- **User manual** brought up to date (76 pages): new sections for all of the above, in Manual/manual_source.md, the PDF and the online manual (website/docs).
- **Website**: the home page lists the new assembly and drawing features, IGES, the browser version for Mac and Linux users, and version 0.14.0-beta; the browser version (website/app) rebuilt.
- The release workflow leaves a version that already has a release alone (this one is published by hand, as before).

## 2026-10-21 09:59 — Geometry kernels sized to the PC; a kernel for each open part
- **How many geometry kernels work at once now comes from the PC RazorCAD runs on.** It is worked out from the processor threads (one per kernel, two left for the window and the rest of the PC) and the free memory (about 1 GB per kernel beyond 2 GB), read from Windows when RazorCAD starts: at least 2, at most 16. The browser version uses the browser's rough figure for the PC's memory.
  - Before, it was a quarter of the threads, at most 4, whatever the memory.
  - The kernels for an assembly's parts and drawing views use the budget, and those idle for 3 minutes are stopped to give their memory back.
- **Each open part keeps a kernel of its own** (as many as the budget allows, up to 8):
  - Switching back to a part is immediate, with no rebuild: the Giant Golfball back in front 86 ms after another part, where its kernel had to build it again before.
  - A part still building goes on building while you work in another tab.
  - One kernel is kept started ahead, so a new part doesn't wait for one to start.
  - A closed part's kernel is stopped. Past the budget, a new part takes the kernel of the part used longest ago, which then builds the new part (as all parts did before).
- Fixed: a rebuild started just before another tab came to the front could leave the first tab's kernel waiting for good.
- The kernels in use are noted in crash reports, e.g. "up to 12 at once (24 threads, 14.8 GB free)" on a PC with 24 threads and 14.8 GB free (memory is what limits it there).
- Regression test: kernel-per-tab (budgets for a small, mid-size and big PC; two parts each with their own kernel, the first still holding its part when it comes back; the closed part's kernel stopped; with a budget of one, the kernel lent).

## 2026-10-21 09:24 — Meshing only what changed; opening big parts at once
- **Editing a feature remeshes only what it changed.** A feature usually leaves most of a body's faces and edges as they were. Their triangles and edge points are now kept and reused, and only the new faces are meshed. The geometry library's mesher used to mesh every face again each time.
  - Giant Golfball, the last dimple edited: 2.3 s → 1.15 s; its meshing 1.75 s → 0.58 s.
  - The mesh is exactly the same as before (every vertex, normal, triangle and face).
- **Opening a big part: the kernel picks up where it left off.** The state after each feature is kept with the stored model, so after opening the kernel doesn't build the part again.
  - Giant Golfball: ready about 1.5 s after opening, instead of a 6 s rebuild.
  - Keeping those states now takes 0.3 s instead of 4.5 s. Before, every body's exact box was worked out while writing them, and the kernel was busy for those 4.5 s after the first build.
  - The stored model now shows while the states are read in, not after.
- **Stored models survive RazorCAD updates that leave the geometry kernel alone.** They used to be thrown away with every new RazorCAD.exe. They are now kept per geometry kernel: a hash of its code (`kernelsig.py`). A new kernel still starts afresh, as it may build differently.
- **The browser version keeps stored models too**, in the browser's own storage (up to 400 MB, the least recently used let go), so a big part opens quickly the second time there as well.
- Regression test: incremental-mesh (a plate with five holes, the last moved: the mesh the main kernel makes from its kept faces is exactly the one a fresh kernel makes).

## 2026-10-21 08:56 — Faster rebuilds of parts with many cuts
- **Giant Golfball: 12.9 s → 6.0 s to rebuild**, with the same geometry (volume, area, 179 faces, 367 edges, the same triangles).
- More than half of each cut's time went on bookkeeping around it, not on the cut:
  - An exact bounding box of the whole body after every cut (OpenCascade's precise box, slow on a body with many curved faces). The box is only used to skip tools that can't reach a body, and a cut body only gets smaller, so the box from before the cut is used for that. The exact box is worked out only when something needs it.
  - Two volume measurements of the whole body after every cut, to see whether the cut missed it. A cut that changed the faces hit the body, so the volumes are now measured only when the face count stayed the same.
  - Every sketch worked out the body's exact box for projected edges, even with none in it. Now only when a projection needs it.
- Editing the golf ball's last dimple: about 2.3 s, most of it meshing the whole ball again.

## 2026-10-21 08:40 — Accessibility: Property panels from the keyboard, labels for screen readers
- **Property panels from the keyboard**: Tab goes through a panel's fields and buttons. The group headings are buttons: Enter or Space opens or closes them. The small ✕ / ▲ buttons in lists can be pressed the same way. Tab on a panel button now moves the focus (it used to hide what was under the cursor), and Enter on a button presses it (it used to OK the whole panel).
- **F6 / Shift+F6** move the focus round the window: the Property panel (or the tree), the ribbon, the view.
- **Screen readers**: every panel field is named by its label and unit (e.g. "Depth (mm)"), fields with an invalid value are marked so, and icon-only buttons are named by their tooltips. Panel headings are headings. The status bar and panel messages are read out as they change, and errors and pop-up messages at once.
- **Dialogs** are named by their title. They take the focus when they open (their first field), keep Tab inside, and give the focus back when they close.
- The keyboard focus is outlined when it comes from the keyboard.
- Regression test: accessibility (the Extrude panel's fields named, headings open and close with Enter, Tab / Enter left to a focused button, F6 round the window, a dialog's focus in, round and back).

## 2026-10-21 08:35 — Performance tracking in the regression tests
- `tests/run_tests.py` keeps every run's times (each part's rebuild per configuration, each drawing, each UI test, the whole run) for each machine, the last 10 of each, in `tests/perf-history.json` (not in git).
- A **Performance** section after the results compares each time with the test's usual time (the median of its earlier runs, after 3 of them). A test markedly slower (1.5× and 300 ms more) is listed as SLOWER. The three slowest tests are listed too.
- `--perf` lists every time against its usual one; `--perf-strict` fails the run when something got slower. `--only` runs are timed but leave the whole-run time alone.
- On GitHub the Tests workflow keeps the history between runs, so slowdowns show there too.

## 2026-10-21 08:31 — Releases from a version tag
- New GitHub workflow **Release** (`.github/workflows/release.yml`), run only when a version tag is pushed (e.g. `v0.14.0-beta`), never on ordinary pushes. It checks the tag against `version.txt`, runs the regression tests, builds RazorCAD.exe and the setup (signed when signing secrets are set up), and drafts a release with the setup, its read-me and SHA-256 checksums. Betas are marked as pre-releases. Nothing is published until the draft is reviewed.
- `tools/release_notes.py`: the release notes from CHANGELOG.md, the entries added since the previous tag (test notes left out).
- `installer/RELEASING.md`: how to tag a release, and how to set up signing for it.

## 2026-10-21 08:29 — Speed mode for very large assemblies
- **Speed Mode** (Assembly ribbon, View menu): the parts are shown from simplified display meshes, made coarser by the kernel, with far fewer triangles to draw and keep in memory (a test assembly of round parts: 2096 → 600). The faces and edges stay the same, so mates, measuring, picking and collision detection work as before.
- A component you select is loaded in full. Turning speed mode off shows everything in full again.
- Saved with the assembly. The simplified meshes are cached like the full ones, so the assembly opens quickly next time.
- A large assembly (3 million triangles or 300 components) suggests speed mode in the status bar, once.
- Drawings, exports and Interference Check always use the exact geometry.
- Regression test: speed-mode (fewer triangles with the same faces, the selected component in full, back to full when off).

## 2026-10-21 08:25 — Check Drawing
- **Check Drawing** (Annotation ribbon, Tools menu) lists what a drawing still lacks before it goes out, most important first, grouped:
  - **Title block**: fields left empty (the sheet format's own fields, else the standard ones). Title, drawing number, drawn by, date, revision and material are to fix; checked and approved are noted, to be filled in at sign-off.
  - **Dimensions per view**: part views with no dimensions (a view whose sizes all show in other views is only noted), crowded views, annotations whose view was deleted and dimensions that lost what they measured.
  - **Undimensioned features**: the overall sizes, hole diameters, radii and hole positions that no dimension gives. A size given in one view is not asked for again in the part's other views, a hole callout gives a hole's diameter, and hole positions count in baseline, chain or ordinate style.
- Click an item to show its view or annotation. **Add Missing Dimensions** puts in what Auto Dimension would; **Title Block…** opens the drawing's properties.
- Regression test: drawing-check (a plate with three holes: the empty fields, 2 views without dimensions, the overall sizes and 3× Ø4; a hole callout covers the diameter; after chain Auto Dimension and the title block filled in, only notes are left; a note on a deleted view is reported).

## 2026-10-21 08:19 — Assembly features: holes and cuts made in the assembly, with fasteners
- **Assembly Hole** and **Assembly Cut** (Assembly ribbon, Insert menu): click points on a flat face of a component; the hole or cut goes in square from there, through all or to a depth, through every component behind it (listed in the panel, each can be left out).
- Holes: simple, counterbore, countersink or tapped, standard sizes (ISO 273 close / normal / loose) or custom. The first component gets the hole as chosen, the ones behind it a plain hole of the drill size; **Tap the last component** makes the last one tapped for the size (a cosmetic thread). Cuts: a rectangle, width × length, turned by an angle.
- **Fasteners**: hex bolts or socket head cap screws put in each hole as it is made, with washers and a nut on the far side if wanted, the length taken from the whole stack (a standard length), mated in the hole (into a tapped last component: a screw without a nut, about one diameter into the thread).
- Made in the assembly only: the parts' files are not changed. Each component cut gets the feature in its copy of its part, so the assembly's drawings (hole callouts too), BOM and exports have the holes. Move a component and its holes are worked out again (they stay with the component they were clicked on).
- The features are listed in the tree (Assembly Features): edit, suppress, rename, delete. Undo includes them.
- Regression test: assembly-features (two M8 holes through two plates, bolts / washers / nuts with no collisions, the kernel's assembly cut too, the tapped last component, a rectangular cut through both and its undo, and the holes following a moved plate).

## 2026-10-21 08:07 — Collision detection while dragging and in motion studies
- **Collision Detection** (Assembly ribbon, and Tools ▸ Collision Detection Off / Show Collisions While Dragging / Stop at Collisions While Dragging). While a component is dragged, the parts that run into others are shown in red with their names in the status bar; with Stop at Collisions the dragged component (and what its mates carry along) stops where it meets the other part, brought right up to it.
- Faces that only touch (mated faces) are not collisions, nor a shaft in a hole of its size, nor a screw in a nut or tapped hole (threads are cosmetic, so the screw is its full diameter in a bore of about its minor diameter). Parts that overlap already when the drag starts are left out.
- **Motion studies: Detect collisions** (on for new studies) checks every step: the parts that collide are shown in red as the motion plays, and the panel names the first collision and its step. **Stop at the first collision** ends the motion at the step before it.
- Quick: worked out from the parts' display meshes (a tree of each part's triangles, built once), not from the solids, so it keeps up with the mouse. Interference Check still gives the exact overlap volumes.
- Regression tests: collision-detection (pin in its hole and block on the plate clear; block 2 mm into the plate collides; the drag stops at the plate; the motion stops before step 5); standard-parts-2 now also checks that the bolts, washers and nuts seated in their holes do not collide.

## 2026-10-21 07:56 — Equations shared across an assembly
- **Assembly ▸ Equations…** (also in the Insert ribbon): the assembly's own variables, e.g. `base = 6`, `thickness = 2*base`. A variable that **drives the parts** sets the variable of the same name in every part that has one, through the sub-assemblies, so related parts are sized together from the top (top-down design).
- The table shows each variable's value, the parts it drives and a Drives the parts check box (off: a variable used only to work out others).
- The values are written into the assembly's copies of the parts, so the assembly, its drawings, BOM and exports use them, and they are applied again when a part is read again from its file. **Update Open Parts** writes them into the parts open in tabs too, to be saved there.
- Undo and redo include the equations.
- Regression test: assembly-equations (two parts made 5 thick by their own variable become 12 thick from the assembly; a part without it stays; undo puts it back).

## 2026-10-21 07:51 — Curvature control: 3D splines, curvature combs, lofts
- **3D sketch splines: Shape ▸ Curvature-continuous (C2).** The spline's curvature runs on smoothly through every point it passes, where the tangent-smooth shape (C1, as before) has small kinks in curvature. Select a spline to set it.
- **End weights:** how strongly a spline's end tangents pull (1 as before; more leaves the ends straighter), with a Tangent relation or a free end.
- **Show curvature:** combs drawn on the 3D sketch's splines (the selected ones when some are), so the curvature can be seen as it is shaped.
- **Lofts: Through the profiles ▸ Curvature-continuous (C2, as before) or Tangent-continuous (C1)**, and **Smooth the surface**, which evens out its bends.
- The 3D sketch's Selected list names splines properly (it showed "undefined").
- Regression test: curvature-splines (the C2 spline's curvature matches on both sides of every point: 3e-16 against 0.05 for C1).

## 2026-10-21 07:45 — Fillets: radius at each vertex, setback corners
- **Variable size fillets: Radius ▸ Set at each vertex.**
  - The Property panel lists the vertices of the selected edges (the ends of each run of edges) with a radius for each; ones left empty use the fillet's radius.
  - Along each edge the radius changes from the one at its start to the one at its end, so a run of edges can grow and shrink vertex by vertex.
  - The older "from the start to the end of each edge" stays.
- **Setback at corners** (constant and variable fillets): where three or more fillets meet, a distance blends the corner smoothly from that far out, instead of the usual small corner patch. It works by taking a ball of that radius out at the corner and filling it with a surface tangent to the faces round it; a little more than the radius works well. 0 keeps the usual corner. The fillet's note says how many corners were blended.
- Regression test: fillet-vertex-setback (R2 → R6 along a cube edge: the top face ends exactly 2 and 6 mm short of each end; three R4 fillets with an 8 mm setback: one solid with a blended corner).

## 2026-10-21 06:59 — IGES import, DXF into drawings, exact volumes of NURBS bodies
- **IGES files** (.igs, .iges) open and import like STEP files (File ▸ Open, Import).
  - Read: trimmed and bounded surfaces, B-rep solids, B-spline / plane / revolved / extruded / cylinder / cone / sphere / torus surfaces, lines, arcs, B-spline curves, composite curves, polylines, and the file's units and transformations.
  - Faces that close up are sewn into a solid; the rest come in as surface bodies.
  - (The geometry kernel has no IGES reader of its own, so RazorCAD translates IGES into STEP for it.)
- **Insert ▸ DXF Drawing…** on drawings places a DXF file's lines, circles, arcs, polylines (with bulges), ellipses, splines and texts on the sheet as one item. It goes in the middle of the frame at full size, or scaled down to a standard scale that fits. Drag it, right-click ▸ Scale…, or delete it; it prints and exports with the sheet.
- DWG is left out: no free DWG reader exists that could run in RazorCAD. Save the drawing as DXF from the program that made it.
- **Volumes are now exact for bodies with B-spline faces** (imported NURBS, IGES). The old measure could be off by up to about 1% on them; e.g. a NURBS cylinder came out 9501.6 mm³ instead of 9424.8. Bodies made of planes, cylinders and other plain faces are unchanged.
- Regression tests: iges-import (a box of trimmed planes, a NURBS cylinder and a B-rep tetrahedron, all to their exact volumes; written by tests/make_iges.py), dxf-into-drawing.

## 2026-10-21 06:45 — Compare two versions of a part
- **File ▸ Compare With…** compares the part in front with its last saved version, another part file, or another open part.
- **Features and settings:**
  - features added or removed;
  - features changed, with which settings (depth, sketch points, end condition, renamed from …);
  - features moved in the tree;
  - the part's own settings (material, equations, units, configurations, properties).
- **Shapes:** both versions' volumes, and the material this version **adds** (shown yellow on the model) and **removes** (red), with their volumes.
- Regression test: compare-versions (a plate made 2 mm thicker with a Ø10 hole: added 4642.92 mm³ and removed 785.40 mm³, both exactly as worked out by hand).

## 2026-10-21 06:41 — BOM mass, cost and totals; columns edited on the table
- **Mass and cost in bills of materials:** new column kinds Mass, Total mass, Cost and Total cost, with a **TOTAL** row (quantity, total mass, total cost).
  - Mass comes from each part's material and volume, worked out when the assembly builds the part; a sub-assembly adds up its parts.
  - Cost comes from a part's **Cost** property (e.g. 12.50, $3 or R12,50).
- **Columns edited right on the table:**
  - **Assembly ▸ Bill of Materials:** click a column heading. You can change what it shows (any field, property, mass, cost, or values typed in), insert a column left or right, move, rename or remove it. Typed values are edited in the table itself.
  - **Drawing BOM table:** right-click a column for the same menu; double-click a typed value to edit it. Columns… still has everything in one dialog.
  - The window's columns are kept with the assembly (Default Columns goes back to the usual ones), are part of undo, and are what Copy / Save CSV write.
- Context menus now also open over dialogs.
- Regression test: bom-mass-cost.

## 2026-10-21 06:35 — Auto Dimension options
- **Auto Dimension** now asks how to dimension. Your choices are kept for next time.
  - **Positions:** baseline (each hole from the edge, as before), chain (edge → hole → hole, on one row), or ordinate (values from the view's bottom left corner, on a row above and a column to the right).
  - **Tolerance:** e.g. ±0.1, added to the new lengths and diameters.
  - **Spread labels that would overlap:** texts on one row are moved apart, and hole and arc labels are moved further out along their leader.
  - **Add:** choose which kinds: overall sizes, hole diameters, hole positions, arc radii.
- Regression test: auto-dimension-styles (chain with ±0.1 and no overlapping texts, then ordinate).

## 2026-10-21 06:31 — Macros in assemblies and drawings
- **Record Macro** now records what you change in **assemblies and drawings** too, not only their commands:
  - in assemblies: parts inserted, components placed or moved, mates, explode steps, motion studies, configurations;
  - in drawings: views, annotations, sheets, models and the drawing's properties.
- Items made during the recording are kept in variables. Ones that were already there are found by name, so a recording plays back into another assembly or drawing.
- In macros: `rc.addItem`, `rc.setItem`, `rc.removeItem`, `rc.ref`, `rc.items` and `rc.setDoc` work on the assembly or drawing in front (see the API button). When the macro ends, parts are built, mates solved and views drawn, and its changes are one undo step there too.
- Regression test: macros-editors.

## 2026-10-21 06:27 — Standard parts: fastener sets, all holes, more types
- **Fastener sets:** a bolt or screw can take a **washer under its head** and a **washer and nut on the other side** of the hole. All of them are mated, and the bolt length is picked to suit (e.g. a 10 mm plate: M8 × 25).
- **Into all matching holes:** the same part (or set) goes into every hole of the same size, parallel to the selected one, in one go.
- **New types:**
  - socket set screws (ISO 4026), flush with the hole's end;
  - circlips for shafts and for bores (DIN 471 / 472, simplified rings with their gap);
  - parallel keys (DIN 6885 A, the size picked from the shaft);
  - round head rivets (ISO 1051).
- **Inch fasteners:** hex bolts (ASME B18.2.1), socket head cap screws (ASME B18.3), hex nuts (ASME B18.2.2) and SAE flat washers, 1/4" to 1", with UNC cosmetic threads and inch lengths (1-1/4" …). Fitted to clearance or tapped holes like the metric ones.
- **Holes ending on a curved face** (e.g. a cross hole in a round bar) now get a seat plane of their own. It follows the hole when the part changes.
- Regression test: standard-parts-2 (every type builds; four sets in a plate, 32 mates; the bar's hole end follows the hole).

## 2026-10-21 06:18 — Fonts that come with RazorCAD
- RazorCAD now includes the **DejaVu** fonts: Sans, Sans Mono and Serif, each in regular, bold, italic and bold italic. They are free to share, and their licence is in app/fonts.
- They are always in the font list for sketch text, and they work everywhere: in the browser version, in the tests and on PCs without the Windows fonts.
- A Windows font a PC (or the browser) doesn't have is drawn in the DejaVu font most like it: Times New Roman, Georgia and similar in DejaVu Serif; Consolas and Courier New in DejaVu Sans Mono; the rest in DejaVu Sans. This covers sketch text, engraving and drawing text, on screen and in PDFs.
- The browser version no longer asks for the PC's fonts it can't have.
- Regression test: bundled-fonts.

## 2026-10-21 00:21 — Report a problem on GitHub
- **Help ▸ Report a Problem…** and **Report on GitHub…** in the start window's crash notice turn a crash report into a GitHub issue in one click. Help ▸ Report a Problem can also send a plain report, without a crash.
- The report contains RazorCAD's version, Windows, what went wrong with its details, and the last lines of the session log. You see the whole text first and can edit it.
- Your user name and your folders are taken out, and the part you were working on is not included.
- **Open GitHub Issue** opens RazorCAD's new-issue page in your browser with the text filled in. Nothing is sent until you submit it there (with a GitHub account), so reporting stays your choice. **Copy Text** copies it instead.
- Regression test: report-problem.

## 2026-10-21 00:17 — More regression tests, and tests on GitHub
- **Tests on GitHub:** the regression tests now run on GitHub for every push and pull request (Windows, Microsoft Edge, the software renderer for the 3D view). The README shows whether they pass. They start running from the next push.
- **More tests:**
  - **Drawings against stored output:** six test parts drawn in the front, top, right and isometric views (sheet metal also as its flat pattern). The count of each kind of line and the size of every view must match the stored results.
  - **A sheet metal tray:** a 1.5 mm base with flanges on all four sides, closed corners, a hole and a slot. Its flat pattern (154.79 × 114.79 mm, 4 bends) checks out by hand.
  - **STEP round trip:** a part exported as STEP and imported again gives the same solid: volume, area, 12 faces and 20 edges.
  - **A big assembly:** 120 components of 3 parts. It loads, the bill of materials counts 3 × 40, and the assembly STEP export holds each part once.
- On small machines (such as GitHub's) the parallel-kernels test only asks for a smaller speed-up.

## 2026-10-21 00:10 — Other languages
- **View ▸ Language**: English, Deutsch, Français or Español, in parts, assemblies and drawings, kept with your preferences.
- Translated:
  - the menus, ribbons and their tabs;
  - the Property panels (headings, labels, choices);
  - dialog titles and buttons, the feature tree's fixed items and the start window;
  - the command search, which finds a command by its translated name or its English one.
- The common CAD terms are used for each language. Long German words break cleanly in the narrow toolbar buttons.
- Longer help texts and messages are still in English for now.
- Commands keep their English names inside, so macros, recorded macros and your keyboard shortcuts work in every language. Files are the same in every language.
- The dictionaries are built from tools/i18n (one numbered line per text) by tools/i18n/build_dicts.py.
- Regression test: languages.

## 2026-10-20 23:57 — Dark theme
- **View ▸ Theme**: Light, Dark, or Follow Windows (switches when Windows does). It is in the View menu of parts, assemblies and drawings, and kept with your preferences.
- In the dark theme:
  - the menus, ribbon, trees, Property panels, dialogs, messages and the start window are dark;
  - the 3D view has a dark background;
  - sketches draw fully defined geometry in light grey (instead of black) and the rest in a lighter blue, on a darker grid;
  - wireframe lines are light.
- Drawing sheets stay white paper.
- Regression test: dark-theme.

## 2026-10-20 23:52 — RazorCAD in the browser
- **A browser version** for the website (razorcad.com/app/, "Try it in your browser" on the home page). It is the same program running in the browser: parts, sketches, assemblies, drawings, macros, all on the same geometry kernel.
- In the browser, Save downloads the file and Open reads one from your PC; preferences stay in that browser.
- A notice at the top says what works differently (no auto-save, no Windows fonts, no Ask Claude sign-in) and links to the Windows app; ✕ closes it for good. Closing the tab with unsaved work asks first.
- Built by tools/build_web_app.py into website/app (also run by the website docs build). It goes online with the website, the next time that is published.

## 2026-10-20 23:47 — Part properties and BOM table columns
- **File ▸ Properties…** in parts and assemblies: custom properties such as Part Number, Description, Vendor or Finish (common names are suggested; any name works). Undo takes a change back. A drawing of a part takes its drawing number from the Part Number.
- **BOM table columns** on drawings: right-click the table ▸ **Columns…** (or double-click it). Each column shows one of:
  - a field: item, quantity, part, material, file or configuration;
  - any custom property the parts have;
  - values typed into the table, entered in a grid in the same dialog.
- Each column has its own heading and width and can be moved or removed. **Default Columns** goes back to ITEM | QTY | PART | MATERIAL. The table keeps its right edge where it was, so it stays inside the frame.
- The assembly's **Bill of Materials** window and its CSV have a column for each custom property too.
- Regression test: bom-columns.

## 2026-10-20 23:42 — Auto Dimension
- **Annotation ▸ Auto Dimension** (also Insert ▸ Annotations) dimensions the selected views, or every view on the sheet:
  - the overall sizes of each view, outermost;
  - hole diameters, one per size ("4× Ø9" for four holes of one size), with the leader pointing into the view;
  - arc radii;
  - hole positions from the view's left and bottom edges, one dimension per position.
- Each size is given once in the drawing: the front view's width and height, then the depth from the view below or beside it. Nothing is added that a view's own dimensions already give, so running it again adds nothing new.
- Only views looking along the part's axes are dimensioned (not isometric ones). A part with a round outline gets its diameter rather than its width and height.
- Everything it adds is one undo step; drag the dimensions to tidy them up.
- Regression test: auto-dimension (a 120 × 80 × 10 plate with four holes: 120, 80, 10, 4× Ø9 and the holes' positions; a second run adds nothing).

## 2026-10-20 23:36 — Macros
- **Tools ▸ Macros…**: write, run and save JavaScript macros that drive RazorCAD.
  - In parts they can sketch (lines, rectangles, circles, arcs, polygons), extrude, cut, revolve, add any feature, change or delete features, set equations and the material, and rebuild.
  - Anywhere they can run any command by its name in the command search, ask you for a value, and run other macros.
  - The **API** button lists what a macro can use, and a sample macro shows the idea.
  - A macro's changes to a part are one undo step. A part that was empty is zoomed to fit afterwards.
  - Errors show their line, which is selected in the editor. Ctrl+Enter runs; Ctrl+S saves.
- **Tools ▸ Record Macro** records what you do until **Stop Recording Macro** (or the red "● Recording macro" in the status bar):
  - the features you add, change, delete, reorder or undo in parts, and the part's own settings;
  - the commands you run from the menus, toolbars, command search or your shortcuts.
  - The recording opens in the Macros dialog to be saved or edited. Features made in the recording are kept in variables; other features are found by name, so a recording plays back into another part.
- Saved macros are in the Tools menu (**Macro: name**) and the command search, so they can have keyboard shortcuts. **Import…** / **Export…** share them as .js files.
- Macros can do anything RazorCAD can: run only macros you trust.
- Regression test: macros (a plate with four holes from one run; a recording played back into a new part).

## 2026-10-20 23:26 — Standard parts library
- **Assembly ▸ Standard Parts** (also Insert ▸ Standard Parts…) adds ISO parts made to size:
  - hex bolts (ISO 4017) and socket head cap screws (ISO 4762), M3–M24, in the standard lengths;
  - hex nuts (ISO 4032), washers (ISO 7089), dowel pins (ISO 8734, Ø2–Ø20);
  - 6000 and 6200 series ball bearings.
- Each is an ordinary part (threads shown as cosmetic threads, so they build fast). Choose its material: steel, stainless, brass or aluminium. The same type, size, length and material is one part however many times it is used, so the bill of materials counts them.
- **Select a hole first** (its round face or edge): the size is picked to fit it (a clearance or tapped hole for bolts, the bore for a bearing, the pin's diameter) and the length to go through it with room for a nut. The part goes into the hole at the end facing you, mated to it: Concentric, plus Coincident on the face round the hole. Heads, nuts and washers sit on that face; a bearing is flush with the bore's end; a dowel pin is half in.
- Regression test: standard-parts.

## 2026-10-20 23:15 — Update Now
- **One click to update.** When a newer version is out, the notice (and Help ▸ Check for Updates) offers **Update Now**. RazorCAD then:
  - downloads the new setup from its GitHub release and checks it against the release (size and SHA-256);
  - installs it in the background into the same folder, asking for administrator rights only when it was installed for all users;
  - closes, and starts again as the new version a few seconds later.
- Unsaved work is saved first (**Save All and Update**), or the update waits.
- If anything goes wrong (permission refused, the download fails), the version you had starts again. A copy of RazorCAD that wasn't installed with the setup keeps the **Download** button.

## 2026-10-20 23:11 — More geometry kernels at once
- **Assemblies build their parts side by side.** Extra geometry kernels start when they are first needed: up to 4, a quarter of the PC's processor threads. Six slow parts took 1.1 s instead of 2.8 s, and each part shows as soon as it is built.
- **Drawings use the extra kernels too:** views, fast assembly views (their parts built side by side), balloons and cut lists. Each model stays with the same kernel, so its build is reused. The interference check and assembly STEP export share one kernel, so they reuse the parts it built.
- The main kernel stays with the part you are editing. Building an assembly's parts no longer replaces its state, so editing the part right after is not slowed down.
- Regression test: parallel-kernels.

## 2026-10-20 23:08 — Motion studies
- **Assembly ▸ Motion Study** shows how an assembly moves. Choose a driver:
  - **turning a component** about the axis of one of its mates (360°, for example);
  - **sliding a component** along one of its mates' axes or faces;
  - **changing a Distance or Angle mate's value** from where it is to a new one.
- The motion is worked out step by step and the mates carry the other components along, gear and rack-pinion mates included. Turns of any size work: two full turns of a pinion slide its rack by two circumferences.
- **Play / Stop** (also Space), back to the start, a slider to go through the steps, the number of steps, the duration and **Loop**. Where the mates can't follow, it says at which step.
- ✔ keeps the study in the assembly's **Motion Studies** folder: double-click one to play it; right-click to edit, rename or delete it. Closing the panel puts the assembly back as it was; a motion study never moves the assembly itself.
- Regression test: motion-study.

## 2026-10-20 23:03 — Arrow keys in the trees
- **The feature tree, the assembly tree and the drawing tree can be used from the keyboard.** Click the tree, then:
  - **↑ / ↓** move from row to row, selecting each as a click does;
  - **←** closes a folder (or goes up to the folder a row is in), **→** opens it (or goes into it);
  - **Enter** opens the item, as a double-click does (edit a feature, open a part);
  - **Home / End** go to the first / last row.
- While the tree has the keyboard, the arrow keys no longer turn the view; click the view to give them back.
- Help ▸ Keyboard Shortcuts lists it.

## 2026-10-20 23:00 — Etch lines on sheet metal
- **Sheet Metal ▸ Etch Lines:** pick a sketch drawn on the top or bottom face of a flat part of the sheet. Its lines, arcs, circles, splines and text are marked in the flat pattern, for etching, scribing or marking part numbers and bend marks. They go on the DXF's **ETCH** layer (DXF Settings can leave them out) and show in drawing flat-pattern views (View Properties ▸ Etch lines). They are clipped to the face they are on.
- The folded part is not changed and keeps its name; the etch lines show on the model as thin lines.
- Regression test: sheet-metal-etch.

## 2026-10-20 22:54 — STEP export of assemblies
- **Assembly ▸ File ▸ Export ▸ STEP…** saves the whole assembly as one STEP file with its structure. Each part is stored once, in the configuration used. Every component is placed where it is and named after it, sub-assemblies stay assemblies, and the parts keep their colours (and multi-body parts their bodies' colours). Suppressed components are left out. Other CAD programs open it as an assembly; RazorCAD opens it back the same way.
- Fix: colours in exported STEP files (parts too) came out lighter than shown; they now match.
- Regression test: assembly-step-export (read back: 2 parts, 5 placed, the sub-assembly kept, names and positions).

## 2026-10-20 22:33 — Version 0.13.0-beta: installer
- **RazorCAD-Setup-0.13.0-beta.exe** built (in "RazorCAD Install"), with everything since 0.12.0-beta:
  - automated regression tests;
  - references that survive edits, with Fix References / Fix Mates;
  - the geometry kernel handling one request at a time;
  - cosmetic threads;
  - parts that reopen ready to edit;
  - faster patterns of added features;
  - code signing ready;
  - the update check;
  - inch units;
  - balloons and BOM tables;
  - exploded views on drawings;
  - assembly interference check;
  - gear and rack-pinion mates;
  - command search;
  - custom shortcuts;
  - the Getting Started Tour.

## 2026-10-20 22:32 — Getting Started Tour
- **A one-minute tour for new users:** eight short steps, each pointing at a part of the window: the toolbar, the feature tree, the view and its mouse buttons, how to make a first part (sketch, dimension, extrude), the command search and units. It ends with **Open the Sample Part**. Next / Back (or → / ←, Enter); Esc or Skip ends it.
- The first time RazorCAD starts, the start window offers it ("New to RazorCAD? Take the one-minute tour"). If the start window is closed on an empty part, the tour starts by itself, once. After that it is in **Help ▸ Getting Started Tour**.
- Regression test: getting-started-tour (the test runs skip the tour on their fresh first run).

## 2026-10-20 22:28 — Your own keyboard shortcuts
- **Help ▸ Customize Shortcuts…** (also from Help ▸ Keyboard Shortcuts ▸ Customize): find a command, click **Set** and press the keys you want (Ctrl+Shift+F, G, F6…). They work for the part, sketch, assembly or drawing in front, wherever that command exists. They are kept with your RazorCAD settings.
- A shortcut of your own takes the place of RazorCAD's own key, and the window says when it does (F instead of Zoom to Fit, for example). Giving a key to another command moves it there. Esc, Enter, Tab and Backspace can't be taken. ✕ removes one; Remove All removes them all.
- Your shortcuts show in the command search (Ctrl+K) and at the top of Help ▸ Keyboard Shortcuts.

## 2026-10-20 22:25 — Command search
- **Ctrl+K** (or **/**) opens a search box. Type part of a command's name, such as "fil" for Fillet or "circ pat" for Circular Pattern, then pick with ↑/↓ and Enter or click. It searches every command of the menus and toolbars of what is in front: part, sketch, 3D sketch, assembly or drawing. Each result shows where the command lives and its shortcut. The commands used lately come first. Also in Help ▸ Search Commands and as the magnifier next to Save.
- Help ▸ Keyboard Shortcuts lists it.

## 2026-10-20 22:22 — Gear and rack-and-pinion mates
- **Gear mate:** pick the cylinders of two gears (their pitch circles). Turn one and the other turns the other way, in the ratio of their radii; you can change the ratio. **Reverse** is for an internal gear (both turn the same way). In the tree it shows as e.g. "Gear1 1:2".
- **Rack-pinion mate:** pick the pinion's cylinder and a straight edge (or the flat face) of the rack. Turning the pinion slides the rack along it, by the pinion's circumference per turn (π × diameter, which you can change), and sliding the rack turns the pinion. **Reverse** changes the direction.
- Both relate the motion from where the parts are when the mate is made, so set the gears' teeth in mesh first. They follow turns of any size made step by step (dragging); one jump of more than half a turn can't be told from a turn the other way. Each removes one degree of freedom. The other mates still hold the gears on their axles (concentric and coincident mates).
- Regression test: gear-rack-mates.

## 2026-10-20 22:18 — Interference check for assemblies
- **Assembly ▸ Interference Check** (toolbar and Tools menu) finds where components overlap. Each overlap shows in red on the model and is listed with the two components (inside sub-assemblies too, as "Sub-assembly ▸ Part") and the overlap volume in the assembly's units. Faces that only touch, such as mated faces, are not counted, and nor are the bodies of one multi-body part against each other. An exploded assembly is collapsed first, so the check is of where the mates put the parts.
- Regression test: assembly-interference.

## 2026-10-20 22:15 — Exploded views on drawings
- **A drawing view of an assembly can show one of its exploded views:** View Properties ▸ Display ▸ **Exploded**. The components are where the exploded view moves them; the view keeps its place on the sheet. Its projected, section, auxiliary and detail views follow, and balloons placed on it pick the moved parts. Set it back to "Not exploded" at any time.
- Drawings with exploded and plain views of the same assembly no longer build its parts again for each: the kernel keeps the latest parts it built for drawings.
- Regression test: exploded-drawing-view.

## 2026-10-20 22:12 — Balloons and bill of materials on assembly drawings
- **Annotation ▸ BOM Table:** the drawing's assembly as a table (ITEM, QTY, PART, MATERIAL), placed at the top right of the sheet; drag it anywhere. Right-click it to show the sub-assemblies' parts too (indented). It follows the assembly when its parts change.
- **Annotation ▸ Balloon:** click a part in a view, then where the balloon goes. The circled number is that part's item in the bill of materials, found from the part under the click, also in sub-assemblies (their item at the top level). Keep clicking for more balloons; Esc ends. Where no part can be told, it asks for the number (the next free one is offered). Right-click a balloon ▸ Item Number to change it.
- The assembly's own Bill of Materials window and the drawing tables share the same rows.
- Regression test: assembly-drawing-bom-balloons.

## 2026-10-20 22:08 — Inch units
- **Each part, assembly and drawing can be in millimetres or inches.** Click **MMGS / IPS** in the status bar (or Tools ▸ Units). The sizes stay exactly as they are; only how they are shown and typed changes.
- **In an inch document:** feature fields show and take inches (the arrow keys step 0.1 in, Shift 1 in). Sketch dimensions, the Modify box and the drawing tips are in inches, and so are Measure (in, in², in³) and Mass Properties (also lb). New features start at round sizes (to 1/8 in).
- **Units in any value:** `2in`, `30 mm`, `1.5cm`, `2ft`, `(w/2)*in`; the result is in millimetres. In an inch document, variables count in inches when used in a length (`w/2` with w = 3 is 1.5 in). Values typed before a document became inch keep their size: an expression shows as `(…)*mm`.
- **Drawings:** an inch drawing (Drawing Properties, or the status bar) dimensions in inches with 3 decimals, and its title block says "in". A drawing made from an inch part starts in inches. Angles and the K-factor are never converted.
- Regression test: inch-units.

## 2026-10-20 22:01 — Update check
- **RazorCAD says when a newer version is out.** A little after it starts (at most once a day), it asks GitHub for the newest RazorCAD release. When that is newer, a notice in the corner offers **Download** (opens the release page), **Later** or **Skip this version**. Nothing is shown when you are up to date or offline, and only GitHub is asked.
- **Help ▸ Check for Updates…** checks now and says what it found. It also has the switch for the check at start.
- **Help ▸ About** shows the version. The session log and crash reports record it too.
- Pre-releases count (0.12.0-beta < 0.12.0-rc1 < 0.12.0). Only RazorCAD's own GitHub pages can be opened from the app this way.

## 2026-10-20 21:58 — Ready for code signing
- **The builds sign RazorCAD once a code-signing certificate is set up.** `build.bat` signs RazorCAD.exe and its thumbnail DLL; `installer\build_installer.bat` signs the DLL it installs and the setup itself. Each file gets SHA-256 with a timestamp and is checked with `signtool verify`; a failed signing stops the build. Without a certificate the builds say "Not signed" and carry on as before.
- **`tools\sign.py`**: takes a certificate on a USB token or in the Windows certificate store (by thumbprint), a .pfx file (password only from an environment variable), or a cloud signing service. `--check` shows what is set up; `--dry-run` shows the signtool command. Settings go in environment variables or a `signing.local.json`, which git ignores (as it does .pfx files).
- **installer\SIGNING.md**: how to get a certificate (a certificate authority, a cloud signing service, or free open-source programmes), how to install signtool, and how to set it up.
- The installer's **"Read me first.txt"** matches the setup: signed, it says how to check the publisher; unsigned, it keeps the "More info ▸ Run anyway" steps.

## 2026-10-20 21:54 — Faster patterns of bosses and other added features
- **Linear, circular and other patterns of an added feature** (bosses, ribs, pins…) now fuse all their copies into the body in one operation, as patterns of cuts already did. Before, each copy was fused on its own, and each fuse was slower than the last as the body grew. A plate with 200 bosses builds in 2.0 s instead of 8.8 s; 50 bosses in 0.58 s instead of 0.89 s. The result is the same.
- Copies that reach no body still become bodies of their own. Unusual cases (a copy bridging two bodies, loose copies overlapping each other) are still done copy by copy, as before.
- Mirrors were already a single operation (one copy).
- Regression test part: boss-pattern.

## 2026-10-20 21:51 — Parts reopen ready to edit
- **The geometry of every feature is kept between sessions.** When a part that takes a while to build is saved (or opened, then left unchanged), RazorCAD also stores the geometry kernel's state after each feature next to the stored model. Opening the part again restores it instead of building every feature, so the **first change after opening is as quick as any later one**. Before, the kernel rebuilt the whole part in the background first. Example: a sphere with 120 cut dimples was ready 1.8 s after opening before, now 0.09 s, and editing its last feature rebuilds only that feature.
- The stored states are checked feature by feature: anything changed since (in RazorCAD or in the file) is rebuilt from that feature on, as usual. They live with the stored models (%LOCALAPPDATA%\RazorCAD\modelcache, shared limit 1 GB, oldest removed first); shapes shared between features are written only once.
- Parts that build quickly (under 0.8 s, counting every feature) are not stored. The stored model now also follows the cost of the whole part, not just the last (quick) rebuild, so a big part saved after a small change is still stored.
- The session log notes how soon the model was ready after opening.
- Regression test: feature-states-kept (every test part written out, read back and rebuilt from it with the same result).

## 2026-10-20 21:36 — Cosmetic threads
- **Insert ▸ Features ▸ Cosmetic Thread** (also on the Features toolbar): click a bore or a shaft and choose the thread (metric or inch, automatic size from the face, custom, pitch, left-hand). Length: the whole face, a depth, or up to a plane / face; it starts at the end nearest where you clicked. The thread is **shown but not modelled**, so it costs nothing to rebuild, unlike Thread Cut / Thread Extrude. The feature's note says when the face is not the size the thread expects.
- **In the model:** a thin bronze helix on the bore or shaft. **Tapped holes** made with the Hole feature now show their thread the same way.
- **On drawings**, drawn by convention: from the side, thin lines at the thread's other diameter and a line where it ends (a bore's thread dashed, as it is hidden, unless a section cuts through it); end on, a ¾ circle. View ▸ Display ▸ **Cosmetic threads** turns them off for a view. Works in assembly drawings too.
- **Hole callouts** on a bore with a cosmetic thread give the thread: "M10×1.5 THRU ALL / TAP DRILL Ø8.5 THRU ALL".
- Fix: a feature reused from the rebuild cache keeps its list of missing references (Fix References ▸ Remove missing).
- Regression test: cosmetic-threads.

## 2026-10-20 21:30 — Geometry kernel: one request at a time
- The geometry kernel now finishes each request before it starts the next, in the order they were asked. A rebuild that pauses part way (while it reads an imported STEP or 3MF file, or an export being packed) no longer lets another request (a measurement, an export, a drawing view) run in that pause on a half-built model and reset the kernel under it. Before, an export asked for during such a pause could fail with "There is no body to export" or export the previous model.
- Crash reports also record how many kernel requests were waiting.
- Regression test: kernel-one-at-a-time.

## 2026-10-20 21:27 — References that survive edits; Fix References
- **Edges are found again after bigger changes.** An edge reference (fillets, chamfers, axes…) now also remembers the faces on its two sides and whether it is an outside or inside corner. When a dimension moves the edge so far that other edges lie nearer its old place, RazorCAD still finds the right one. It no longer takes a nearby edge of a different kind for it.
- **Faces that moved are found again** (shell, draft, faces picked for other features): the face facing the same way that is clearly nearest. A reference found this way is updated in the part, so it keeps following the model.
- **Mates follow their parts.** A mate's face or edge is checked by its geometry, not only by its number in the part. After a part gets a new feature (its faces numbered differently) or a dimension moves the face, the mate stays on the same face. A mate whose face or edge is gone is marked with a red **!** in the tree ("1 mate lost a face"), instead of quietly moving to another face.
- **Tools ▸ Fix References** (also: click the red error count in the status bar, or right-click a failed feature) lists every feature that failed to rebuild, what went wrong and which edges / faces are no longer found. For each: **Edit** (pick again), **Remove missing** (keep the references still found) or **Suppress**. The list updates after every rebuild. In assemblies: **Tools ▸ Fix Mates** (Edit / Suppress / Delete).
- Regression tests: references-follow-edits and mates-follow-part-edits.

## 2026-10-20 21:16 — Automated regression tests
- **`python tests/run_tests.py`** rebuilds 11 test parts with the real geometry kernel in headless Edge and compares the results with stored ones: feature errors and, per body, face / edge count, volume, area (sheet metal: flat-pattern size and bends), in every configuration. Covered: extrude, cut, linear and circular patterns, fillet, revolve, shell, sweep, loft, reference plane, sheet-metal base and edge flanges, multiple bodies and combine, counterbored holes, surface extrude and thicken, a one-operation cut pattern, structural members, equations and configurations.
- **UI checks** done with real pointer events: sketch a rectangle, dimension it, extrude it (checks the volume); a drawing with three views; an assembly of two components; the mouse buttons on the view.
- Exit code 1 on any difference; `--update` stores new expected results, `--only` runs a few, `--make-parts` regenerates the test parts from `tests/make_parts.js`. See `tests/README.md`.

## 2026-10-20 20:59 — Tool wheel on the right mouse button; Shift + right-drag pans
- **Sketch tool wheel:** press and hold the **right** mouse button in a sketch (or start dragging with it), move toward a tool and release. It no longer clashes with rotating the view: holding the middle button still while starting to rotate used to open the wheel.
- **A quick right click** (press and release without moving) still opens the right-click menu, in sketches and everywhere else. The browser's own menu no longer appears when the wheel closes.
- **Pan: Shift + right-drag** (Ctrl + right-drag and Ctrl + middle-drag also pan). A plain right-drag no longer pans.
- The middle button only turns the view (Ctrl: pan, Shift: zoom, Alt: roll). Drawings keep their own controls.
- Help ▸ Keyboard Shortcuts, README and the user manual describe the new buttons.

## 2026-10-20 20:36 — Version 0.12.0-beta
- `version.txt` 0.11.0-beta → **0.12.0-beta**, for the release with everything since 0.11.0-beta: drawings of assemblies (with fast hidden lines for big assemblies), the drawing tree fix, and some features and tools renamed.
- Installer `RazorCAD-Setup-0.12.0-beta.exe` and the user manual rebuilt.

## 2026-10-20 20:21 — Some features and tools renamed
- Some features, sketch tools, drawing tools and a ribbon tab have new, plainer names.
- Features in parts saved earlier that still carry an old default name are renamed when the part is opened; names you typed yourself are kept.
- README, user manual, website page and the Part Builder template use the new names.

## 2026-10-19 — Drawings of assemblies; drawing tree fix
- **Drawings of assemblies**: a drawing view can show an assembly as well as a part.
  - Model View and Standard Views list open assemblies, and Browse takes a .rasm file. **File ▸ Make Drawing from Assembly** (in an assembly) makes a drawing with its three standard views.
  - Every component is drawn where it sits, through its sub-assemblies, in the configurations shown. Suppressed and hidden components are left out.
  - Each part is built once and placed for every component that uses it. Section, detail, projected and other views, hole callouts and cut lists work on assemblies too.
  - **Big assemblies are drawn fast.** Above about 200 solids (or 600,000 display triangles), plain views are worked out from the parts' display meshes, the same ones the 3D view draws and keeps in the model cache. Hidden-line removal on thousands of solids took many minutes per view.
    - How it works: everything is drawn into a depth grid as the view sees it, then each edge, and the outline of each curved face, is followed over the grid. An edge is visible where nothing is in front of it and hidden where something is.
    - Lines, circles and arcs come out as they are, as exact as the 3D view's. Where an edge turns hidden is accurate to about two thousandths of the view's size.
    - On a 2,400-solid, 3.2-million-triangle site layout: a new drawing with its three standard views in about 25 s, and about 3 s per view after that (exact views took more than 9 minutes each). On a small test assembly, the visible lines matched exact hidden-line removal everywhere.
    - Each assembly view has **Hidden lines: Automatic / Exact / Fast** in its properties. Section and flat-pattern views are always exact.
- **The drawing tree's part row stays in its place.** It took on the look of a sketch dimension label (a white box floating over the tree), so it covered the drawing's name and moved off when the panel was widened.

## 2026-10-19 07:10 — Version 0.11.0-beta
- `version.txt` 0.10.0-beta → **0.11.0-beta**, for the release with everything below since 0.10.0-beta (STEP assemblies with their sub-assemblies and appearances, the assembly model cache and instanced display, sub-assemblies, drawing templates and sheet formats, PC fonts, the new logo, assembly picking, selection filters, planes, separate part files, no zoom-out limit).
- The installer is `RazorCAD-Setup-0.11.0-beta.exe`; the user manual is rebuilt for it.

## 2026-10-19 07:07 — Assembly picking, selection filters, planes, and saving parts as separate files
- **Picking in the 3D view is fixed**: the part under the cursor is the one picked, on any size of model. The pick ray used to start at the camera's position, which can be metres inside a big assembly, so it passed through the nearest parts and picked one behind them, and some parts couldn't be picked at all. On a 2,400-solid layout, picks now match what is drawn on top everywhere (they were right only 86–97% of the time).
- **Assemblies use the selection filters, as part files do.** With no filter, a click picks the vertex, edge, face or plane under the cursor; with the Bodies filter, whole components. Ctrl adds or takes away. The one under the cursor shows in orange. Dragging still moves the component.
  - Right-click a face, edge or vertex for Mate… and the component's commands. What is selected goes into Mate (M).
- **Every assembly has the standard planes and the origin** (Front, Top, Right Plane, Origin) at the top of its tree, imported or new. They show in the view like a part's (eye in the tree, View ▸ Show Planes), and mates can use them: they stay put, like the origin.
- **Mates find the other alignment** when the one chosen from how the faces sit can't be reached (e.g. faces at right angles), unless Flip was used.
- **Saving an assembly whose parts and sub-assemblies are only inside it** (e.g. from a STEP file) asks whether to keep them in one file, or save each as a file of its own beside the assembly (.rcad for parts, .rasm for sub-assemblies, those inside a sub-assembly saved before it). The assembly then uses those files, so each can be opened and changed on its own.
  - The same part used in several places is one file. Existing files are only replaced after asking.
  - The question is asked again on Save As, until the assembly is saved as one file.

## 2026-10-19 00:40 — No limit on zooming out
- **The view zooms out as far as you like.** It used to stop at about 10 m tall, so a big layout couldn't be zoomed out past Zoom to Fit, and the mouse wheel jumped back in.
- **The 3D view's depth follows the model's size and where the view has been panned to**, instead of a fixed ±20 m (still the least), so very large models are never cut off when turned.

## 2026-10-19 00:28 — Sub-assemblies, and STEP appearances kept
- **Sub-assemblies**: a component can use an assembly instead of a part, kept whole with its own parts, components, placements and configurations.
  - Insert Components ▸ Browse takes a .rasm file as well as a part. An assembly can't go inside itself.
  - A sub-assembly moves, hides, suppresses and explodes as one. Clicking any of its parts picks it, and selecting it highlights all its parts.
  - Mates can use faces, edges and vertices of the parts inside it, and follow them when they change.
  - The tree shows each sub-assembly's components under it (▶ to open), as deep as they go. Double-clicking one opens it in its own tab, and Open Sub-assembly does the same for the component. Changes made there come back to this assembly.
  - The Bill of Materials is indented: a sub-assembly's parts are listed under it (1.1, 1.2…), with quantities for one of it.
  - The same part in several places, inside sub-assemblies or not, is built once and drawn once.
- **STEP assemblies keep their structure**: Open as an Assembly makes a sub-assembly for each sub-assembly in the file, used wherever the file uses it, instead of flattening everything into one level.
- **STEP appearances are kept**: the colour of each solid and of single faces, and transparency.
  - Imported bodies and faces show them in parts and assemblies, whether the file opens as an assembly or as one part, is inserted into a part, or is a single-part file.
  - A body's own appearance or transparency setting still wins. An imported transparent body can be made opaque.
  - The appearances stay with the bodies through later features.
  - Each solid and face is found again by the box round its vertices, with solids that have none (spheres) in file order.
  - Part appearances set in RazorCAD (a body's colour, made transparent) now show in assemblies too.

## 2026-10-18 21:34 — New RazorCAD logo
- **The RazorCAD logo**: a sliced decahedron, its upper piece lifted clear to show a hatched section face, on the red tile.
  - It replaces the "R" mark in the title bar and shows in the About box, as the page icon, and in the Windows icon (`assets\razorcad.ico`).
  - `tools\make_icon.py` draws every size from one set of geometry: `assets\razorcad.svg` (copied to `app\razorcad.svg`), the multi-size `.ico` (no hatching below 48 px) and `assets\razorcad-512.png`.

## 2026-10-18 21:32 — Assemblies drawn part by part: moving a component is instant
- **An assembly draws each part once and places it at every component that uses it**: the part's mesh goes to the graphics card once, and each component is just a placement. Before, every component was copied into one big mesh.
  - Moving (dragging), hiding, suppressing or exploding a component only changes placements. On a 2,400-solid, 3.2-million-triangle layout, each drag step takes 0.2 ms instead of about 2.2 s, and showing the assembly takes 0.7 s instead of 2.2 s.
  - Without the copy, the 3D view uses about 1.3 GB less memory on that layout. Reopening it from the model cache takes 4 s instead of 6 s.
  - Edge lines are drawn per placement on the graphics card too.
  - Picking a component, face, edge or vertex goes through its placement to the part's own face and edge numbers. Face picks were checked against the old merged view and are identical.
  - Edge and vertex picking (for mates) only looks at the components near the cursor.
- Display styles (shaded, shaded with edges, hidden lines removed, wireframe), selection and hover highlights, Zoom to Fit and file previews work as before.

## 2026-10-18 21:25 — Assemblies reopen in seconds
- **Each part an assembly builds is kept in the model cache** (the one parts already use, in `%LOCALAPPDATA%\RazorCAD\modelcache`). It is keyed by a hash of the part as built, including the configuration used.
  - Opening the assembly again reads every stored part at once and shows them straight away. The kernel only builds parts that changed or were never built, then stores them for next time.
  - A part whose rebuild had errors is not stored.
  - Edge points are stored as 32-bit floats (the precision of the vertices), not as text, which halves the cache size.
  - On a 130 MB, 2,400-solid layout imported as an assembly: **reopening takes 6 s instead of 110 s**, from 40 MB of cache. The first open is unchanged.

## 2026-10-18 21:10 — STEP assemblies open as assemblies
- **Opening a STEP file that holds an assembly** asks whether to open it **as an assembly** or **as one part**.
  - As an assembly, each part of the file becomes a part of the assembly. A component is placed, fixed, where the file places each occurrence, with the part and product names from the file.
  - Each part holds only its own piece of the STEP file. It is read and built on its own, which takes less kernel memory than one huge part, and a part used several times is read once.
  - Parts take the colour the file gives most of their solids, until they get a material. Sub-assemblies are flattened into the one assembly.
  - The assembly structure is read straight from the file text, in a background worker (a few seconds for a 130 MB file).
  - On a 130 MB, 2,400-solid layout: 110 s to open instead of 131 s, and 930 MB of kernel memory instead of 1,445 MB, with the same placement to the millimetre.
- **Assembly undo no longer copies the parts**: each undo step keeps a reference to the part copies (a few KB) instead of copying them (which could be over 100 MB for imported parts).
- An assembly opened from a file is zoomed to fit once its parts are built.

## 2026-10-18 20:08 — Company sheet formats, drawing fonts and Change Template
- **A drawing template can carry its own sheet format**: a company border, title block and logo in place of the standard ISO one.
  - It is used on sheets of its size and orientation; a sheet changed to another size gets the standard format.
  - Its text shows the drawing's properties (title, drawing number, material…) and the scale, sheet size and sheet number.
  - Drawing Properties lists the title block's own fields (e.g. Ref No., Type, Status).
  - Views placed by Make Drawing from Part keep clear of its title block.
- **Pictures in drawings**: a sheet format's logo shows on screen, in file previews and in PDF exports (JPEG); DXF exports leave it out.
- **A sheet format can set its text in a font from the PC** (e.g. Century Gothic), read from the Windows Fonts folder like sketch text fonts (nothing is bundled). Text is measured in that font, and PDF exports embed it, so they look the same on any PC. If the PC doesn't have the font, the text falls back to Helvetica.
- **Century Gothic** is added to the fonts for sketch text.
- **Change Template…** (File menu, Sheet tab, and right-clicking the drawing in the tree) switches an existing drawing to another template.
  - The template brings its sheet format, sheet size, orientation and projection (on every sheet), drawing settings and notes. The old template's notes are replaced.
  - Company, tolerance and finish come from the new template. Other title block entries the drawing already has are kept.
  - Views, dimensions and annotations stay. Edit ▸ Undo goes back.
- **Changing the projection** (Change Template or Sheet Properties) lays the views out for the new projection. A view above or below its parent moves to the other side, so a top view stays a top view. A view beside its parent stays put and shows the side the new projection puts there. The views stay centred where they were.

## 2026-10-18 16:34 — Drawing templates and a New Drawing set-up dialog
- **Drawing templates (.rdrt), a file type of their own:**
  - A template keeps a drawing's set-up: its sheets (size, orientation, scale, projection), the drawing settings (text height, decimals…), the title block's standing entries (company, drawn / checked / approved by, finish, tolerances, revision) and notes placed on the sheet.
  - Part-specific entries (title, drawing number, material, mass, date), views and parts are not kept.
  - **File ▸ Save as Template…** in a drawing saves one, by default to `Documents\RazorCAD\Templates`.
  - Opening a .rdrt file edits the template in its own "Drawing Template" tab; Save writes it back.
  - Templates get an Explorer preview like other RazorCAD files, and .rdrt opens with RazorCAD.
- **New Drawing opens a set-up dialog** (also used by Make Drawing from Part):
  - Choose a template: your templates (from the Templates folder, or Browse… for one anywhere; browsed templates are remembered), or the standard ones: A4 portrait / landscape, A3, A2, A1, A0 landscape, and A3 / A4 in third angle projection.
  - Set the drawing name, title, drawing number, drawn by and company, and the first sheet's size, orientation, scale and projection. These are filled from the template and can be changed.
  - **"Use this template as my default"**: the default is marked and chosen first next time. Double-click a template to create the drawing at once.

## 2026-10-18 16:40 — Licensed under the GPL-3.0
- RazorCAD is free software under the GNU General Public License v3.0 or later (`LICENSE`).
- `THIRD-PARTY-NOTICES.md` lists the bundled libraries and their licenses (Open CASCADE under the LGPL-2.1; replicad, three.js and others under MIT) and the changes made to them.
- Help ▸ About RazorCAD shows the license and where the source is. The installer installs `LICENSE.txt` and `THIRD-PARTY-NOTICES.md` next to RazorCAD.exe and mentions the license on its first page.

## 2026-10-18 16:10 — First public release (GitHub)
- Source published at https://github.com/Labs9119/RazorCAD; the installer and manual are attached to the 0.10.0-beta release.
- Installer read-me: crash reports and feature requests go to GitHub Issues.

## 2026-10-18 15:44 — Project Edges works on selected edges
- **Select model edges first, then click Project Edges (or press E)**: the selected edges, vertices or other sketches' entities become real sketch geometry at once (solid, purple, linked to the source, ends joined), and the Select tool stays active.
  - Before, the tool ignored the selection. Clicking an edge with Select only makes a temporary reference for relations and dimensions: dotted construction geometry that is not part of the profile. So selected-then-converted edges stayed dotted and unusable.
- With nothing selected, Project Edges works as before: click the edges to convert.

## 2026-10-18 15:02 — Projected (converted) sketch geometry: visible, and usable as profiles
- **Projected / converted geometry is purple.** Lines, arcs and circles linked to model edges or other sketches (Project Edges, intersection curves, linked offsets) are now drawn in purple. Before, they were near-black like the model edges they usually lie on, so they could not be seen.
- **Converted entities join up.** Project Edges now joins the ends of the new lines with each other and with sketch geometry already at those points. Converting the edges of a face gives a closed outline that can be extruded or cut; before, each line kept its own ends and the sketch had "no closed profile".
- Converting something already in the sketch no longer stacks a copy on top: the status bar says it is already there.
- The linked outline still follows the model: widening the source part moves the converted corners, and the features made from them update.

## 2026-10-18 10:44 — Faster opening and tab switching; tabs show file names
- **Opening a part shows it at once:**
  - After a part that takes a while to build (over 0.8 s) is built, its finished model is stored, about 2 MB under `%LOCALAPPDATA%\RazorCAD\modelcache`.
  - Opening the unchanged file again shows that model straight away, and the kernel rebuilds it in the background ("Rebuilding…" in the status bar).
  - The store is keyed by the file's content, so a changed file is always rebuilt. It is cleared whenever RazorCAD.exe is rebuilt and kept under 1 GB.
  - Giant Golfball: 13 s → 0.3 s to see it.
- **Switching tabs shows the part at once:** each tab keeps its last model; the kernel catches up behind it. Before, every switch rebuilt the whole part.
- **Patterns of cuts are much faster:** the copies of a cut feature are cut out in one operation instead of one after another, which got slower with every cut.
  - Giant Golfball (11 circular patterns of dimples): 60 s → 13 s to rebuild, with identical geometry (same volume, area, faces and edges).
  - Sheet metal keeps the old one-by-one way.
- **Tabs and the title bar show the file's name.** A part, assembly or drawing still called by its default name (Part1, Assembly1…) takes its file's name when opened or saved, and assembly components are named after the part's file.
- Safer while a rebuild runs: other kernel requests (measure, export…) wait for it. A rebuild result arriving after another tab came to the front is no longer applied to that tab.

## 2026-10-18 10:24 — Explorer previews set up automatically
- Fixed: previews didn't show in Explorer because nothing was registered until Help ▸ Open Files With RazorCAD ▸ Register was clicked.
- RazorCAD.exe now sets this up itself when it starts:
  - `.rcad`, `.rasm` and `.rdrw` are made to open with it when they aren't set up yet, or when the RazorCAD they pointed to no longer exists.
  - Their Explorer previews are turned on.
  - Types set to another RazorCAD.exe that still exists are left alone.
- The previews are also registered under SystemFileAssociations, so they still show if the files are set to open with RazorCAD through "Open with".

## 2026-10-18 10:18 — File previews (thumbnails) for parts, assemblies and drawings
- **Saving keeps a preview in the file:** a picture of the view as it is when you save.
  - Parts and assemblies: the model framed as seen, on the view's background. A JPEG of up to 400 px, about 15 KB.
  - Drawings: the sheet shown. A PNG of up to 400 px.
  - It is written first in the file, so it can be read without loading the rest.
- **Windows Explorer and Open / Save dialogs** show the preview as the file's thumbnail.
  - New thumbnail handler (`shell\RazorCADThumbs.cs`), built by build.bat with the .NET Framework compiler that comes with Windows, and bundled in RazorCAD.exe.
  - It is set up with the file types: Help ▸ Open Files With RazorCAD ▸ Register (or Register Again), or by the installer. The dialog shows whether previews are on.
- **Start window:** each recent file shows its preview; files without one show their type's icon.
- Previews are dropped when a file is opened, so they never end up in memory, undo, or the copies of parts kept in assemblies and drawings.
- Files saved before this version show a preview after their next save.
- Installer script (not rebuilt): ships `RazorCADThumbs.dll`, registers the previews with the file types, and the uninstaller removes them.

## 2026-10-18 09:59 — DXF preview: zoom, pan, delete lines, change line type
- The DXF export preview (flat patterns) is now interactive:
  - **Zoom** with the mouse wheel (at the cursor), **pan** by dragging, **double-click** or **Fit** to see it all.
  - **Select** lines by clicking them (Ctrl / Shift + click adds or removes), **Shift+drag** for a box selection, Ctrl+A for all. The line under the cursor is highlighted.
  - **Delete** (Del key or button) removes the selected lines, text or notes from the file.
  - **Line type:** give the selected lines their own line type (Continuous, Dashed, Hidden, Center, Phantom, Dash-dot, Dot), or back to By layer.
  - **Layer:** move the selected lines or text to another layer (e.g. make a line a bend line or an etch line); they take that layer's colour and line type.
  - **Undo** (Ctrl+Z) and **Restore All** put deleted or changed lines back. Escape clears the selection (with nothing selected it closes the preview).
- What is shown is what is written. A line with its own line type is written with it (DXF group 6), and that line type is added to the file's line-type table.
- These edits are for that one export; the layer settings and options work as before.

## 2026-10-18 09:52 — DXF export from the flat pattern view
- While a flat pattern is shown (Sheet Metal ▸ Flatten, or right-click a sheet metal body ▸ View Flat Pattern), it can be exported straight to DXF:
  - **Export DXF…** button on the flat pattern banner, next to Exit Flatten.
  - **Right-click the view:** Export Flat Pattern as DXF (the body shown), Export All Flat Patterns as DXF, DXF Settings, Exit Flatten.
  - **File ▸ Export ▸ Flat Pattern as DXF…** (new), and File ▸ Export ▸ Face as DXF / the Export Face as DXF button, which export the flat pattern while one is shown.
  - Sheet Metal ▸ Export DXF exports the body being shown, even when the part has several sheet metal bodies and none is selected.
- The pattern already shown is exported as it is (no second flattening). The DXF preview with layer colours and options opens as before.

## 2026-10-18 09:40 — Own file extensions: .rcad, .rasm, .rdrw (open with a double-click)
- **New extensions:** parts save as **.rcad**, assemblies as **.rasm** and drawings as **.rdrw**. They are still JSON inside.
  - Windows picks the default app by the last extension, so the old `.json` names could only open with whatever opens `.json`.
  - Auto-saves keep the part's extension (`Bracket.autosave.rcad`).
- **Opening from Windows:** `RazorCAD.exe "file.rcad"` (double-click, Open with) opens the file instead of the start window.
  - If RazorCAD is already running, the file opens in a new tab there and that window comes to the front. No second copy stays open.
- **Help ▸ Open Files With RazorCAD (.rcad .rasm .rdrw)…** shows whether the types are registered and to which RazorCAD.exe. **Register** makes them open with this RazorCAD.exe for your Windows user.
  - Or right-click a file ▸ Open with ▸ Choose another app ▸ RazorCAD.exe ▸ Always.
- Installer script (not rebuilt): a new option, on by default, "Open .rcad, .rasm and .rdrw files with RazorCAD" (`/NOASSOC` to skip). The uninstaller removes the file types.
- Part files that start with a UTF-8 byte-order mark (e.g. edited in Notepad) now open.

## 2026-10-18 09:27 — Exploded views; section hatching per body with outlines
- **Exploded views for assemblies and multi-body parts** (the display moves only; the model and the mates stay put):
  - Assemblies: **Exploded View** on the ribbon or Insert menu. Parts: **Insert ▸ Exploded View…**, or right-click the Solid Bodies folder (two or more bodies).
  - In the Property panel:
    - Click components / bodies to pick them (click again to drop one).
    - Pick a direction: ±X / ±Y / ±Z, or along a face's normal.
    - Drag the picked items along the direction, or type the distance, then **Add Step**.
    - **Spread Out** spaces the picked items out along the direction, one step each.
    - Click a step to change it, ✕ to delete it.
    - **Explode lines** (dashed, from each item's place to where it is shown) can be switched off.
  - The tree has an **Exploded Views** folder:
    - Double-click a view to explode or collapse it (animated).
    - Right-click for Explode / Collapse, Animate, Edit, Rename, Delete.
    - Assemblies also get an Explode / Collapse ribbon button.
  - Dragging a component, adding a mate, or editing a feature or sketch collapses the view first (it is kept). Exploded views are saved with the file and are part of undo.
- **Section views show section lines (hatching) for each body / component:**
  - 3D Section View:
    - Each body or component gets its own cap, in its colour, with section lines.
    - The angle alternates and the spacing varies from body to body (45°, 135° wider, 30°, 150° wider, 60°, 120° closer…), so touching parts read apart.
    - Each cut body is outlined.
  - Drawing section views hatch each body with its own angle and spacing too.
  - Fixed: drawing section views of multi-body parts showed no hatching at all.

## 2026-10-18 09:07 — Part configurations in assemblies; assembly configurations
- **Components use a part configuration:**
  - Insert Components asks which configuration of the part to use (it starts on the one the part was saved showing; a browsed part file with configurations asks in a dialog).
  - Right-click a component to switch it to another configuration.
  - The tree shows each component's configuration, and the same part can be in the assembly in several configurations (e.g. a 40 mm and an 80 mm pin).
  - Mates on its faces follow the configuration used.
- **Assembly configurations, with the Configurations tab in assemblies too** (the same tab as for parts):
  - Default plus your own; Add, Copy, Rename, Delete, and double-click to show one.
  - While a configuration is shown, these change that configuration only: a component's part configuration, Hide / Show, **Suppress** (new: a suppressed component is left out, with its mates), and a mate's Suppress or value (Edit Mate).
  - Each configuration is listed with a summary of what it changes; the tree shows its name next to the assembly.
- **Bill of Materials:** one row per part and configuration used; suppressed components are left out.

## 2026-10-18 09:03 — Configurations tab
- A third tab at the top of the left panel, next to the Feature tree and the Property panel: the **Configurations tab**.
- It lists **Default** and every configuration of the part, the one shown ticked, each with a summary of what it changes (variable values, suppressed features).
  - **Double-click** one to show it.
  - **Right-click** for Show Configuration, Rename, Copy Configuration, Properties (Design Table) and Delete.
  - **+ Add Configuration** makes a new one starting from the one shown; **Design Table…** edits them all in a table.
- While a configuration is shown, **Suppress / Unsuppress** in the tree changes that configuration only; the other configurations keep the feature as it was. The tree shows the configuration's name next to the part and greys out what it suppresses.
- The tab is for parts only; drawings and assemblies don't show it.

## 2026-10-18 08:52 — Assemblies
- **File ▸ New Assembly** (also in the start window). An assembly opens in a tab of its own with the 3D view and saves as **.rasm**; File ▸ Open opens it.
- **Insert Components:** pick a part open in another tab, or browse for a part file.
  - The first component is **fixed** at the origin; the others are placed beside what is there.
  - The assembly keeps a copy of each part, refreshed from its tab or file whenever you come back to the assembly, so edit a part and the assembly follows.
  - Several instances of one part share it.
- **Mate** (M): click two faces, edges or vertices on different components, choose the type, and ✔ (it is ready for the next mate; Esc closes).
  - Types: **Coincident, Concentric, Parallel, Perpendicular, Tangent, Distance, Angle, Lock**. Each mate is shown applied while you choose; Flip swaps Aligned / Anti-Aligned (or the side for Distance / Tangent).
  - Faces count as planes (flat), axes (cylinders and cones; circular edges count too) or points (spheres, vertices).
  - A mate that conflicts with the others is refused with a message.
- **Moving components:** left-drag a component to move it, Alt+drag to turn it; it moves only as its mates allow. The middle button turns the view and the right button pans.
- **Feature tree:** the components with (f) fixed or (-) still free to move, an eye to hide or show each, and a **Mates** folder (right-click: Edit, Flip, Suppress, Delete).
- **Right-click a component:** Open Part (double-click too), Fix / Float, Hide / Show, Insert Another Instance, Rename, Delete.
- **Bill of Materials:** parts with quantities and materials; copy or save it as CSV.
- Undo / redo in the assembly.
- Not in yet: exploded views, interference detection, assembly drawings and STEP export of the whole assembly.

## 2026-10-18 08:26 — 3D Sketch: Project Edges, Spline, Tangent Arc, Move / Copy / Rotate
- **Project Edges** (Sketch tab, E): click model edges to bring them into a 3D sketch. Lines stay lines, circular edges become arcs or circles, and other curves become splines; edges that meet share their corner points.
  - The converted geometry (purple) stays **linked to the model**. When the part changes (say a box gets wider or taller), it follows the edges, and what is attached to it (lines drawn from its corners, dimensions) follows too.
  - "Unlink from the Model" in the Property panel makes it ordinary geometry.
- **Spline** (N): click the points it runs through (they snap like line points). Double-click or Enter ends it; clicking the first point closes it.
  - Drag its points to shape it.
  - A **Tangent** relation with a line at an end makes it leave the line smoothly.
  - Splines join lines and arcs into one curve for sweeps and routes.
- **Tangent Arc**: click the free end of a line, arc or spline, then where the arc should end. It carries on tangent (Tangent relation added); keep clicking for more arcs, Esc ends.
- **Move / Copy / Rotate**: select geometry, then:
  - **Drag** a selected line, arc or circle to move the selection; it snaps along X, Y and Z.
  - **Type** ΔX/ΔY/ΔZ and click Move or Copy, or rotate about X, Y, Z or the drawing plane's normal by an angle, with Rotate or Copy Rotated.
  - Copies keep the relations among the copied geometry. Rotations turn Along X/Y/Z relations with them (and drop the ones that no longer apply).
  - Fixed and converted geometry stays put.
- Also: two arcs that meet can be made Tangent.

## 2026-10-17 21:49 — 3D Trim and Chamfer; equal radii; fillets and chamfers made equal per use of the tool
- **Trim in 3D sketches** (Sketch tab, T): click the piece of a line, arc or circle to remove, up to where other entities cross or touch it.
  - A piece between two crossings splits the entity in two.
  - A circle loses the clicked piece between two crossings and becomes an arc.
  - With nothing crossing it, the whole entity goes.
  - New end points stay on the line that crosses there.
- **Sketch Chamfer in 3D sketches:** set the distance in the Property panel and click corners where two lines meet.
- **Equal radii:** two arcs or circles can be made Equal (3D: Equal Radius). 2D sketches already offered Equal for them.
- **Fillets and chamfers made equal, 2D and 3D:**
  - The first fillet made after picking Sketch Fillet gets the radius dimension. Each further fillet is made **Equal** to it instead of getting its own dimension, until you leave the tool. Changing the one radius changes them all.
  - Chamfers work the same way: the first gets one distance (both sides equal) and the later ones get **Equal Distance** to it.
  - Picking the tool again starts a new size.

## 2026-10-17 21:34 — 3D Sketch: Sketch Fillet, circles, arcs and polygons
- On the Sketch tab these now work in a 3D sketch too: **Circle, Centerpoint Arc, 3 Point Arc, Polygon and Sketch Fillet**. Each is drawn on the active drawing plane (the small grid) through its first click. Tab switches the plane before or between clicks, and a plane or face chosen with Ctrl+click works as well.
  - **Circle:** click the centre, then a point on the circle.
  - **Centerpoint Arc:** click the centre, the start, then the end. The arc follows the mouse round, either way.
  - **3 Point Arc:** click the start, the end, then a point it runs through.
  - **Polygon:** click the centre, then a corner (sides set in the Property panel, default 6). It stays regular (Regular Polygon relation).
  - **Sketch Fillet:** set the radius in the Property panel and click a corner where two lines meet. Both lines are trimmed and joined by a tangent arc, with a radius dimension (double-click to change it). The sharp corner stays as a point on both lines, so lengths measured to it keep their meaning.
- Arcs join lines end to end: a run of lines and arcs is one curve, e.g. a pipe route or sweep path with exact bends. Circles are curves of their own.
- Dimension: click an arc for its **radius**, a circle for its **diameter**. A Tangent relation can be added between an arc and a line that meet. Points snap to the midpoints of arcs too.
- A selected arc shows its radius, angle and length; a circle its diameter.

## 2026-10-17 21:23 — One set of sketch tools for 2D and 3D sketches
- The **Sketch** tab's tools now serve both kinds of sketch.
- With no sketch open, a tool such as Circle starts a **2D sketch**: you are asked for a plane or flat face, then the tool is ready.
- **3D Sketch** must be clicked to draw in 3D. While a 3D sketch is open:
  - The **3D Sketch** button stays highlighted and the first button becomes **Exit 3D Sketch**.
  - The tools a 3D sketch has stay available: **Select, Line, Centerline, Point and Dimension**, plus **Construction Geometry** (Q) for the selected lines and **Delete**.
  - Every 2D-only tool (rectangles, circles, arcs, splines, trim, offset, patterns, blocks, text, gears…) is **greyed out and can't be clicked**.
- The 3D sketch's Property panel no longer repeats the tool buttons. It names the active tool and keeps the drawing plane, the selection, exact points and the curve options.

## 2026-10-17 21:18 — 3D Sketch: snap to lines and their midpoints
- New points (line ends, points) now snap to the other lines of the 3D sketch, not just to their end points:
  - **Midpoint** of a line: shown with a green marker and the cursor note "Midpoint of the line". It gets a Midpoint relation.
  - **On a line**, anywhere along it: the line lights up and the cursor says "On the line". It gets an On Line relation.
- The relations keep the point there when the line changes (e.g. after a new dimension, or when dragging).
- Order of priority: points, then midpoints, then a point along a line, then the origin and model vertices, then along X/Y/Z, then the drawing plane.

## 2026-10-17 21:09 — 3D Sketch: draw along X, Y and Z in any view
- **Fixed: only two directions could be drawn.** Lines now snap along **X, Y or Z** from the last point whenever the mouse moves along that direction on screen, in any view and whatever the drawing plane. A dashed inference line shows it and an Along X/Y/Z relation is added. Hold Ctrl or Shift to draw freely. Before, a line could only follow the two axes of the current drawing plane until Tab was pressed.
- **Drawing plane:** away from the axes, lines follow the drawing plane through the last point. **Tab** cycles XY → YZ → ZX. The plane name shows at the cursor, and the space handle at the last point shows X, Y and Z.
- **3D sketch planes:** Ctrl+click a plane or flat face, or click a plane in the tree, to draw on it. Points placed there get an **On Plane** relation. Tab or Esc goes back to XY / YZ / ZX.
- **Dimensions:** while placing a length or distance, **Tab** cycles true length → ΔX → ΔY → ΔZ. Dimensions are placed with a click.
- **More 3D relations:** Collinear; Parallel to XY / YZ / ZX; On XY / YZ / ZX plane; On Plane. These come on top of Along X/Y/Z, Parallel, Perpendicular, Equal, Midpoint, On Line, Fix and Merge.
- **Point and line properties:** a selected point shows its X, Y and Z (type new values to move it; refused if its relations hold it). A selected line shows its length, ΔX/ΔY/ΔZ and end points.
- **Centerline tool** (and Make Construction): construction lines shape the sketch, e.g. a frame envelope to attach to, but make no curve.

## 2026-10-17 19:54 — Kernel memory no longer grows with every rebuild
- **Fixed: the geometry kernel kept almost everything it ever made.** In the bundled kernel (`replicad_single.wasm`), `delete()` did nothing for 171 of the 271 kernel classes RazorCAD uses. That includes every shape, every boolean, fillet and extrude builder, explorers, points and boxes: no destructor ran and no memory was freed. Each shape left behind also kept its geometry in memory, and objects the code dropped without deleting were never freed at all. So the kernel's memory grew with every rebuild until the worker was replaced at 3.6 GB. (The "Booleans about twice as fast" entry below blamed memory held inside OpenCascade itself. That was wrong.)
- New `app/js/ocfree.js` frees these objects properly. Builders go through their own C++ destructor, shapes drop their geometry reference, and plain values are freed directly. Objects the code drops are freed once JavaScript has collected them. Two small hooks in `app/vendor/replicad/replicad_single.js` make this possible; the kernel itself is not rebuilt. Replicad's edge queries (point, tangent, type and so on) also free their temporary curve straight away.
- Kernel memory over repeated rebuilds, before → after:
  - 464 BCAF impeller, 6 rebuilds: 163 → 287 → 413 → 595 → 595 → 811 MB → 100 MB every time.
  - Giant Golfball, 2 rebuilds: 287 → 496 MB → 127 → 127 MB.
  - BCL 400 Blade SM, 4 rebuilds: 100 → 163 → 239 → 344 MB → 100 MB every time. PBWE impeller, 5 rebuilds: 100 → 199 MB → 100 MB.
  - Part1: 444 → 1077 → 1077 MB, unchanged. That is working memory, not a leak. Fillet4 (a fillet that includes a B-spline edge) needs a few hundred MB while it runs, the kernel's memory never shrinks, and it doesn't grow after the second rebuild.
- Rebuilds are a little slower because of the extra freeing work: 464 impeller 2.55 → 2.8 s, PBWE impeller 0.57 → 0.63 s, Part1 6.6 → 6.8 s. Giant Golfball and BCL 400 Blade SM are unchanged.
- The worker is still replaced at 3.6 GB. A fresh worker takes about 1.3 s to start, plus a full rebuild of the part (Part1 7 s, Giant Golfball 61 s), and memory returns to the same peak within two rebuilds. Replacing it sooner would only add waits.
- Unchanged: these all rebuild with the same bodies, volumes, areas, and face, edge and triangle counts as without this change:
  - Part1 (and its autosave), BCL 400 Blade, BCL 400 Blade SM, the sample part, transition1, the PBWE impeller, the Giant Golfball and the 464 impeller;
  - three test parts with shells, lofts, sweeps, holes, threads, structural members, splits, patterns, mirrors, and sheet metal flanges, hems and corner reliefs.
- Tested on the 464 impeller: STEP and STL export, measure, drawing views, feature previews, interference and the flat pattern all work.

## 2026-10-17 19:54 — Booleans about twice as fast across the whole model
- **Every cut, join and intersect was computed twice.** This covered extrude, revolve and sweep cuts and joins, patterns of them, and the other features that combine bodies. Each one is now computed once, in the geometry library RazorCAD uses (replicad, in `app/vendor/replicad`). Its working data is freed as soon as the result is taken.
  - Part1: 11.3 s → 6.5 s. Giant Golfball: 79 s → 62 s. Sample part: 0.23 → 0.19 s. BCL 400 Blade: 0.26 → 0.15 s.
  - A test of 150 cuts on a 66-face part: 9.3 s → 4.8 s. 150 joins: 10.3 s → 5.5 s.
  - Rebuilds that are mostly sheet metal or patterns are unchanged (464 impeller about 2.5 s, BCL 400 Blade SM about 5.4 s, PBWE impeller about 0.56 s). The sheet-metal fix above already did this for folding.
- Booleans and moves, turns, mirrors and scales also free their temporary copy of the result, and each move frees its transform. Before, these stayed in memory for as long as the kernel ran.
- **Memory is about the same.** The kernel's memory (`kernelMemoryMB`) reached the same sizes before and after: Part1 444 MB on the first rebuild and 1077 MB on later ones; the 464 impeller 287 → 413 → 595 MB over three rebuilds. Measured inside the kernel, each cut still leaves about 0.7 MB in memory and each join about 1.5 MB, even with every result freed. That memory is kept inside the OpenCascade kernel itself, which RazorCAD's code can't free. The worker is still replaced at 3.6 GB.
- Unchanged: Part1 (and its autosave), BCL 400 Blade, BCL 400 Blade SM, the sample part, transition1, the PBWE impeller, the Giant Golfball and the 464 BCAF impeller all rebuild with the same bodies, volumes, areas and face and edge counts as before.

## 2026-10-17 19:54 — Patterns of sheet metal parts; much faster cuts across formed sheets
- **Fixed: Circular Pattern, Linear Pattern and Mirror of a sheet metal feature** (Base-Flange, SM-Extrude, Lofted-Bend, Transition) put every copy on top of the original, and the copies left out later changes such as flanges and cuts. Each copy is now the body as it is at the pattern, turned or moved into place. It stays sheet metal, with its own flat pattern. The same goes for Sketch, Curve and Fill Patterns.
  - **Mirror** gives the mirror-image part. Its flat pattern is mirrored, with every bend (and form) going the other way. A mirrored lofted bend becomes a plain solid, and the feature says so.
  - Tested on the 464 BCAF impeller: a Circular Pattern of the trimmed SM-Extrude blade gives 10 sheet metal blades, each 241.2 × 160.7 mm flat with 14 bends, matching the old solid copies. A Move/Copy Bodies of the trimmed blade gives the same result.
- **Fixed: a cut across many bends made the part slow, and copying it could crash the kernel** ("memory access out of bounds"). Example: the cone trim on the 14-bend 464 blade.
  - The cut's outline across each bend was traced as a polyline of 48 points per curve. That gave the flat pattern 675 short edges and the folded blade 703 faces. Each traced curve is now one smooth spline edge: the same blade now has 17 edges and 45 faces, with the same volume, flat size and flat area as before.
  - Folding a sheet now does each boolean once (before, every one was done twice), fuses the panels and bends together in one step, and frees its temporary shapes as it goes. Before, they stayed in memory until the rebuild ended.
  - The 464 impeller as it was saved (one sheet metal blade and 9 solid copies) now rebuilds in 7 s instead of 35 s. It uses 240 MB of kernel memory instead of 1.6 GB.
  - With all 10 blades as sheet metal, patterned after the trim, it rebuilds in about 4 s using about 300 MB. Patterned before the trim, so each blade is trimmed as sheet metal, it takes about 16 s.
- Unchanged: the existing test parts (Part1, BCL 400 Blade, BCL 400 Blade SM), the sample part, a flanged tray with closed corners, a transition, and the PBWE impeller all rebuild exactly as before: same bodies, volumes, face counts and flat patterns.

## 2026-10-17 13:45 — 3D sketches drawn in space; visibility column; hide single planes; Change Sketch Plane
- **3D Sketch rebuilt from scratch.** It opens empty, with no plane to pick, and the Line tool is ready.
  - Click points to draw lines in space. Lines are drawn on a drawing plane through the last point (XY, YZ or ZX); **Tab** switches it. Each line snaps to the X, Y and Z directions and gets an Along X/Y/Z relation.
  - Points snap to the sketch's own points, to model vertices and to the origin (both fixed there).
  - A "Next Point" box in the Property panel takes exact offsets (e.g. 0, 0, 250).
  - **3D relations:** Along X/Y/Z, Parallel, Perpendicular, Equal Length, Midpoint, On Line, Fix and Merge (coincident). **Dimensions:** length, distance between points, and angle between lines.
  - A solver keeps everything held and reports Fully defined or the degrees of freedom left. A relation or dimension that conflicts is refused with a message. You can drag points, and undo/redo works inside the sketch.
  - Each connected run of lines is a curve (a T-junction splits into separate runs), as straight runs with an optional bend radius or as a spline. Sweeps and structural members use it as before.
  - Older 3D sketches are converted when opened and keep their shape.
- **Visibility column** at the right of the feature tree: an eye on every sketch, plane (the three standard planes too), axis, point, curve, body and body-making feature. Click it to show or hide that item. Hiding a feature hides the bodies it built.
- **Hide single references:** planes, axes, points and curves can be hidden one at a time (eye, or right-click ▸ Hide), whatever the Planes/Axes/Points switches are set to.
- **Change Sketch Plane…** (right-click a sketch): pick another plane or flat face for an existing sketch, e.g. to repair one whose plane was deleted ("The reference plane is missing"). Its curves keep their sketch coordinates. Only planes above the sketch in the tree are offered.

## 2026-10-15 21:28 — Fixed: Claude Code not found when it came with the Store version of the Claude app
- The Claude desktop app from the Microsoft Store keeps its copy of Claude Code in `%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude\claude-code`. Only the Claude app itself sees that folder at `%APPDATA%\Claude`, so RazorCAD missed it. RazorCAD now looks in both places.
- Tested by signing in to Claude Code with a Claude subscription, then sending a request through RazorCAD's subscription backend. A plate with a hole came back as a valid feature list in about 3 seconds.

## 2026-10-15 21:23 — Ask Claude can use your Claude subscription (no API key)
- Claude Settings has a new choice: **My Claude subscription (Claude Code on this PC)** or **An Anthropic API key**. With the subscription, each request goes through the Claude Code command-line program installed on this PC, signed in to your own Claude Pro/Max plan. It counts toward that plan's usage limits, and there's no separate API bill.
- The dialog shows where Claude Code was found, its version and whether it's signed in. **Sign In…** opens a window running `claude auth login`, which you finish in the browser. **Check Again** re-reads the status.
- RazorCAD looks for Claude Code in this order: on PATH, `~\.local\bin\claude.exe` (the native installer), npm's `claude.cmd`, then the newest copy bundled with the Claude desktop app. To use a specific copy, set `"cliPath"` in `%APPDATA%\RazorCAD\claude.json`.
- Claude Code runs with no tools, no MCP servers and no settings, CLAUDE.md files or memory. It runs from an empty folder (`%APPDATA%\RazorCAD\claude-cli`), so it sees only RazorCAD's guide and your request. An `ANTHROPIC_API_KEY` in the environment is ignored, so the request uses the subscription sign-in.
- This is for each person's own use: everyone using it needs Claude Code installed and signed in as themselves. The API key option is unchanged, and the browser (development) version still uses only the API key.

## 2026-10-15 07:25 — Installer 0.10.0-beta, with the version on it
- New installer: `RazorCAD Install\RazorCAD-Setup-0.10.0-beta.exe`. It includes everything since 0.9.0-beta (11 Oct).
- The version is now in the installer's file name and in its Properties ▸ Details (file and product version). The setup window and Windows' Installed apps list already showed it.
- "Read me first.txt" names this version and its setup file.
- The previous installer was renamed `RazorCAD-Setup-0.9.0-beta.exe` (kept, not deleted).
- Building: set the version in `version.txt`, then run `installer\build_installer.bat`.

## 2026-10-14 23:28 — Fixed: Dimension did nothing in sketches
- Clicking a line, circle or point with Dimension again picks it, and the next click places the dimension and opens the Modify box.
- Cause: the 13:23 build ("Sketch tools: ellipse, … extend, split …") accidentally removed the line that passed Dimension clicks to the dimension code. Clicks then went to the code for two-click drawing tools, which created nothing. A check of the other changes made that day found nothing else removed this way.

## 2026-10-14 22:40 — Cut lofted bends have square edges; no rolling lines on formed parts
- A cut through a Lofted-Bend (or a Transition) now gives edges square to the sheet, as a laser-cut blank formed to shape has. Before, the body was cut by the tool as it was, so a trimmed edge followed the cutting surface at a slant through the thickness, which could leave a thin lip where it met the sheet at a shallow angle (e.g. a fan blade's tip on the A diameter).
- The 3D edges now follow the flat pattern exactly: each cut edge of the pattern is carried onto the sheet at its neutral layer, and the sheet is trimmed square to itself there. Holes cut through the sheet are square too.
- Formed (rolled) Lofted-Bends and Transitions no longer show bend lines across their smooth stretches in the flat pattern, DXF and drawings. A rolled part needs none, as with a cylinder. Real sharp folds at a profile's corners (e.g. a square-to-square transition) still get their bend lines, and Bent lofted bends keep all of theirs.

## 2026-10-14 21:21 — Fixed: formed lofted bends shown as facets; Thicken making inside-out solids
- Formed Lofted-Bends (e.g. a cone between two arcs) are smooth again where they came out as many flat strips. The smooth solid was right, but its volume was measured several % short (a quick integration that misjudges B-spline faces with many spans), so it failed the check against the facets and the facets were used. It is now measured span by span. A fan blade cone of 72 divisions: 6 faces instead of 372, same flat pattern.
- Thicken could make an inside-out solid (negative volume), depending on the side and Flip. It looked right, but Combine ▸ Common with it gave the material round it instead (e.g. a ring with a blade-shaped slot), and cuts and mass were wrong. Every Thicken solid now faces out. Checked for one side and both sides, Flip on and off, on a curved and a flat surface, with Combine ▸ Common.
- (A formed Transition with corners still uses facets: its smooth solid can't be made yet.)

## 2026-10-14 21:10 — Cuts on lofted bends carried into the flat pattern
- A cut (extruded, revolved, …) through a Lofted-Bend, or a Transition made from one, now cuts its flat pattern too. Before, the body was cut but the flat pattern and DXF still showed the uncut sheet.
- The cut is traced where it crosses the sheet's neutral layer and laid into the developed pattern, so a laser-cut blank formed to shape matches the cut body. Holes become cut-outs (with their pierces and cut length), and a cut that trims an edge trims the outline. Forming / bend lines are clipped to what is left.
- This makes trimmed conical parts possible, e.g. a fan blade: loft the cone between two arcs, then cut it to the blade outline with a revolved cut.
- The body is cut by the tool as it is, so trimmed edges follow the cut's surface rather than being square to the sheet.

## 2026-10-14 20:35 — Feature tree arrows: lines enter the arrowheads from behind
- Each arrow now runs straight for at least 28 px before its head. Before, when the related item sat right next to the arrow's lane, the vertical line ran into the side of the arrowhead.

## 2026-10-14 20:32 — Feature tree: straight parent/child arrows
- When a feature is selected, the arrows to its parents (blue) and children (purple) now use straight lines with square corners instead of curves. Each line runs right from the feature, straight up or down in its own lane, and back to the related item.
- Nearer items get the inner lanes and farther ones the outer lanes, so the lines nest without crossing. Lanes stay clear of the names they pass and of marks such as a rebuild error's "!".

## 2026-10-14 20:25 — Fixed: a deleted STL body stayed on screen (and in new parts); long operations can be stopped
- Cause: an Extrude cut through the imported 3DBenchy (79,000 mesh faces) takes several minutes. While it ran, every later change (deleting the Benchy, opening a new part) waited in line behind it, so the screen and the Solid Bodies list kept showing the old Benchy.
- Deleting or changing the feature being worked on (or anything before it), or opening another part, now stops the stale work at once. Deleting the Benchy and the cut now clears the model in about 1 second.
- After 4 seconds a banner above the model says what is being worked on ("Still working on Extrude Cut1 (12 s)…"), with a **Stop** button (also next to the progress bar in the status bar). Stop restarts the geometry kernel. A feature you are still editing is cancelled, and a finished feature is suppressed (unsuppress it to try again).
- Starting a cut, boss, fillet, shell, combine and similar features on a body with more than 20,000 mesh faces shows a warning that it can take several minutes.

## 2026-10-14 20:07 — Fixed: big STL files (e.g. 3DBenchy) would not import
- Large meshes (STL, OBJ, 3MF) are now simplified on import to 80,000 triangles. The triangles that change the shape least are merged, edges and outlines are kept, and no triangle is flipped. 3DBenchy (225,706 triangles) comes in as a closed solid in about 14 seconds, its volume unchanged to 0.001%.
- Before, a mesh over 200,000 triangles was refused. Raising that limit was not enough: the geometry kernel ran out of memory well before that size.
- The limit is in the import's properties ("Simplify meshes above … triangles"; 0 never simplifies), and the import's note says how far a mesh was simplified.
- Imported meshes are shown (and repaired by Repair Mesh / Convert to Solid) straight from their triangles instead of being meshed again by the kernel, which also ran it out of memory.
- Organic meshes (scans, sculpted models) skip the merge of flat areas, which only helps CAD-made STLs and took minutes on big ones.

## 2026-10-14 19:53 — Two-row ribbon with icon sizes
- The toolbar ribbon now shows its buttons in two rows of smaller icons, each label under its icon. Every toolbar fits across the window instead of running off the side; the Sketch toolbar is about half as wide as before.
- Toolbar icon size: Small, Medium or Large, from View ▸ Toolbar Icons or by right-clicking the ribbon (a button, a tab or the empty space). The ribbon's height follows the size, and the choice is remembered.
- Dragging buttons to rearrange them works across both rows.

## 2026-10-14 18:26 — Fast Structure: weld beads and cut list
- Weld Bead: beads of the weld size along every line where the chosen bodies touch (none chosen: every weldment member). Each joint is its own bead body.
- Cut List (Fast Structure tab): identical members counted together, with their length, end angles, total length and mass each (from the bodies' materials), then plates and welds (total weld length). It also shows the total length by profile and exports to CSV (opens in Excel).
- Drawings: Cut List Table (Annotation tab) for the part of the selected view. It updates when the part changes.
- Fixed: a drawing view could get a stray line far outside the part (seen with weld beads looked at end on), which spoiled the view's size and the sheet scale.

## 2026-10-14 15:46 — Fast Structure: Trim/Extend, End Cap, Gusset
- Trim/Extend: members trimmed or extended to a plane or another body at their nearer end, either cut square on the boundary's face or coped to it. Click the members on the model.
- End Cap: a plate on the open end of a tube or pipe, on the end or set inside it flush.
- Gusset: a triangular plate in the corner between two members (click a flat face on each), with leg lengths, thickness, a corner chamfer for weld clearance, and its position along the corner.
- Caps and gussets are bodies of their own, named by size for the cut list.

## 2026-10-14 15:43 — Fast Structure: Structural Member
- New Fast Structure tab with Structural Member: a standard profile along every line and arc of a sketch or 3D sketch (and of more sketches added to the list, for frames in 3D). Each member is its own body, named after its profile.
- Profiles: SHS, RHS, CHS (pipe), equal and unequal angle, channel (PFC / UPN), I-beams (UB, UC, IPE, HEA), flat and round bar. Size tables for AS/NZS and EN/ISO, or enter your own sizes.
- Corners where two members meet: mitred, or butted either way. A member ending on the middle of another (a T-joint), or under a corner (e.g. a table leg), is trimmed to it, square on its face. Pipes and round bars are coped (fish-mouthed).
- Alignment: which point of the profile the sketch line runs through (centre, corners, edges), profile rotation and mirror.

## 2026-10-14 15:22 — Zebra stripes, curvature and draft analysis, Flatten Surface
- Zebra Stripes (Evaluate tab): reflected stripes on every body. Smooth joins show the stripes running on without a kink.
- Curvature (Evaluate tab): bodies coloured from blue (flat) through green and yellow to red (tightest). The status bar gives the radius red stands for.
- Draft Analysis (Evaluate tab): choose a pull direction (an axis or a selected face's normal) and the draft needed. Faces turn green with enough draft, red with draft the other way, yellow where they need more. Click a button again to turn its display off.
- Flatten Surface (Surfaces tab): faces of a surface or a solid unrolled flat beside the model as a surface body. Surfaces that unroll (cylinders, cones, bent sheets) come out exact. Doubly curved ones (e.g. a dome) are spread out keeping their edge lengths as well as possible, and the note gives the size, the area change and how much the edge lengths changed.

## 2026-10-14 15:13 — Split Line, Projected Curve, Composite Curve, Boundary Surface
- Projected Curve: a sketch projected along its normal onto faces, as a 3D curve.
- Split Line: faces split along a sketch's projection, or where a plane or surface crosses them. The body stays one body with the faces split, e.g. for a part line, a draft or a colour.
- Composite Curve: edges of the model joined end to end into one curve.
- Boundary Surface: a surface through curves in two directions. The first and last of each direction bound it, and the ones between shape it.
- Projected and composite curves can be used as sweep paths, lofted-surface profiles, curve-driven pattern paths and boundary curves.

## 2026-10-14 15:10 — Delete Face, Replace Face, Ruled Surface, Untrim
- Delete Face: take faces out of a solid or surface. Either leave the hole (the body becomes a surface body) or patch each hole smoothly, optionally tangent, so the solid stays solid. Good for removing fillets and bad faces from imported parts.
- Replace Face: flat faces of a solid move onto a surface body, so the body grows or shrinks to meet it (e.g. a curved top).
- Ruled Surface: straight-sided surfaces standing on edges, either square to the surface or along a direction tapered by an angle, on one or both sides (e.g. mould parting surfaces). "Tangent" is left out because Extend Surface already does that.
- Untrim Surface: fill a surface's holes, or give it back its natural extent.
- Fixed: a Planar Surface from a sketch with holes in it failed to build.
- Fixed: the "make a solid" option of Filled Surface (and Delete Face) could close an open surface into a solid. It now only does so when nothing is left open.

## 2026-10-14 15:06 — Surfaces: lofted, swept, filled, trim and extend
- Lofted Surface: a surface through two or more profiles (sketches or 3D sketches), open or closed, optionally ruled. Open profiles drawn in opposite directions are lined up automatically.
- Swept Surface: an open or closed sketch profile (or a circle) swept along a sketch, 3D sketch or helix as a surface.
- Filled Surface: a smooth patch over a hole bounded by edges (of a surface or a solid), touching or tangent to the faces round it. It can be knit into the surface and close a solid. A flat loop gives a flat patch.
- Trim Surface: surfaces cut by a plane, a surface body (optionally trimming each other) or a sketch's curves. You click the pieces to keep, or to remove.
- Extend Surface: open edges of a surface carried straight on by a distance, following the surface's slope at the edge, and knit to it.

## 2026-10-14 13:56 — OBJ / 3MF, DXF into sketches, appearances, interference check, configurations
- Import and export OBJ and 3MF meshes (3MF in millimetres, with its units and build placement read on import). Closed meshes come in as solids, open ones as surfaces (Repair Mesh / Convert to Solid can close them).
- Import DXF (Sketch tab): lines, arcs, circles, polylines with arcs, ellipses (and elliptical arcs), splines, points and blocks go into the open sketch. The file's units are converted to millimetres, and you can scale it and place it as in the file, centred, or by its corner.
- Appearance: right-click a face (Appearance…) or a body (Body Appearance…) to give it a colour, or set it back to the default. Face colours stay with their face when the model changes.
- Interference Check (Evaluate tab): finds where solid bodies overlap, lists each pair with its overlap volume and shows the overlaps in red.
- Configurations / design table (Evaluate tab): each configuration gives the global variables other values and can suppress features. The active one is picked with a click, and the table can be copied to / pasted from Excel as CSV.
- IGES is not available: the geometry kernel in RazorCAD is built without its IGES module. STEP does the same job and is read by all CAD programs.

## 2026-10-14 13:49 — Drawings: callouts, baseline/ordinate/chamfer dimensions, auxiliary/break/crop views, GD&T and symbols, revision table, DXF export
- Hole Callout: click a hole and the callout gives its size and depth from the Hole feature (counterbore, countersink, tapped thread and tap drill), plus how many of the same holes the view shows (e.g. "4× Ø6.6 THRU ALL / CBORE Ø11 DEEP 6.5").
- Baseline Dimension (stacked from one base), Ordinate Dimension (distances from an origin along a row) and Chamfer Dimension ("3 × 45°").
- Auxiliary View (looking square at an inclined edge), Break (a long part shortened, with dimensions across the break keeping the true length) and Crop View (only the area drawn round). Views can be un-broken or un-cropped from the right-click menu.
- Datum Feature, Geometric Tolerance (feature control frames with the 14 characteristic symbols, Ø zone, material condition and up to three datums), Surface Finish and Weld Symbol (fillet, square, V, bevel, plug; arrow / other / both sides; all-around, field weld, tail), each with an optional leader.
- Revision Table: rows edited in one dialog; the latest revision goes into the title block.
- Export DXF of the current sheet (layers for visible, thin, hidden, centre lines, text and hatching). DWG can't be written: it is a closed proprietary format, and practically every CAD program opens DXF.

## 2026-10-14 13:40 — Pattern any feature; sketch, curve and fill patterns
- Linear Pattern, Circular Pattern and Mirror now copy any feature that changes the bodies at a place. That includes holes, cuts, fillets, chamfers, drafts, domes and sheet metal forms, not only extrudes and revolves. Features without a shape of their own (e.g. a fillet) are run again on the matching edges or faces of each copy.
- Sketch Driven Pattern: a copy at every point (or circle centre) of a sketch.
- Curve Driven Pattern: copies spaced along a sketch, 3D sketch or helix, either evenly to the end or at a set distance. They are moved, or turned to follow the curve.
- Fill Pattern: copies on a square or staggered grid over a flat face, kept a margin from its edges (e.g. perforated panels).

## 2026-10-14 13:35 — Draft, Rib, Dome, Move Face, Scale, variable and face fillets
- Draft: pick a neutral face, then the faces to tilt by an angle (reversible).
- Rib: an open sketch line is thickened and filled out until it meets the model, either in the sketch plane (e.g. a gusset across a bracket corner) or square to it.
- Dome: a spherical cap or half ellipsoid on round faces, and a smooth dome filled over any other flat outline. Reverse presses it in.
- Move Face: push or pull flat faces along their normal, or turn a face about one of its edges (the neighbouring faces follow).
- Scale: every body by one factor, about the origin or the centre of the bodies.
- Fillet: new Variable size (radius at the start → radius at the end of each edge) and Face fillet (pick faces; the edges where they meet are rounded).
- Toolbars you have rearranged now show commands added in later versions next to their usual neighbours, instead of at the end of the bar.

## 2026-10-14 13:23 — Sketch tools: ellipse, 3 point and tangent arcs, point, extend, split, sketch patterns, blocks
- Ellipse tool (centre, end of the major axis, minor radius). Trim an ellipse for an elliptical arc. Dimension on an ellipse sets the minor radius, or the major radius when placed nearer the major axis. Points can be put on ellipses with On Curve relations. Ellipses extrude, revolve and sweep exactly.
- 3 Point Arc (start, end, then a point it runs through) and Tangent Arc (from the end of a line or arc, kept tangent by a Tangent relation).
- Point tool: lone sketch points that stay (e.g. for Hole positions).
- Extend (a line or arc end runs on to the first entity in its way and stays on it) and Split (a line or arc split in two at the click, kept collinear / equal).
- Linear and Circular Sketch Patterns of the selected entities. The relations and dimensions among them are copied too (circular patterns copy only the ones a rotation keeps). A selected point is the circular pattern's centre.
- Blocks: Make Block saves the selection (with its relations) under a name in your settings. Insert Block places copies with a click, in any sketch, and can delete blocks from the library.

## 2026-10-14 11:47 — Hole
- New Hole (Features tab, Insert ▸ Features): clearance holes (ISO 273 close / normal / loose for M2–M24), counterbores (socket head cap screws, ISO 4762), countersinks (ISO 10642, 90°) and tapped holes (ISO metric and Unified, drilled at the tap drill size, the thread kept for callouts), or your own sizes. Blind with a 118° drill point, or through all; reversible. Placed at clicked points on a flat face, or exactly at the points and circle centres of a sketch on the face. Works on sheet metal too.

## 2026-10-14 11:28 — Miter Flange, Sheet Metal Check and bend tables
- New Miter Flange (Sheet Metal tab): a flange with a profile of up to four segments (length to the outside of the bends, angle; a negative angle folds back the other way — 90 / 90 makes a C, 90 / −90 a Z) along a chain of edges, the corners mitred (closed, with a gap) at every level.
- New Sheet Metal Check: lists every bend of the sheet metal body (direction, angle, inside radius, length, the straight flange on each side) and warns about flanges shorter than 3 × t past their bend and holes closer than 2t + R to a bend.
- Drawings: flat pattern views can show a bend table instead of notes — the bend lines numbered B1, B2 … and a table (direction, angle, inside radius) under the view.
- (Rip and normal cut: Convert to Sheet Metal already leaves a closed box's extra corners open, and cuts on sheet metal are already square to the sheet across bends.)

## 2026-10-14 11:23 — Forming tools and Gusset
- New Forming Tools (Sheet Metal tab): Dimple (diameter, depth), Extruded (flanged) hole (hole diameter, collar height, bend radius) and Louver (width, opening height; drawn as a line on the face — the slit). Placed at clicked points or exactly at the points / circle centres of a sketch on the face; pressed toward the face they are placed on, or the other way. The flat pattern gets a centre mark and a note for each, an extruded hole's pre-hole (the collar laid flat) and a louver's slit as a cut.
- New Gusset: click a bend (its round face) to press a stiffening dart across it at that point (size and width); the flat pattern marks it.
- Forms stay with the part through later sheet metal features and are left off (rather than breaking the part) if one cannot be made.

## 2026-10-14 11:17 — Tab and Slot
- New Tab and Slot (Sheet Metal tab): click the edge of one sheet metal part where it sits on another, then the face of the other part. Tabs are added along the edge (number, length, height — through the other part by default — and an optional margin at each end) and matching slots, with clearance all round, are cut through the other part. Both flat patterns and DXFs get them, so the parts locate each other for welding.

## 2026-10-14 11:13 — Sketched Bend, Jog, Cross Break and gauge tables
- New Sketched Bend (Sheet Metal tab): draw lines on the top or bottom face of a flat part of the sheet and it is bent along each one (angle, radius, bend centred on the line or starting / ending at it, fold direction, which side stays put). The flat pattern stays the plate it was.
- New Jog: one line, two opposite bends that step the sheet over by a height, measured face to face, outside to outside or inside to inside; it says when the height is too small for the bends.
- New Cross Break: click flat faces to mark an X of shallow stiffening folds; it shows in Flatten, the DXF (new Forming marks layer, with a note) and flat pattern drawings.
- Gauge tables: Base Flange, Sheet Metal Extrude and Transition have a Gauge list (mild steel, steel gauges, stainless 304, aluminium 5052 and 6061-T6) that sets thickness, inside radius and K-factor; Save… keeps your own values as a gauge.

## 2026-10-14 10:32 — Customisable toolbars
- Toolbar buttons can be dragged to a new place: the other buttons slide aside to make room, and the new order is kept.
- Your own toolbars: the + after the toolbar tabs (or right-click a tab ▸ New Toolbar…) makes one with a name of your choice; it shows as a tab like the others. Add any tool by dragging a button onto its tab, by right-clicking a button ▸ Add to "…", or in Customize Toolbars… (right-click any button or tab). Drag a button off your toolbar to remove it; right-click its tab to rename or delete it.
- Right-click a button on a built-in toolbar to hide it or add a separator after it; Customize Toolbars… shows hidden buttons again, and Reset puts a toolbar back as it was.
- The layout is kept by RazorCAD between sessions (prefs.json in its data folder).

## 2026-10-14 10:26 — Spline sketch tool
- New Spline tool (Sketch tab, key N): click the points the curve runs through — they snap to other points like the line tool — then double-click, Enter or Esc to finish, or click the first point again to close it into a loop. The curve runs smoothly through every point; drag a point to reshape it, or drag the curve to move it all. Deleting a point takes it out of the spline.
- Splines make profiles on their own (closed) or with lines and arcs, and are exact curves in the model: extrude, revolve, cut, loft profiles and sweep paths. Lines can be trimmed where they cross a spline; mirror works. Not yet: offsetting a spline (also thin-wall features from one) and trimming the spline itself.

## 2026-10-14 08:44 — Convert to Solid and Repair Mesh
- New Convert to Solid (Surfaces tab, Insert ▸ Surface, right-click a surface body): surface bodies that together enclose a volume — or an STL mesh — are joined (edges closer than the gap tolerance meet) and made into one solid. When they leave gaps it says how many open edges and holes there are.
- New Repair Mesh (same places): closes the holes of a surface body or STL with missing pieces — flat holes with one flat face, curved holes with a filling surface, holes in a mesh with triangles — turns any triangles that face the wrong way round, and makes a solid. Option: the largest hole to close.
- STL import: a mesh that is not closed now comes in as a surface body (with a note saying how many open edges it has) instead of a broken solid; the same triangle listed twice is ignored. Large meshes import faster.

## 2026-10-14 08:15 — Bend / forming lines on formed transitions and lofted bends
- Formed (rolled) transitions and lofted bends now have forming lines in the flat pattern, Flatten and DXF (bend layers, with UP / DOWN, angle and radius notes): each curved corner (cone) is split into the set number of lines (Transition: "Forming lines per corner" / "round the whole part"; Lofted Bend: "Forming lines along the profiles"), each line carrying the angle formed along its stretch; sharp corners (e.g. a rectangle-to-square frustum) are lines of their own. Bent parts keep one bend line per fold.
- The bend radius used in the line notes can now be set for formed parts too.

## 2026-10-13 23:27 — Transitions / lofted bends: square cut edges at the corners
- The other side of a transition or bent lofted bend is now each facet moved a thickness square to itself, so every cut edge is square to the sheet; where facets fold, the outside of the fold is a narrow strip, and at the bottom corners the cut edges of the two sides join round the end of the fold (as a real folded part looks), instead of meeting at one mitred point.
- A transition's flat side is one face again (it was drawn split in two along the line where a seam can go).

## 2026-10-13 23:15 — Sheet Metal Extrude and 3D Sketch
- New Sheet Metal Extrude (Sheet Metal tab): extrudes an open sketch of lines and arcs into a sheet metal part. Arcs drawn in the sketch are bends of their own radius; sharp corners get a bend of the radius set in the panel (inside radius). Material on one side, the other side or both sides of the sketch; depth one way, reversed or mid-plane. A circle on its own is rolled into a cylinder, leaving the seam gap. Flanges, hems, Flatten and DXF work on it.
- New 3D Sketch (Sketch tab and Insert menu): points anywhere in space, typed as X / Y / Z, added a step along an axis from the last point, or clicked on model vertices; joined by straight runs with rounded corners (bend radius) for pipe, duct and wiring routes, or by a smooth spline; optional closed loop. Sweep uses it as a path (with a circular profile, or a sketch profile at its start).
- Hem: a teardrop hem has its own angle (default 225°).

## 2026-10-13 23:05 — Sheet metal Transition / Reducer and Hem
- New Transition / Reducer (Sheet Metal tab): cones / concentric and eccentric reducers, square-, rectangle-, triangle-, pentagon- and hexagon-to-round transitions (either way up) and polygon frustums. Sizes, offset and rotation are set in the panel; a sketch line (bottom centre to top centre) places the part and sets its height — change the line and the part follows. Started with no sketch, it asks for a plane and opens the line tool.
- Made from a number of equal parts, each a sheet metal body with its own flat pattern: a cone from one part or more, a flat-sided transition from two or more (seams at the middle of the flat sides or at the corners). Sizes can be inside, outside or mean; formed (rolled) or bent (bump formed with a set number of bends).
- New Hem (Sheet Metal tab): closed, open (gap), teardrop and rolled hems on straight edges, inside or outside the edge; hems meeting at a corner are mitred.
- Lofted bends: the other side of the sheet keeps an even thickness at sharp corners (least-squares mitre).
- Flatten no longer shows a feature selected in the tree on top of the flat pattern.

## 2026-10-13 22:43 — Sheet metal Lofted Bend
- New Lofted Bend (Sheet Metal tab): a sheet metal part between two open profile sketches (each one chain of lines / arcs), e.g. a round-to-square transition, hopper or duct piece. Points are matched along both profiles by length, with every corner of either profile kept.
- Manufacturing method: Bent — flat facets folded along straight lines, each fold a bend line (angle, up / down) in the flat pattern and DXF; the number of divisions is set. Formed — a smooth sheet (rolled / pressed).
- The flat pattern of both is developed by triangulation at the neutral layer (K-factor) and works with Flatten, DXF export and flat pattern drawings; thickness side can be flipped.
- Edge flanges, corner reliefs and closed corners are refused on a lofted bend (its shape comes from the profiles); a cut on it is made on the body only.

## 2026-10-13 22:25 — Airfoil sketch generator (NACA and Clark Y)
- New Airfoil tool (Sketch tab): select a line and click Airfoil (or click Airfoil, then the line). The line becomes the chord (a construction line, leading edge at its start) and an airfoil is drawn on it. It follows the line: drag its ends or dimension it (or set "Chord length" in the panel) and the airfoil scales.
- Library: 28 NACA 4-digit sections (0006–6412), 10 NACA 5-digit sections (21012–25012, reflexed 23112) and Clark Y (11.7 %, 8, 10, 14 %). Or type a NACA code (e.g. 4415, 23012).
- Custom shapes by the NACA convention: 4-digit (max camber, its position, thickness), 5-digit (design lift coefficient, camber position, reflexed camber line, thickness), Clark Y thickness; decimals allowed.
- Options: sharp or blunt trailing edge, camber to the other side, leading edge at the other end. Extrudes as a smooth closed profile (follows the exact NACA shape to within 0.002 % of the chord).

## 2026-10-13 21:56 — Quick dimension readout of edges, sketch entities and faces
- Clicking an edge shows a small tag in the model view: its length, or R and length for an arc, Ø and circumference for a circle. Ctrl+click adds (or removes) more edges: the tag gives their total length, or the perimeter when they go all the way round.
- Sketch entities shown in the model view can be clicked outside the sketch the same way (picked ones turn orange), with the same total.
- Faces and surfaces: one face shows its area (and Ø when round); Ctrl+click a second face: "Parallel · 12 mm apart", "Perpendicular · 90°" or "Angle 45°"; two round faces give their centre distance; three or more faces their total area.
- Fixed: measuring a conical face (e.g. a countersink) failed with a kernel error.

## 2026-10-13 21:37 — Convert to Sheet Metal: self-intersection trim; thickness side for surfaces
- Rolled sheets that would run into themselves (e.g. the two sides of a blade meeting at the trailing edge) are trimmed back at one end, whichever needs the least, leaving a small clearance. Option "Trim where the sheet would run into itself" (on by default); with it off the feature note warns instead.
- Surfaces get a Thickness choice: behind the surface, in front of it, or both sides (symmetric), for curved and flat-faced surfaces.

## 2026-10-13 21:19 — Convert curved surfaces to sheet metal (rolled sheets)
- Convert to Sheet Metal now accepts a curved surface that is curved one way only (a cylinder, or a profile swept straight, e.g. a fan blade copied with Copy Surface). Its section is followed by smoothly joined arcs (and straight runs), each arc a bend of its own radius, so the sheet is rolled from a flat blank whose outline is the surface's own outline unrolled.
- New "Arc fit tolerance" (default 0.05 mm): how closely the rolled sheet follows the surface; smaller gives more, shorter bends.
- Sheet metal parts can now be all bends (no flat panel).
- The convert panel accepts curved faces; clicking a face records which body was clicked, so a copied surface lying on its (hidden) solid is picked, not the solid.
- Flat patterns with many bends are built about 3× faster.

## 2026-10-13 20:56 — Copy Surface
- New feature (Surfaces tab ▸ Copy Surface, or Insert ▸ Surface ▸ Copy…): click faces of any bodies (solid or surface, flat or curved) to copy them as surface bodies; the bodies themselves are not changed.
- Option "Join copies that touch into one surface body" (on by default); off: one surface body per face.

## 2026-10-13 20:48 — Changelog started
- This file. Earlier entries reconstructed from the development log (request and build times).

## 2026-10-13 20:41 — Convert to Sheet Metal: detected thickness and radii, with overrides
- Picking a face of a solid reads its thickness and bend radii and shows them in the panel ("Found in the body: thickness 3 mm · bend radii R300, R227, R13").
- "Use the body's thickness" and "Use the body's bend radii" are on by default; untick either to enter your own value (pre-filled with the detected one). A thickness set keeps the picked side in place; a radius set applies to every bend.
- The bend-radius field only appears when it is used (radius override, sharp edges, or a surface).
- The feature note says where each value came from (from the body / set / sharp edges).

## 2026-10-13 20:26 — Kernel crash on large assemblies fixed; Open loads STEP/STL as a new part
- Fixed: after converting a body in a large imported assembly the geometry kernel ran out of memory and restarted (crash reports 2026-10-13 08:20). Highlighting a feature's faces now only checks the faces that feature changed, and frees its memory.
- A kernel crash now writes one crash report instead of one per waiting request.
- File ▸ Open (and Open… in the start window) opens a STEP or STL file as its own part in a new tab, named after the file, without asking. Insert ▸ Import still offers new part / insert / insert with mates.

## 2026-10-13 20:21 — File ▸ Open fixed
- Fixed: File ▸ Open and the start window's Open… showed "… is not a valid file filter" instead of the file browser.

## 2026-10-13 08:37 — Convert to Sheet Metal rewritten for real sheet metal bodies
- Works on bodies modelled as sheet metal (e.g. STEP exports): follows the whole sheet from the picked face through its flat faces and bends.
- Bends keep their own radius and angle; bends that run straight into each other (rolled shapes such as a fan scroll) are supported.
- Bend faces are unrolled from their real outline (cut-outs kept); holes stay true circles and arcs in the flat pattern and DXF.
- Sharp-cornered bodies (e.g. a shelled box) still convert, with sharp edges bent at the set radius.
- Warns in the feature note when the sheet's volume differs from the body's by more than 0.5 % (body isn't really sheet metal).

## 2026-10-13 07:42 — Flat pattern matches the folded part at closed corners
- The flat pattern now includes each bend's run-on into a closed corner, the relief and the corner round, so a laser-cut blank folds to the modelled part (DXF, drawing flat views, Flatten, flat area, cut length all follow).
- The V lines of a corner can no longer make the bends collide when folded.
- No more zero-size "holes" in the flat outline (no extra pierces).

## 2026-10-13 07:28 — Closed corners: smooth teardrop relief; smoother curved edges
- V-cutout closed corners: each bend's edge is set back by a small relief near the corner point that fades into the V line, joined by one small round at the corner: one smooth teardrop opening, no sharp corners or self-intersection (replaces the 07:01 round relief and 07:14 slot).
- Overlap and underlap corners are exact mirror images.
- Curved model edges are drawn with more points, so small curves don't look kinked when zoomed in.

## 2026-10-13 07:14 — Closed corners: straight slot at the corner point (superseded 07:28)

## 2026-10-13 07:01 — Closed corners: small round relief at the corner point (superseded 07:28)

## 2026-10-13 06:55 — Drawing crash fixed
- Fixed: clicking a projected drawing view opened its panel with an error (crash report 2026-10-13 06:52).

## 2026-10-13 06:51 — Drawing views: change after placing, view panel, rotate
- Clicking a drawing view opens its panel; its orientation can be changed after placing, including to / from Flat Pattern.
- Rotate View: −90°, +90°, 180°, 0° buttons and an angle box; section lines, detail circles and annotations rotate with the view.

## 2026-10-13 06:44 — Model View panel layout fixed
- Fixed: the Flat Pattern button overlapped the orientation buttons in the Model View panel.

## 2026-10-13 06:40 — Closed corners: V line runs straight to the start of each bend
- Removed the small notch and hooks at the corner point; the two bends never overlap.

## 2026-10-13 06:34 — Closed corners: self-intersection near the corner point reduced

## 2026-10-13 06:30 — Claude tab
- New Claude tab in the Command ribbon (after Evaluate): Ask Claude, New Conversation, Claude Settings.

## 2026-10-13 06:18 — Identical bodies grouped with a count
- Identical bodies are listed once with ×N in Solid Bodies and Sheet Metal Bodies (expand to see each). DXF quantity follows the count; Export All DXF writes one file per group.

## 2026-10-13 06:14 — Sheet metal: flat pattern side, right-click flat pattern, cut length
- Body property "Flat pattern seen from" (top / bottom face): DXF, bend lines and notes, Flatten and drawing views follow it.
- Right-click a sheet metal body in the model view ▸ View Flat Pattern / Export Flat Pattern as DXF.
- Cut length (outline + holes) and number of pierces for laser cutting estimates: Body Properties, DXF part info, flat pattern drawing views.

## 2026-10-13 06:09 — Flat pattern drawing views
- Drawings can show a sheet metal body's flat pattern with bend lines and notes (UP/DOWN, angle, radius), flat size, thickness and bend count; dimensionable and exportable to PDF.

## 2026-10-12 22:58 — Drawings
- New drawing documents (.rdrw): File ▸ New Drawing, File ▸ Make Drawing from Part, New Drawing in the start window.
- Default A3 template (ISO frame and title block); sheet sizes A0–A4.
- Views: model views, standard 3 view, projected, section and detail views (hidden-line projection).
- Annotations: smart dimensions, notes, center marks, centerlines. Views and dimensions follow changes to the part.
- Multiple sheets, sheet and drawing properties, undo / redo, vector PDF export.

## 2026-10-12 22:32 — Closed corner "Bend region": V cutout
- Default V cutout: each bend runs on into the corner as formed from the flat, leaving a lens-shaped opening; "Closed" keeps the bends meeting on the diagonal. Also in Edge Flange ▸ Corners.

## 2026-10-12 21:53 — Closed corners: outside seam runs straight down through the bend

## 2026-10-12 21:45 — Closed corners: fixed an opening at the bend corner (R = thickness) and butt corners losing walls

## 2026-10-12 21:39 — Closed corners no longer twist at the bends (bends meet on the mitre)

## 2026-10-12 21:32 — Closed Corner: corner type and corner picking
- Corner type Overlap / Underlap / Butt; pick which corners to close by clicking a flange face (the adjacent flange is found automatically).

## 2026-10-12 21:23 — Edge Flange: corner gap
- Edge Flange ▸ Corners: flanges meeting at a corner are closed with a gap you set, or left open.

## 2026-10-12 21:21 — Closed Corner also closes the bend (radiused) corner

## 2026-10-12 21:09 — Model with Claude
- Ask Claude panel in RazorCAD (your own Anthropic API key): describe a part or a change and Claude adds the features.
- RazorCAD Part Builder page on claude.ai: describe a part and download it as a .rcad.

## 2026-10-12 20:56 — Sheet metal (Change request 4)
- Sheet Metal tab: Base Flange, Edge Flange, Corner Relief, Closed Corner, Unbend / Bend, Flatten, Convert to Sheet Metal.
- Sheet Metal Bodies folder, sheet metal properties (thickness, bends, flat size, mass, quantity).
- Flat pattern with K-factor; DXF export (single and bulk) with bend lines, notes, layer colours and a preview window.

## 2026-10-12 08:26 — Sketch view no longer flips on each edit; Flip Side button

## 2026-10-12 07:55 — Gears: setting teeth or a ratio adjusts the centre-line lengths

## 2026-10-12 07:44 — Gears validated; gear numbers; Tab hides the body under the cursor
- Gear trains must be valid (exact mesh distance, no overlaps, at least 6 teeth); broken trains show red with "Fit gears to the lines".
- Gear numbers shown on the gears in the sketch.
- Tab hides the body under the cursor; Shift+Tab shows a hidden body under the cursor.

## 2026-10-12 07:12 — Gears button works from anywhere; Gear Train panel crash fixed

## 2026-10-12 06:56 — Threads run all the way to the ends (no hard stop at a bore's mouth)

## 2026-10-12 02:05 — Threads stay within their face; body transparency
- Thread cuts / extrudes no longer protrude past the ends of the face.
- Right-click a body ▸ Make Transparent / Make Opaque.

## 2026-10-11 23:15 — Tree hover highlight no longer sticks in the view

## 2026-10-11 22:50 — Gear tool (Change request 3)
- Involute gear trains on centre lines: module, pressure angle, teeth / ratios, backlash and clearance, bores; extrude to one body per gear.

## 2026-10-11 22:43 — Change request 2
- Shortcut badges on tool buttons; Swept Boss/Cut; Lofted Boss/Cut; Helix; Thread Cut / Thread Extrude; full-round fillets where two blends meet; convert / offset entities from a section of the model; Text tool; Wrap (emboss / deboss) onto curved faces.

## 2026-10-11 21:42 — Sketch references to body edges and vertices without converting them

## 2026-10-11 21:30 — Faster feature previews (e.g. fillets)

## 2026-10-11 21:16 — Opening a recent part: the window closes at once, no duplicate tabs

## 2026-10-11 21:07 — Feature tree reference arrows point the right way

## 2026-10-11 21:01 — Change request 1
- Rollback bar, drag to reorder features, reference arrows; thin extrude; Delete Body; Subtract Bodies; chamfer options; cut scope; sketch orientation, mirror, fillet, chamfer, intersection curve; part tabs; STEP/STL insert with mates; body folders; Measure; hide / isolate bodies; visibility filters; Knit to solid; Delete / Move surfaces; reference axis from a cylinder.

## 2026-10-11 20:17 — Crash fixed: all bodies disappearing and the feature tree failing

## 2026-10-11 16:04 — Redundant files cleaned out of the project folder

## 2026-10-11 13:03 — Shift+right-click cycling: release Shift and click to select; Shift+left-click cycles back

## 2026-10-11 12:49 — Installer (RazorCAD-Setup.exe) for testers

## 2026-10-11 12:41 — Selected cuts are highlighted through the body (see-through preview)

## 2026-10-11 12:37 — Shell works on filleted bodies when the shell is thicker than the fillet; hovering tree features highlights them

## 2026-10-11 12:18 — Crash reports written to a folder for inspection

## 2026-10-11 12:11 — Start window, auto-save, progress bar, body cycling
- Start window on launch (recent files, new part) instead of reopening the last part.
- Auto-save only after the first save, to a separate file next to the part (recoverable after a crash).
- Progress bar for long operations (opening, STEP import); multi-body STEP bodies separate; Shift+right-click cycles through bodies / surfaces under the cursor.

## 2026-10-11 12:09 — Shell, offset, arc dimensions, surfaces, combine / split, move body, dotted construction lines
- Shell; offset sketch entities (including linked offsets from model edges); dimensions between arcs (min / max / centre); surface modelling; merge and split bodies; Move/Copy Body by coordinates or mates; construction lines drawn dotted; cut preview fixed.

## 2026-10-11 08:02 — Cylinders and their fillets / chamfers are one continuous face (no seams)

## 2026-10-11 07:39 — Selection filters, materials, Solid Bodies folder, body properties, export body as STEP

## 2026-10-11 07:20 — Sketch tool wheel (hold the middle mouse button); export a face as DXF

## 2026-10-11 07:05 — More reference plane options (at an angle to a face through an edge, mid-plane between faces)

## 2026-10-11 06:56 — Reference axes and points; extrude / cut up to references; coloured feature previews; fillet fixes

## 2026-10-11 06:09 — Fillet at a corner between other fillets fixed; CAD-style rotation

## 2026-10-11 01:13 — Project entities from other sketches; dimensions to model references; fillet / chamfer; STEP / STL import and export

## 2026-10-11 00:31 — Desktop executable; sketch relations; trim tool
- RazorCAD runs as its own Windows program instead of in a browser.
- Sketch relations (horizontal, vertical, coincident, midpoint, symmetric, …) and a trim tool.

## 2026-10-10 18:24 — Project started
- A parametric CAD program with a simple feature-tree interface.
