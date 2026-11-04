// Weldment profiles: standard structural sections (AS/NZS and EN/ISO), timber, and their cross sections as 2D loops
// (line / arc segments) for the kernel. Dimensions in mm. Root radii are the standard ones; tapered
// flanges (e.g. UPN) are drawn parallel.

// tube corner radii (EN 10219 / AS/NZS 1163): outside 2t up to 6 mm wall, 2.5t up to 10, 3t above
const tubeRo = (t) => (t <= 6 ? 2 * t : t <= 10 ? 2.5 * t : 3 * t);

const rows = (txt, keys) => txt.trim().split(/\s*;\s*/).map((r) => { const v = r.split(/[\sx×]+/).map(Number); return Object.fromEntries(keys.map((k, i) => [k, v[i]])); });
const tubes = (spec) => spec.trim().split(/\s*;\s*/).flatMap((r) => { const [size, ts] = r.split(':'); const [b, d] = size.split('x').map(Number); return ts.split(',').map(Number).map((t) => ({ b, d: d || b, t })); });
const chs = (spec) => spec.trim().split(/\s*;\s*/).flatMap((r) => { const [D, ts] = r.split(':'); return ts.split(',').map(Number).map((t) => ({ D: +D, t })); });
const angles = (spec, rr) => spec.trim().split(/\s*;\s*/).flatMap((r) => { const [size, ts] = r.split(':'); const [a, b] = size.split('x').map(Number); return ts.split(',').map(Number).map((t) => ({ a, b: b || a, t, r: rr(Math.max(a, b || a)) })); });
const asRoot = (leg) => (leg <= 30 ? 3 : leg <= 55 ? 6 : leg <= 100 ? 8 : leg <= 150 ? 13 : 15);
// the nominal size (designation) nearest a real depth
const nominal = (d, list) => list.reduce((b, x) => (Math.abs(x - d) < Math.abs(b - d) ? x : b), list[0]);
const enRoot = (leg) => (leg <= 30 ? 3.5 : leg <= 50 ? 7 : leg <= 80 ? 8 : leg <= 100 ? 12 : leg <= 150 ? 16 : 18);

export const PROFILE_TYPES = {
  shs: { label: 'Square hollow section (SHS)', kind: 'tube', dims: [['b', 'Width'], ['t', 'Wall']] },
  rhs: { label: 'Rectangular hollow section (RHS)', kind: 'tube', dims: [['d', 'Depth'], ['b', 'Width'], ['t', 'Wall']] },
  chs: { label: 'Circular hollow section (CHS / pipe)', kind: 'chs', dims: [['D', 'Outside diameter'], ['t', 'Wall']] },
  ea: { label: 'Equal angle', kind: 'angle', dims: [['a', 'Leg'], ['t', 'Thickness'], ['r', 'Root radius']] },
  ua: { label: 'Unequal angle', kind: 'angle', dims: [['a', 'Long leg'], ['b', 'Short leg'], ['t', 'Thickness'], ['r', 'Root radius']] },
  channel: { label: 'Channel (PFC / UPN)', kind: 'channel', dims: [['d', 'Depth'], ['bf', 'Flange width'], ['tf', 'Flange thickness'], ['tw', 'Web thickness'], ['r', 'Root radius']] },
  ibeam: { label: 'I-beam (UB / UC / IPE / HEA)', kind: 'ibeam', dims: [['d', 'Depth'], ['bf', 'Flange width'], ['tf', 'Flange thickness'], ['tw', 'Web thickness'], ['r', 'Root radius']] },
  flat: { label: 'Flat bar', kind: 'flat', dims: [['b', 'Width'], ['t', 'Thickness']] },
  timber: { label: 'Timber (rectangular)', kind: 'flat', dims: [['b', 'Width'], ['t', 'Thickness']] },
  round: { label: 'Round bar', kind: 'round', dims: [['D', 'Diameter']] },
};

// standard -> type -> sizes ({ name, …dims })
const named = (list, fmt) => list.map((x) => ({ ...x, name: fmt(x) }));
const n = (v) => String(+(+v).toFixed(2));
const tubeName = (x) => `${n(x.d || x.b)}x${n(x.b)}x${n(x.t)}`;
// (timber: [width, thickness] of the finished section; a size sold by a nominal name keeps it, with what it really is)
const boards = (list) => list.map(([b, t, nominal]) => ({ name: nominal ? `${nominal} (${b}x${t})` : `${b}x${t}`, b, t }));
export const LIBRARY = {
  'AS/NZS': {
    shs: named(tubes('20:1.6,2; 25:1.6,2,2.5,3; 30:1.6,2; 35:2,2.5,3; 40:2,2.5,3,4; 50:2,2.5,3,4,5,6; 65:2.5,3,4,5,6; 75:2.5,3,3.5,4,5,6; 89:3.5,5,6; 100:3,4,5,6,9; 125:4,5,6,9; 150:5,6,9,10; 200:5,6,9,10'), (x) => `${n(x.b)}x${n(x.b)}x${n(x.t)} SHS`),
    rhs: named(tubes('50x25:1.6,2,2.5,3; 65x35:2,2.5,3,4; 75x25:1.6,2,2.5; 75x50:2,2.5,3,4,5,6; 100x50:2,2.5,3,3.5,4,5,6; 125x75:3,4,5,6,9; 150x50:3,4,5; 150x100:4,5,6,9,10; 200x100:4,5,6,9,10; 250x150:5,6,9,10').map((x) => ({ d: x.b, b: x.d, t: x.t })), (x) => `${n(x.d)}x${n(x.b)}x${n(x.t)} RHS`),
    chs: named(chs('21.3:2,2.6,3.2; 26.9:2,2.3,2.6,3.2; 33.7:2,2.6,3.2,4; 42.4:2,2.6,3.2,4; 48.3:2.3,2.9,3.2,4; 60.3:2.3,2.9,3.6,4.5; 76.1:2.3,3.2,3.6,4.5; 88.9:2.6,3.2,4,5.5; 101.6:3.2,4,5; 114.3:3.2,3.6,4.5,5.4,6; 139.7:3,3.5,5,5.4,6.6; 165.1:3,3.5,5,5.4,7; 168.3:7.1; 219.1:4.8,5,6.4,8.2'), (x) => `${n(x.D)}x${n(x.t)} CHS`),
    ea: named(angles('25:3,5; 30:3,5; 40:3,5,6; 45:3,5,6; 50:3,5,6,8; 55:5,6; 65:5,6,8,10; 75:5,6,8,10; 90:6,8,10; 100:6,8,10,12; 125:8,10,12,16; 150:10,12,16,19; 200:13,16,18,20,26', asRoot), (x) => `${n(x.a)}x${n(x.a)}x${n(x.t)} EA`),
    ua: named(angles('75x50:5,6,8; 100x75:6,8,10; 125x75:6,8,10,12; 150x90:8,10,12,16; 150x100:10,12', asRoot), (x) => `${n(x.a)}x${n(x.b)}x${n(x.t)} UA`),
    channel: named(rows('75 40 6.1 3.8 8; 100 50 6.7 4.2 8; 125 65 7.5 4.7 8; 150 75 9.5 6 10; 180 75 11 6 12; 200 75 12 6 12; 230 75 12 6.5 12; 250 90 15 8 12; 300 90 16 8 14; 380 100 17.5 10 14', ['d', 'bf', 'tf', 'tw', 'r']), (x) => `${n(x.d)} PFC`),
    ibeam: [
      ...rows('150 75 7 5 8 14.0; 155 75 9.5 6 8 18.0; 173 90 7 4.5 8.9 16.1; 175 90 8 5 8.9 18.1; 179 90 10 6 8.9 22.2; 198 99 7 4.5 11 18.2; 202 133 7 5 8.9 22.3; 203 133 7.8 5.8 8.9 25.4; 207 134 9.6 6.3 8.9 29.8; 248 124 8 5 12 25.7; 252 146 8.6 6.1 8.9 31.4; 256 146 10.9 6.4 8.9 37.3; 298 149 8 5.5 13 32.0; 304 165 10.2 6.1 11.4 40.4; 307 166 11.8 6.7 11.4 46.2; 352 171 9.7 6.9 11.4 44.7; 356 171 11.5 7.3 11.4 50.7; 359 172 13 8 11.4 56.7; 403 178 10.9 7.6 11.4 53.7; 406 178 12.8 7.8 11.4 59.7; 454 190 12.7 8.5 11.4 67.1', ['d', 'bf', 'tf', 'tw', 'r', 'm'])
        .map((x) => ({ ...x, name: `${nominal(x.d, [150, 180, 200, 250, 310, 360, 410, 460])}UB${x.m.toFixed(1)}` })),
      ...rows('97 99 7 5 10 14.8; 152 152 6.8 6.1 8.9 23.4; 158 153 9.4 6.6 8.9 30.0; 162 154 11.5 8.1 8.9 37.2; 203 203 11 7.3 11.4 46.2; 206 204 12.5 8 11.4 52.2; 210 205 14.2 9.3 11.4 59.5; 254 254 14.2 8.6 12.7 72.9; 260 256 17.3 10.5 12.7 89.5', ['d', 'bf', 'tf', 'tw', 'r', 'm'])
        .map((x) => ({ ...x, name: `${nominal(x.d, [100, 150, 200, 250, 310])}UC${x.m.toFixed(1)}` })),
    ],
    flat: named(rows('20 3; 25 3; 25 5; 30 5; 40 5; 50 5; 50 6; 50 10; 65 6; 75 6; 75 10; 100 6; 100 10; 150 10', ['b', 't']), (x) => `${n(x.b)}x${n(x.t)} FL`),
    round: named(rows('6; 8; 10; 12; 16; 20; 25; 30; 40; 50', ['D']), (x) => `${n(x.D)} RB`),
  },
  'EN/ISO': {
    shs: named(tubes('20:2; 25:2,2.5; 30:2,2.5,3; 40:2,2.5,3,4; 50:2.5,3,4,5; 60:3,4,5; 70:3,4,5; 80:3,4,5,6; 90:4,5,6; 100:4,5,6,8; 120:4,5,6,8,10; 140:5,6,8,10; 150:5,6,8,10; 160:5,6,8,10; 200:6,8,10,12.5'), (x) => `SHS ${n(x.b)}x${n(x.b)}x${n(x.t)}`),
    rhs: named(tubes('40x20:2,2.5,3; 50x30:2.5,3,4; 60x40:2.5,3,4,5; 80x40:3,4,5; 100x50:3,4,5,6; 120x60:4,5,6; 120x80:4,5,6,8; 150x100:4,5,6,8,10; 160x80:5,6,8; 200x100:5,6,8,10; 250x150:6,8,10,12.5').map((x) => ({ d: x.b, b: x.d, t: x.t })), (x) => `RHS ${n(x.d)}x${n(x.b)}x${n(x.t)}`),
    chs: named(chs('21.3:2,2.6; 26.9:2,2.6,3.2; 33.7:2.6,3.2,4; 42.4:2.6,3.2,4; 48.3:2.6,3.2,4,5; 60.3:2.9,3.2,4,5; 76.1:2.9,3.2,4,5; 88.9:3.2,4,5,6.3; 114.3:3.6,4,5,6.3; 139.7:4,5,6.3,8; 168.3:4,5,6.3,8,10; 219.1:4.5,6.3,8,10'), (x) => `CHS ${n(x.D)}x${n(x.t)}`),
    ea: named(angles('20:3; 25:3,4; 30:3,4; 35:4; 40:4,5; 45:4.5; 50:5,6; 60:5,6,8; 70:6,7; 80:8,10; 90:7,8,9; 100:8,10,12; 120:10,12; 150:12,15; 200:16,20', enRoot), (x) => `L ${n(x.a)}x${n(x.a)}x${n(x.t)}`),
    ua: named(angles('60x40:5,6; 75x50:6,8; 80x40:6,8; 100x50:6,8,10; 100x65:7,8,10; 120x80:8,10,12; 150x75:9,10,12; 150x90:10,12; 200x100:10,12,15', enRoot), (x) => `L ${n(x.a)}x${n(x.b)}x${n(x.t)}`),
    channel: named(rows('80 45 8 6 8; 100 50 8.5 6 8.5; 120 55 9 7 9; 140 60 10 7 10; 160 65 10.5 7.5 10.5; 180 70 11 8 11; 200 75 11.5 8.5 11.5; 220 80 12.5 9 12.5; 240 85 13 9.5 13; 260 90 14 10 14; 300 100 16 10 16', ['d', 'bf', 'tf', 'tw', 'r']), (x) => `UPN ${n(x.d)}`),
    ibeam: [
      ...named(rows('80 46 5.2 3.8 5; 100 55 5.7 4.1 7; 120 64 6.3 4.4 7; 140 73 6.9 4.7 7; 160 82 7.4 5 9; 180 91 8 5.3 9; 200 100 8.5 5.6 12; 220 110 9.2 5.9 12; 240 120 9.8 6.2 15; 270 135 10.2 6.6 15; 300 150 10.7 7.1 15; 330 160 11.5 7.5 18; 360 170 12.7 8 18; 400 180 13.5 8.6 21', ['d', 'bf', 'tf', 'tw', 'r']), (x) => `IPE ${n(x.d)}`),
      ...rows('96 100 8 5 12 100; 114 120 8 5 12 120; 133 140 8.5 5.5 12 140; 152 160 9 6 15 160; 171 180 9.5 6 15 180; 190 200 10 6.5 18 200; 210 220 11 7 18 220; 230 240 12 7.5 21 240; 250 260 12.5 7.5 24 260; 270 280 13 8 24 280; 290 300 14 8.5 27 300', ['d', 'bf', 'tf', 'tw', 'r', 'k']).map((x) => ({ ...x, name: `HEA ${x.k}` })),
    ],
    flat: named(rows('20 3; 20 5; 25 5; 30 5; 40 5; 40 8; 50 5; 50 8; 50 10; 60 6; 80 8; 100 10; 120 10; 150 12', ['b', 't']), (x) => `FL ${n(x.b)}x${n(x.t)}`),
    round: named(rows('6; 8; 10; 12; 16; 20; 25; 30; 40; 50; 60', ['D']), (x) => `RD ${n(x.D)}`),
  },
  Timber: {
    timber: boards([[70, 35], [90, 35], [90, 45], [140, 35], [140, 45], [190, 45], [240, 45], [290, 45], [42, 19], [65, 19], [90, 19], [115, 19], [140, 19], [190, 19], [240, 19], [42, 42], [65, 42],
      [38, 19, '1x2'], [64, 19, '1x3'], [89, 19, '1x4'], [140, 19, '1x6'], [184, 19, '1x8'], [235, 19, '1x10'], [286, 19, '1x12'], [38, 38, '2x2'], [64, 38, '2x3'], [89, 38, '2x4'], [140, 38, '2x6'], [184, 38, '2x8'], [235, 38, '2x10'], [286, 38, '2x12'], [89, 89, '4x4']]),
    round: [6, 8, 10, 12, 16, 20, 25, 32].map((D) => ({ name: `${D} dowel`, D })),
  },
};
export const STANDARDS = Object.keys(LIBRARY);

// The dimensions of a member's profile: from the library, or the custom ones. f: { standard, ptype, size, dims }
export function profileDims(f, ev = Number) {
  const type = PROFILE_TYPES[f.ptype] ? f.ptype : 'shs';
  if (f.standard === 'custom') {
    const d = {};
    for (const [k] of PROFILE_TYPES[type].dims) d[k] = ev(f.dims?.[k] ?? 0);
    if (type === 'shs') d.d = d.b;
    if (type === 'ea') d.b = d.a;
    const label = `${PROFILE_TYPES[type].label.split(' (')[0]} ${PROFILE_TYPES[type].dims.map(([k]) => n(d[k])).join('x')}`;
    return { type, ...d, label };
  }
  const list = LIBRARY[f.standard]?.[type] || [];
  const row = list.find((x) => x.name === f.size) || list[0];
  if (!row) throw new Error('Choose a profile size');
  return { type, ...row, d: row.d ?? row.b, b: row.b ?? row.a, label: row.name };
}

// ---- cross sections
const P = (x, y) => [x, y];
// A closed polygon with rounded corners: pts [[x, y, r]…] → line / arc segments.
function rounded(pts) {
  const segs = [], N = pts.length, ends = [];
  for (let i = 0; i < N; i++) {
    const [x, y, r] = pts[i], prev = pts[(i - 1 + N) % N], next = pts[(i + 1) % N];
    if (!(r > 0)) { ends.push({ a: P(x, y), b: P(x, y) }); continue; }
    const u1 = [prev[0] - x, prev[1] - y], u2 = [next[0] - x, next[1] - y];
    const l1 = Math.hypot(...u1), l2 = Math.hypot(...u2);
    u1[0] /= l1; u1[1] /= l1; u2[0] /= l2; u2[1] /= l2;
    const phi = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    const d = r / Math.tan(phi / 2), h = r / Math.sin(phi / 2);
    const bx = u1[0] + u2[0], by = u1[1] + u2[1], bl = Math.hypot(bx, by) || 1;
    const C = [x + (bx / bl) * h, y + (by / bl) * h];
    ends.push({ a: P(x + u1[0] * d, y + u1[1] * d), b: P(x + u2[0] * d, y + u2[1] * d), m: P(C[0] - (bx / bl) * r, C[1] - (by / bl) * r) });
  }
  for (let i = 0; i < N; i++) {
    const e = ends[i], nx = ends[(i + 1) % N];
    if (e.m) segs.push({ type: 'arc', a: e.a, m: e.m, b: e.b });
    if (Math.hypot(nx.a[0] - e.b[0], nx.a[1] - e.b[1]) > 1e-9) segs.push({ type: 'line', a: e.b, b: nx.a });
  }
  return segs;
}
const rect = (w, h, r = 0) => rounded([[-w / 2, -h / 2, r], [w / 2, -h / 2, r], [w / 2, h / 2, r], [-w / 2, h / 2, r]]);
const circle = (D) => [{ type: 'circle', c: [0, 0], r: D / 2 }];

// The section: { outer: segs, inner: segs | null, box: { x0, y0, x1, y1 } } in profile coordinates (x across,
// y up, the bounding box centred on the origin).
export function profileSection(p) {
  const shift = (segs, dx, dy) => segs.map((s) => (s.type === 'circle' ? { ...s, c: [s.c[0] + dx, s.c[1] + dy] } : { ...s, a: [s.a[0] + dx, s.a[1] + dy], b: [s.b[0] + dx, s.b[1] + dy], ...(s.m ? { m: [s.m[0] + dx, s.m[1] + dy] } : {}) }));
  let outer, inner = null, w, h;
  switch (p.type) {
    case 'shs': case 'rhs': {
      w = p.b; h = p.type === 'shs' ? p.b : p.d;
      if (!(p.t > 0) || 2 * p.t >= Math.min(w, h)) throw new Error('The wall is too thick for the section');
      const ro = Math.min(tubeRo(p.t), Math.min(w, h) / 2 - 1e-3), ri = Math.max(0, ro - p.t);
      outer = rect(w, h, ro); inner = rect(w - 2 * p.t, h - 2 * p.t, ri);
      break;
    }
    case 'chs': {
      w = h = p.D;
      if (!(p.t > 0) || 2 * p.t >= p.D) throw new Error('The wall is too thick for the pipe');
      outer = circle(p.D); inner = circle(p.D - 2 * p.t);
      break;
    }
    case 'round': w = h = p.D; outer = circle(p.D); break;
    case 'flat': case 'timber': w = p.b; h = p.t; outer = rect(w, h); break;
    case 'ea': case 'ua': {
      const a = p.a, b = p.type === 'ea' ? p.a : p.b, t = p.t, r = Math.min(p.r || 0, Math.min(a, b) - t - 1e-3);
      w = a; h = b;
      outer = shift(rounded([[0, 0, 0], [a, 0, 0], [a, t, 0], [t, t, r], [t, b, 0], [0, b, 0]]), -a / 2, -b / 2);
      break;
    }
    case 'channel': {
      const { d, bf, tf, tw } = p, r = Math.min(p.r || 0, bf - tw - 1e-3, d / 2 - tf - 1e-3);
      w = bf; h = d;
      outer = shift(rounded([[0, 0, 0], [bf, 0, 0], [bf, tf, 0], [tw, tf, r], [tw, d - tf, r], [bf, d - tf, 0], [bf, d, 0], [0, d, 0]]), -bf / 2, -d / 2);
      break;
    }
    case 'ibeam': {
      const { d, bf, tf, tw } = p, r = Math.min(p.r || 0, (bf - tw) / 2 - 1e-3, d / 2 - tf - 1e-3), X = bf / 2, Y = d / 2, x = tw / 2, y = d / 2 - tf;
      w = bf; h = d;
      outer = rounded([[-X, -Y, 0], [X, -Y, 0], [X, -y, 0], [x, -y, r], [x, y, r], [X, y, 0], [X, Y, 0], [-X, Y, 0], [-X, y, 0], [-x, y, r], [-x, -y, r], [-X, -y, 0]]);
      break;
    }
    default: throw new Error('Unknown profile type');
  }
  if (!(w > 0 && h > 0)) throw new Error('The profile sizes must be greater than zero');
  return { outer, inner, box: { x0: -w / 2, y0: -h / 2, x1: w / 2, y1: h / 2 } };
}

// The pierce point (where the sketch line runs through the profile): a point of the bounding box.
export const PIERCE = [['tl', 'Top left'], ['tc', 'Top centre'], ['tr', 'Top right'], ['ml', 'Middle left'], ['mc', 'Centre'], ['mr', 'Middle right'], ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['br', 'Bottom right']];
export function piercePoint(box, key = 'mc') {
  const x = key[1] === 'l' ? box.x0 : key[1] === 'r' ? box.x1 : 0;
  const y = key[0] === 't' ? box.y1 : key[0] === 'b' ? box.y0 : 0;
  return [x, y];
}
