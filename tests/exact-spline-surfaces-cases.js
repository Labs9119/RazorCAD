import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import { KernelClient } from '/js/kernelclient.js';

// Face counts alone miss an accidentally refitted spline: also check exact arc
// length / surface area and independent de Boor samples against the CAD surface.
function pointAt(points, degree, u, weights = points.map(() => 1)) {
  const n = points.length, spans = n - degree;
  const knots = [...Array(degree + 1).fill(0), ...Array.from({ length: spans - 1 }, (_, i) => i + 1), ...Array(degree + 1).fill(spans)];
  u = Math.min(u, spans - 1e-12);
  let k = degree; while (k < n - 1 && knots[k + 1] <= u) k++;
  const q = Array.from({ length: degree + 1 }, (_, j) => {
    const i = j + k - degree, w = weights[i]; return [points[i][0] * w, points[i][1] * w, w];
  });
  for (let r = 1; r <= degree; r++) for (let j = degree; j >= r; j--) {
    const i = j + k - degree, a = (u - knots[i]) / (knots[i + degree - r + 1] - knots[i]);
    q[j] = q[j].map((x, c) => (1 - a) * q[j - 1][c] + a * x);
  }
  return q[degree].slice(0, 2).map(x => x / q[degree][2]);
}

export async function run({ threads = 1 } = {}) {
  const kernel = new KernelClient({ threads }), results = [];
  await kernel.ready;
  const points = [[0, 0], [0, 2], [10, 24], [25, 30], [40, 24], [50, 2], [50, 0]];
  try {
    for (const degree of [2, 3, 5, 7]) for (const weighted of [false, true]) {
      const P = degree === 7 ? [...points.slice(0, 4), [30, 29], ...points.slice(4)] : points;
      const weights = weighted ? P.map((_, i) => 1 + i % 3 / 2) : null;
      for (const closed of [false, true]) {
        const doc = M.newDoc(), sk = M.createFeature(doc, 'sketch', { plane: { ref: 'front' } });
        const ids = P.map(p => S.addPoint(sk, ...p));
        // Put the closing line first so the spline must be traversed backwards.
        if (closed) S.addLine(sk, ids[0], ids.at(-1));
        const cid = S.addCtrlSpline(sk, ids, degree, false, false, weights);
        doc.features.push(sk);
        const profiles = closed ? [LR.regionRef(sk.id, LR.selectableRegions(sk)[0])] : [sk.id];
        const feature = M.createFeature(doc, 'surfExtrude', { profiles, depth: 5 }); doc.features.push(feature);
        const r = await kernel.rebuild(doc), body = r.body?.bodies?.at(-1);
        if (r.errors.length || !body) { results.push({ ok: false, degree, weighted, closed, errors: r.errors }); continue; }
        const m = (await kernel.request('measure', { refs: [{ kind: 'body', id: body.id }] })).items[0];
        const expected = 5 * (S.curveLength(sk, S.getCurve(sk, cid)) + (closed ? 50 : 0));
        let worst = 0;
        for (let i = 0; i <= 12; i++) {
          const q = pointAt(P, degree, (P.length - degree) * i / 12, weights || undefined);
          const probe = await kernel.request('measure', { refs: [{ kind: 'vertex', p: [...q, 2.5] }, { kind: 'body', id: body.id }] });
          worst = Math.max(worst, probe.distance);
        }
        // GProp's area quadrature on a single high-degree rational patch is accurate
        // to a few ppm; the independent point probes below use a tighter CAD tolerance.
        results.push({ name: `degree ${degree}, weighted ${weighted}, closed contour ${closed}`, ok: body.faceCount === (closed ? 2 : 1) && Math.abs(m.area - expected) < expected * 1e-5 && worst < 1e-6, faces: body.faceCount, area: m.area, expected, worst });
        if (closed) {
          feature.type = 'surfPlanar';
          const planar = await kernel.rebuild(doc), face = planar.body?.bodies?.at(-1);
          results.push({ name: 'planar boundary', degree, weighted, ok: !planar.errors.length && face?.faceCount === 1 && face?.edgeCount === 2, edges: face?.edgeCount, errors: planar.errors });
        }
      }
    }
    // Downstream operations must see a single spline face, including after STEP
    // export/import. Close a copy of the surface into a solid before filleting.
    {
      const doc = M.newDoc(), sk = M.createFeature(doc, 'sketch', { plane: { ref: 'front' } });
      const ids = points.map(p => S.addPoint(sk, ...p));
      S.addLine(sk, ids[0], ids.at(-1)); S.addCtrlSpline(sk, ids, 5);
      const surface = M.createFeature(doc, 'surfExtrude', { profiles: [sk.id], depth: 5 });
      doc.features.push(sk, surface);
      const initial = await kernel.rebuild(doc), body = initial.body?.bodies?.at(-1);
      const step = new TextDecoder().decode(await kernel.exportBody('step'));
      const imported = M.newDoc();
      imported.features.push(M.createFeature(imported, 'import', { format: 'step', fileName: 'spline.step', data: step }));
      const round = await kernel.rebuild(imported), roundBody = round.body?.bodies?.at(-1);
      results.push({ name: 'STEP retains spline surface topology', ok: !initial.errors.length && !round.errors.length && body?.faceCount === 2 && roundBody?.faceCount === 2 && roundBody?.edgeCount === body?.edgeCount, errors: round.errors });
      const q = pointAt(points, 5, 1), copy = M.createFeature(doc, 'surfCopy', { faces: [{ body: surface.id, p: [...q, 2.5] }] });
      doc.features.push(copy);
      const selected = await kernel.rebuild(doc), copied = selected.body?.bodies?.find(b => b.last === copy.id);
      results.push({ name: 'select and copy the whole spline face', ok: !selected.errors.length && copied?.faceCount === 1, errors: selected.errors });
      doc.features.pop();
      const cap = M.createFeature(doc, 'surfPlanar', { profiles: [sk.id] }); doc.features.push(cap);
      const move = M.createFeature(doc, 'moveBody', { bodies: [cap.id], copy: true, dz: 5 }); doc.features.push(move);
      const moved = await kernel.rebuild(doc);
      const solid = M.createFeature(doc, 'surfSolid', { bodies: moved.body?.bodies?.map(b => b.id) }); doc.features.push(solid);
      const fillet = M.createFeature(doc, 'fillet', { radius: 0.5, edges: [{ p: [...q, 5] }] }); doc.features.push(fillet);
      const rounded = await kernel.rebuild(doc);
      results.push({ name: 'fillet spline edge after sewing to a solid', ok: !rounded.errors.length && rounded.body?.bodies?.some(b => b.kind === 'solid'), errors: rounded.errors });
    }
    // A selected bounded face can use only half a source spline. Its other half
    // must not reappear when replacing full curves by exact edges.
    {
      const doc = M.newDoc(), sk = M.createFeature(doc, 'sketch', { plane: { ref: 'front' } });
      const ids = points.map(p => S.addPoint(sk, ...p));
      S.addLine(sk, ids[0], ids.at(-1)); S.addCtrlSpline(sk, ids, 5);
      S.addLine(sk, S.addPoint(sk, 25, -5), S.addPoint(sk, 25, 35));
      const region = LR.selectableRegions(sk).find(r => r.outer.poly.every(p => p[0] <= 25 + 1e-6));
      doc.features.push(sk, M.createFeature(doc, 'surfPlanar', { profiles: [LR.regionRef(sk.id, region)] }));
      const r = await kernel.rebuild(doc), body = r.body?.bodies?.at(-1);
      const distance = async p => (await kernel.request('measure', { refs: [{ kind: 'vertex', p }, { kind: 'body', id: body.id }] })).distance;
      results.push({ name: 'selected half-spline region', ok: !r.errors.length && !!body && await distance([10, 5, 0]) < 1e-6 && await distance([40, 5, 0]) > 10, errors: r.errors });
    }
    // Different span counts (and approximation piece counts) must not prevent a loft.
    for (const ruled of [false, true]) {
      const doc = M.newDoc(), profiles = [];
      for (let i = 0; i < 2; i++) {
        const plane = M.createFeature(doc, 'plane', { refs: [{ kind: 'plane', id: 'front' }], offset: i * 80 });
        const sk = M.createFeature(doc, 'sketch', { plane: { ref: plane.id } });
        const P = i ? [...points.slice(0, 4), [30, 29], ...points.slice(4)] : points;
        const ids = P.map(p => S.addPoint(sk, ...p)); S.addLine(sk, ids[0], ids.at(-1));
        S.addCtrlSpline(sk, ids, 5); doc.features.push(plane, sk);
        profiles.push(LR.regionRef(sk.id, LR.selectableRegions(sk)[0]));
      }
      doc.features.push(M.createFeature(doc, 'surfLoft', { profiles, ruled }));
      const r = await kernel.rebuild(doc), body = r.body?.bodies?.at(-1);
      results.push({ name: `different spline spans, ruled ${ruled}`, ok: !r.errors.length && body?.faceCount === 2, faces: body?.faceCount, errors: r.errors });
    }
    return { ok: results.every(r => r.ok), results };
  } finally { kernel.dispose(); }
}
