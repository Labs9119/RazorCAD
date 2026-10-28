import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Revolve (and Surface Revolve) up to a vertex or a surface (extent 'upToVertex' / 'upToSurface': kernel.worker.js
// revolveExtent, clipRevolution). A 5 × 10 rectangle on Front, x 5 to 10, turned about the sketch's vertical axis
// (world Y): forward, a point on +X goes towards -Z. A whole turn is 750π mm³.
const FULL=750*Math.PI;
export function fixture(options={},{open=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  if(open)S.addLine(sk,S.addPoint(sk,5,-5),S.addPoint(sk,5,5));
  else{const p=[[5,-5],[10,-5],[10,5],[5,5]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
  doc.features.push(sk);
  const feature=M.createFeature(doc,open?'surfRevolve':'revolve',{sketch:sk.id,profiles:[sk.id],axis:'v',...options});doc.features.push(feature);
  return {doc,sk,feature};
}
const point=(d,x,y,z)=>{const p=M.createFeature(d.doc,'point',{pointType:'coords',x,y,z});d.doc.features.splice(d.doc.features.indexOf(d.feature),0,p);return p.id;};
const plane=(d,offset)=>{const p=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset});d.doc.features.splice(d.doc.features.indexOf(d.feature),0,p);return p.id;};
// stopped by the plane z = -c: each point at radius r turns until r·sin t = c
const clipped=(c)=>{let v=0;const n=20000,h=5/n;for(let i=0;i<n;i++){const r=5+(i+.5)*h;v+=r*Math.asin(Math.min(1,c/r));}return 10*v*h;};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  try{
    const cases=[
      {name:'up to a vertex a quarter turn on',options:{extent:'upToVertex'},edit:d=>{d.feature.toPoint=point(d,0,0,-8);},volume:FULL/4,probes:[[0,5,-10],[0,-5,-5]]},
      {name:'up to a vertex three quarters on',options:{extent:'upToVertex'},edit:d=>{d.feature.toPoint=point(d,0,0,8);},volume:FULL*3/4,probes:[[0,5,10]]},
      {name:'up to a vertex the other way round',options:{extent:'upToVertex',reverse:true},edit:d=>{d.feature.toPoint=point(d,0,0,8);},volume:FULL/4,probes:[[0,5,10]]},
      {name:'up to a plane through the axis',options:{extent:'upToSurface',toPlane:'right'},volume:FULL/4,probes:[[0,5,-10]]},
      {name:'up to a plane through the axis, reversed',options:{extent:'upToSurface',toPlane:'right',reverse:true},volume:FULL/4,probes:[[0,5,10]]},
      {name:'up to a plane beside the axis (trimmed)',options:{extent:'upToSurface'},edit:d=>{d.feature.toPlane=plane(d,-3);},volume:clipped(3),probes:[[Math.sqrt(100-9),5,-3],[4,0,-3]],integrated:true},
      {name:'up to a plane it never reaches rejected',options:{extent:'upToSurface'},edit:d=>{d.feature.toPlane=plane(d,-20);},reject:true},
      {name:'up to a vertex on the axis rejected',options:{extent:'upToVertex'},edit:d=>{d.feature.toPoint=point(d,0,3,0);},reject:true},
      {name:'surface revolve up to a vertex',open:true,options:{extent:'upToVertex'},edit:d=>{d.feature.toPoint=point(d,0,0,-8);},area:25*Math.PI},
      {name:'surface revolve trimmed by a plane rejected',open:true,options:{extent:'upToSurface'},edit:d=>{d.feature.toPlane=plane(d,-3);},reject:true},
    ];
    for(const c of cases){
      const d=fixture(c.options,{open:c.open});c.edit?.(d);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([e])=>e===d.feature.id),errors:r.errors});continue;}
      const list=r.body?.bodies||[];
      if(r.errors.length||!list.length){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const body=list.at(-1),m=await measure(body.id);
      if(c.area){results.push({name:c.name,ok:Math.abs(m.area-c.area)<1e-4,area:m.area,expected:c.area});continue;}
      let ok=Math.abs(m.volume-c.volume)<(c.integrated?1e-6*c.volume:1e-4);const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,...(missed.length?{missed}:{})});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
