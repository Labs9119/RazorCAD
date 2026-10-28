// Hole standards: ISO metric screw sizes with clearance holes (ISO 273: close / normal / loose
// fits), counterbores for socket head cap screws (ISO 4762) and countersinks for countersunk socket screws
// (ISO 10642, 90°); tapped holes from the thread tables (tap drill = major diameter − pitch).
import { threadList } from './threads.js';

// [size, close, normal, loose, cbore Ø, cbore depth, csink Ø]
const ISO = [
  ['M2', 2.2, 2.4, 2.6, 4.4, 2.4, 4.4], ['M2.5', 2.7, 2.9, 3.1, 5.5, 2.9, 5.5],
  ['M3', 3.2, 3.4, 3.6, 6.5, 3.4, 6.9], ['M4', 4.3, 4.5, 4.8, 8, 4.4, 9.2],
  ['M5', 5.3, 5.5, 5.8, 10, 5.4, 11.5], ['M6', 6.4, 6.6, 7, 11, 6.5, 13.7],
  ['M8', 8.4, 9, 10, 15, 8.6, 18.3], ['M10', 10.5, 11, 12, 18, 10.8, 22.7],
  ['M12', 13, 13.5, 14.5, 20, 13, 27.2], ['M14', 15, 15.5, 16.5, 24, 15, 31.2],
  ['M16', 17, 17.5, 18.5, 26, 17.5, 33.9], ['M20', 21, 22, 24, 33, 21.5, 40.7],
  ['M24', 25, 26, 28, 40, 25.5, 48],
];
export const HOLE_SIZES = ISO.map((r) => r[0]);
const FIT = { close: 1, normal: 2, loose: 3 };

// The hole's sizes for a type, standard size and fit (custom values where the size is 'custom').
// f: the feature ({ holeType, size, fit, diameter, cboreD, cboreDepth, csinkD, csinkAngle, thread, system })
// ev: expression evaluator. Returns { d (drill Ø), cbD, cbDepth, csD, csAng, thread: { label, D, P } | null, label }
export function holeSpec(f, ev) {
  const type = f.holeType || 'simple';
  if (type === 'tapped') {
    const th = threadList(f.system || 'metric').find((t) => t.id === f.thread) || threadList('metric').find((t) => t.id === 'M6');
    const d = +(th.D - th.P).toFixed(3);
    return { type, d, thread: th, label: `${th.label} tapped (drill Ø${d})` };
  }
  const row = ISO.find((r) => r[0] === f.size);
  const custom = !row || f.size === 'custom';
  const d = custom ? ev(f.diameter) : row[FIT[f.fit || 'normal']];
  const out = { type, d, thread: null };
  if (type === 'cbore') { out.cbD = custom ? ev(f.cboreD) : row[4]; out.cbDepth = custom ? ev(f.cboreDepth) : row[5]; }
  if (type === 'csink') { out.csD = custom ? ev(f.csinkD) : row[6]; out.csAng = custom ? ev(f.csinkAngle ?? 90) : 90; }
  const what = custom ? '' : `${f.size} ${f.fit || 'normal'} `;
  out.label = type === 'slot' ? `${what}slot ${+d.toFixed(3)} wide` : type === 'cbore' ? `${what}Ø${+d.toFixed(3)} counterbore Ø${+out.cbD.toFixed(3)} × ${+out.cbDepth.toFixed(3)}`
    : type === 'csink' ? `${what}Ø${+d.toFixed(3)} countersink Ø${+out.csD.toFixed(3)} × ${+out.csAng.toFixed(1)}°`
      : `${what}Ø${+d.toFixed(3)}`;
  return out;
}

// The hole's revolved profile, (r, z) with z down into the material from the face (z = 0), closed on the axis.
// depth: the hole's depth (to the start of the drill point); point: a drill point at a blind hole's end, of angle
// pointAngle (118° unless given).
export function holeProfile(spec, depth, point, pointAngle = 118) {
  const r = spec.d / 2, pts = [[0, -0.05]];
  if (spec.type === 'cbore') { pts.push([spec.cbD / 2, -0.05], [spec.cbD / 2, spec.cbDepth], [r, spec.cbDepth]); }
  else if (spec.type === 'csink') {
    const rc = spec.csD / 2, h = (rc - r) / Math.tan(((spec.csAng || 90) * Math.PI) / 360);
    pts.push([rc + 0.05 * Math.tan(((spec.csAng || 90) * Math.PI) / 360), -0.05], [r, h]);
  } else pts.push([r, -0.05]);
  pts.push([r, depth]);
  if (point) pts.push([0, depth + r / Math.tan(((pointAngle / 2) * Math.PI) / 180)]);
  else pts.push([0, depth]);
  return pts;
}
