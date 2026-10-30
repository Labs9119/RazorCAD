// Appearances: colours and textures put on faces, bodies or the whole part, kept as an ordered list in the part
// (doc.appearances), each one over those before it (the last one to reach a face is the one it shows). Each holds a
// look from the library below (metals, anodised aluminium, paints, plastics, glass, timbers, stone, rubber, meshes and
// gratings…), its colour, and the size and angle of its texture.
//
// The textures are drawn here, as seamless tiles on a canvas (nothing is downloaded), and laid on the model by box
// mapping (each face takes the tile projected along the axis it faces most, blended where it turns), so the model needs
// no texture coordinates. A mesh or grating cuts its holes out of the face: the face looks like a grating or a fence,
// see-through, without them being modelled.
//
//   doc.appearances: [{ id: 'ap1', name, suppressed?, target: 'part' | 'bodies' | 'faces', bodies: [body id],
//                       faces: [{ p: [x, y, z], n: [x, y, z], b: body id }], look: { preset, color?, scale?, angle? } }]
import * as THREE from 'three';

// ---- the library
// pbr: the physically based material's settings (for renders and the realistic view); tex: the texture's kind (null:
// a plain colour); size: the tile in mm ([width, height]); cut: the texture's holes are see-through
export const CATEGORIES = ['Metals', 'Anodised aluminium', 'Paints and coatings', 'Plastics', 'Glass', 'Timber', 'Stone and concrete', 'Rubber', 'Meshes and gratings', 'Fabrics and composites'];
const P = (id, name, cat, color, pbr, tex = null, size = 50, extra = {}) => ({ id, name, cat, color, pbr, tex, size: Array.isArray(size) ? size : [size, size], ...extra });
const metal = (r, m = 1, more = {}) => ({ metalness: m, roughness: r, ...more });
const dielectric = (r, more = {}) => ({ metalness: 0, roughness: r, ...more });
export const LIBRARY = [
  // metals
  P('steel', 'Steel (machined)', 'Metals', '#9ea3a9', metal(0.38, 0.95), 'brushed', [60, 60]),
  P('millSteel', 'Mild steel (mill scale)', 'Metals', '#5f646b', metal(0.62, 0.7), 'mill', 160),
  P('stainlessBrushed', 'Stainless steel (brushed)', 'Metals', '#c6cacf', metal(0.3), 'brushed', [40, 40]),
  P('stainlessPolished', 'Stainless steel (polished)', 'Metals', '#d5d8dc', metal(0.08)),
  P('chrome', 'Chrome', 'Metals', '#eef0f2', metal(0.03)),
  P('galvanised', 'Galvanised steel', 'Metals', '#b8bdc3', metal(0.42, 0.85), 'spangle', 60),
  P('castIron', 'Cast iron', 'Metals', '#4c4e52', metal(0.75, 0.7), 'grain', 12),
  P('alBrushed', 'Aluminium (brushed)', 'Metals', '#cacdd1', metal(0.28), 'brushed', [40, 40]),
  P('alBlasted', 'Aluminium (bead blasted)', 'Metals', '#bec2c7', metal(0.55, 0.9), 'grain', 6),
  P('alCast', 'Aluminium (cast)', 'Metals', '#a8acb1', metal(0.66, 0.85), 'grain', 18),
  P('checkerPlate', 'Checker plate (tread plate)', 'Metals', '#c0c4c9', metal(0.35, 0.95), 'checker', 30),
  P('brass', 'Brass', 'Metals', '#c9a54a', metal(0.18)),
  P('copper', 'Copper', 'Metals', '#c47a50', metal(0.2)),
  P('bronze', 'Bronze', 'Metals', '#9b6b3e', metal(0.32)),
  P('titanium', 'Titanium', 'Metals', '#8f9093', metal(0.34), 'brushed', [40, 40]),
  P('gold', 'Gold', 'Metals', '#e4bd5b', metal(0.12)),
  P('corten', 'Weathering steel (rusted)', 'Metals', '#7b4024', metal(0.85, 0.25), 'rust', 220),
  // anodised aluminium (a dyed, slightly glossy metal over a fine brushed grain)
  ...[['anodClear', 'clear', '#c9cdd2'], ['anodBlack', 'black', '#2a2c30'], ['anodRed', 'red', '#a5232e'], ['anodBlue', 'blue', '#1f52a0'], ['anodGold', 'gold', '#c39a3c'],
    ['anodGreen', 'green', '#2f7d50'], ['anodPurple', 'purple', '#5c2e84'], ['anodOrange', 'orange', '#c9581e'], ['anodGrey', 'titanium grey', '#6f7378']]
    .map(([id, c, hex]) => P(id, `Anodised aluminium (${c})`, 'Anodised aluminium', hex, metal(0.32, 0.85, { clearcoat: 0.35, clearcoatRoughness: 0.25 }), 'brushedFine', [30, 30])),
  // paints and coatings
  P('glossPaint', 'Gloss paint', 'Paints and coatings', '#c62828', dielectric(0.25, { clearcoat: 1, clearcoatRoughness: 0.05 })),
  P('satinPaint', 'Satin paint', 'Paints and coatings', '#1e5aa8', dielectric(0.45, { clearcoat: 0.3, clearcoatRoughness: 0.35 })),
  P('mattePaint', 'Matte paint', 'Paints and coatings', '#3b3e43', dielectric(0.85)),
  P('metallicPaint', 'Metallic paint', 'Paints and coatings', '#8a1c2b', metal(0.38, 0.55, { clearcoat: 1, clearcoatRoughness: 0.04 }), 'flake', 6),
  P('powderCoat', 'Powder coat (smooth)', 'Paints and coatings', '#f1f1ef', dielectric(0.5, { clearcoat: 0.2, clearcoatRoughness: 0.5 }), 'grain', 8),
  P('powderTextured', 'Powder coat (textured)', 'Paints and coatings', '#26272a', dielectric(0.72), 'orangePeel', 8),
  P('hammertone', 'Hammertone', 'Paints and coatings', '#4e6b5b', metal(0.45, 0.4), 'hammer', 30),
  P('safetyYellow', 'Safety yellow', 'Paints and coatings', '#f2c200', dielectric(0.4, { clearcoat: 0.5, clearcoatRoughness: 0.2 })),
  P('primer', 'Red oxide primer', 'Paints and coatings', '#8c3b2a', dielectric(0.8), 'grain', 10),
  // plastics
  P('glossPlastic', 'Plastic (gloss)', 'Plastics', '#e8e8e8', dielectric(0.15, { clearcoat: 0.5, clearcoatRoughness: 0.1 })),
  P('mattePlastic', 'Plastic (matte)', 'Plastics', '#2c2e32', dielectric(0.6)),
  P('texturedPlastic', 'Plastic (textured)', 'Plastics', '#313337', dielectric(0.78), 'grain', 3),
  P('nylon', 'Nylon (natural)', 'Plastics', '#eee8d6', dielectric(0.55)),
  P('acrylic', 'Acrylic (clear)', 'Plastics', '#f4f8fb', dielectric(0.02, { transmission: 1, ior: 1.49, thickness: 3 }), null, 50, { see: 0.25 }),
  P('frostedPlastic', 'Plastic (frosted)', 'Plastics', '#eef3f6', dielectric(0.45, { transmission: 0.9, ior: 1.49, thickness: 3 }), null, 50, { see: 0.45 }),
  // glass
  P('glass', 'Glass (clear)', 'Glass', '#ffffff', dielectric(0.01, { transmission: 1, ior: 1.5, thickness: 4 }), null, 50, { see: 0.2 }),
  P('tintedGlass', 'Glass (tinted)', 'Glass', '#5f8f8a', dielectric(0.02, { transmission: 0.9, ior: 1.5, thickness: 4 }), null, 50, { see: 0.4 }),
  P('frostedGlass', 'Glass (frosted)', 'Glass', '#e9f0f2', dielectric(0.35, { transmission: 0.95, ior: 1.5, thickness: 4 }), null, 50, { see: 0.5 }),
  // timber
  P('oak', 'Oak', 'Timber', '#b48a5a', dielectric(0.6, { clearcoat: 0.15, clearcoatRoughness: 0.4 }), 'wood', [300, 150], { rings: 9 }),
  P('pine', 'Pine', 'Timber', '#d9b27c', dielectric(0.62), 'wood', [300, 150], { rings: 6 }),
  P('walnut', 'Walnut', 'Timber', '#5f3b25', dielectric(0.5, { clearcoat: 0.3, clearcoatRoughness: 0.3 }), 'wood', [300, 150], { rings: 10 }),
  P('maple', 'Maple', 'Timber', '#e1c69c', dielectric(0.5, { clearcoat: 0.2, clearcoatRoughness: 0.3 }), 'wood', [300, 150], { rings: 12 }),
  P('cherry', 'Cherry', 'Timber', '#9c5233', dielectric(0.48, { clearcoat: 0.3, clearcoatRoughness: 0.3 }), 'wood', [300, 150], { rings: 10 }),
  P('plywood', 'Plywood (birch)', 'Timber', '#dcc49c', dielectric(0.65), 'wood', [400, 200], { rings: 4 }),
  P('mdf', 'MDF', 'Timber', '#a9855e', dielectric(0.8), 'grain', 4),
  // stone and concrete
  P('concrete', 'Concrete', 'Stone and concrete', '#9b9994', dielectric(0.9), 'concrete', 250),
  P('granite', 'Granite (polished)', 'Stone and concrete', '#6f6b69', dielectric(0.3, { clearcoat: 0.4, clearcoatRoughness: 0.1 }), 'granite', 80),
  P('marble', 'Marble (white)', 'Stone and concrete', '#ecebe7', dielectric(0.18, { clearcoat: 0.6, clearcoatRoughness: 0.08 }), 'marble', 400),
  P('slate', 'Slate', 'Stone and concrete', '#41474d', dielectric(0.7), 'slate', 250),
  P('sandstone', 'Sandstone', 'Stone and concrete', '#c8a87b', dielectric(0.95), 'sandstone', 250),
  P('brick', 'Brick', 'Stone and concrete', '#9d4b34', dielectric(0.9), 'brick', [450, 150]),
  // rubber
  P('rubber', 'Rubber (black)', 'Rubber', '#1d1d1f', dielectric(0.9), 'grain', 4),
  P('rubberGrey', 'Rubber (grey)', 'Rubber', '#5b5e62', dielectric(0.9), 'grain', 4),
  P('rubberRed', 'Rubber (red)', 'Rubber', '#9c2b23', dielectric(0.88), 'grain', 4),
  P('rubberRibbed', 'Rubber matting (ribbed)', 'Rubber', '#232325', dielectric(0.85), 'ribs', [10, 10]),
  P('silicone', 'Silicone (translucent)', 'Rubber', '#dfe6ea', dielectric(0.5, { transmission: 0.6, ior: 1.4, thickness: 3 }), null, 50, { see: 0.55 }),
  // meshes and gratings (see-through where they have holes)
  P('barGrating', 'Bar grating (30 × 100)', 'Meshes and gratings', '#a7acb2', metal(0.45, 0.85), 'grating', [30, 100], { cut: true }),
  P('expandedMesh', 'Expanded metal mesh', 'Meshes and gratings', '#9fa4aa', metal(0.5, 0.85), 'expanded', [40, 20], { cut: true }),
  P('perforated', 'Perforated sheet (Ø5 holes)', 'Meshes and gratings', '#b9bdc2', metal(0.35, 0.9), 'perforated', [8, 8 * Math.sqrt(3)], { cut: true }),
  P('slotted', 'Perforated sheet (slots)', 'Meshes and gratings', '#b9bdc2', metal(0.35, 0.9), 'slots', [30, 15], { cut: true }),
  P('wovenMesh', 'Woven wire mesh', 'Meshes and gratings', '#c3c6ca', metal(0.4, 0.95), 'woven', [12, 12], { cut: true }),
  P('weldMesh', 'Welded wire mesh (fence)', 'Meshes and gratings', '#8f9aa0', metal(0.5, 0.8), 'weldMesh', [75, 75], { cut: true }),
  P('chainLink', 'Chain-link fence', 'Meshes and gratings', '#a9b0b5', metal(0.45, 0.85), 'chainLink', [50, 50], { cut: true }),
  // fabrics and composites
  P('carbonFibre', 'Carbon fibre (twill)', 'Fabrics and composites', '#1b1c1f', dielectric(0.3, { clearcoat: 1, clearcoatRoughness: 0.03 }), 'carbon', [8, 8]),
  P('canvas', 'Canvas', 'Fabrics and composites', '#c9b996', dielectric(0.9), 'weave', [4, 4]),
  P('leather', 'Leather', 'Fabrics and composites', '#5a3a26', dielectric(0.55), 'leather', 40),
  P('felt', 'Felt', 'Fabrics and composites', '#55595f', dielectric(1), 'grain', 6),
];
// a plain colour (the default look of a new appearance)
LIBRARY.unshift(P('color', 'Colour (plain)', 'Paints and coatings', '#1e88e5', dielectric(0.45)));
export const PRESETS = Object.fromEntries(LIBRARY.map((p) => [p.id, p]));

// ---- seamless noise for the textures (a lattice that repeats every px × py cells)
function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, px, py, s = 1) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
  const m = (v, p) => ((v % p) + p) % p;
  const a = hash(m(xi, px), m(yi, py), s), b = hash(m(xi + 1, px), m(yi, py), s), c = hash(m(xi, px), m(yi + 1, py), s), d = hash(m(xi + 1, px), m(yi + 1, py), s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
// fractal noise at (u, v) in the tile ([0, 1)), starting with fx × fy cells, 0…1
function fbm(u, v, fx, fy, oct = 4, s = 1) {
  let sum = 0, amp = 0.5, tot = 0;
  for (let o = 0; o < oct; o++) { const kx = fx << o, ky = fy << o; sum += amp * vnoise(u * kx, v * ky, kx, ky, s + o * 17); tot += amp; amp *= 0.5; }
  return sum / tot;
}
// cells (Worley): the nearest of n points scattered in the tile (wrapping round), its distance and its number
function cells(n, s) { const pts = []; for (let i = 0; i < n; i++) pts.push([hash(i, 1, s), hash(i, 2, s)]); return pts; }
function nearest(u, v, pts) {
  let d1 = 9, d2 = 9, k = 0;
  for (let i = 0; i < pts.length; i++) {
    let dx = Math.abs(u - pts[i][0]), dy = Math.abs(v - pts[i][1]);
    dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy);
    const d = dx * dx + dy * dy;
    if (d < d1) { d2 = d1; d1 = d; k = i; } else if (d < d2) d2 = d;
  }
  return { d: Math.sqrt(d1), d2: Math.sqrt(d2), k };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const frac = (x) => x - Math.floor(x);

// ---- texture tiles: each a function of (u, v) in the tile (and its size in mm, for the meshes' wires) giving
// [brightness or [r, g, b] multiplier, alpha]; the base colour is multiplied by it
const TILES = {
  brushed: (u, v) => [0.86 + 0.16 * vnoise(u * 3, v * 220, 3, 220, 3) + 0.06 * (vnoise(u * 40, v * 600, 40, 600, 5) - 0.5)],
  brushedFine: (u, v) => [0.92 + 0.09 * vnoise(u * 2, v * 300, 2, 300, 7) + 0.03 * (vnoise(u * 30, v * 700, 30, 700, 8) - 0.5)],
  grain: (u, v) => [0.92 + 0.16 * (fbm(u, v, 32, 32, 3, 11) - 0.5) + 0.06 * (hash(Math.floor(u * 256), Math.floor(v * 256), 12) - 0.5)],
  mill: (u, v) => { const n = fbm(u, v, 4, 4, 5, 21); return [0.78 + 0.42 * n + 0.05 * (fbm(u, v, 64, 64, 2, 22) - 0.5)]; },
  spangle: (() => { const pts = cells(26, 31); return (u, v) => { const c = nearest(u, v, pts), k = hash(c.k, 9, 32); const edge = smooth(0, 0.012, c.d2 - c.d); return [(0.9 + 0.14 * k) * (0.95 + 0.05 * edge) + 0.03 * (fbm(u, v, 16, 16, 2, 33) - 0.5)]; }; })(),
  rust: (u, v) => {
    const n = fbm(u, v, 4, 4, 5, 41), m = fbm(u, v, 16, 16, 3, 42);
    const t = smooth(0.35, 0.7, n);
    return [[0.85 + 0.45 * t + 0.1 * m, 0.8 + 0.25 * t, 0.75 + 0.1 * t]];
  },
  checker: (u, v) => {
    // raised lozenges in a 2 × 2 pattern, turned one way and the other, lit from the top left
    const i = Math.floor(u * 2), j = Math.floor(v * 2), x = u - (i + 0.5) / 2, y = v - (j + 0.5) / 2;
    const ang = ((i + j) % 2 ? -1 : 1) * (Math.PI / 4), c = Math.cos(ang), s = Math.sin(ang);
    const a = (x * c + y * s) / 0.2, b = (-x * s + y * c) / 0.05, r = a * a + b * b;
    const base = 0.9 + 0.05 * (fbm(u, v, 16, 16, 2, 51) - 0.5);
    return [r < 1 ? base * (1.1 - 0.9 * (x + y) * (1 - r)) : base];
  },
  flake: (u, v) => { const s = hash(Math.floor(u * 512), Math.floor(v * 512), 61); return [0.9 + (s > 0.93 ? 0.6 * (s - 0.93) / 0.07 : 0) + 0.08 * (fbm(u, v, 8, 8, 2, 62) - 0.5)]; },
  orangePeel: (u, v) => { const n = fbm(u, v, 12, 12, 3, 71); return [0.82 + 0.36 * n]; },
  hammer: (() => { const pts = cells(18, 81); return (u, v) => { const c = nearest(u, v, pts); const rim = smooth(0.0, 0.06, c.d2 - c.d); const dome = 1 - c.d * 6; return [0.75 + 0.25 * rim + 0.12 * dome + 0.05 * (fbm(u, v, 32, 32, 2, 82) - 0.5)]; }; })(),
  wood: (u, v, p) => {
    // grain along u; rings across v, wavy, with fine fibres and pores
    const K = p.rings || 8;
    const warp = fbm(u, v, 2, 4, 4, 91) * 1.6 + 0.25 * Math.sin(2 * Math.PI * u * 2);
    const ring = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * K + warp));
    const late = smooth(0.55, 0.95, ring);
    const fibre = vnoise(u * 6, v * 260, 6, 260, 92) - 0.5;
    const pore = hash(Math.floor(u * 160), Math.floor(v * 512), 93) > 0.985 ? -0.25 : 0;
    const k = 1.12 - 0.42 * late + 0.1 * fibre + pore;
    return [[k, k * (0.97 - 0.05 * late), k * (0.93 - 0.08 * late)]];
  },
  concrete: (u, v) => { const n = fbm(u, v, 6, 6, 5, 101), pore = hash(Math.floor(u * 400), Math.floor(v * 400), 102) > 0.992 ? -0.35 : 0; return [0.86 + 0.26 * n + pore + 0.05 * (hash(Math.floor(u * 512), Math.floor(v * 512), 103) - 0.5)]; },
  granite: (u, v) => {
    const a = vnoise(u * 70, v * 70, 70, 70, 111), b = vnoise(u * 120, v * 120, 120, 120, 112), c = fbm(u, v, 8, 8, 3, 113);
    if (a > 0.72) return [0.35];
    if (b > 0.8) return [[1.45, 1.25, 1.2]];
    if (a < 0.2) return [1.3];
    return [0.9 + 0.2 * c];
  },
  marble: (u, v) => {
    const t = Math.sin(2 * Math.PI * (u * 1 + v * 2 + fbm(u, v, 4, 4, 5, 121) * 2.2));
    const vein = 1 - smooth(0, 0.12, Math.abs(t));
    const fine = 1 - smooth(0, 0.05, Math.abs(Math.sin(2 * Math.PI * (u * 3 - v * 1 + fbm(u, v, 8, 8, 4, 122) * 1.5))));
    return [1 - 0.42 * vein - 0.15 * fine + 0.03 * (fbm(u, v, 16, 16, 2, 123) - 0.5)];
  },
  slate: (u, v) => [0.84 + 0.28 * fbm(u, v, 2, 12, 5, 131) + 0.06 * (fbm(u, v, 32, 32, 2, 132) - 0.5)],
  sandstone: (u, v) => { const band = fbm(u, v, 2, 8, 4, 141); return [[0.9 + 0.22 * band, 0.88 + 0.2 * band, 0.86 + 0.15 * band].map((x) => x + 0.08 * (hash(Math.floor(u * 512), Math.floor(v * 512), 142) - 0.5))]; },
  brick: (u, v) => {
    // two courses per tile, each two bricks long (215 × 65 with 10 mm joints, roughly)
    const row = Math.floor(v * 2), y = frac(v * 2), x = frac(u * 2 + (row % 2 ? 0.5 : 0));
    const mortar = x < 0.022 || y < 0.067;
    if (mortar) { const k = 0.95 + 0.1 * hash(Math.floor(u * 300), Math.floor(v * 300), 151); return [{ abs: [178 * k, 172 * k, 160 * k] }]; }
    const id = Math.floor(u * 2 + (row % 2 ? 0.5 : 0)) + row * 7;
    const k = 0.82 + 0.3 * hash(id, row, 152);
    return [k + 0.12 * (fbm(u, v, 16, 8, 3, 153) - 0.5)];
  },
  ribs: (u, v) => [0.7 + 0.45 * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * v), 2) + 0.05 * (fbm(u, v, 8, 8, 2, 161) - 0.5)],
  carbon: (u, v) => {
    // 2 × 2 twill: four tows each way per tile, each going over two and under two
    const i = Math.floor(u * 4), j = Math.floor(v * 4), fu = frac(u * 4), fv = frac(v * 4);
    const horiz = (i + j) % 4 < 2;
    const across = horiz ? fv : fu, along = horiz ? fu : fv;
    const tube = Math.sin(Math.PI * across);
    return [0.55 + 0.75 * tube * (horiz ? 1 : 0.7) + 0.08 * Math.sin(2 * Math.PI * along * 6)];
  },
  weave: (u, v) => {
    const i = Math.floor(u * 4), j = Math.floor(v * 4), fu = frac(u * 4), fv = frac(v * 4);
    const horiz = (i + j) % 2 === 0;
    return [0.72 + 0.35 * Math.sin(Math.PI * (horiz ? fv : fu)) + 0.08 * (hash(Math.floor(u * 128), Math.floor(v * 128), 171) - 0.5)];
  },
  leather: (() => { const pts = cells(60, 181); return (u, v) => { const c = nearest(u, v, pts); const crease = smooth(0, 0.02, c.d2 - c.d); return [0.72 + 0.3 * crease + 0.08 * (fbm(u, v, 16, 16, 3, 182) - 0.5)]; }; })(),
  // meshes: [brightness, alpha] (alpha 0: a hole)
  grating: (u, v, p, W, H) => {
    // bearing bars along v every tile width (5 mm), a cross bar every tile height (6 mm, twisted)
    const bar = 5 / W, cross = 6 / H;
    const onBar = u < bar, onCross = v < cross;
    if (!onBar && !onCross) return [1, 0];
    return [onBar ? 0.95 + 0.15 * Math.sin(Math.PI * u / bar) : 0.85 + 0.2 * (frac(u * 8) > 0.5 ? 1 : 0), 1];
  },
  expanded: (u, v, p, W) => {
    const w = 3.2 / W, f1 = Math.abs(frac(u + v + 0.5) - 0.5), f2 = Math.abs(frac(u - v + 0.5) - 0.5), d = Math.min(f1, f2);
    return d < w ? [0.85 + 0.3 * (f1 < f2 ? 1 : 0.6) * (1 - d / w), 1] : [1, 0];
  },
  perforated: (u, v, p, W, H) => {
    // Ø5 holes staggered at 8 mm (the tile: 8 × 8√3, two rows)
    const r = 2.5, hole = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]].some(([x, y]) => Math.hypot((u - x) * W, (v - y) * H) < r);
    return hole ? [1, 0] : [1, 1];
  },
  slots: (u, v, p, W, H) => {
    // 20 × 5 slots, rows staggered (the tile: 30 × 15)
    const inSlot = (cx, cy) => { const x = Math.abs((u - cx) * W), y = Math.abs((v - cy) * H); return x < 7.5 ? y < 2.5 : Math.hypot(x - 7.5, y) < 2.5; };
    const hole = inSlot(0.25, 0.25) || inSlot(0.75, 0.75) || inSlot(-0.25, 0.75) || inSlot(1.25, 0.25);
    return hole ? [1, 0] : [1, 1];
  },
  woven: (u, v, p, W) => {
    // wires 1.2 mm each way, every half tile, going over and under each other in turn
    const w = 1.2 / W, du = Math.abs(frac(u * 2 + 0.5) - 0.5) / 2, dv = Math.abs(frac(v * 2 + 0.5) - 0.5) / 2;
    const onU = du <= w / 2, onV = dv <= w / 2;
    if (!onU && !onV) return [1, 0];
    const over = (Math.floor(u * 2 + 0.5) + Math.floor(v * 2 + 0.5)) % 2 === 0;
    const shade = onU && (!onV || over) ? Math.cos((Math.PI * du) / w) : Math.cos((Math.PI * dv) / w);
    return [0.7 + 0.45 * shade, 1];
  },
  weldMesh: (u, v, p, W) => {
    const w = 4 / W, du = Math.min(u, 1 - u), dv = Math.min(v, 1 - v);
    if (du > w / 2 && dv > w / 2) return [1, 0];
    return [0.75 + 0.35 * Math.cos((Math.PI * Math.min(du, dv)) / w), 1];
  },
  chainLink: (u, v, p, W) => {
    const w = 3 / W, f1 = Math.abs(frac(u + v + 0.5) - 0.5), f2 = Math.abs(frac(u - v + 0.5) - 0.5), d = Math.min(f1, f2);
    return d < w / 2 ? [0.75 + 0.4 * Math.cos((Math.PI * d) / w), 1] : [1, 0];
  },
};
export const TEXTURE_KINDS = Object.keys(TILES);

// A preset's tile drawn in a colour: a canvas (cached), at most 512 pixels on its long side
const tileCache = new Map();
export function tileCanvas(spec, px = 256) {
  if (!spec?.tex || !TILES[spec.tex]) return null;
  const [W, H] = spec.base || spec.size;
  const key = `${spec.tex}|${spec.color}|${W}x${H}|${spec.rings || ''}|${px}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const asp = H / W, w = asp > 1 ? Math.max(32, Math.round(px / asp)) : px, h = asp > 1 ? px : Math.max(32, Math.round(px * asp));
  const cv = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d'), im = ctx.createImageData(w, h);
  const base = [1, 3, 5].map((i) => parseInt(spec.color.slice(i, i + 2), 16)); // (sRGB, as the canvas holds it)
  const tile = TILES[spec.tex];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [k, a = 1] = tile((x + 0.5) / w, (y + 0.5) / h, spec, W, H), o = (y * w + x) * 4;
    for (let j = 0; j < 3; j++) im.data[o + j] = Math.max(0, Math.min(255, Math.round(k.abs ? k.abs[j] : base[j] * (Array.isArray(k) ? k[j] : k))));
    im.data[o + 3] = Math.round(255 * clamp01(a));
  }
  ctx.putImageData(im, 0, 0);
  tileCache.set(key, cv);
  if (tileCache.size > 80) tileCache.delete(tileCache.keys().next().value);
  return cv;
}
const texCache = new Map();
export function tileTexture(spec) {
  const cv = tileCanvas(spec);
  if (!cv) return null;
  if (texCache.has(cv)) return texCache.get(cv);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  texCache.set(cv, t);
  return t;
}

// ---- an appearance's look, as it is drawn: the preset with the appearance's colour, size and angle
const specCache = new Map();
export function lookSpec(look) {
  const p = PRESETS[look?.preset] || PRESETS.color;
  const color = /^#[0-9a-f]{6}$/i.test(look?.color || '') ? look.color.toLowerCase() : p.color;
  const scale = Number(look?.scale) > 0 ? Number(look.scale) : 1, angle = Number(look?.angle) || 0;
  const key = `${p.id}|${color}|${scale}|${angle}`;
  if (specCache.has(key)) return specCache.get(key);
  const s = { key, preset: p.id, name: p.name, cat: p.cat, color, pbr: p.pbr, tex: p.tex, base: p.size, size: [p.size[0] * scale, p.size[1] * scale], angle, cut: !!p.cut, see: p.see || 0, rings: p.rings };
  specCache.set(key, s);
  return s;
}
export const presetName = (look) => (PRESETS[look?.preset] || PRESETS.color).name;

// A look for a body that has no appearance: its colour, and the metal or plastic of its render look (render.js LOOKS)
export function plainSpec(color, pbr) {
  const key = `plain|${color}|${JSON.stringify(pbr)}`;
  if (specCache.has(key)) return specCache.get(key);
  const s = { key, preset: null, color: '#' + new THREE.Color(color).getHexString(), pbr, tex: null, size: [50, 50], angle: 0, cut: false, see: pbr.transmission ? 0.25 : 0 };
  specCache.set(key, s);
  return s;
}

// ---- which look each face shows: the appearances in order, each over those before it
// mesh: the part's mesh (bodies, faceGroups); bodyIds: the id of each of mesh.bodies; faceAt(f): the face index a stored
// face { p, n, b } is found at now (-1: not found). → { looks: [spec | null per face], lost: Map(appearance id → faces
// not found) }
export function resolve(appearances, mesh, bodyIds, faceAt) {
  const nf = mesh?.faceGroups?.length || 0, looks = new Array(nf).fill(null), lost = new Map();
  const bodies = mesh?.bodies?.length ? mesh.bodies : [{ faceStart: 0, faceCount: nf }];
  for (const ap of appearances || []) {
    if (ap.suppressed) continue;
    const spec = lookSpec(ap.look);
    if (ap.target === 'part') looks.fill(spec);
    else if (ap.target === 'bodies') {
      for (const id of ap.bodies || []) {
        const bi = bodyIds.indexOf(id), b = bodies[bi];
        if (!b) { lost.set(ap.id, (lost.get(ap.id) || 0) + 1); continue; }
        looks.fill(spec, b.faceStart, b.faceStart + b.faceCount);
      }
    } else for (const f of ap.faces || []) {
      const fi = faceAt(f);
      if (fi === -2) continue; // (on a hidden body)
      if (fi < 0 || fi >= nf) { lost.set(ap.id, (lost.get(ap.id) || 0) + 1); continue; }
      looks[fi] = spec;
    }
  }
  return { looks, lost };
}

// Stored faces found on a mesh without the view (an assembly's parts, files): the face nearest the point, on the same
// body and (flat) facing the same way; -1: not found
export function faceFinder(mesh) {
  const V = mesh.vertices, T = mesh.triangles, N = mesh.normals, groups = mesh.faceGroups || [];
  const gs = groups.reduce((n, g) => n + g.count, 0) === T.length ? 1 : 3;
  const faceOfTri = new Int32Array(T.length / 3).fill(-1), bodyOfFace = new Int32Array(groups.length).fill(0);
  groups.forEach((g, gi) => { for (let k = g.start * gs; k < (g.start + g.count) * gs; k += 3) faceOfTri[k / 3] = gi; });
  (mesh.bodies || []).forEach((b, bi) => bodyOfFace.fill(bi, b.faceStart, b.faceStart + b.faceCount));
  const d2 = (p, i) => {
    // (the squared distance from p to triangle i: its nearest point, as in Ericson's Real-Time Collision Detection)
    const a = T[3 * i] * 3, b = T[3 * i + 1] * 3, c = T[3 * i + 2] * 3;
    const ab = [V[b] - V[a], V[b + 1] - V[a + 1], V[b + 2] - V[a + 2]], ac = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]], ap = [p[0] - V[a], p[1] - V[a + 1], p[2] - V[a + 2]];
    const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const d1 = dot(ab, ap), d2_ = dot(ac, ap);
    let q;
    if (d1 <= 0 && d2_ <= 0) q = [0, 0];
    else {
      const bp = [p[0] - V[b], p[1] - V[b + 1], p[2] - V[b + 2]], d3 = dot(ab, bp), d4 = dot(ac, bp);
      const cp = [p[0] - V[c], p[1] - V[c + 1], p[2] - V[c + 2]], d5 = dot(ab, cp), d6 = dot(ac, cp);
      const vc = d1 * d4 - d3 * d2_, vb = d5 * d2_ - d1 * d6, va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) q = [1, 0];
      else if (d6 >= 0 && d5 <= d6) q = [0, 1];
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = [d1 / (d1 - d3), 0];
      else if (vb <= 0 && d2_ >= 0 && d6 <= 0) q = [0, d2_ / (d2_ - d6)];
      else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); q = [1 - w, w]; }
      else { const den = 1 / (va + vb + vc); q = [vb * den, vc * den]; }
    }
    const x = ab[0] * q[0] + ac[0] * q[1] - ap[0], y = ab[1] * q[0] + ac[1] * q[1] - ap[1], z = ab[2] * q[0] + ac[2] * q[1] - ap[2];
    return x * x + y * y + z * z;
  };
  return (f) => {
    let best = Infinity, fi = -1;
    for (let i = 0; i < T.length / 3; i++) { const d = d2(f.p, i); if (d < best) { best = d; fi = faceOfTri[i]; } }
    if (fi < 0) return -1;
    if (f.b != null && mesh.bodies?.[bodyOfFace[fi]] && mesh.bodies[bodyOfFace[fi]].id !== f.b) return -1;
    if (f.n) { const v = T[groups[fi].start * gs] * 3; if (N[v] * f.n[0] + N[v + 1] * f.n[1] + N[v + 2] * f.n[2] < 0.9) return -1; }
    return fi;
  };
}

// A part's mesh with its appearances' colours on its faces (face looks { c, t }), as an assembly shows the part
export function meshWithAppearances(mesh, appearances) {
  const list = (appearances || []).filter((x) => !x.suppressed);
  if (!list.length || !mesh?.faceGroups?.length) return mesh;
  const { looks } = resolve(list, mesh, (mesh.bodies || []).map((b) => b.id), faceFinder(mesh));
  if (!looks.some(Boolean)) return mesh;
  return { ...mesh, faceGroups: mesh.faceGroups.map((g, i) => (looks[i] ? { ...g, look: { c: looks[i].color, t: looks[i].see ? 1 - looks[i].see : 0 } } : g)) };
}

// A short line for an appearance in the tree: what it is on
export function targetSummary(ap, bodyName = (id) => id) {
  if (ap.target === 'part') return 'Whole part';
  if (ap.target === 'bodies') { const n = ap.bodies?.length || 0; return n === 1 ? bodyName(ap.bodies[0]) : `${n} bodies`; }
  const n = ap.faces?.length || 0;
  return `${n} face${n === 1 ? '' : 's'}`;
}

export function nextId(doc) {
  const used = (doc.appearances || []).map((a) => +String(a.id).slice(2) || 0);
  doc.nextAppearance = Math.max(doc.nextAppearance || 0, ...used, 0) + 1;
  return 'ap' + doc.nextAppearance;
}

// ---- box mapping in a three.js material: the tile projected along the axis each point faces most (blended where it
// turns, except for the see-through meshes, whose holes stay sharp), in mm of the model; its holes cut out (also from
// the shadows, through a depth material made the same way)
export function boxMapped(mat, tex, spec) {
  const c = Math.cos((spec.angle * Math.PI) / 180), s = Math.sin((spec.angle * Math.PI) / 180);
  const uni = { bmMap: { value: tex }, bmSize: { value: new THREE.Vector2(spec.size[0], spec.size[1]) }, bmRot: { value: new THREE.Vector2(c, s) } };
  const cut = !!spec.cut;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 bmP;\nvarying vec3 bmN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nbmP = position;\nbmN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D bmMap; uniform vec2 bmSize; uniform vec2 bmRot; varying vec3 bmP; varying vec3 bmN;
vec4 bmAt(vec2 q) { vec2 r = vec2(q.x * bmRot.x - q.y * bmRot.y, q.x * bmRot.y + q.y * bmRot.x); return texture2D(bmMap, r / bmSize); }`)
      .replace('#include <map_fragment>', `{
  vec3 an = abs(normalize(bmN));
  vec4 tx;
  ${cut
    ? 'if (an.x >= an.y && an.x >= an.z) tx = bmAt(bmP.zy); else if (an.y >= an.z) tx = bmAt(bmP.xz); else tx = bmAt(bmP.xy);\n  if (tx.a < 0.5) discard;'
    : 'vec3 w = pow(an, vec3(8.0)); w /= (w.x + w.y + w.z);\n  tx = bmAt(bmP.zy) * w.x + bmAt(bmP.xz) * w.y + bmAt(bmP.xy) * w.z;'}
  diffuseColor.rgb *= tx.rgb;
}`);
  };
  mat.customProgramCacheKey = () => 'boxmap' + (cut ? 'cut' : '');
  return mat;
}
export function boxMappedDepth(tex, spec) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  return boxMapped(m, tex, spec);
}
