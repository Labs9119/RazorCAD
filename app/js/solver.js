// Geometric constraint solver for sketches.
// Variables: point x/y and circle radii. Each relation/dimension contributes
// residual equations; a Levenberg–Marquardt solver with minimum-norm steps
// drives them to zero while moving geometry as little as possible.
// The same Jacobian gives degrees of freedom and fully-defined status.

import { patternEntities, updateSketchPatterns, getCurve, getPoint, curveLength, splinePieces } from './sketchmodel.js';
import * as SO from './sketchoffset.js';

const H = 1e-6;

export const RELATION_INFO = {
  coincident: { label: 'Coincident', glyph: '•' },
  horizontal: { label: 'Horizontal', glyph: 'H' },
  vertical: { label: 'Vertical', glyph: 'V' },
  onCurve: { label: 'Coincident (on curve)', glyph: '◦' },
  midpoint: { label: 'Midpoint', glyph: 'M' },
  midpointCoincident: { label: 'Coincident Midpoints', glyph: 'M≡' },
  symmetric: { label: 'Symmetric', glyph: '⇋' },
  parallel: { label: 'Parallel', glyph: '∥' },
  perpendicular: { label: 'Perpendicular', glyph: '⊥' },
  collinear: { label: 'Collinear', glyph: '≡' },
  equal: { label: 'Equal', glyph: '=' },
  equalLength: { label: 'Equal Curve Length', glyph: '≋' },
  equalDist: { label: 'Equal Distance', glyph: '=' },
  concentric: { label: 'Concentric', glyph: '◎' },
  tangent: { label: 'Tangent', glyph: 'T' },
  splineTangent: { label: 'Tangent (spline)', glyph: 'T' },
  fix: { label: 'Fixed', glyph: '⚓' },
  block: { label: 'Block (rigid)', glyph: '▣' },
  equation: { label: 'Equation', glyph: 'ƒ' },
  projected: { label: 'On Edge (projected)', glyph: '⇲' },
  sketchPattern: { label: 'Sketch Pattern', glyph: '⋮' },
  offset: { label: 'Offset', glyph: '⇉' },
  offsetGeometry: { label: 'Offset', glyph: '⇉' },
  dim: { label: 'Dimension', glyph: '↔' },
};

export function makeSystem(sk, ev) {
  const idx = new Map();
  const X = [];
  for (const p of sk.points) {
    idx.set('x:' + p.id, X.length); X.push(p.x);
    idx.set('y:' + p.id, X.length); X.push(p.y);
  }
  for (const c of sk.curves) if (c.type === 'circle') { idx.set('r:' + c.id, X.length); X.push(c.r); }
  for (const c of sk.curves) if (c.type === 'ellipse' || c.type === 'earc') { idx.set('b:' + c.id, X.length); X.push(Math.abs(c.r2)); }
  const curves = new Map(sk.curves.map((c) => [c.id, c]));
  const vx = (id) => (id === 'O' ? -1 : idx.get('x:' + id) ?? -2);
  const vy = (id) => (id === 'O' ? -1 : idx.get('y:' + id) ?? -2);
  const g = (Xa, i) => (i < 0 ? 0 : Xa[i]);

  const pt = (id) => {
    const ix = vx(id), iy = vy(id);
    if (ix === -2 || iy === -2) throw new Error('Missing point ' + id);
    return { get: (Xa) => [g(Xa, ix), g(Xa, iy)], deps: [ix, iy].filter((i) => i >= 0) };
  };
  const line = (id) => {
    const c = curves.get(id);
    if (!c || c.type !== 'line') throw new Error('Expected a line');
    const a = pt(c.p1), b = pt(c.p2);
    return { a: a.get, b: b.get, deps: [...a.deps, ...b.deps] };
  };
  const round = (id) => {
    const c = curves.get(id);
    if (!c || (c.type !== 'circle' && c.type !== 'arc')) throw new Error('Expected a circle or arc');
    const ctr = pt(c.c);
    if (c.type === 'circle') {
      const ir = idx.get('r:' + c.id);
      return { c: ctr.get, r: (Xa) => Xa[ir], deps: [...ctr.deps, ir] };
    }
    const s = pt(c.p1);
    return { c: ctr.get, r: (Xa) => { const C = ctr.get(Xa), S = s.get(Xa); return Math.hypot(S[0] - C[0], S[1] - C[1]); }, deps: [...ctr.deps, ...s.deps] };
  };
  // an ellipse: centre, major-axis point, minor radius. off(Xa, p): the point's distance off the
  // ellipse (≈ along the normal, scaled to the major radius)
  const ellipse = (id) => {
    const c = curves.get(id);
    if (!c || (c.type !== 'ellipse' && c.type !== 'earc')) throw new Error('Expected an ellipse');
    const C = pt(c.c), A = pt(c.a), ib = idx.get('b:' + c.id);
    const ra = (Xa) => dist(C.get(Xa), A.get(Xa));
    const off = (Xa, p) => {
      const cc = C.get(Xa), a = A.get(Xa), r = Math.hypot(a[0] - cc[0], a[1] - cc[1]) || 1e-12, rb = Math.abs(Xa[ib]) || 1e-12;
      const ux = (a[0] - cc[0]) / r, uy = (a[1] - cc[1]) / r, dx = p[0] - cc[0], dy = p[1] - cc[1];
      const u = dx * ux + dy * uy, v = -dx * uy + dy * ux;
      return r * (Math.hypot(u / r, v / rb) - 1);
    };
    return { off, ra, rb: (Xa) => Math.abs(Xa[ib]), deps: [...C.deps, ...A.deps, ib] };
  };
  const kindOf = (id) => (curves.has(id) ? curves.get(id).type : 'point');
  const lengthOf = (id) => {
    const c = curves.get(id);
    if (!c || !['line', 'arc', 'circle', 'ellipse', 'earc', 'spline'].includes(c.type)) throw new Error('Select curves for Equal Curve Length');
    const points = [...new Set([c.p1, c.p2, c.c, c.a, ...(c.pts || []), ...(c.handles || [])].filter(Boolean))].map((id) => ({ id, ...pt(id) }));
    const size = c.type === 'circle' ? idx.get('r:' + id) : (c.type === 'ellipse' || c.type === 'earc') ? idx.get('b:' + id) : null;
    return {
      deps: [...points.flatMap((p) => p.deps), ...(size != null ? [size] : [])],
      value: (Xa) => {
        const shape = { ...c };
        if (c.type === 'circle') shape.r = Xa[size];
        if (c.type === 'ellipse' || c.type === 'earc') shape.r2 = Math.abs(Xa[size]);
        return curveLength({ points: points.map((p) => { const q = p.get(Xa); return { id: p.id, x: q[0], y: q[1] }; }) }, shape);
      },
    };
  };

  const eqs = [];
  const bad = [];
  const validate=[];
  const push = (f, deps, k) => eqs.push({ f, deps: [...new Set(deps)], k });

  // internal: arc end points stay on the arc's circle
  for (const c of sk.curves) {
    if (c.type !== 'arc') continue;
    const C = pt(c.c), S = pt(c.p1), E = pt(c.p2);
    push((Xa) => {
      const cc = C.get(Xa), s = S.get(Xa), e = E.get(Xa);
      return [Math.hypot(e[0] - cc[0], e[1] - cc[1]) - Math.hypot(s[0] - cc[0], s[1] - cc[1])];
    }, [...C.deps, ...S.deps, ...E.deps], null);
  }
  // internal: elliptical arc end points stay on the ellipse
  for (const c of sk.curves) {
    if (c.type !== 'earc') continue;
    const El = ellipse(c.id), S = pt(c.p1), E = pt(c.p2);
    push((Xa) => [El.off(Xa, S.get(Xa)), El.off(Xa, E.get(Xa))], [...El.deps, ...S.deps, ...E.deps], null);
  }

  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lineDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-12;
    return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / L;
  };
  const dir = (L, Xa) => { const a = L.a(Xa), b = L.b(Xa); const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1e-12; return [dx / n, dy / n]; };

  for (const k of sk.constraints) {
    if (k.type === 'dim' && k.driven) continue;
    const R = k.refs;
    try {
      switch (k.type) {
        case 'coincident': {
          const a = pt(R[0]), b = pt(R[1]);
          push((Xa) => { const p = a.get(Xa), q = b.get(Xa); return [p[0] - q[0], p[1] - q[1]]; }, [...a.deps, ...b.deps], k);
          break;
        }
        case 'horizontal':
        case 'vertical': {
          const ax = k.type === 'horizontal' ? 1 : 0;
          let A, B, deps;
          if (R.length === 1) { const L = line(R[0]); A = L.a; B = L.b; deps = L.deps; }
          else { const a = pt(R[0]), b = pt(R[1]); A = a.get; B = b.get; deps = [...a.deps, ...b.deps]; }
          push((Xa) => [A(Xa)[ax] - B(Xa)[ax]], deps, k);
          break;
        }
        case 'onCurve': {
          const p = pt(R[0]);
          if (kindOf(R[1]) === 'line') {
            const L = line(R[1]);
            push((Xa) => [lineDist(p.get(Xa), L.a(Xa), L.b(Xa))], [...p.deps, ...L.deps], k);
          } else if (kindOf(R[1]) === 'ellipse' || kindOf(R[1]) === 'earc') {
            const El = ellipse(R[1]);
            push((Xa) => [El.off(Xa, p.get(Xa))], [...p.deps, ...El.deps], k);
          } else {
            const C = round(R[1]);
            push((Xa) => [dist(p.get(Xa), C.c(Xa)) - C.r(Xa)], [...p.deps, ...C.deps], k);
          }
          break;
        }
        case 'midpointCoincident': {
          const A = line(R[0]), B = line(R[1]);
          push((Xa) => {
            const a = A.a(Xa), b = A.b(Xa), c = B.a(Xa), d = B.b(Xa);
            return [(a[0] + b[0] - c[0] - d[0]) / 2, (a[1] + b[1] - c[1] - d[1]) / 2];
          }, [...A.deps, ...B.deps], k);
          break;
        }
        case 'midpoint': {
          const p = pt(R[0]);
          if (kindOf(R[1]) === 'arc') {
            // an arc's midpoint: on it, half way round from its start to its end (counter-clockwise)
            const c = curves.get(R[1]), C = pt(c.c), S = pt(c.p1), E = pt(c.p2);
            push((Xa) => {
              const q = p.get(Xa), cc = C.get(Xa), s = S.get(Xa), e = E.get(Xa), r = dist(cc, s);
              const a0 = Math.atan2(s[1] - cc[1], s[0] - cc[0]);
              let span = Math.atan2(e[1] - cc[1], e[0] - cc[0]) - a0;
              while (span <= 0) span += 2 * Math.PI;
              const am = a0 + span / 2;
              return [q[0] - (cc[0] + r * Math.cos(am)), q[1] - (cc[1] + r * Math.sin(am))];
            }, [...p.deps, ...C.deps, ...S.deps, ...E.deps], k);
            break;
          }
          const L = line(R[1]);
          push((Xa) => { const q = p.get(Xa), a = L.a(Xa), b = L.b(Xa); return [q[0] - (a[0] + b[0]) / 2, q[1] - (a[1] + b[1]) / 2]; }, [...p.deps, ...L.deps], k);
          break;
        }
        case 'symmetric': {
          // two points symmetric about a line: midpoint on the line, connector perpendicular
          const a = pt(R[0]), b = pt(R[1]), L = line(R[2]);
          push((Xa) => {
            const p = a.get(Xa), q = b.get(Xa), la = L.a(Xa), lb = L.b(Xa);
            const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
            const d = dir(L, Xa);
            return [lineDist(m, la, lb), (q[0] - p[0]) * d[0] + (q[1] - p[1]) * d[1]];
          }, [...a.deps, ...b.deps, ...L.deps], k);
          break;
        }
        case 'parallel':
        case 'perpendicular':
        case 'collinear': {
          const L1 = line(R[0]), L2 = line(R[1]);
          push((Xa) => {
            const d1 = dir(L1, Xa), d2 = dir(L2, Xa);
            if (k.type === 'perpendicular') return [d1[0] * d2[0] + d1[1] * d2[1]];
            const cr = d1[0] * d2[1] - d1[1] * d2[0];
            if (k.type === 'parallel') return [cr];
            return [cr, lineDist(L2.a(Xa), L1.a(Xa), L1.b(Xa))];
          }, [...L1.deps, ...L2.deps], k);
          break;
        }
        case 'equalLength': {
          const a = lengthOf(R[0]), b = lengthOf(R[1]);
          push((Xa) => [a.value(Xa) - b.value(Xa)], [...a.deps, ...b.deps], k);
          break;
        }
        case 'equal': {
          if (kindOf(R[0]) === 'line') {
            const L1 = line(R[0]), L2 = line(R[1]);
            push((Xa) => [dist(L1.a(Xa), L1.b(Xa)) - dist(L2.a(Xa), L2.b(Xa))], [...L1.deps, ...L2.deps], k);
          } else {
            const C1 = round(R[0]), C2 = round(R[1]);
            push((Xa) => [C1.r(Xa) - C2.r(Xa)], [...C1.deps, ...C2.deps], k);
          }
          break;
        }
        case 'equalDist': {
          // |p1 p2| = |p3 p4| (chamfers made equal to the first one)
          const a = pt(R[0]), b = pt(R[1]), c = pt(R[2]), d = pt(R[3]);
          push((Xa) => [dist(a.get(Xa), b.get(Xa)) - dist(c.get(Xa), d.get(Xa))], [...a.deps, ...b.deps, ...c.deps, ...d.deps], k);
          break;
        }
        case 'concentric': {
          const C1 = round(R[0]), C2 = round(R[1]);
          push((Xa) => { const a = C1.c(Xa), b = C2.c(Xa); return [a[0] - b[0], a[1] - b[1]]; }, [...C1.deps, ...C2.deps], k);
          break;
        }
        case 'tangent': {
          if(kindOf(R[0])==='line'&&kindOf(R[1])==='spline'){
            const sp=curves.get(R[1]),end=R[2],L=line(R[0]);
            if(sp.closed||![sp.p1,sp.p2].includes(end))throw new Error('The tangent relation needs an endpoint of an open spline');
            const atStart=end===sp.p1,T=pt(end),handle=sp.ctrl?sp.pts[atStart?1:sp.pts.length-2]:sp.handles?.[atStart?0:sp.handles.length-1];
            const points=[...new Set(sp.pts)].map(id=>({id,...pt(id)})),HP=handle?pt(handle):null;
            const tangent=Xa=>{
              const t=T.get(Xa);if(HP){const h=HP.get(Xa);return [h[0]-t[0],h[1]-t[1]];}
              const local={points:points.map(p=>{const q=p.get(Xa);return {id:p.id,x:q[0],y:q[1]};})},pieces=splinePieces(local,sp),piece=atStart?pieces[0]:pieces.at(-1),h=atStart?piece.c1:piece.c2;
              return [h[0]-t[0],h[1]-t[1]];
            };
            if(Math.hypot(...tangent(X))<1e-9||dist(L.a(X),L.b(X))<1e-9)throw new Error('A tangent needs a nonzero line and spline endpoint direction');
            push(Xa=>{const h=tangent(Xa),d=dir(L,Xa);return [(h[0]*d[1]-h[1]*d[0])/(Math.hypot(...h)||1e-12)];},[...L.deps,...T.deps,...(HP?HP.deps:points.flatMap(p=>p.deps))],k);
            break;
          }
          const s = k.s || 1;
          // Tangency at a shared end point is written as "radius ⊥ line" (or collinear
          // centers for two arcs); the distance form is degenerate there.
          const ends = (id) => { const c = curves.get(id); return c.type === 'circle' ? [] : [c.p1, c.p2]; };
          const shared = ends(R[0]).find((p) => ends(R[1]).includes(p));
          if (kindOf(R[0]) === 'line') {
            const L = line(R[0]), C = round(R[1]);
            if (shared) {
              const P = pt(shared), cc = pt(curves.get(R[1]).c);
              push((Xa) => {
                const p = P.get(Xa), c = cc.get(Xa), d = dir(L, Xa);
                const rx = p[0] - c[0], ry = p[1] - c[1], rl = Math.hypot(rx, ry) || 1e-12;
                return [(rx * d[0] + ry * d[1]) / rl];
              }, [...L.deps, ...C.deps], k);
            } else {
              push((Xa) => [s * lineDist(C.c(Xa), L.a(Xa), L.b(Xa)) - C.r(Xa)], [...L.deps, ...C.deps], k);
            }
          } else if (shared) {
            const P = pt(shared), c1 = pt(curves.get(R[0]).c), c2 = pt(curves.get(R[1]).c);
            push((Xa) => {
              const p = P.get(Xa), a = c1.get(Xa), b = c2.get(Xa);
              const ux = p[0] - a[0], uy = p[1] - a[1], vx = p[0] - b[0], vy = p[1] - b[1];
              return [(ux * vy - uy * vx) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1e-12)];
            }, [...P.deps, ...c1.deps, ...c2.deps], k);
          } else {
            const C1 = round(R[0]), C2 = round(R[1]);
            const internal = k.internal;
            push((Xa) => {
              const d = dist(C1.c(Xa), C2.c(Xa));
              return [internal ? d - Math.abs(C1.r(Xa) - C2.r(Xa)) : d - (C1.r(Xa) + C2.r(Xa))];
            }, [...C1.deps, ...C2.deps], k);
          }
          break;
        }
        case 'splineTangent': {
          // an arc and a spline meeting at an end of both: the spline's tangent handle there square to the arc's radius
          const arc = curves.get(R[0]), sp = curves.get(R[1]);
          if (!arc || arc.type !== 'arc' || !sp || sp.type !== 'spline' || !sp.handles) throw new Error('Expected an arc and a spline with handles');
          const end = [sp.p1, sp.p2].find((q) => q === arc.p1 || q === arc.p2);
          if (!end) throw new Error('The arc and the spline must meet at an end');
          const T = pt(end), H = pt(sp.handles[end === sp.p1 ? 0 : sp.handles.length - 1]), Cc = pt(arc.c);
          push((Xa) => {
            const t = T.get(Xa), hh = H.get(Xa), c = Cc.get(Xa);
            const hx = hh[0] - t[0], hy = hh[1] - t[1], rx = t[0] - c[0], ry = t[1] - c[1];
            return [(hx * rx + hy * ry) / ((Math.hypot(hx, hy) * Math.hypot(rx, ry)) || 1e-12)];
          }, [...T.deps, ...H.deps, ...Cc.deps], k);
          break;
        }
        case 'block': {
          // a block instance moves and turns as one: B at d0 from A, the others at their places along and across AB
          const A = pt(R[0]), B = R[1] ? pt(R[1]) : null, rest = R.slice(2).map((id) => [pt(id), k.loc[id]]);
          const sizes = [...Object.entries(k.radii || {}).map(([id, v]) => [idx.get('r:' + id), v]), ...Object.entries(k.minors || {}).map(([id, v]) => [idx.get('b:' + id), v])].filter(([i]) => i !== undefined);
          push((Xa) => {
            const a = A.get(Xa), out = [];
            if (B) {
              const b = B.get(Xa), dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-12, ex = dx / L, ey = dy / L;
              out.push(L - k.d0);
              for (const [P, [l1, l2]] of rest) { const q = P.get(Xa); out.push(q[0] - (a[0] + l1 * ex - l2 * ey), q[1] - (a[1] + l1 * ey + l2 * ex)); }
            }
            for (const [i, v] of sizes) out.push(Xa[i] - v);
            return out;
          }, [...A.deps, ...(B ? B.deps : []), ...rest.flatMap(([P]) => P.deps), ...sizes.map(([i]) => i)], k);
          break;
        }
        case 'equation':
        case 'sketchPattern':
        case 'projected': {
          // linked geometry: points (and radius) follow their source
          const deps = [];
          const getters = [];
          for (const [id, t] of Object.entries(k.pts || {})) {
            const p = pt(id);
            deps.push(...p.deps);
            getters.push([p.get, t]);
          }
          let rIdx = -1;
          const c = curves.get(R[0]);
          if (c?.type === 'circle' && k.r != null) { rIdx = idx.get('r:' + c.id); deps.push(rIdx); }
          const sizes = [...Object.entries(k.radii || {}).map(([id, v]) => [idx.get('r:' + id), v]), ...Object.entries(k.minors || {}).map(([id, v]) => [idx.get('b:' + id), v])].filter(([i]) => i !== undefined);
          deps.push(...sizes.map(([i]) => i));
          push((Xa) => {
            const out = [];
            for (const [get, t] of getters) { const q = get(Xa); out.push(q[0] - t[0], q[1] - t[1]); }
            if (rIdx >= 0) out.push(Xa[rIdx] - k.r);
            for (const [i, v] of sizes) out.push(Xa[i] - v);
            return out;
          }, deps, k);
          break;
        }
        case 'offsetGeometry': {
          const dimension=sk.constraints.find(q=>q.id===k.dim),value=dimension?ev(dimension.value):k.v;
          if(!(value>0))throw new Error('The offset distance must be positive');
          const sources=k.chain.map(it=>{const c=curves.get(it.id);if(!c)throw new Error('An offset source curve is missing');return c;});
          const ids=[...new Set(sources.flatMap(c=>[c.p1,c.p2,c.c,c.a,...(c.pts||[]),...(c.handles||[])].filter(Boolean)))],sourcePoints=ids.map(id=>({id,...pt(id)}));
          const radiusSources=sources.filter(c=>c.type==='circle').map(c=>({id:c.id,index:idx.get('r:'+c.id)})),deps=[...sourcePoints.flatMap(p=>p.deps),...radiusSources.map(r=>r.index)];
          const local=Xa=>({points:sourcePoints.map(p=>{const q=p.get(Xa);return {id:p.id,x:q[0],y:q[1]};}),curves:sources.map(c=>({...c,...(c.type==='circle'?{r:Xa[idx.get('r:'+c.id)]}:{})}))});
          let signature=null,cached=null;
          const target=Xa=>{const key=deps.map(i=>Xa[i]).join(',');if(key!==signature){cached=SO.targets(local(Xa),k,value,false);signature=key;}return cached;};
          SO.targets(local(X),k,value,true);validate.push(Xa=>SO.targets(local(Xa),k,value,true));
          for(const b of k.bindings){
            if(b.radius){const ir=idx.get('r:'+b.radius);push(Xa=>[Xa[ir]-target(Xa).radii[b.radius]],[...deps,ir],k);}
            else{const p=pt(b.id);push(Xa=>{const a=p.get(Xa),q=target(Xa).points[b.id];return [a[0]-q[0],a[1]-q[1]];},[...deps,...p.deps],k);}
          }
          break;
        }
        case 'offset': {
          // offset copy: lines stay parallel at distance v, arcs/circles concentric with radius r + s·v.
          // The distance comes from the group's offset dimension (k.dim), or k.v if that was deleted.
          const dk = k.dim ? sk.constraints.find((c) => c.id === k.dim) : null;
          const v = dk ? ev(dk.value) : (k.v ?? 0);
          const s = k.s || 1;
          if (kindOf(R[0]) === 'line') {
            const L1 = line(R[0]), L2 = line(R[1]);
            push((Xa) => {
              const d1 = dir(L1, Xa), d2 = dir(L2, Xa), a = L2.a(Xa), b = L2.b(Xa);
              return [d1[0] * d2[1] - d1[1] * d2[0], s * lineDist([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], L1.a(Xa), L1.b(Xa)) - v];
            }, [...L1.deps, ...L2.deps], k);
            // open chain ends sit square across from the source end
            for (const [np, sp] of k.ends || []) {
              const P = pt(np), Q = pt(sp);
              push((Xa) => { const p = P.get(Xa), q = Q.get(Xa), d = dir(L1, Xa); return [(p[0] - q[0]) * d[0] + (p[1] - q[1]) * d[1]]; }, [...P.deps, ...Q.deps, ...L1.deps], k);
            }
          } else {
            const C1 = round(R[0]), C2 = round(R[1]);
            push((Xa) => { const a = C1.c(Xa), b = C2.c(Xa); return [a[0] - b[0], a[1] - b[1], C2.r(Xa) - C1.r(Xa) - s * v]; }, [...C1.deps, ...C2.deps], k);
            for (const [np, sp] of k.ends || []) {
              const P = pt(np), Q = pt(sp);
              push((Xa) => {
                const p = P.get(Xa), q = Q.get(Xa), c = C1.c(Xa);
                const ux = p[0] - c[0], uy = p[1] - c[1], wx = q[0] - c[0], wy = q[1] - c[1];
                return [(ux * wy - uy * wx) / ((Math.hypot(ux, uy) * Math.hypot(wx, wy)) || 1e-12)];
              }, [...P.deps, ...Q.deps, ...C1.deps], k);
            }
          }
          break;
        }
        case 'fix': {
          const p = pt(R[0]);
          push((Xa) => { const q = p.get(Xa); return [q[0] - k.x, q[1] - k.y]; }, p.deps, k);
          break;
        }
        case 'dim': {
          const v = ev(k.value);
          const s = k.s || 1;
          switch (k.kind) {
            case 'distance': {
              const a = pt(R[0]), b = pt(R[1]);
              push((Xa) => [dist(a.get(Xa), b.get(Xa)) - v], [...a.deps, ...b.deps], k);
              break;
            }
            case 'hdist':
            case 'vdist': {
              const ax = k.kind === 'hdist' ? 0 : 1;
              const a = pt(R[0]), b = pt(R[1]);
              push((Xa) => [b.get(Xa)[ax] - a.get(Xa)[ax] - s * v], [...a.deps, ...b.deps], k);
              break;
            }
            case 'pointLine': {
              const p = pt(R[0]), L = line(R[1]);
              push((Xa) => [s * lineDist(p.get(Xa), L.a(Xa), L.b(Xa)) - v], [...p.deps, ...L.deps], k);
              break;
            }
            case 'arcDist': {
              // A (point, line, circle/arc) to B (circle/arc): center-to-center, minimum or maximum
              const B = round(R[1]);
              const cond = k.cond || 'center';
              if (kindOf(R[0]) === 'line') {
                const L = line(R[0]);
                const rs = cond === 'min' ? -1 : cond === 'max' ? 1 : 0;
                push((Xa) => [s * lineDist(B.c(Xa), L.a(Xa), L.b(Xa)) + rs * B.r(Xa) - v], [...L.deps, ...B.deps], k);
              } else {
                const isPt = kindOf(R[0]) === 'point';
                const A = isPt ? null : round(R[0]), P = isPt ? pt(R[0]) : null;
                const cA = isPt ? P.get : A.c, rA = isPt ? () => 0 : A.r;
                push((Xa) => {
                  const d = dist(cA(Xa), B.c(Xa)), ra = rA(Xa), rb = B.r(Xa);
                  if (cond === 'center') return [d - v];
                  if (cond === 'max') return [d + ra + rb - v];
                  return [k.nested ? Math.abs(ra - rb) - d - v : d - ra - rb - v];
                }, [...(isPt ? P.deps : A.deps), ...B.deps], k);
              }
              break;
            }
            case 'offset':
              break; // its value drives the group's offset relations
            case 'diameter':
            case 'radius': {
              if (kindOf(R[0]) === 'ellipse' || kindOf(R[0]) === 'earc') {
                // an ellipse's minor (or, with axis 'major', major) radius / diameter
                const El = ellipse(R[0]), f = k.kind === 'diameter' ? 2 : 1;
                push((Xa) => [f * (k.axis === 'major' ? El.ra(Xa) : El.rb(Xa)) - v], El.deps, k);
                break;
              }
              const C = round(R[0]);
              const f = k.kind === 'diameter' ? 2 : 1;
              push((Xa) => [f * C.r(Xa) - v], C.deps, k);
              break;
            }
            case 'angle': {
              const L1 = line(R[0]), L2 = line(R[1]);
              const e1 = k.e1 || 1, e2 = k.e2 || 1, rad = (v * Math.PI) / 180;
              push((Xa) => {
                const d1 = dir(L1, Xa), d2 = dir(L2, Xa);
                const u = [d1[0] * e1, d1[1] * e1], w = [d2[0] * e2, d2[1] * e2];
                return [Math.atan2(Math.abs(u[0] * w[1] - u[1] * w[0]), u[0] * w[0] + u[1] * w[1]) - rad];
              }, [...L1.deps, ...L2.deps], k);
              break;
            }
          }
          break;
        }
      }
    } catch (e) {
      bad.push(`${k.type === 'dim' ? 'Dimension' : 'Relation'}: ${e.message}`);
      if(k.type==='offsetGeometry')push(()=>[1],[],k);
    }
  }
  return { X: Float64Array.from(X), idx, eqs, n: X.length, bad,validate };
}

function residuals(sys, X) {
  const r = [];
  for (const e of sys.eqs) for (const v of e.f(X)) r.push(v);
  return r;
}

function jacobian(sys, X, cols) {
  const rows = [];
  for (const e of sys.eqs) {
    const r0 = e.f(X);
    const block = r0.map(() => new Float64Array(cols.size));
    for (const j of e.deps) {
      const c = cols.get(j);
      if (c === undefined) continue;
      const x = X[j];
      const h = H * Math.max(1, Math.abs(x));
      X[j] = x + h; const rp = e.f(X);
      X[j] = x - h; const rm = e.f(X);
      X[j] = x;
      for (let k = 0; k < r0.length; k++) block[k][c] = (rp[k] - rm[k]) / (2 * h);
    }
    rows.push(...block);
  }
  return rows;
}

function solveSPD(A, b) {
  // Gaussian elimination with partial pivoting (A is small and dense)
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) continue;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = Math.abs(M[r][r]) < 1e-300 ? 0 : s / M[r][r];
  }
  return x;
}

const sumSq = (r) => r.reduce((s, v) => s + v * v, 0);
const maxAbs = (r) => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

function lm(sys, X, fixed) {
  const cols = new Map();
  for (let j = 0; j < sys.n; j++) if (!fixed.has(j)) cols.set(j, cols.size);
  let r = residuals(sys, X);
  let err = sumSq(r);
  let lambda = 1e-9;
  for (let it = 0; it < 80; it++) {
    if (maxAbs(r) < 1e-10) break;
    const J = jacobian(sys, X, cols);
    const m = J.length, n = cols.size;
    if (!n) break;
    // A = J J^T
    const A = [];
    for (let i = 0; i < m; i++) {
      const row = new Float64Array(m);
      for (let k = 0; k <= i; k++) {
        let s = 0;
        const Ji = J[i], Jk = J[k];
        for (let c = 0; c < n; c++) s += Ji[c] * Jk[c];
        row[k] = s;
      }
      A.push(row);
    }
    for (let i = 0; i < m; i++) for (let k = i + 1; k < m; k++) A[i][k] = A[k][i];
    let improved = false;
    for (let tries = 0; tries < 12; tries++) {
      const Ad = A.map((row, i) => { const c = Float64Array.from(row); c[i] += lambda * (1 + row[i]); return c; });
      const y = solveSPD(Ad, r);
      const Xn = Float64Array.from(X);
      for (const [j, c] of cols) {
        let s = 0;
        for (let i = 0; i < m; i++) s += J[i][c] * y[i];
        Xn[j] -= s;
      }
      const rn = residuals(sys, Xn);
      const en = sumSq(rn);
      if (Number.isFinite(en) && en < err) {
        X.set(Xn);
        r = rn; err = en;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return maxAbs(r);
}

function applyX(sk, sys, X) {
  for (const p of sk.points) { p.x = X[sys.idx.get('x:' + p.id)]; p.y = X[sys.idx.get('y:' + p.id)]; }
  for (const c of sk.curves) if (c.type === 'circle') c.r = Math.abs(X[sys.idx.get('r:' + c.id)]);
  for (const c of sk.curves) if (c.type === 'ellipse' || c.type === 'earc') c.r2 = Math.abs(X[sys.idx.get('b:' + c.id)]);
}

// Solve the sketch in place. `pin` holds points at given positions (dragging).
export function solveSketch(sk, ev, opts = {}) {
  if (!sk.patterns?.length) return solveSketchBase(sk, ev, opts);
  try {
    const generated = patternEntities(sk);
    const primary = { ...sk, points: sk.points.filter((p) => !generated.has(p.id)), curves: sk.curves.filter((c) => !generated.has(c.id)), constraints: sk.constraints.filter((k) => k.type !== 'sketchPattern' && !k.refs.some((r) => generated.has(r))) };
    const r = solveSketchBase(primary, ev, opts);
    if (!r.ok || r.bad.length) return r;
    updateSketchPatterns(sk, ev);
    // Copies follow their sources; relations to copies can position other geometry, but cannot drive the sources.
    const updated = patternEntities(sk);
    const attached = sk.constraints.some((k) => k.type !== 'sketchPattern' && k.refs.some((id) => updated.has(id)));
    if (!attached) return r;
    const sourcePoints = new Set(), sourceCircles = new Set();
    for (const p of sk.patterns) for (const id of [...p.sources, p.path].filter(Boolean)) {
      const c = getCurve(sk, id);
      if (!c) sourcePoints.add(id);
      else {
        for (const q of [c.p1, c.p2, c.c, c.a, ...(c.pts || []), ...(c.handles || [])].filter(Boolean)) sourcePoints.add(q);
        if (c.type === 'circle') sourceCircles.add(id);
      }
    }
    return solveSketchBase(sk, ev, { pin: [...(opts.pin || []), ...[...sourcePoints].filter((id) => id !== 'O').map((id) => ({ ...getPoint(sk, id) }))], pinR: [...(opts.pinR || []), ...[...sourceCircles].map((id) => ({ id, r: getCurve(sk, id).r }))] });
  } catch (e) { return { ok: false, err: Infinity, bad: [e.message] }; }
}

function solveSketchBase(sk, ev, { pin = [], pinR = [] } = {}) {
  const sys = makeSystem(sk, ev);
  const X = Float64Array.from(sys.X);
  const fixed = new Set();
  for (const { id, x, y } of pin) {
    const ix = sys.idx.get('x:' + id), iy = sys.idx.get('y:' + id);
    if (ix === undefined) continue;
    X[ix] = x; X[iy] = y;
    fixed.add(ix); fixed.add(iy);
  }
  for (const { id, r } of pinR) {
    const ir = sys.idx.get('r:' + id);
    if (ir === undefined) continue;
    X[ir] = r;
    fixed.add(ir);
  }
  const err = sys.eqs.length ? lm(sys, X, fixed) : 0;
  let ok = err < 1e-6;
  if(ok)for(const check of sys.validate){try{check(X);}catch(e){ok=false;sys.bad.push(e.message);}}
  if (ok) {
    applyX(sk, sys, X);
    for(const k of sk.constraints)if(k.type==='offsetGeometry'){const d=sk.constraints.find(q=>q.id===k.dim);if(d)k.v=ev(d.value);}
  }
  return { ok, err, bad: sys.bad };
}

// Row-reduce a matrix (rows normalized) and return rank, pivot columns and the reduced rows.
function rref(rows, n, tol = 1e-7) {
  const M = rows.map((r) => {
    const norm = Math.hypot(...r);
    return norm > 1e-12 ? Float64Array.from(r, (v) => v / norm) : null;
  }).filter(Boolean);
  const pivots = [];
  let row = 0;
  for (let c = 0; c < n && row < M.length; c++) {
    let piv = row;
    for (let r = row + 1; r < M.length; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < tol) continue;
    [M[row], M[piv]] = [M[piv], M[row]];
    const pv = M[row][c];
    for (let k = 0; k < n; k++) M[row][k] /= pv;
    for (let r = 0; r < M.length; r++) {
      if (r === row) continue;
      const f = M[r][c];
      if (Math.abs(f) < 1e-15) continue;
      for (let k = 0; k < n; k++) M[r][k] -= f * M[row][k];
    }
    pivots.push(c);
    row++;
  }
  return { rank: pivots.length, pivots, M };
}

function fullJacobian(sys) {
  const cols = new Map();
  for (let j = 0; j < sys.n; j++) cols.set(j, j);
  return jacobian(sys, Float64Array.from(sys.X), cols);
}

export function sketchRank(sk, ev) {
  const sys = makeSystem(sk, ev);
  return rref(fullJacobian(sys), sys.n).rank;
}

// Why relations just added to a sketch (in sk.constraints) take away fewer degrees of freedom than they should:
// kind 'redundant' when the geometry already satisfies them (another relation defines it that way), 'conflict' when
// it doesn't (they would over-define it); blockers: the relations already there that are in the way (without any one
// of them, the new relations would take away their full share). Only relations on the same points are tried.
export function relationDiagnosis(sk, added, ev) {
  const sys = makeSystem(sk, ev), X = Float64Array.from(sys.X);
  const mine = sys.eqs.filter((e) => added.includes(e.k));
  if (!mine.length) return null; // (a relation kept by other means, e.g. Fixed: points pinned while solving)
  let worst = 0, scale = 1;
  for (const v of X) scale = Math.max(scale, Math.abs(v));
  for (const e of mine) for (const v of e.f(X)) worst = Math.max(worst, Math.abs(v));
  const kind = worst <= 1e-7 * scale ? 'redundant' : 'conflict';
  const deps = new Set(mine.flatMap((e) => e.deps));
  const others = sk.constraints.filter((k) => !added.includes(k));
  const touching = others.filter((k) => sys.eqs.some((e) => e.k === k && e.deps.some((d) => deps.has(d)))).slice(-40);
  const blockers = [];
  for (const k of touching) {
    const without = { ...sk, constraints: sk.constraints.filter((x) => x !== k) };
    const r1 = sketchRank(without, ev), r0 = sketchRank({ ...without, constraints: without.constraints.filter((x) => !added.includes(x)) }, ev);
    if (r1 - r0 >= added.length) blockers.push(k);
  }
  return { kind, blockers };
}

// Free ends of construction lines: an end point used only by construction lines and by no
// relation or dimension may slide along its line without the sketch counting as under defined
// (a centerline only has to be positioned). One extra equation per such end pins that slide.
function constructionSlideRows(sk, sys) {
  const useCount = new Map();
  for (const c of sk.curves) for (const k of ['p1', 'p2', 'c']) if (c[k]) useCount.set(c[k], (useCount.get(c[k]) || 0) + 1);
  const inRelation = new Set();
  for (const k of sk.constraints) for (const r of k.refs) inRelation.add(r);
  const rows = [];
  for (const c of sk.curves) {
    if (c.type !== 'line' || !c.construction || c.fitHandle) continue;
    const a = sk.points.find((p) => p.id === c.p1) || (c.p1 === 'O' ? { x: 0, y: 0 } : null);
    const b = sk.points.find((p) => p.id === c.p2) || (c.p2 === 'O' ? { x: 0, y: 0 } : null);
    if (!a || !b) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-12) continue;
    const u = [(b.x - a.x) / L, (b.y - a.y) / L];
    for (const id of [c.p1, c.p2]) {
      if (id === 'O' || useCount.get(id) !== 1 || inRelation.has(id)) continue;
      const ix = sys.idx.get('x:' + id), iy = sys.idx.get('y:' + id);
      if (ix === undefined || iy === undefined) continue;
      const row = new Float64Array(sys.n);
      row[ix] = u[0]; row[iy] = u[1];
      rows.push(row);
    }
  }
  return rows;
}

// Degrees of freedom and which points/curves are fully defined. `dof` counts every freedom;
// `dofDefined` (and the defined flags) ignore construction-line ends that may slide along
// their line, so a positioned centerline counts as defined.
export function analyzeSketch(sk, ev) {
  const sys = makeSystem(sk, ev);
  const J0 = fullJacobian(sys);
  const rank0 = rref(J0, sys.n).rank;
  const slide = constructionSlideRows(sk, sys);
  const J = slide.length ? [...J0, ...slide] : J0;
  const { rank, pivots, M } = rref(J, sys.n);
  const n = sys.n;
  const determined = new Array(n).fill(false);
  const pivotSet = new Set(pivots);
  pivots.forEach((c, i) => {
    let ok = true;
    for (let k = 0; k < n; k++) if (!pivotSet.has(k) && Math.abs(M[i][k]) > 1e-6) { ok = false; break; }
    determined[c] = ok;
  });
  const pointDefined = new Map([['O', true]]);
  for (const p of sk.points) pointDefined.set(p.id, determined[sys.idx.get('x:' + p.id)] && determined[sys.idx.get('y:' + p.id)]);
  const curveDefined = new Map();
  for (const c of sk.curves) {
    let ok;
    if (c.type === 'line') ok = pointDefined.get(c.p1) && pointDefined.get(c.p2);
    else if (c.type === 'spline') ok = [...c.pts, ...(c.handles || [])].every((id) => pointDefined.get(id));
    else if (c.type === 'circle') ok = pointDefined.get(c.c) && determined[sys.idx.get('r:' + c.id)];
    else if (c.type === 'ellipse') ok = pointDefined.get(c.c) && pointDefined.get(c.a) && determined[sys.idx.get('b:' + c.id)];
    else if (c.type === 'earc') ok = pointDefined.get(c.c) && pointDefined.get(c.a) && determined[sys.idx.get('b:' + c.id)] && pointDefined.get(c.p1) && pointDefined.get(c.p2);
    else ok = pointDefined.get(c.c) && pointDefined.get(c.p1) && pointDefined.get(c.p2);
    curveDefined.set(c.id, !!ok);
  }
  return { dof: n - rank0, dofDefined: n - rank, rank: rank0, equations: J0.length, pointDefined, curveDefined };
}
