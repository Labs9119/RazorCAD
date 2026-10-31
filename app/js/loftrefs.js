// Stable sketch contour references for lofts and extrusions, shared by picker and kernel.
import * as S from './sketchmodel.js';

export const sourceId = (ref) => typeof ref === 'string' ? ref : ref?.sketch;
export const isModelEdgeChain = ref => ref?.kind === 'modelEdgeChain';
const edgeKey = edge => JSON.stringify([edge.body || null, ...edge.p.map(x=>Math.round(x*1e6))]);
const sorted = (ids) => [...new Set(ids)].sort();
const boundaryIds = (loop) => sorted(loop.segs.map((g) => g.sourceCurve));
export const regionKey = (region) => JSON.stringify([boundaryIds(region.outer), region.holes.map(boundaryIds).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
export const refKey = (ref) => !ref || typeof ref === 'string' ? ref : isModelEdgeChain(ref) ? JSON.stringify(['modelEdgeChain', (ref.edges||[]).map(edgeKey).sort()]) : ref.kind === 'modelFace' ? JSON.stringify(['modelFace', ref.body || null, ...ref.p.map((x) => Math.round(x * 1e4))]) : JSON.stringify([ref.sketch, sorted(ref.curves || []), ref.region || null,...(ref.face?[ref.face]:[])]);
const loopFaceKey=loop=>{
  const items=[],same=(a,b)=>a&&b&&a[0]===b[0]&&a[1]===b[1];for(const g of loop.segs){const key=[g.sourceCurve,g.sourceDirection||1];if(!same(items.at(-1),key))items.push(key);}
  if(items.length>1&&same(items[0],items.at(-1)))items.pop();
  return JSON.parse(items.map((_,i)=>JSON.stringify([...items.slice(i),...items.slice(0,i)])).sort()[0]||'[]');
};
const faceKey=region=>JSON.stringify([loopFaceKey(region.outer),region.holes.map(loopFaceKey).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);

// Sweep roles may use different contours from one sketch, but must not reuse
// the same entities. A whole-sketch reference includes every contour in it.
export function overlappingRefs(a,b){
  if(isModelEdgeChain(a)||isModelEdgeChain(b)){const keys=new Set((a?.edges||[]).map(edgeKey));return (b?.edges||[]).some(edge=>keys.has(edgeKey(edge)));}
  if(!a||!b||sourceId(a)!==sourceId(b))return false;
  if(typeof a==='string'||typeof b==='string')return true;
  const ids=new Set(a.curves||[]);return (b.curves||[]).some(id=>ids.has(id));
}

export function regionRef(sketch, region) {
  return { kind: 'sketchContour', sketch, curves: sorted([region.outer, ...region.holes].flatMap(boundaryIds)), region: regionKey(region),face:faceKey(region) };
}

// Every bounded face is pickable, including the disk inside an annular profile's hole.
export function selectableRegions(sk) {
  const loops = S.profileRegions(sk, true,true).flatMap((r) => [r.outer, ...r.holes]);
  const area = (loop) => Math.abs(loop.poly.reduce((a, p, i) => { const q = loop.poly[(i + 1) % loop.poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0));
  const areas = loops.map(area), parent = loops.map((loop, i) => {
    let best = -1;
    loops.forEach((other, j) => { if (areas[j] > areas[i] && S.pointInPoly(loop.poly[0], other.poly) && (best < 0 || areas[j] < areas[best])) best = j; });
    return best;
  });
  return loops.map((outer, i) => ({ outer, holes: loops.filter((_, j) => parent[j] === i) }));
}

export function contourSketch(sk, ref, guide = false) {
  if (typeof ref === 'string') return sk;
  if (ref?.kind !== 'sketchContour' || !Array.isArray(ref.curves) || !ref.curves.length) throw new Error('The selected contour reference is invalid');
  const ids = new Set(ref.curves), curves = sk.curves.filter((c) => ids.has(c.id));
  if (curves.length !== ids.size) throw new Error(`${sk.name}: a selected curve was deleted; reselect the contour`);
  if (curves.some((c) => c.ctrlOf || (!guide && c.construction))) throw new Error(`${sk.name}: a selected profile curve is construction geometry or a spline handle`);
  return { ...sk, curves: curves.map((c) => guide ? { ...c, construction: false } : c) };
}

export function resolveContour(sk, ref, guide = false) {
  const subset = contourSketch(sk, ref, guide);
  if (ref?.region) {
    const matches = S.profileRegions(subset, true,!!ref.face).filter((r) => regionKey(r) === ref.region&&(!ref.face||faceKey(r)===ref.face));
    if (matches.length !== 1) throw new Error(`${sk.name}: the selected region changed or became ambiguous; reselect it`);
    return { sketch: subset, region: matches[0] };
  }
  const chains = S.curveChains(subset);
  if (chains.length !== 1 || chains[0].items.length !== subset.curves.length) throw new Error(`${sk.name}: select one connected, unbranched chain`);
  return { sketch: subset, chain: chains[0] };
}

export function chainRef(sk, sketch, curve, chain = true, guide = false) {
  const c = S.getCurve(sk, curve);
  if (!c || c.ctrlOf || (!guide && c.construction)) throw new Error('Select a profile curve or a guide, not a spline handle');
  const candidates = { ...sk, curves: sk.curves.filter((q) => !q.ctrlOf && (guide ? q.construction === c.construction : !q.construction)).map((q) => ({ ...q, construction: false })) };
  const picked = chain ? S.curveChains(candidates).find((ch) => ch.items.some((it) => it.c.id === curve)) : null;
  return { kind: 'sketchContour', sketch, curves: picked ? picked.items.map((it) => it.c.id) : [curve] };
}

export function describeRef(doc, ref) {
  if (isModelEdgeChain(ref)) return `Model edges (${ref.edges?.length||0})`;
  if (ref?.kind === 'modelFace') return 'Model face';
  const sk = doc.features.find((f) => f.id === sourceId(ref));
  return typeof ref === 'string' ? sk?.name || '(missing)' : `${sk?.name || '(missing)'} · ${ref.region ? 'region' : 'contour'} (${ref.curves?.length || 0} curves)`;
}
