// glTF export (.glb): the part's bodies as the view shows them, each a mesh with a physically based material (its
// colour, and the metalness and roughness of its render look), in metres (the model is in millimetres), Y up, for
// web viewers and AR.
import * as THREE from 'three';
import { LOOKS } from './render.js';

// bodies: [{ name, color, look, positions: Float32Array, normals: Float32Array, indices: Uint32Array }]
export function glb(bodies, name = 'Part') {
  const chunks = [], views = [], accessors = [], meshes = [], materials = [], nodes = [];
  let offset = 0;
  const addView = (arr, target) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, new Uint8Array(pad));
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return views.length - 1;
  };
  bodies.forEach((b, i) => {
    const n = b.positions.length / 3, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) for (let j = 0; j < 3; j++) { const v = b.positions[3 * k + j]; if (v < min[j]) min[j] = v; if (v > max[j]) max[j] = v; }
    const pv = addView(b.positions, 34962), nv = addView(b.normals, 34962), iv = addView(b.indices, 34963);
    accessors.push({ bufferView: pv, componentType: 5126, count: n, type: 'VEC3', min, max }, { bufferView: nv, componentType: 5126, count: n, type: 'VEC3' }, { bufferView: iv, componentType: 5125, count: b.indices.length, type: 'SCALAR' });
    const c = new THREE.Color(b.color ?? 0xc3cad4), L = LOOKS[b.look] || LOOKS.powder; // (three.js keeps colours linear: as glTF wants them)
    materials.push({ name: `${b.name} (${L.name})`, pbrMetallicRoughness: { baseColorFactor: [c.r, c.g, c.b, L.transmission ? 0.35 : 1], metallicFactor: L.metalness ?? 0, roughnessFactor: L.roughness ?? 0.5 }, doubleSided: true, ...(L.transmission ? { alphaMode: 'BLEND' } : {}) });
    meshes.push({ name: b.name, primitives: [{ attributes: { POSITION: 3 * i, NORMAL: 3 * i + 1 }, indices: 3 * i + 2, material: i }] });
    nodes.push({ name: b.name, mesh: i });
  });
  const root = { name, scale: [0.001, 0.001, 0.001], children: nodes.map((_, i) => i + 1) };
  const json = {
    asset: { version: '2.0', generator: 'RazorCAD' },
    scene: 0, scenes: [{ name, nodes: [0] }], nodes: [root, ...nodes],
    meshes, materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }],
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(js.length + jpad).fill(0x20); t.set(js); js = t; }
  const total = 12 + 8 + js.length + 8 + offset, out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(js, 20);
  let at = 20 + js.length;
  dv.setUint32(at, offset, true); dv.setUint32(at + 4, 0x004e4942, true); at += 8;
  for (const ch of chunks) { out.set(ch, at); at += ch.length; }
  return out;
}

// The viewport's bodies (hidden ones left out), each with only the points it uses.
export function viewportBodies(vp, { names = [], colors = [], looks = [] } = {}) {
  const mesh = vp.mesh, tris = mesh?.triangles;
  if (!tris) return [];
  const P = mesh.vertices, N = mesh.normals;
  const list = vp.bodies?.length ? vp.bodies : [{ triStart: 0, triCount: tris.length }];
  return list.map((b, bi) => {
    if (vp.hiddenBodies?.has(bi)) return null;
    const map = new Map(), pos = [], nor = [], idx = new Uint32Array(b.triCount);
    for (let k = 0; k < b.triCount; k++) {
      const v = tris[b.triStart + k];
      let j = map.get(v);
      if (j === undefined) { j = map.size; map.set(v, j); pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); nor.push(N[3 * v], N[3 * v + 1], N[3 * v + 2]); }
      idx[k] = j;
    }
    return { name: names[bi] || `Body ${bi + 1}`, color: colors[bi], look: looks[bi], positions: new Float32Array(pos), normals: new Float32Array(nor), indices: idx };
  }).filter(Boolean);
}
