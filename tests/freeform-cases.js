import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Freeform face editing: a 40 × 20 × 10 box (Top, x ±20, z ±10, y 0 to 10), its top face pushed up by one handle 3 mm
// at its middle, its edges held: as contact (G0), tangent (G1), curvature (G2). The face passes through the handle;
// the more is held at the edges the less it bulges; G1 / G2 keep the face's tangent plane / curvature along them. The
// reshaped face (now a B-spline) reshaped again: a 2 × 1 grid, one up, one down.
export function fixture(options={},again=null){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const f=M.createFeature(doc,'freeform',{faces:[{p:[0,10,0]}],nu:1,nv:1,h0:3,...options});
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}),f);
  if(again)doc.features.push(M.createFeature(doc,'freeform',{faces:[{p:[0,13,0]}],...again}));
  return {doc,feature:f};
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const volume=async(r)=>r.body?.bodies?.length===1?(await k.request('measure',{refs:[{kind:'body',id:r.body.bodies[0].id}]})).items[0].volume:NaN;
  try{
    const v={};
    for(const keep of ['G0','G1','G2']){
      const d=fixture({keep}),r=await k.rebuild(d.doc),note=r.notes?.[d.feature.id]||'',h=r.detected?.[d.feature.id]?.handles?.[0];
      v[keep]=await volume(r);
      const met=/met to ([\d.e+-]+) mm/.exec(note),a=/within ([\d.e+-]+)°/.exec(note),c=/and ([\d.e+-]+) \/mm/.exec(note);
      const ok=!r.errors.length&&v[keep]>8000+1&&!!met&&+met[1]<1e-6&&!!h&&Math.hypot(h.p[0],h.p[1]-13,h.p[2])<1e-6
        &&(keep==='G0'||(!!a&&+a[1]<1e-4))&&(keep!=='G2'||(!!c&&+c[1]<1e-6));
      results.push({name:`one handle, edges kept ${keep}: through the handle${keep==='G0'?'':keep==='G1'?', tangent plane kept':', tangent plane and curvature kept'}`,ok,volume:v[keep],note,errors:r.errors});
    }
    results.push({name:'the more held at the edges, the less it bulges',ok:v.G0>v.G1&&v.G1>v.G2,v});
    const d=fixture({keep:'G1'},{nu:2,nv:1,h0:2,h1:-1,keep:'G1'}),r=await k.rebuild(d.doc),id=d.doc.features[3].id,note=r.notes?.[id]||'',hs=r.detected?.[id]?.handles||[];
    const ok=!r.errors.length&&r.body.bodies.length===1&&/met to ([\d.e+-]+) mm/.test(note)&&+/met to ([\d.e+-]+) mm/.exec(note)[1]<1e-6&&hs.length===2;
    results.push({name:'a reshaped (B-spline) face reshaped again by two handles',ok,note,errors:r.errors,volume:await volume(r)});
    const bad=fixture({faces:[{p:[0,8+Math.SQRT1_2*2,8+Math.SQRT1_2*2]}],keep:'G1'});
    bad.doc.features.splice(2,0,M.createFeature(bad.doc,'fillet',{radius:2,edges:[{p:[0,10,10]}]}));
    const rb=await k.rebuild(bad.doc);
    results.push({name:'a round (not flat, not a B-spline) refused, saying why',ok:rb.errors.some(e=>/four straight edges/.test(e[1])),errors:rb.errors});
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
