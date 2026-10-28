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
    // a circular edge: a Ø10 boss 10 high on the block's top, its foot (concave, R2) or its top rim (convex, R1.5)
    // rounded G2. The volume from Pappus: the section between the sharp corner and the quintic (its three end points in
    // line with each face), integrated on 20,000 steps, swept round the axis (2π × its centroid's radius × its area)
    const ring=(edgeY,r,foot)=>{
      const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
      const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
      const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:10}),b=M.createFeature(doc,'sketch',{plane:{ref:pl.id}});S.addCircle(b,'O',5);
      const f=M.createFeature(doc,'fillet',{radius:r,edges:[{p:[5,edgeY,0]}],continuity:'G2'});
      doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}),pl,b,M.createFeature(doc,'extrude',{sketch:b.id,depth:10}),f);
      // (rho, y) half-plane: corner c, a on the flat face, b on the cylinder
      const c=[5,edgeY],A=foot?[5+r,edgeY]:[5-r,edgeY],B=foot?[5,edgeY+r]:[5,edgeY-r],L=(p,q,t)=>[p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t];
      const P=[A,L(A,c,.4),L(A,c,.8),L(B,c,.8),L(B,c,.4),B],bz=t=>{let Q=P.map(q=>[...q]);for(let k=1;k<6;k++)Q=Q.slice(1).map((q,i)=>L(Q[i],q,t));return Q[0];};
      const poly=[c,...Array.from({length:20001},(_,i)=>bz(i/20000))];let area=0,cx=0;
      for(let i=0;i<poly.length;i++){const p0=poly[i],p1=poly[(i+1)%poly.length],x=p0[0]*p1[1]-p1[0]*p0[1];area+=x;cx+=(p0[0]+p1[0])*x;}
      area/=2;cx/=6*area;const swept=2*Math.PI*cx*Math.abs(area);
      return {doc,feature:f,volume:8000+Math.PI*25*10+(foot?swept:-swept)};
    };
    for(const [name,y,r,foot] of [['G2 round at a boss’s foot (a circular edge, concave)',10,2,true],['G2 round on a boss’s top rim (a circular edge, convex)',20,1.5,false]]){
      const d=ring(y,r,foot),res=await k.rebuild(d.doc),bd=res.body?.bodies?.at(-1),note=res.notes?.[d.feature.id]||'',v=bd?(await measure(bd.id)).volume:NaN;
      const m=/within ([\d.e+-]+)° and ([\d.e+-]+) \/mm/.exec(note),pts=+(/\((\d+) points checked\)/.exec(note)||[0,0])[1];
      results.push({name,ok:!res.errors.length&&Math.abs(v-d.volume)<1e-6*d.volume&&!!m&&+m[1]<0.01&&+m[2]<1e-3&&pts>=10,volume:v,expected:d.volume,note,errors:res.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
