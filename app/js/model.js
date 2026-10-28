// Parametric document: an ordered feature list. The geometry is rebuilt from it
// by the kernel worker (kernel.worker.js) whenever anything changes.
import * as G from './geometry.js';
import * as S from './sketchmodel.js';

export const MATERIALS = [
  { id: 'steel', name: 'Plain Carbon Steel', density: 7.8, color: 0xb5bcc6 },
  { id: 'stainless', name: 'AISI 304 Stainless', density: 8.0, color: 0xc9cfd6 },
  { id: 'al6061', name: '6061 Aluminum Alloy', density: 2.7, color: 0xd5dbe2 },
  { id: 'brass', name: 'Brass', density: 8.5, color: 0xd9b45a },
  { id: 'copper', name: 'Copper', density: 8.96, color: 0xc77b4f },
  { id: 'titanium', name: 'Ti-6Al-4V', density: 4.43, color: 0xa7a9ad },
  { id: 'abs', name: 'ABS Plastic', density: 1.04, color: 0xe8e4da },
  { id: 'pla', name: 'PLA Plastic', density: 1.24, color: 0x6fa3d8 },
  { id: 'nylon', name: 'Nylon 6/6', density: 1.14, color: 0xf0eee6 },
];
// RazorCAD's own file extension for parts (JSON inside)
export const PART_EXT = '.rcad';

// A file's text: the preview picture first (Windows Explorer and the start window read just the start
// of the file for it), then the document. thumbnail: a data: URL, or null for none.
export function docJSON(doc, thumbnail, indent) {
  const { thumbnail: _old, ...rest } = doc;
  return JSON.stringify(thumbnail ? { thumbnail, ...rest } : rest, null, indent);
}
// A file's name without its folder and extension ("C:\Parts\Bracket.rcad" → "Bracket").
export function fileStem(path) {
  const name = String(path || '').split(/[\\/]/).pop();
  return name.replace(/\.(rcad|rasm|rdrw)$/i, '') || name;
}
// A document still called by its default name (Part1, Assembly2, Drawing1…): it takes its file's name.
export const isDefaultName = (name) => !name || /^(Part|Assembly|Drawing)\s*\d*$/i.test(String(name).trim());

// Default feature names used by earlier versions, and what they are called now. A feature still carrying
// an old default name (old name + number) is renamed when its part is opened (names the user typed are kept).
const LEGACY_NAMES = [['Boss-Extrude', 'Extrude'], ['Cut-Extrude', 'Extrude Cut'], ['Cut-Revolve', 'Revolve Cut'], ['Cut-Sweep', 'Sweep Cut'],
  ['Cut-Loft', 'Loft Cut'], ['LPattern', 'Linear Pattern'], ['CirPattern', 'Circular Pattern'], ['Body-Move/Copy', 'Move Body'],
  ['Body-Delete', 'Delete Body'], ['3DSketch', '3D Sketch']];
export function renameLegacyNames(doc) {
  const feats = doc?.features || [];
  const taken = new Set(feats.map((f) => f.name));
  let n = 0;
  for (const f of feats) {
    for (const [old, now] of LEGACY_NAMES) {
      const m = typeof f.name === 'string' && f.name.startsWith(old) ? /^(\d+)$/.exec(f.name.slice(old.length)) : null;
      if (!m || taken.has(now + m[1])) continue;
      taken.delete(f.name);
      f.name = now + m[1];
      taken.add(f.name);
      n++;
      break;
    }
  }
  return n;
}

// A document as read from a file, without its preview (kept out of memory, undo and copies).
export function stripThumbnail(doc) {
  if (doc && typeof doc === 'object') delete doc.thumbnail;
  return doc;
}
export const DEFAULT_BODY_COLOR = 0xc3cad4;
export const SURFACE_COLOR = 0xd9c08c; // surface bodies (no material)

// Per-body settings live in doc.bodies[bodyId] = { name, material, description, props: [{ name, value }] }.
// A body without its own material follows the part material (doc.material).
export function bodySettings(doc, id) {
  return doc.bodies?.[id] || null;
}

export function ensureBodySettings(doc, id) {
  doc.bodies ||= {};
  return (doc.bodies[id] ||= { name: '', material: null, description: '', props: [] });
}

// The material that applies to a body: its own, else the part's (null = not specified).
export function bodyMaterialId(doc, id) {
  const own = doc.bodies?.[id]?.material;
  return own || doc.material || null;
}

export const materialById = (id) => MATERIALS.find((m) => m.id === id) || null;

export const TYPE_INFO = {
  sketch: { base: 'Sketch', icon: 'sketch' },
  extrude: { base: 'Extrude', cutBase: 'Extrude Cut', icon: 'extrude', cutIcon: 'cutExtrude' },
  revolve: { base: 'Revolve', cutBase: 'Revolve Cut', icon: 'revolve', cutIcon: 'cutRevolve' },
  plane: { base: 'Plane', icon: 'plane' },
  axis: { base: 'Axis', icon: 'axis' },
  point: { base: 'Point', icon: 'refpoint' },
  lpattern: { base: 'Linear Pattern', icon: 'lpattern' },
  cpattern: { base: 'Circular Pattern', icon: 'cpattern' },
  mirror: { base: 'Mirror', icon: 'mirror' },
  fillet: { base: 'Fillet', icon: 'fillet' },
  chamfer: { base: 'Chamfer', icon: 'chamfer' },
  import: { base: 'Imported', icon: 'import' },
  shell: { base: 'Shell', icon: 'shell' },
  combine: { base: 'Combine', icon: 'combine' },
  split: { base: 'Split', icon: 'split' },
  moveBody: { base: 'Move Body', icon: 'moveBody' },
  deleteBody: { base: 'Delete Body', icon: 'deleteBody' },
  sweep: { base: 'Sweep', cutBase: 'Sweep Cut', icon: 'sweep', cutIcon: 'cutSweep' },
  loft: { base: 'Loft', cutBase: 'Loft Cut', icon: 'loft', cutIcon: 'cutLoft' },
  helix: { base: 'Helix', icon: 'helix' },
  hole: { base: 'Hole', icon: 'hole' },
  draft: { base: 'Draft', icon: 'draft' },
  spattern: { base: 'Sketch Driven Pattern', icon: 'spattern' },
  curvePattern: { base: 'Curve Driven Pattern', icon: 'curvePattern' },
  fillPattern: { base: 'Fill Pattern', icon: 'fillPattern' },
  rib: { base: 'Rib', icon: 'rib' },
  dome: { base: 'Dome', icon: 'dome' },
  scale: { base: 'Scale', icon: 'scale' },
  moveFace: { base: 'Move Face', icon: 'moveFace' },
  sketch3d: { base: '3D Sketch', icon: 'sketch3d' },
  thread: { base: 'Thread-Extrude', cutBase: 'Thread-Cut', icon: 'threadExtrude', cutIcon: 'threadCut' },
  cosmeticThread: { base: 'Cosmetic Thread', icon: 'cosmeticThread' },
  wrap: { base: 'Wrap', icon: 'wrap' },
  deleteSurface: { base: 'Surface-Delete', icon: 'deleteSurface' },
  surfExtrude: { base: 'Surface-Extrude', icon: 'surfExtrude' },
  surfRevolve: { base: 'Surface-Revolve', icon: 'surfRevolve' },
  surfPlanar: { base: 'Surface-Plane', icon: 'surfPlanar' },
  surfOffset: { base: 'Surface-Offset', icon: 'surfOffset' },
  surfLoft: { base: 'Surface-Loft', icon: 'surfLoft' },
  surfSweep: { base: 'Surface-Sweep', icon: 'surfSweep' },
  surfFill: { base: 'Surface-Fill', icon: 'surfFill' },
  surfTrim: { base: 'Surface-Trim', icon: 'surfTrim' },
  surfExtend: { base: 'Surface-Extend', icon: 'surfExtend' },
  deleteFace: { base: 'Delete-Face', icon: 'deleteFace' },
  replaceFace: { base: 'Replace-Face', icon: 'replaceFace' },
  ruledSurface: { base: 'Ruled-Surface', icon: 'ruledSurface' },
  untrim: { base: 'Untrim-Surface', icon: 'untrim' },
  projCurve: { base: 'Projected-Curve', icon: 'projCurve' },
  splitLine: { base: 'Split-Line', icon: 'splitLine' },
  compCurve: { base: 'Composite-Curve', icon: 'compCurve' },
  boundarySurf: { base: 'Boundary-Surface', icon: 'boundarySurf' },
  flattenSurf: { base: 'Surface-Flatten', icon: 'flattenSurf' },
  structMember: { base: 'Structural Member', icon: 'structMember' },
  weldTrim: { base: 'Trim/Extend', icon: 'weldTrim' },
  weldBead: { base: 'Weld Bead', icon: 'weldBead' },
  endCap: { base: 'End Cap', icon: 'endCap' },
  weldGusset: { base: 'Gusset', icon: 'weldGusset' },
  surfCopy: { base: 'Surface-Copy', icon: 'surfCopy' },
  knit: { base: 'Surface-Knit', icon: 'knit' },
  surfSolid: { base: 'Convert-to-Solid', icon: 'surfSolid' },
  meshRepair: { base: 'Repair-Mesh', icon: 'meshRepair' },
  thicken: { base: 'Thicken', icon: 'thicken' },
  // sheet metal
  smBase: { base: 'Base-Flange', icon: 'smBase' },
  smLoft: { base: 'Lofted-Bend', icon: 'smLoft' },
  smTransition: { base: 'Transition', icon: 'smTransition' },
  smExtrude: { base: 'SM-Extrude', icon: 'smExtrude' },
  smSketchBend: { base: 'Sketched-Bend', icon: 'smSketchBend' },
  smEtch: { base: 'Etch', icon: 'smEtch' },
  smJog: { base: 'Jog', icon: 'smJog' },
  smCrossBreak: { base: 'Cross-Break', icon: 'smCrossBreak' },
  smTabSlot: { base: 'Tab-and-Slot', icon: 'smTabSlot' },
  smForm: { base: 'Form', icon: 'smForm' },
  smGusset: { base: 'Gusset', icon: 'smGusset' },
  smProfileFlange: { base: 'Miter-Flange', icon: 'smProfileFlange' },
  smHem: { base: 'Hem', icon: 'smHem' },
  smFlange: { base: 'Edge-Flange', icon: 'smFlange' },
  smCornerRelief: { base: 'Corner-Relief', icon: 'smCornerRelief' },
  smClosedCorner: { base: 'Closed-Corner', icon: 'smClosedCorner' },
  smUnfold: { base: 'Unbend', icon: 'smUnfold' },
  smFold: { base: 'Bend', icon: 'smFold' },
  smConvert: { base: 'Convert-to-Sheet-Metal', icon: 'smConvert' },
};
export const SHEET_TYPES = new Set(['smBase', 'smFlange', 'smCornerRelief', 'smClosedCorner', 'smUnfold', 'smFold', 'smConvert', 'smLoft', 'smTransition', 'smHem', 'smExtrude', 'smSketchBend', 'smJog', 'smCrossBreak', 'smTabSlot', 'smForm', 'smGusset', 'smProfileFlange', 'smEtch']);

// Features that need a sketch (the first unused one is offered by default).
// features a pattern or mirror can copy (anything that changes the bodies at a place)
export const PATTERN_SKIP = new Set(['structMember', 'weldTrim', 'weldBead', 'sketch', 'plane', 'axis', 'point', 'helix', 'sketch3d', 'projCurve', 'compCurve', 'lpattern', 'cpattern', 'mirror', 'spattern', 'curvePattern', 'fillPattern', 'combine', 'deleteBody', 'deleteSurface', 'moveBody', 'scale', 'import', 'knit', 'surfSolid', 'meshRepair', 'smConvert', 'smUnfold', 'smFold', 'split']);
export const SKETCH_FEATURES = new Set(['extrude', 'revolve', 'surfExtrude', 'surfRevolve', 'surfPlanar', 'helix', 'wrap', 'smBase', 'smExtrude', 'smSketchBend', 'smJog', 'smEtch', 'rib']);

// Sketches a feature uses (they are hidden and shown under it in the tree once used).
export function sketchesUsedBy(f) {
  return [...new Set([f.sketch, f.profile, f.path, f.guide, f.profileA, f.profileB, ...(Array.isArray(f.profiles) ? f.profiles : []), ...(f.guides || [])].map((x) => typeof x === 'string' ? x : x?.sketch).filter(Boolean))];
}

export function iconFor(f) {
  const t = TYPE_INFO[f.type];
  return f.op === 'cut' && t.cutIcon ? t.cutIcon : t.icon;
}

export function newDoc() {
  return { version: 1, name: 'Part1', material: null, equations: [], features: [], nextId: 1 };
}

export function newId(doc) {
  return 'f' + doc.nextId++;
}

export function nextName(doc, type, op) {
  const t = TYPE_INFO[type];
  const base = op === 'cut' && t.cutBase ? t.cutBase : t.base;
  let max = 0;
  const re = new RegExp('^' + base.replace(/[-]/g, '\\-') + '(\\d+)$');
  for (const f of doc.features) {
    const m = re.exec(f.name);
    if (m) max = Math.max(max, +m[1]);
  }
  return base + (max + 1);
}

export function createFeature(doc, type, props = {}) {
  const defaults = {
    sketch: { plane: { ref: 'front' }, ...S.newSketchData() },
    // merge: added material fuses with the bodies it touches (off: it becomes a separate body)
    // thin: a wall of thickness thinT along the sketch curves (open sketches are always thin);
    // thinDir: 'one' (outside a closed profile / left of an open one), 'other' or 'mid'.
    // scopeAll: a cut acts on every body it reaches (off: only the bodies in scope)
    extrude: { sketch: null, op: 'add', merge: true, startFrom:'profile',startOffset:0,startPlane:null,startFace:null,end: 'blind', depth: 10, depth2: 0, reverse: false, toPoint: null, toVertex: null, toPlane: null, toFace: null, toOffset: 5, toFlip: false, side2: false, end2: 'blind', toPoint2: null, toVertex2: null, toPlane2: null, toFace2: null, toOffset2: 5, toFlip2: false, draft2Own: false, draft2: 0, draftOutward2: false, thin: false, thinT: 2, thinDir: 'one', scopeAll: true, scope: [] },
    revolve: { sketch: null, profiles: null, extent: 'angle', angle2: 0, projectAxis: false, axisSketch: null, thin: false, thinT: 2, thinDir: 'one', op: 'add', merge: true, axis: 'v', end: 'oneway', angle: 360, reverse: false, axisEdge: null, axisFace: null, toPoint: null, toVertex: null, toPlane: null, toFace: null, scopeAll: true, scope: [] },
    // axis: 'v' (sketch vertical), 'u' (sketch horizontal), the id of a line in the sketch, an axis
    // feature, or 'edge' / 'face' (a straight model edge / cylindrical face picked on the model)
    // refs: up to three references (see refgeom.js); the plane type is inferred from them
    // through: an edge and a point make a plane through both; along: the distance along the edge (position
    // 'distance'); around: the angle round a cylinder for a tangent plane; moveBy / turn / reverse: the plane moved
    // along its normal, its axes turned in it, its normal turned round (any type)
    plane: { refs: [], offset: 20, flip: false, angle: 90, flipAngle: false, position: 'mid', bisector: false, through: false, along: 0, around: 0, moveBy: 0, turn: 0, reverse: false },
    axis: { axisType: 'twoPlanes', planeA: 'front', planeB: 'top', pointA: null, pointB: null, edge: null, face: null, sketchLine: null },
    point: { pointType: 'coords', x: 0, y: 0, z: 0, vertex: null, edge: null },
    // (patterns: feature, plus features, faces (each brings the feature that made it) and bodies (copied whole);
    // pick: what a click on the model picks, 'faces' | 'bodies')
    lpattern: { feature: null, features: [], faces: [], bodies: [], pick: 'faces', dir1: 'x', rev1: false, dist1: 20, count1: 3, dir2: 'none', rev2: false, dist2: 20, count2: 2 },
    cpattern: { feature: null, features: [], faces: [], bodies: [], pick: 'faces', axis: 'y', angle: 360, count: 6, equal: true },
    mirror: { feature: null, features: [], bodies: [], plane: 'right' },
    // Sketch driven: a copy at each point of `sketch` (the point nearest the feature is the feature)
    spattern: { feature: null, features: [], faces: [], bodies: [], pick: 'faces', sketch: null },
    // Curve driven: count copies along `path`, spacing 'equal' | 'distance'; align 'translate' | 'tangent'
    curvePattern: { feature: null, features: [], faces: [], bodies: [], pick: 'faces', path: null, count: 4, spacing: 'equal', distance: 20, reverse: false, align: 'translate' },
    // Fill: copies on a 'square' | 'staggered' grid over a flat face, margin from its edges
    fillPattern: { feature: null, features: [], face: null, spacing: 15, layout: 'square', angle: 0, margin: 3 },
    // filletType 'constant' | 'variable' (radius at the start → radius2 at the end of each edge) | 'face'
    // (the edges where the picked faces meet)
    // radiusMode (variable): 'ends' (start → end of each edge) | 'vertices' (vertexRadii: [{ p, r }], the others: radius);
    // setback: corners where three or more fillets meet blended from this distance (0: the kernel's own corner)
    // edgePoints (radiusMode 'vertices'): [{ edge (its place in edges), t (% of its length from its start), r }]
    fillet: { radius: 2, edges: [], filletType: 'constant', radius2: 4, flipRadii: false, faces: [], radiusMode: 'ends', vertexRadii: [], edgePoints: [], setback: 0 },
    // Draft: face (neutral plane, flat) + faces to tilt by angle; reverse: pull the other way
    draft: { face: null, faces: [], angle: 3, reverse: false },
    // Rib: an open sketch, thickness, ribDir 'parallel' (in the sketch plane) | 'normal'; flip: the other side
    rib: { sketch: null, thickness: 5, ribDir: 'parallel', flip: false },
    // Dome: flat faces, height; elliptical (round faces); reverse: pressed in
    dome: { faces: [], height: 5, elliptical: false, reverse: false },
    // Scale: every body by factor about 'origin' | 'centroid'
    scale: { factor: 1.5, about: 'origin' },
    // Move Face: mode 'offset' (distance along the normal) | 'rotate' (angle about edge)
    moveFace: { faces: [], mode: 'offset', distance: 5, angle: 5, edge: null, reverse: false },
    // chamferType: 'distance' (equal distances), 'angleDist' (distance + angle) or 'twoDist';
    // flip swaps which face the distance (or first distance) is measured on
    chamfer: { chamferType: 'distance', distance: 1, distance2: 1, angle: 45, flip: false, edges: [] },
    // imported bodies stay separate (mergeBodies: fuse touching ones into one body)
    // maxTris: meshes (STL / OBJ / 3MF) with more triangles are simplified to that many (0: never)
    import: { format: 'step', fileName: '', data: '', mergeBodies: false, maxTris: 80000 },
    // faces: picked face references { p, n }; bodies / main / body: body ids
    shell: { faces: [], thickness: 2, outward: false },
    // consume: the tool bodies are used up (off: they are kept)
    combine: { op: 'add', main: null, bodies: [], consume: true },
    // tool: a plane id or a surface body id ('' + toolFace: a picked flat face); keep: all | positive | negative
    split: { tool: 'front', toolFace: null, bodies: [], keep: 'all' },
    // mode 'translate': rotate about rotAxis by angle (about the origin or the bodies' center), then move dx/dy/dz;
    // mode 'mates': mates [{ type, a, b, value, flip }] between the moving bodies and fixed geometry
    moveBody: { bodies: [], copy: false, copies: 1, mode: 'translate', dx: 0, dy: 0, dz: 0, rotAxis: 'none', angle: 0, rotCenter: 'origin', mates: [] },
    surfExtrude: { sketch: null, profiles: null, edges: [], chainSelection: false, startFrom: 'profile', startOffset: 0, startPlane: null, startFace: null, depth2: 0, end: 'blind', depth: 10, reverse: false, toPoint: null, toVertex: null, toPlane: null, toFace: null, toOffset: 5, toFlip: false, direction: 'none', draft: 0, draftOutward: false },
    surfRevolve: { sketch: null, profiles: null, edges: [], chainSelection: false, end: 'oneway', extent: 'angle', angle2: 0, reverse: false, projectAxis: false, axisSketch: null, axis: 'v', angle: 360, toPoint: null, toVertex: null, toPlane: null, toFace: null },
    surfPlanar: { sketch: null, profiles: null, edges: [], chainSelection: true },
    surfOffset: { faces: [], distance: 5, flip: false },
    // profiles: sketches / 3D sketches (one chain each, all open or all closed), in order; guides: guide curves
    // (sketches or curves) the surface follows, each through every profile
    surfLoft: { profiles: [], guides: [], ruled: false, startCondition: 'none', endCondition: 'none', startDirection: 'y', endDirection: 'y', startStrength: 1, endStrength: 1, startReverse: false, endReverse: false, startFaces: [], endFaces: [] },
    surfSweep: { profileType: 'sketch', profile: null, diameter: 10, path: null, guide: null, guideMode: 'orientation', orientation: 'perpendicular', twistAngle: 0 },
    // Patch continuity: G0/G1/G2, with optional per-edge overrides and support faces. Legacy tangent means G1.
    surfFill: { edges: [], chainSelection: true, continuity: null, supportFaces: [], merge: true, solid: false },
    // tool: a plane, surface body or sketch; faces: points on the pieces; mode 'keep' | 'remove'
    surfTrim: { tool: '', faces: [], mode: 'keep', mutual: false },
    surfExtend: { edges: [], distance: 10 },
    // mode 'delete' (leave the hole) | 'patch' (fill each hole; tangent: G1 to the faces round it)
    deleteFace: { faces: [], mode: 'delete', tangent: false },
    // flat faces of a solid moved onto surface body `tool`
    replaceFace: { faces: [], tool: null },
    // ruleType 'normal' (square to the face) | 'direction' (along an axis, tilted by angle); both: both sides
    ruledSurface: { edges: [], ruleType: 'normal', direction: 'y', angle: 0, distance: 10, flip: false, both: false },
    // mode 'holes' (fill the inner loops) | 'all' (the natural extent); faces: only these (empty: all)
    untrim: { body: null, faces: [], mode: 'holes' },
    // a sketch projected along its normal onto faces (none picked: every face)
    projCurve: { sketch: null, faces: [] },
    // faces split along a sketch's projection, or by a plane / surface body (tool)
    splitLine: { tool: '', faces: [] },
    compCurve: { edges: [] },
    // curves in two directions (sketches, 3D sketches, composite / projected curves)
    boundarySurf: { dir1: [], dir2: [] },
    // faces unrolled flat (relaxation iterations for doubly curved ones)
    flattenSurf: { faces: [], iterations: 1000 },
    // weldment members: profile standard / ptype / size (or dims for 'custom') along every segment of path
    // (a sketch or 3D sketch); pierce point, rotation, mirror; corner 'mitre' | 'butt1' | 'butt2' | 'none'
    // members (bodies) trimmed / extended to tool (a plane or a body); trimType 'planar' | 'cope'
    weldTrim: { bodies: [], tool: '', extend: true, trimType: 'planar' },
    // weld beads where the bodies touch (none chosen: every weldment member); size: the weld size
    weldBead: { bodies: [], size: 5 },
    // plates on the end faces of hollow members: capType 'outside' | 'inside'
    endCap: { faces: [], capType: 'outside', thickness: 3 },
    // a triangular plate between two flat faces: legs d1 / d2, thickness, corner chamfer, position along the corner
    weldGusset: { faces: [], d1: 75, d2: 75, thickness: 6, chamfer: 10, position: 'mid', offset: 0 },
    structMember: { path: null, paths: [], standard: 'AS/NZS', ptype: 'shs', size: '50x50x3 SHS', dims: {}, pierce: 'mc', rotate: 0, mirror: false, corner: 'mitre', trim: 'planar' },
    // faces: picked faces of any bodies (solid or surface), copied as they are; knit: touching copies become one surface body
    surfCopy: { faces: [], knit: true },
    knit: { bodies: [], solid: true, tolerance: 0.01, merge: true },
    // surface bodies (or an STL mesh) enclosing a volume made into a solid; edges closer than tolerance join
    surfSolid: { bodies: [], tolerance: 0.01, merge: false },
    // holes (loops of open edges) up to maxHole across (0: any size) closed, then made a solid
    meshRepair: { bodies: [], tolerance: 0.01, maxHole: 0, solid: true, merge: false },
    thicken: { body: null, thickness: 2, side: 'one', flip: false, merge: true },
    // removed bodies come back when the feature is deleted or suppressed
    deleteBody: { bodies: [] },
    deleteSurface: { bodies: [] },
    // profileType 'circle': a round profile of `diameter` made across the start of the path (springs)
    sweep: { op: 'add', profileType: 'sketch', profile: null, diameter: 2, path: null, guide: null, guideMode: 'orientation', orientation: 'perpendicular', twistAngle: 0, merge: true, thin: false, thinT: 1, thinDir: 'one', scopeAll: true, scope: [] },
    // profiles: sketch ids in order; circles are split to match the other profiles' points
    // continuity: 'C2' (curvature-continuous through the profiles) | 'C1' (tangent-continuous); smoothing: evened out
    // guides: guide curves (sketches or curves) the loft's outline follows, each from the first profile to the last
    loft: { op: 'add', startCondition: 'none', endCondition: 'none', startDirection: 'y', endDirection: 'y', startStrength: 1, endStrength: 1, startReverse: false, endReverse: false, startFaces: [], endFaces: [], profiles: [], guides: [], ruled: false, continuity: 'C2', smoothing: false, merge: true, thin: false, thinT: 1, thinDir: 'one', scopeAll: true, scope: [] },
    // Hole: holeType 'simple' | 'cbore' | 'csink' | 'tapped'; size a standard screw size (or
    // 'custom': diameter / cboreD / cboreDepth / csinkD / csinkAngle), fit 'close' | 'normal' | 'loose';
    // tapped: system + thread (cosmetic, threadDepth for the callout); end 'blind' (depth, drill point) | 'through'
    hole: { holeType: 'simple', size: 'M6', fit: 'normal', diameter: 6.6, cboreD: 11, cboreDepth: 6.5, csinkD: 13.7, csinkAngle: 90, system: 'metric', thread: 'M6', threadDepth: '', end: 'blind', depth: 10, drillPoint: true, reverse: false, sketch: null, faces: [] },
    // pts: [{ x, y, z }] (expressions); kind 'lines' (rounded by radius at the corners) | 'spline'
    sketch3d: { pts: [], segs: [], rels: [], nextId: 1, kind: 'lines', radius: 0 },
    helix: { sketch: null, definedBy: 'pitchRev', pitch: 5, revolutions: 5, height: 25, startAngle: 0, clockwise: false, reverse: false },
    // op 'cut' = Thread Cut, 'add' = Thread Extrude; size 'auto' picks the standard that fits the face
    thread: { op: 'cut', face: null, system: 'metric', size: 'auto', diameter: 10, pitch: '', leftHand: false, end: 'through', depth: 10, toPlane: null, toFace: null, reverse: false, autoSize: true },
    cosmeticThread: { face: null, system: 'metric', size: 'auto', diameter: 10, pitch: '', leftHand: false, end: 'through', depth: 10, toPlane: null, toFace: null, reverse: false },
    wrap: { sketch: null, face: null, method: 'emboss', depth: 1, flip: false },
    // sheet metal (see sheetmetal.js). kFactor: where the neutral axis lies in the thickness
    smBase: { sketch: null, thickness: 2, radius: 2, kFactor: 0.44, reverse: false },
    // method: 'bent' (flat facets, `bends` of them across, each fold a bend line) | 'formed' (smooth)
    smLoft: { profileA: null, profileB: null, thickness: 2, kFactor: 0.44, radius: 0, method: 'bent', bends: 12, flip: false },
    // transition / reducer on the axis line of `sketch` (bottom centre to top centre). Ends b (bottom) and
    // t (top): Shape 'round' | 'square' | 'rect' | 'tri' | 'pent' | 'hex'; D (round), Size + Basis
    // ('side' | 'flats' | 'corners'), W × L (rect). dims: 'inside' | 'outside' | 'mean'
    smTransition: {
      sketch: null, reverse: false,
      bShape: 'square', bD: 300, bSize: 300, bW: 400, bL: 300, bBasis: 'side',
      tShape: 'round', tD: 200, tSize: 150, tW: 200, tL: 150, tBasis: 'side',
      offX: 0, offY: 0, rotation: 0, parts: 2, seamAt: 'mid', seamShift: false, seamAngle: 0, seamGap: 0,
      method: 'formed', divs: 6, divsRound: 24, radius: 0, thickness: 2, kFactor: 0.44, dims: 'inside',
    },
    // extruded from an open profile (or a circle, rolled): direction 'one' | 'reverse' | 'mid'; side 'one' |
    // 'other' | 'mid' (material left of the profile's direction, right, or half each side); radius: inside
    // bend radius at sharp corners
    // bends along sketch lines on a flat face of a sheet (the flat pattern stays the plate); position:
    // the bend zone 'center' (centred on the line) | 'start' (starts at it) | 'end' (ends at it)
    smSketchBend: { sketch: null, angle: 90, useDefaultRadius: true, radius: 2, position: 'center', flip: false, swapFixed: false },
    smEtch: { sketch: null },
    // two opposite bends from one line, stepping the sheet over by height (heightRef: 'face' | 'overall' | 'inside')
    smJog: { sketch: null, height: 10, heightRef: 'face', angle: 90, useDefaultRadius: true, radius: 2, position: 'start', flip: false, swapFixed: false },
    // an X of shallow folds across each picked flat face (marks for the flat pattern / DXF); flip: pressed down
    smCrossBreak: { faces: [], flip: false },
    // tabs on an edge of one sheet part (edge) through slots in another's face (face); height '' = the
    // other part's thickness; margin '' = tabs evenly spread
    // formType: 'dimple' (diameter, depth) | 'louver' (on sketch lines: width, height, side) | 'exthole'
    // (holeDiameter, collarHeight, radius); placed at sketch points / circle centres or clicked points
    smForm: { formType: 'dimple', sketch: null, faces: [], diameter: 10, depth: 2, width: 8, height: 4, side: false, holeDiameter: 8, collarHeight: 5, useDefaultRadius: true, radius: 1, flip: false },
    // size: each leg from the inside corner; width: across the bend
    smGusset: { faces: [], size: 10, width: 4 },
    // a flange of up to four segments (len / ang; a negative angle folds back the other way) along edges
    smProfileFlange: { edges: [], segments: '2', len1: 20, ang1: 90, len2: 10, ang2: 90, len3: 10, ang3: 90, len4: 10, ang4: 90, position: 'inside', flip: false, useDefaultRadius: true, radius: 2, corner: 'closed', cornerGap: 0.1, reliefType: 'rect', reliefRatio: 0.5 },
    smTabSlot: { edge: null, face: null, count: 3, length: 15, height: '', clearance: 0.1, margin: '' },
    smExtrude: { sketch: null, depth: 100, direction: 'one', thickness: 2, side: 'one', radius: 2, kFactor: 0.44, seamGap: 0.5 },
    // hemType: 'closed' | 'open' (gap) | 'teardrop' (radius, angle 181-269) | 'rolled' (radius, angle)
    smHem: { edges: [], hemType: 'closed', length: 10, gap: 1, radius: 1, angle: 270, tearAngle: 225, position: 'inside', flip: false, reliefType: 'rect', reliefRatio: 0.5 },
    // lengthRef: 'outer' | 'inner' (virtual sharp) | 'tangent'; position: 'inside' | 'outside' | 'bend'
    // corner: 'square' (flanges meeting at a corner each run square up to the other's inside face, their
    // inner edges cornerGap apart, the outside corner open) | 'butt' (mitred: they meet on the diagonal,
    // cornerGap apart) | 'closed' (one runs on to cover the other's end) | 'open'
    smFlange: { edges: [], length: 20, lengthRef: 'outer', angle: 90, position: 'inside', offset: 0, flip: false, useDefaultRadius: true, radius: 2, reliefType: 'rect', reliefRatio: 0.5, corner: 'square', cornerGap: 0.5, cornerSwap: false, cornerBend: 'vcut' },
    smCornerRelief: { body: null, reliefType: 'rect', size: 4 },
    // faces: picked flange faces, one per corner (none: every corner); cornerType: overlap | underlap | square | butt
    // bendCorner: 'vcut' (bends as formed from the flat, lens-shaped opening) | 'mitre' (bends closed on the diagonal)
    smClosedCorner: { body: null, faces: [], cornerType: 'overlap', bendCorner: 'vcut', gap: 0.1, swap: false },
    smUnfold: { face: null },
    smFold: { body: null },
    // autoThickness / autoRadius: read them from the body (a solid); off: the thickness / radius below instead
    // rollTol: a curved surface is rolled from arcs that follow it to within this (mm)
    // thickSide (surfaces): 'one' behind the surface | 'other' in front | 'mid' symmetric (flip: older parts);
    // trimSelf: a rolled sheet that would run into itself is cut back at one end
    smConvert: { face: null, autoThickness: true, thickness: 2, autoRadius: true, radius: 2, kFactor: 0.44, flip: false, thickSide: 'one', trimSelf: true, rollTol: 0.05 },
  }[type];
  const f = { id: newId(doc), type, name: '', suppressed: false, ...structuredClone(defaults), ...props };
  if (type === 'sketch') f.rev = newRev();
  f.name = props.name || nextName(doc, type, f.op);
  return f;
}

// Revision tag for sketch content; lets the app ignore stale kernel results.
export function newRev() {
  return Math.random().toString(36).slice(2, 10);
}

export function findFeature(doc, id) {
  return doc.features.find((f) => f.id === id);
}

// Features whose sketch is `sketchId`.
export function consumersOf(doc, sketchId) {
  return doc.features.filter((f) => f.type !== 'sketch' && sketchesUsedBy(f).includes(sketchId));
}

export function dependentsOf(doc, id) {
  return doc.features.filter((f) => f.id !== id && referencesOf(doc, f).has(id));
}

// The feature that created a body: body ids are 'f3', 'f3.2' (second body of f3) or 'f3~2' (split piece).
export const bodyOwner = (bodyId) => String(bodyId).split(/[.~]/)[0];

// Features that f refers to directly (its sketch, planes, axes, points, patterned features, the
// features that made the bodies it uses). Model faces/edges picked on the model are not counted.
export function referencesOf(doc, f) {
  const ids = new Set(doc.features.map((x) => x.id));
  const out = new Set();
  const addId = (v) => { if (typeof v === 'string' && ids.has(v)) out.add(v); };
  const addBody = (v) => { if (typeof v === 'string' && v) addId(bodyOwner(v)); };
  for (const k of ['sketch', 'feature', 'base', 'toPoint', 'toPlane', 'toPoint2', 'toPlane2', 'planeA', 'planeB', 'pointA', 'pointB', 'axis', 'dir1', 'dir2', 'rotAxis', 'parent', 'profile', 'path', 'guide', 'startDirection', 'endDirection']) addId(f[k]);
  if(['extrude','surfExtrude'].includes(f.type)&&f.startFrom==='surface')addId(f.startPlane);
  if (f.type === 'surfExtrude' && f.direction && f.direction !== 'none') addId(f.direction);
  for (const ref of [f.profile,f.path,f.guide,...(f.profiles || []), ...(f.guides || [])]) addId(typeof ref === 'string' ? ref : ref?.sketch);
  for (const id of expandFeatureRefs(doc, f.features)) addId(id);
  if (f.type !== 'sketch' && typeof f.plane === 'string') addId(f.plane);
  if (f.plane?.ref) addId(f.plane.ref);
  if (f.type === 'split') { addId(f.tool); addBody(f.tool); }
  if (f.axis === 'sketchLine' && f.axisSketch?.sketch) addId(f.axisSketch.sketch);
  if (f.sketchLine) addId(String(f.sketchLine).split(':')[0]);
  for (const r of [...(f.startFaces || []), ...(f.endFaces || []), ...(f.supportFaces || [])]) addBody(r.body);
  if (['surfFill','surfPlanar'].includes(f.type)) for (const r of f.edges || []) addBody(r.body);
  for (const r of f.type==='point'&&f.referenceDefinition&&f.pointType==='coords'?[]:f.refs||[]) { addId(r?.id); if (r?.kind === 'sketch') addId(r.sketch); addBody(r?.body); }
  for (const b of [...(f.bodies || []), ...(f.scope || []), f.main, f.body]) addBody(b);
  for (const m of f.mates || []) { addId(m.a?.id); addId(m.b?.id); }
  // projected (converted) sketch geometry
  for (const k of f.constraints || []) if (k.type === 'projected' && k.src?.fid) addId(k.src.fid);
  out.delete(f.id);
  return out;
}

// ---------------------------------------------------------------- rollback and reordering
// doc.rollbackAt: id of the first feature below the rollback bar (rolled back: not built), or null.
export function rollbackIndex(doc) {
  const i = doc.rollbackAt ? doc.features.findIndex((f) => f.id === doc.rollbackAt) : -1;
  return i < 0 ? doc.features.length : i;
}

export const isRolledBack = (doc, f) => doc.features.indexOf(f) >= rollbackIndex(doc);

// New features go just above the rollback bar.
export function insertFeature(doc, f) {
  doc.features.splice(rollbackIndex(doc), 0, f);
  return f;
}

// Sketches absorbed by feature f (they move with it).
export function absorbedSketches(doc, f) {
  if (f.type === 'sketch') return [];
  const used = sketchesUsedBy(f);
  return doc.features.filter((s) => s.type === 'sketch' && used.includes(s.id) && consumersOf(doc, s.id)[0] === f);
}

// Can the features `ids` (in their order) move to just before feature `beforeId` (null = the end)?
// Returns null when allowed, else the reason.
export function moveProblem(doc, ids, beforeId) {
  const group = new Set(ids);
  const rest = doc.features.filter((f) => !group.has(f.id));
  let at = beforeId ? rest.findIndex((f) => f.id === beforeId) : rest.length;
  if (at < 0) at = rest.length;
  const order = [...rest.slice(0, at), ...ids.map((id) => findFeature(doc, id)), ...rest.slice(at)];
  const pos = new Map(order.map((f, i) => [f.id, i]));
  for (const f of order) {
    for (const r of referencesOf(doc, f)) {
      if (pos.get(r) > pos.get(f.id)) {
        const a = findFeature(doc, r), b = f;
        return group.has(b.id) ? `${b.name} uses ${a.name}, so it must stay below it` : `${b.name} uses ${a.name}, so ${a.name} must stay above it`;
      }
    }
  }
  return null;
}

export function moveFeatures(doc, ids, beforeId) {
  const group = new Set(ids);
  const moving = ids.map((id) => findFeature(doc, id));
  const rest = doc.features.filter((f) => !group.has(f.id));
  let at = beforeId ? rest.findIndex((f) => f.id === beforeId) : rest.length;
  if (at < 0) at = rest.length;
  doc.features = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

// ---------------------------------------------------------------- feature folders
// doc.featureFolders: [{ id, name, ids }]: features of the tree grouped under a folder (shown where its first one is).
// A pattern may name a folder in its features ('folder:<id>'): it copies what is in the folder at each rebuild.
export const folderOfFeature = (doc, fid) => (doc.featureFolders || []).find((g) => g.ids.includes(fid)) || null;
export function putFeatureInFolder(doc, fid, folderId) {
  for (const g of doc.featureFolders || []) g.ids = g.ids.filter((x) => x !== fid);
  const g = folderId && (doc.featureFolders || []).find((x) => x.id === folderId);
  if (g) g.ids.push(fid);
  doc.featureFolders = (doc.featureFolders || []).filter((x) => x.ids.length);
  if (!doc.featureFolders.length) delete doc.featureFolders;
}
export function newFeatureFolder(doc, name, ids) {
  const used = new Set((doc.featureFolders || []).map((g) => g.id));
  let n = 1;
  while (used.has('ff' + n)) n++;
  for (const g of doc.featureFolders || []) g.ids = g.ids.filter((x) => !ids.includes(x));
  (doc.featureFolders ||= []).push({ id: 'ff' + n, name, ids: [...ids] });
  doc.featureFolders = doc.featureFolders.filter((x) => x.ids.length);
  return 'ff' + n;
}
// (a pattern's features with its folders' features in place of them)
export const expandFeatureRefs = (doc, ids) => (ids || []).flatMap((x) => (String(x).startsWith('folder:') ? (doc.featureFolders || []).find((g) => 'folder:' + g.id === x)?.ids || [] : [x]));

// ---------------------------------------------------------------- body folders
// doc.bodyFolders: [{ id, name, kind: 'solid' | 'surface', bodies: [body ids] }]
export function folderOfBody(doc, bodyId) {
  return (doc.bodyFolders || []).find((g) => g.bodies.includes(bodyId)) || null;
}

export function newBodyFolder(doc, kind, name) {
  doc.bodyFolders ||= [];
  let n = doc.bodyFolders.length + 1;
  while (doc.bodyFolders.some((g) => g.name === 'Folder' + n)) n++;
  const g = { id: 'bf' + Math.random().toString(36).slice(2, 8), name: name || 'Folder' + n, kind, bodies: [] };
  doc.bodyFolders.push(g);
  return g;
}

export function putBodyInFolder(doc, bodyId, folderId) {
  for (const g of doc.bodyFolders || []) g.bodies = g.bodies.filter((b) => b !== bodyId);
  const g = folderId && doc.bodyFolders.find((x) => x.id === folderId);
  if (g) g.bodies.push(bodyId);
}

export function planeName(doc, ref) {
  if (G.STD_PLANES[ref]) return G.STD_PLANES[ref].name;
  if (ref === 'face') return 'Face';
  const f = findFeature(doc, ref);
  return f ? f.name : '(missing)';
}

// Lines in a sketch that can serve as a revolve axis (centerlines first).
export function axisCandidates(sketch) {
  if (!sketch?.curves) return [];
  return sketch.curves
    .filter((c) => c.type === 'line')
    .sort((a, b) => (b.construction ? 1 : 0) - (a.construction ? 1 : 0))
    .map((c) => [c.id, S.itemName(sketch, c.id)]);
}

// ---------------------------------------------------------------- undo history
export class History {
  constructor() { this.stack = []; this.idx = -1; }
  reset(doc) { this.stack = [JSON.stringify(doc)]; this.idx = 0; }
  push(doc) {
    const s = JSON.stringify(doc);
    if (this.stack[this.idx] === s) return;
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(s);
    if (this.stack.length > 150) this.stack.shift();
    this.idx = this.stack.length - 1;
  }
  canUndo() { return this.idx > 0; }
  canRedo() { return this.idx < this.stack.length - 1; }
  undo() { return this.canUndo() ? JSON.parse(this.stack[--this.idx]) : null; }
  redo() { return this.canRedo() ? JSON.parse(this.stack[++this.idx]) : null; }
}

// ---------------------------------------------------------------- example part
// The tools of the tutorial in the manual, in one part: a duct lofted from a closed control-point spline up to a
// circle on a plane moved up and turned, following a guide curve; a variable fillet with points along its bottom
// edge; and beside it a sheet metal tray whose flanges meet corner to corner.
export function exampleDoc() {
  const doc = newDoc();
  doc.name = 'Example Duct and Tray';
  const add = (type, props) => { const f = createFeature(doc, type, props); doc.features.push(f); return f; };
  // the bottom profile: a closed control-point spline (it runs round smoothly near its points); symmetric, so it
  // crosses the x axis at (40 + 4·50 + 40) / 6 = 140/3, where the guide starts
  const s1 = add('sketch', { plane: { ref: 'top' } });
  const P1 = [[50, 0], [40, 25], [0, 30], [-40, 25], [-50, 0], [-40, -25], [0, -30], [40, -25]].map(([x, y]) => S.addPoint(s1, x, y));
  S.addCtrlSpline(s1, P1, 3, false, true);
  // the top profile: a circle on a plane 100 up, its axes turned 30° (Placement)
  const pl = add('plane', { refs: [{ kind: 'plane', id: 'top' }], offset: 100, turn: 30 });
  const s2 = add('sketch', { plane: { ref: pl.id } });
  S.addCircle(s2, 'O', 20);
  // the guide: an open control-point spline from the bottom profile to the top one, in the front plane
  const s3 = add('sketch', { plane: { ref: 'front' } });
  S.addCtrlSpline(s3, [[140 / 3, 0], [62, 45], [20, 100]].map(([x, y]) => S.addPoint(s3, x, y)), 2);
  add('loft', { profiles: [s1.id, s2.id], guides: [s3.id] });
  // a variable fillet round the bottom: R3 at its vertices, R8 half way along the edge where the guide starts
  add('fillet', { filletType: 'variable', radiusMode: 'vertices', radius: 3, edges: [{ p: [140 / 3, 0, 0] }], edgePoints: [{ edge: 0, t: 50, r: 8 }] });
  // the tray: a base flange 80 × 60 and four edge flanges meeting corner to corner
  const s4 = add('sketch', { plane: { ref: 'top' } });
  S.buildCenterRect(s4, S.addPoint(s4, 150, 0), 150, 0, 40, 30);
  add('smBase', { sketch: s4.id, thickness: 1.5, radius: 1.5 });
  add('smFlange', { edges: [{ p: [150, 1.5, 30] }, { p: [150, 1.5, -30] }, { p: [110, 1.5, 0] }, { p: [190, 1.5, 0] }], length: 20 });
  return doc;
}

// ---------------------------------------------------------------- sample part
export function sampleDoc() {
  const doc = newDoc();
  doc.name = 'Mounting Plate';
  doc.material = 'al6061';
  doc.equations = [
    { name: 'width', expr: '120' },
    { name: 'depth', expr: '80' },
    { name: 'thickness', expr: '12' },
    { name: 'hole_d', expr: '9' },
    { name: 'margin', expr: '12' },
    { name: 'boss_d', expr: '40' },
  ];
  const add = (type, props) => { const f = createFeature(doc, type, props); doc.features.push(f); return f; };
  const dim = (sk, refs, kind, value, extra = {}) => S.addRel(sk, 'dim', refs, { kind, value, ...extra });

  // Sketch1: base plate, center rectangle on the origin (fully defined)
  const s1 = add('sketch', { plane: { ref: 'top' } });
  const r = S.buildCenterRect(s1, 'O', 0, 0, 60, 40);
  dim(s1, [r.corners[0], r.corners[1]], 'hdist', 'width', { s: 1, off: -12 });
  dim(s1, [r.corners[1], r.corners[2]], 'vdist', 'depth', { s: 1, off: 12 });
  add('extrude', { sketch: s1.id, depth: 'thickness' });

  // Sketch2: corner hole, located from the origin
  const s2 = add('sketch', { plane: { ref: 'top' } });
  const hc = S.addPoint(s2, -48, -28);
  const hole = S.addCircle(s2, hc, 4.5);
  dim(s2, [hole], 'diameter', 'hole_d', { ang: 2.4 });
  dim(s2, ['O', hc], 'hdist', 'width/2 - margin', { s: -1, off: -10 });
  dim(s2, ['O', hc], 'vdist', 'depth/2 - margin', { s: -1, off: 10 });
  const cut = add('extrude', { sketch: s2.id, op: 'cut', end: 'through2' });
  add('lpattern', { feature: cut.id, dir1: 'x', dist1: 'width - 2*margin', count1: 2, dir2: 'z', rev2: true, dist2: 'depth - 2*margin', count2: 2 });

  // Sketch3: boss profile with a chamfer, revolved about the vertical centerline
  const s3 = add('sketch', { plane: { ref: 'front' } });
  const P = [[0, 12], [20, 12], [20, 30], [16, 34], [0, 34]].map(([x, y]) => S.addPoint(s3, x, y));
  const L = P.map((p, i) => S.addLine(s3, p, P[(i + 1) % P.length]));
  S.addRel(s3, 'horizontal', [L[0]]); S.addRel(s3, 'vertical', [L[1]]);
  S.addRel(s3, 'horizontal', [L[3]]); S.addRel(s3, 'vertical', [L[4]]);
  S.addRel(s3, 'vertical', ['O', P[0]]);
  const axisTop = S.addPoint(s3, 0, 44);
  const cl = S.addLine(s3, 'O', axisTop, true);
  S.addRel(s3, 'vertical', [cl]);
  dim(s3, ['O', axisTop], 'distance', 44, { off: 8 });
  dim(s3, ['O', P[0]], 'vdist', 'thickness', { s: 1, off: -6 });
  dim(s3, [P[0], P[1]], 'hdist', 'boss_d/2', { s: 1, off: -8 });
  dim(s3, [P[1], P[2]], 'vdist', 18, { s: 1, off: 10 });
  dim(s3, [P[0], P[4]], 'vdist', 22, { s: 1, off: -16 });
  dim(s3, [P[3], P[2]], 'hdist', 4, { s: 1, off: 10 });
  add('revolve', { sketch: s3.id, axis: cl, angle: 360 });

  // Sketch4: through hole in the boss
  const s4 = add('sketch', { plane: { ref: 'top' } });
  const bore = S.addCircle(s4, 'O', 10);
  dim(s4, [bore], 'diameter', 'boss_d/2', { ang: 0.8 });
  add('extrude', { sketch: s4.id, op: 'cut', end: 'through2' });

  // Sketch5: straight slot, symmetric about the vertical axis, mirrored to the other side
  const s5 = add('sketch', { plane: { ref: 'top' } });
  const c1 = S.addPoint(s5, -20, -26), c2 = S.addPoint(s5, 20, -26);
  const sl = S.buildSlot(s5, c1, c2, 4);
  S.addRel(s5, 'horizontal', [sl.centerline]);
  const mid = S.addPoint(s5, 0, -26);
  S.addRel(s5, 'midpoint', [mid, sl.centerline]);
  S.addRel(s5, 'vertical', ['O', mid]);
  dim(s5, [c1, c2], 'hdist', 40, { s: 1, off: 10 });
  dim(s5, [sl.arcs[1]], 'radius', 4, { ang: -0.4 });
  dim(s5, ['O', mid], 'vdist', 'depth/2 - 14', { s: -1, off: 30 });
  const slot = add('extrude', { sketch: s5.id, op: 'cut', end: 'through2' });
  add('mirror', { feature: slot.id, plane: 'front' });

  // Fillets and a chamfer (edges are referenced by a point on each edge)
  add('fillet', { radius: 'margin/2', edges: [[60, 6, 40], [-60, 6, 40], [60, 6, -40], [-60, 6, -40]].map((p) => ({ p })) });
  add('fillet', { radius: 3, edges: [{ p: [0, 12, 20] }] });
  add('chamfer', { distance: 1, edges: [[0, 12, 40], [0, 12, -40], [60, 12, 0], [-60, 12, 0]].map((p) => ({ p })) });
  return doc;
}
