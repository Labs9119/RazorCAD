// Radiance .hdr (RGBE) files: the photo render scenes' lighting (render.js, app/scenes/). parseHDR(ArrayBuffer) →
// { width, height, data: Uint16Array of half floats, RGBA, bottom row first (as a texture takes it) }.
import * as THREE from 'three';

export function parseHDR(buf) {
  const b = new Uint8Array(buf);
  let i = 0;
  const line = () => { let s = ''; while (i < b.length && b[i] !== 10) s += String.fromCharCode(b[i++]); i++; return s; };
  if (!line().startsWith('#?')) throw new Error('Not a Radiance HDR file');
  for (let l = line(); l.trim(); l = line()) if (/^FORMAT=/.test(l) && !/32-bit_rle_rgbe/.test(l)) throw new Error('Unsupported HDR format');
  const m = /^-Y (\d+) \+X (\d+)/.exec(line());
  if (!m) throw new Error('Unsupported HDR layout');
  const h = +m[1], w = +m[2], rgbe = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    // (a flat scanline, or a run-length encoded one: each channel in turn, runs (n > 128: a byte n − 128 times) and
    // literal stretches (n bytes as they are))
    if (w < 8 || w > 0x7fff || b[i] !== 2 || b[i + 1] !== 2 || b[i + 2] & 0x80) { rgbe.set(b.subarray(i, i + w * 4), row); i += w * 4; continue; }
    i += 4;
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < w;) {
        let n = b[i++];
        if (n > 128) { n -= 128; const v = b[i++]; for (let k = 0; k < n; k++) rgbe[row + (x + k) * 4 + c] = v; } else for (let k = 0; k < n; k++) rgbe[row + (x + k) * 4 + c] = b[i++];
        x += n;
      }
    }
    if (i > b.length) throw new Error('The HDR file is cut short');
  }
  const data = new Uint16Array(w * h * 4), half = THREE.DataUtils.toHalfFloat, one = half(1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = ((h - 1 - y) * w + x) * 4, e = rgbe[s + 3], f = e ? 2 ** (e - 136) : 0;
      data[d] = half(rgbe[s] * f); data[d + 1] = half(rgbe[s + 1] * f); data[d + 2] = half(rgbe[s + 2] * f); data[d + 3] = one;
    }
  }
  return { width: w, height: h, data };
}
