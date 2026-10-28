import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture} from '/tests/surface-patch-cases.js';
// Filled Surface: curves and points inside the opening that the patch passes through (throughCurves, throughPoints),
// and a tangent edge's reach (edges[i].reach: the patch keeps to the support's tangent plane that far in). The 20 × 10
// opening in a flat surface on Top (y = 0, x ±10, z ±5); distances from the patch measured on it.
const point=(d,x,y,z)=>{const p=M.createFeature(d.doc,'point',{pointType:'coords',x,y,z});d.doc.features.splice(d.doc.features.indexOf(d.patch),0,p);return p.id;};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const dist=async(p,id)=>(await k.request('measure',{refs:[{kind:'point',p},{kind:'body',id}]})).distance;
  const cases=[
    {name:'through a point above the opening',edit:d=>{d.patch.throughPoints=[point(d,0,3,0)];},on:[[0,3,0]],off:[[0,0,0]]},
    {name:'through two points',edit:d=>{d.patch.throughPoints=[point(d,-4,2,0),point(d,4,-1,0)];},on:[[-4,2,0],[4,-1,0]]},
    {name:'through a curve across the opening',edit:d=>{const c=M.createFeature(d.doc,'sketch3d',{segs:null,pts:[{x:-5,y:2,z:0},{x:5,y:2,z:0}],kind:'lines',radius:0});d.doc.features.splice(d.doc.features.indexOf(d.patch),0,c);d.patch.throughCurves=[c.id];},on:[[0,2,0],[-5,2,0],[5,2,0]]},
    {name:'through a sketch’s own points',edit:d=>{const pl=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:3}),sk=M.createFeature(d.doc,'sketch',{plane:{ref:pl.id}});S.addPoint(sk,2,1);d.doc.features.splice(d.doc.features.indexOf(d.patch),0,pl,sk);d.patch.throughPoints=[sk.id];},probeSketch:true},
    {name:'tangent with a point: the patch turns at the edges',options:{continuity:'G1'},edit:d=>{d.patch.throughPoints=[point(d,0,3,0)];},on:[[0,3,0]],off:[[8,0,0],[0,0,4]]},
    {name:'tangent with a reach of 2 mm: flat 2 mm in',options:{continuity:'G1'},edit:d=>{d.patch.throughPoints=[point(d,0,3,0)];d.patch.edges.forEach(e=>{e.reach=2;});},on:[[0,3,0],[8,0,0],[0,0,3]]},
    {name:'a reach on a contact (G0) edge rejected',edit:d=>{d.patch.edges[0].reach=2;},reject:/tangent \(G1\) edges/},
    {name:'a negative reach rejected',options:{continuity:'G1'},edit:d=>{d.patch.edges[0].reach=-1;},reject:/zero or more/},
    {name:'a sketch with no points of its own rejected',edit:d=>{d.patch.throughPoints=[d.sk.id];},reject:/no points of its own/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.options||{});c.edit?.(d);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.patch.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const on=c.probeSketch?[[2,3,1],[2,3,-1]]:c.on||[],got={};let ok=true;
      if(c.probeSketch){const a=await dist(on[0],body.id),b=await dist(on[1],body.id);got.on=[a,b];ok=Math.min(a,b)<1e-4;}
      else for(const p of on){const x=await dist(p,body.id);(got.on||=[]).push(x);if(!(x<1e-4))ok=false;}
      for(const p of c.off||[]){const x=await dist(p,body.id);(got.off||=[]).push(x);if(!(x>1e-3))ok=false;}
      results.push({name:c.name,ok,...got});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
