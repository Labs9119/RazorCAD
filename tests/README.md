# RazorCAD regression tests

Updater handoff checks run without a desktop GUI:

```
python -m unittest discover -s tests -p test_updater.py -v
```

When `pwsh` or Windows PowerShell is available (or `RAZORCAD_TEST_PWSH` points to
it), the tests execute the real helper against temporary files and mocked OS
process/installer/GUI calls. They cover successful replacement, frozen-parent
waiting, installer errors, unchanged executables, wrong versions, restart/close
failures, UTF-8 helper files and quoted/non-ASCII paths. This does not replace a
real Windows installer/UAC test.

One command checks that the geometry kernel and the main workflows still give the same results after a change:

```
python tests/run_tests.py
```

It serves `app/` on a free local port, opens it in headless Microsoft Edge (Playwright, `pip install playwright`;
no browser download is needed, the installed Edge is used) and:

- **Parts:** rebuilds every `tests/parts/*.rcad` with the real kernel, in each configuration, and compares the
  feature errors and, per body, its kind, face and edge count, volume and area (and for sheet metal the flat
  pattern's size and bend count) with `tests/expected.json`. Numbers must agree to 1 part in a million.
- **Drawings:** draws some of the test parts in the standard views (front, top, right, isometric; sheet metal also
  flat) with the kernel and compares each view's count of each kind of line and its size with `expected.json`.
- **UI:** does a few things the way a user does them, with pointer events on the view: sketch a rectangle,
  dimension it and extrude it; make a drawing of the part; build an assembly from two components; check the
  mouse buttons (Shift + right-drag pans, a plain right-drag changes nothing, middle-drag turns).

The exit code is 1 when anything fails, so it can be run before every build. GitHub runs it on every push and pull
request too (`.github/workflows/tests.yml`, on Windows with Edge; there the software renderer draws the 3D view).

| Option | |
|---|---|
| `--only NAME ...` | just these parts or UI tests |
| `--update` | store the current results as the expected ones (after a deliberate change; check the numbers first) |
| `--make-parts` | rebuild `tests/parts/*.rcad` from `tests/make_parts.js` |
| `--headed` | show the browser window |
| `--jobs N` | pages run side by side (default: one per 6 processor threads, at most 4; `--jobs 1`: one page, everything in turn) |
| `--shard I/N` | only share I of N (GitHub: 6 machines side by side); share 1 also runs the parts, drawings and desktop tests |
| `--weights LOG` | write `tests/test-weights.json` from a run's output (a GitHub run's log), and stop |

With several jobs, each page has its own storage and kernels and is told its share of the processor threads; the first
runs the parts and drawings, and the UI tests are shared out by their usual times. A UI test must not need what an
earlier one left behind (or must make it itself, as drawing-from-part does). Times are kept apart per number of jobs.

On GitHub the run is split over 6 machines (`--shard 1/6` to `6/6`), some 15 minutes instead of an hour on one. Every
machine has to share the tests out the same way, so the shares come from `tests/test-weights.json` (each UI test's time
on a GitHub runner, in git), not from a machine's own history; a test not in it counts as the median. Refresh it now and
then: `gh run view <run> --log > ci.log`, then `python tests/run_tests.py --weights ci.log`. Before each UI test, marks
an earlier test left on the model are cleared.

To cover a new feature, add a part to `make_parts.js`, run `python tests/run_tests.py --make-parts --only <name> --update`,
and check the recorded numbers by hand (for example a plate's volume) before committing them.

To check a single-guide loft through the app's continuity panel and sketch editor:

```sh
python tests/run_tests.py --only loft-guide-edit-regeneration --jobs 1
```

This checks C0/G1/G2 before and after increasing the end profile height from 40 to
48 mm and changing the guide's control-point offset from 6 to 9 mm. It measures
solid volumes, guide contact, continuity and kernel memory. Open
`tests/data/guided-loft-edit.rcad` in the app to inspect the final edited G2 model.

To check Sweep with a path and guide, including native geometry and panel editing:

```sh
python tests/run_tests.py --only sweep-path-guide sweep-loft --jobs 1
```

This checks analytic volumes, a curved path with varying section, nonlinear and
reversed guides, rotation of a rectangular section by a helical guide, Sweep Cut,
invalid inputs, guide dependencies and editing. Both guide modes are exercised.

Open `tests/data/sweep-path-guide.rcad` for a curved path with a guide that varies
the circular section size.

For guided swept surfaces, run:

```sh
python tests/run_tests.py --only sweep-canvas-selection surface-sweep-path-guide sweep-path-guide --jobs 1
```

This checks open, polyline and closed profiles, uncapped circular shells, analytic
areas, nonlinear/reversed guides, curved paths, invalid inputs and panel editing.
An example is available in `tests/data/surface-sweep-path-guide.rcad`.

For Shell cavity validation and face picking:

```sh
python tests/run_tests.py --only shell-valid-cavity shell-box references-follow-edits --jobs 1
```

This checks analytic inward/outward volumes, fillets and chamfers, duplicate
face references, rejection of collapsed cavities, recovery after failure and
confirmed thickness edits. Open `tests/data/shell-fillet.rcad` for the small-fillet
case that previously returned the original full solid without an error.

### Sweep orientation and twist

`python tests/run_tests.py --only sweep-orientation-and-twist sweep-path-guide surface-sweep-path-guide --jobs 1`

Checks signed and multiple-turn twist, analytical volumes, fixed-orientation translation on a curved path, uncapped/open surfaces, holes, Thin, cuts, nonuniform spline arc length and a 3D helix path. Includes explicit invalid-input rejection, legacy defaults and actual UI edits, expression persistence, orientation switching and cancellation. Run with both kernel configurations. Example: `tests/data/sweep-twist.rcad`.

### Automatic line relations

`python tests/run_tests.py --only sketch-auto-line-relations sketch-dimension-extrude sketch-new-drawing-tools --jobs 1`

Checks real parallel, collinear and extension drawing, construction references,
excluded control polygons, endpoint priority, automatic-relations toggle,
angular rejection, persistence, source edits and undo/redo.

### Projection source selection

`python tests/run_tests.py --only sketch-projection-source sketch-project-small-arc sketch-project-spline --jobs 1`

Checks real clicks on overlapping sketches, exactly two selected side projections
without their connecting edge, explicit source switching, model-only filtering,
saved source visibility and projection references after reopening.

### Subdivided sketch regions

`python tests/run_tests.py --only profile-subregion-selection planar-surface-selection loft-manual-correspondence extrusion-start-controls --jobs 1`

Checks native areas for line/spline dividers, circle halves sharing source IDs,
holes connected by bridges, construction exclusions, stable face references,
legacy outlines, actual canvas picks, save/reopen and stale status-note removal.

### Extrusion start conditions

`python tests/run_tests.py --only extrusion-start-controls loft-canvas-selection standard-feature-workflows --jobs 1`

Checks legacy starts, signed/expression offsets, independent parallel/inclined start and end planes, reverse, symmetric/two-sided extents, through cuts, Thin, model-face starts, rejected crossings and linked source edits. UI checks independent pick slots, actual canvas face selection and save/reopen.

### Parametric sketch offsets

`python tests/run_tests.py --only sketch-parametric-offset sketch-line-spline-tangent ctrl-spline sketch-fit-spline-handles --jobs 1`

Checks analytic and spline offsets, rational and closed profiles, mixed chains, distance/source edits, both sides with one dimension, winding-independent inside/outside, serialization, undo/redo, collapse rejection and native extrusion volume.

### Line–spline tangency

`python tests/run_tests.py --only sketch-line-spline-tangent sketch-fit-spline-handles ctrl-spline sketch-fillet-spline --jobs 1`

Checks both endpoints of control-point/rational, fit-point and legacy splines, the Property panel Tangent action, stable endpoint references, serialization, undo/redo, ambiguous selections and atomic conflict rejection.

### Manual loft correspondence

`python tests/run_tests.py --only loft-manual-correspondence --jobs 1`

Checks native geometry changes from cyclic attachments and circular seams, open-profile direction, rejected incompatible winding, stable references, holes, guides and G2 at both ends. Exercises canvas picks and drags, reset, cancel, undo/redo, save/reopen, profile reorder and source edits.

### Loft endpoint constraints

`python tests/run_tests.py --only loft-end-conditions loft-guide-edit-regeneration shell-valid-cavity --jobs 1`

Checks normal/direction/G1/G2 endpoint construction for solids and surfaces, intermediate profile interpolation, analytical box/cylinder volumes, reference axes, open/reversed profiles, influence, real adjacent cone, sphere, torus and rectangular faces, both endpoints and explicit rejection of missing/nonadjacent supports or unsupported combinations. The app test picks actual CAD support faces in the viewport, confirms influence expressions, saves/reopens and cancels edits, switches G1/G2 and persists G2 support references. Curvature is checked on the final CAD surfaces, including both G2 endpoints and mixed G1/G2 conditions. Run for both kernel configurations. Examples: `tests/data/loft-end-tangent.rcad` and `tests/data/loft-end-curvature.rcad` (G2 at both spherical supports).

### Loft endpoints with guides, holes and Thin

`python tests/run_tests.py --only loft-end-guides-and-walls loft-end-conditions loft-guide-edit-regeneration --jobs 1`

Checks analytic volumes for holes and all three Thin directions, open Thin profiles, circular and rectangular walls, G1/G2 inner/outer supports, G2 with a compatible guide, guide reversal, multiple guides/sections, open and closed surfaces, guided holes and Thin, and incompatible guide tangents/directions. Guide checks use bounded projections on the final CAD side surfaces. Native CAD guide-seam construction with constrained endpoints is rejected explicitly; this combination uses Adaptive approximation. Example: `tests/data/loft-guided-thin-ends.rcad`.

`tests/test_updater.py` checks the desktop app's hand-over to the setup when it updates itself (no window needed). The
whole run includes it; on its own: `python tests/run_tests.py --only updater`, or
`python -m unittest discover -s tests -p test_updater.py`.

### Surface Patch continuity

`python tests/run_tests.py --only surface-patch-chain-selection surface-patch-continuity surface-differential-analysis --jobs 1`

Checks G0/G1/G2 on planar, circular, spherical and cylindrical boundaries; mixed edge conditions; explicit and ambiguous supports; legacy Tangent files; knitting and solid closure; missing/disconnected/duplicate boundaries; and incompatible requests without a G0 fallback. The UI test picks a real support face, switches boundary and face selection, overrides an individual edge, saves/reopens and cancels an edit. Final CAD checks use native trimming curves and independent differential comparisons. Run on both kernels. Example: `tests/data/surface-patch-g2.rcad`.

Patch chain selection additionally checks native inner/outer loops, circular rims without cylinder/sphere seams, solid branches and explicit support-face loops. Real viewport clicks exercise chain toggling, individual picking, partial-chain completion, per-edge continuity retention, save/reopen and cancel.

### Planar Surface profile and entity selection

`python tests/run_tests.py --only planar-surface-selection surface-patch-chain-selection --jobs 1`

Checks individual sketch regions, holes, multiple regions, whole-sketch compatibility, manual entity contours, dimensional edits, construction/unselected geometry, missing/deleted/open entities, model boundary edges and rejection of duplicate/nonplanar loops. The app test starts from a sketch with several regions, clicks a region and individual sketch entities in the viewport, picks model boundary edges, saves/reopens, cancels edits and migrates a legacy whole-sketch feature. Run on both kernels.

### Common Extrude/Revolve workflows

`python tests/run_tests.py --only standard-feature-workflows extrude-canvas-selection loft-canvas-selection planar-surface-selection surface-patch-continuity --jobs 1`

Checks selected solid/surface profiles, analytical volumes and areas, directional native contact probes, two-sided/symmetric/reversed extents, Full with inactive stored angles, legacy whole sketches and clamped angles, independent/projected sketch axes, Thin, solid Join/New body/Cut, invalid angles and axis crossings. The app test uses actual profile/axis picks and cut-target body picks, edits operation/direction controls, saves/reopens and cancels. Run on both kernels. The implementation/reference inventory is in `Manual/cad-behavior-alignment.md`.

## Reference geometry constraints

`python tests/run_tests.py --only reference-entity-list reference-datum-workflows plane-sketch-refs plane-more-types --jobs 1`

`reference-entity-list` checks named sketch entities in the shared panel list,
explicit slot replacement, spline compatibility, origin points, hidden sources,
suppression/order filtering and stable references after reopening.

`reference-plane-display-anchor` checks that the displayed rectangle stays on an
offset defining line as its angle changes, independently of the model pivot,
while preserving the geometric plane and saved sketch coordinate frame.

The shared datum test checks affine/unit-direction constraints for planes, axes and
points; underdefinition, conflicts, alternate angular planes/bisectors, tangent
cylinders, circular edge centres, expressions, incremental replay and downstream
extrusion after source edits. Its UI workflow uses real canvas clicks, replaces
numbered slots, rejects a fourth reference and incomplete acceptance, switches
solutions, and checks cancel, source visibility, legacy editing and reopening.
Run on both kernel configurations.

## Plane and point along path

`python tests/run_tests.py --only reference-along-path reference-datum-workflows --jobs 1`

`path-location-cases.js` checks arc-length positions against analytic arcs,
nonuniform quintics and weighted rational circles, including derivative normals,
3D helices, composite-route boundaries, model circle/spline edges, reversal,
closed seams, cusps, out-of-range values, expressions and source edits. The app
test picks an arc in the canvas, uses the shared relation controls, verifies the
plane origin and tangent, then saves, reopens, cancels invalid edits and changes
the source radius. Run on both kernel configurations.

`assembly-step-mixed-product` checks STEP products that contain both their own solid and child
components, including repeated instances and pure assembly containers. `assembly-step-export` checks
that ordinary exported part/sub-assembly structure and placements still round-trip.
