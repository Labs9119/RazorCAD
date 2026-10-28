import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Curvature continuous (G2) fillets: a 40 × 20 × 10 box (Top, x ±20, z ±10, y 0 to 10), its top front edge rounded
// R4 (G1) and then the same edge G2: the G2 blend keeps the round's set-back, so it takes away less than the sharp
// edge and a different amount than the round, and meets the faces beside it in tangent plane and curvature.
export function fixture(options={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const f=M.createFeature(doc,'fillet',{radius:4,edges:[{p:[0,10,10]}],...options});
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}),f);
  return {doc,feature:f};
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  try{
    const ROUND=8000-(16-4*Math.PI)*40;
    const g1=await k.rebuild(fixture().doc),v1=(await measure(g1.body.bodies[0].id)).volume;
    results.push({name:'the round (G1) as before',ok:!g1.errors.length&&Math.abs(v1-ROUND)<1e-6*ROUND,volume:v1});
    const d=fixture({continuity:'G2'}),g2=await k.rebuild(d.doc),b=g2.body?.bodies?.[0],note=g2.notes?.[d.feature.id]||'';
    const v2=b?(await measure(b.id)).volume:NaN,m=/within ([\d.e+-]+)° and ([\d.e+-]+) \/mm/.exec(note);
    results.push({name:'G2: one solid, between the sharp edge and the round',ok:!g2.errors.length&&g2.body.bodies.length===1&&v2<8000-1&&v2>ROUND-60&&Math.abs(v2-ROUND)>0.5,volume:v2,errors:g2.errors});
    results.push({name:'G2: tangent plane and curvature met at its edges',ok:!!m&&+m[1]<0.01&&+m[2]<1e-3&&+(/\((\d+) points checked\)/.exec(note)||[0,0])[1]>=10,note,volume:v2});
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
