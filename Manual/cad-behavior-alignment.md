# CAD command behavior alignment

This tracks concrete workflows against the documented behaviour of established
parametric CAD programs. It is an implementation inventory, not a claim of complete
feature parity. Geometry selection, options and result type must all work;
matching a menu label alone is insufficient.

## Implemented and verified in this pass

| Family | Geometry selection | Options and behavior |
| --- | --- | --- |
| Solid Extrude / Cut | Canvas regions, connected contours and individual entities; legacy whole sketches remain supported | One side, symmetric depth and two independent depths; a second side with its own end condition (blind, through, up to vertex/surface, offset from surface); Join/New body/Cut/Intersect; draft, to and from angled planes; existing up-to/through options and cut/intersect scope retained |
| Solid Revolve / Cut | Selected coplanar regions/contours; profile and axis picking are separate | Full or angle; one side, symmetric or two independent angles; reverse; optional axis projection; Thin for open contours; Join/New body/Cut/Intersect and explicit target-body selection |
| Surface Extrude | Selected regions or open/closed contours; manual entity selection | One side, symmetric or two independent depths; reverse; produces surface geometry rather than a capped solid |
| Surface Revolve | Selected regions or open/closed contours; profile and axis picking are separate | Same Full/Angle and directional controls as solid Revolve, optional axis projection; keeps a surface result |
| Reference planes, axes and points | Three shared slots, canvas/tree picks and per-reference relations | Analytic constraints, definition states, alternative solutions, source dependencies, preserved legacy constructions, and arc-length plane/point locations on sketch and CAD curves |
| Planar Surface | Previously added canvas regions, individual sketch entities and closed model-edge loops | Preserves region holes, rejects open/nonplanar model boundaries; explicit whole-sketch fallback |
| Sweep / Surface Sweep | Separate canvas profile/path/guide roles; per-role chain or individual-entity selection; disjoint contours from the same sketch; explicit whole-source fallback | Existing guide modes, orientation and twist retained; solid Join/New/Cut and target scope; open surface profiles remain uncapped |

Sketch/reference/model axes remain supported. A picked sketch axis may come
from another earlier sketch; the profile subset does not discard its axis.
Partial revolutions reject totals above 360 degrees and negative second angles.
Coplanar profiles that cross the rotation axis are rejected. Inactive values
are ignored (for example the stored angle in Full mode). Symmetric depth means
the specified **total** depth, split equally between both sides.

Old files without profile selections keep their whole-sketch geometry. Older
revolutions clamped angles above 360 degrees; editing one migrates it to Full
instead of changing the resulting geometry.

## Differences still open

| Family | Existing behavior | Remaining alignment work |
| --- | --- | --- |
| Extrude | Region selection and flat model faces as profiles, Thin, through/up-to/offset and scoped cuts, start from an offset or a plane, draft (each side from the profile plane, to angled ends, from angled starts; the second side drafted on its own), a second side with its own end condition, Intersect | None known |
| Revolve | Features listed above, Intersect, flat model faces as profiles, Up To Vertex / Up To Surface (planes through the axis exactly, other planes and faces trimming the revolution) | None known |
| Surface Extrude | Features listed above, starts from an offset or a plane / face, Up To Vertex / Surface and Offset From Surface (angled ones trimming it), its own direction (an axis), draft of closed contours, model edges and flat faces as contours | A draft for open contours of splines or model edges |
| Surface Revolve | Features listed above, Up To Vertex and Up To Surface (a plane through the axis), model edges and flat faces as contours, up to a plane beside the axis | None known |
| Sweep / Surface Sweep | Contour slots and path/guide modes listed above; orientation square to faces the path runs on; twist evenly or eased; the profile scaled along the path (evenly or eased, by length); model edges as the path | Guided solid holes/Thin remain unsupported |
| Loft / Surface Loft | Canvas profiles, guides, endpoint conditions through G2, manual sketch-profile connectors (start vertex, a point inside a curve without splitting it, circular seam and traversal), holes paired and started by hand, Thin connectors, CAD guide constraints with holes | Manual correspondence for 3D curve profiles; CAD guide constraints with endpoint conditions, more than two profiles or Thin |
| Patch | Per-edge G0/G1/G2, connected model-edge selection, a tangent reach per G1 edge, curves and points inside the opening it passes through | Sketch inputs as boundaries need an explicit product decision (planar sketch creation currently belongs to Planar Surface) |
| Reference geometry | Constraint definitions listed above | Arbitrary curved-surface constraints/intersections and broader combinations with tangent/midplane constructions |
| Fillet / Chamfer | Constant, variable (ends, vertices, points along edges), face fillets, full round, chord width, an edge's own size, setback corners, a face's edges at once; chamfers by distance, distance and angle, two distances, an edge's own distance, vertex chamfers | Conic and curvature-continuous fillet profiles (not offered by the geometry kernel) |
| Shell | Faces removed, inward or outward, small blends kept outside, walls of their own thickness, hollow bodies (no faces removed) | Walls of their own thickness on curved faces or outward |
| Hole | Clearance, counterbore, countersink, tapped and slot types; blind (drill point angle), through, up to next / vertex / surface, offset from surface; far-side countersinks; flat and curved faces, sketch points | Tapered pipe threads; counterdrilled holes |
| Patterns and Mirror | Linear (one or two directions, spacing or total length, symmetric, the second direction for the feature only), circular (equal or set angle, symmetric, rings), sketch, curve and fill patterns, mirror; instances to skip; features, faces' features and bodies | Patterns whose spacing varies along them |
| Sheet metal | Base, extruded, lofted and transition sheets; edge, profile and hem flanges (along the whole edge or part of it); jogs, sketched bends, forms, gussets, tabs and slots, corners and reliefs, unfold / fold, convert; K-factor, bend allowance or bend deduction | Bend tables by angle (one value for a 90° bend, other angles in proportion) |
| Assemblies | Coincident, concentric, parallel, perpendicular, tangent, distance and angle (with limits), lock, width, symmetric, gear, rack pinion and screw mates; interference, explode, motion, BOM, assembly holes and cuts | Cam, slot and path mates |
| Drawings | Model, standard, projected, section (horizontal, vertical or at an angle), detail, auxiliary, broken, cropped and flat pattern views; dimensions (linear, baseline, ordinate, chamfer, auto), hole callouts, GD&T, surface finish, weld symbols, centre marks and lines, balloons; BOM, cut list, revision and hole tables; PDF and DXF | Stepped (offset) and broken-out sections; DWG |

## Validation

`tests/standard-feature-cases.js` checks analytical volumes/areas, native
directional contact probes, selected and legacy profiles, solid operations,
independent/projected axes, Thin, invalid angles and axis crossings. The
`standard-feature-workflows` app test uses real viewport profile and axis
picks, edits the shared controls and operations, selects a cut target body,
saves/reopens and cancels edits. Run it on both kernel configurations, alongside
the existing Extrude, Loft, Planar Surface, Patch and saved-part regressions.

`sweep-canvas-selection` adds native analytical volume/area cases for selected
references, construction curves, shared-sketch roles, missing/overlapping inputs
and surface result types. Its app workflow uses actual viewport clicks and
manual connected-entity selection, checks role-switch guards, independent chain
settings, dependency tracking, reopening and cancel. Existing guide/orientation
tests cover legacy whole-source documents and retained options.
