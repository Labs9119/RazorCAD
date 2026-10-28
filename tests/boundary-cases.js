import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Boundary Surface meeting other faces: a 40 × 20 × 10 block (Top, x ±20, z ±10, y 0 to 10) and a surface bridging
// from its top edge at x = 20 down to a line at x = 40 on the Top plane, between two side curves (in the planes
// z = ±10, leaving the block level, their first three control points in line). Touching, tangent (G1) and curvature
// continuous (G2) to the block's top face: each one face, the last two checked on the CAD faces; a support face the
// curves do not run along is refused.
export function fixture(options={}){
  const doc=M.newDoc(),plane=(id,offset)=>{const p=M.createFeature(doc,'plane',{refs:[{kind:'plane',id}],offset});doc.features.push(p);return p.id;};
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}));
  const line=(ref,a,b)=>{const s=M.createFeature(doc,'sketch',{plane:{ref}});S.addLine(s,S.addPoint(s,...a),S.addPoint(s,...b));doc.features.push(s);return s.id;};
  const top10=plane('top',10);
  const c1=line(top10,[20,-10],[20,10]),c2=line('top',[40,-10],[40,10]);
  const side=(z)=>{const s=M.createFeature(doc,'sketch',{plane:{ref:plane('front',z)}});S.addCtrlSpline(s,[[20,10],[24,10],[28,10],[34,4],[40,0]].map(q=>S.addPoint(s,...q)),3);doc.features.push(s);return s.id;};
  const c3=side(10),c4=side(-10);
  const f=M.createFeature(doc,'boundarySurf',{dir1:[c1,c2],dir2:[c3,c4],...options});
  doc.features.push(f);
  return {doc,feature:f};
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  try{
    const surfaces=r=>(r.body?.bodies||[]).filter(b=>b.surface||b.kind==='surface');
    const g0=fixture(),r0=await k.rebuild(g0.doc);
    results.push({name:'touching (as before): a surface',ok:!r0.errors.length,errors:r0.errors,bodies:(r0.body?.bodies||[]).length});
    for(const cont of ['G1','G2']){
      const d=fixture({continuity:cont,supportFaces:[{p:[0,10,0]}]}),r=await k.rebuild(d.doc),note=r.notes?.[d.feature.id]||'';
      const a=/within ([\d.e+-]+)°/.exec(note),c=/and ([\d.e+-]+) \/mm/.exec(note),t=/touching to ([\d.e+-]+) mm/.exec(note);
      const ok=!r.errors.length&&/along 1 edge/.test(note)&&!!a&&+a[1]<0.5&&!!t&&+t[1]<=1e-4&&(cont==='G1'||(!!c&&+c[1]<=1e-3));
      results.push({name:`${cont} to the block's top face along its edge, checked`,ok,note,errors:r.errors});
    }
    const bad=fixture({continuity:'G1',supportFaces:[{p:[0,5,10]}]}),rb=await k.rebuild(bad.doc);
    results.push({name:'a support face no bounding curve runs along: refused, saying why',ok:rb.errors.some(e=>/runs along an edge of the support faces/.test(e[1])),errors:rb.errors});
    void surfaces;
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
