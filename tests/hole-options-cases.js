import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Hole: ends up to the next face, a vertex or a surface (or offset from it), a drill point of its own angle, a far-side
// countersink, holes on curved faces and slots. A 20 mm cube on Front (x, y ±10, z 0 to 20), drilled from its top
// at the middle; M6 normal clearance: Ø6.6. Exact volumes (the radial hole: integrated).
const r=3.3,A=Math.PI*r*r;
export function fixture(options={},{shellBottom=false,cylinder=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  if(cylinder)S.addCircle(sk,'O',10);else{const p=[[-10,-10],[10,-10],[10,10],[-10,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:20}));
  if(shellBottom)doc.features.push(M.createFeature(doc,'shell',{faces:[{p:[0,0,0],n:[0,0,-1]}],thickness:2}));
  const feature=M.createFeature(doc,'hole',{faces:[{p:[0,0,20],n:[0,0,1]}],size:'M6',fit:'normal',drillPoint:false,...options});doc.features.push(feature);
  return {doc,feature};
}
const before=(d,x)=>{d.doc.features.splice(d.doc.features.indexOf(d.feature),0,x);return x.id;};
// the radial hole: from x = 10 in to x = 5, inside the cylinder of radius 10
const radial=()=>{let v=0;const n=2000,h=2*r/n;for(let i=0;i<n;i++){const y=-r+(i+.5)*h,w=Math.sqrt(r*r-y*y);v+=2*w*(Math.sqrt(100-y*y)-5)*h;}return v;};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  const cone=(R1,R2,h)=>Math.PI*h/3*(R1*R1+R1*R2+R2*R2);
  const cases=[
    {name:'blind (as before)',options:{depth:10},volume:8000-A*10},
    {name:'a drill point of 90°',options:{depth:10,drillPoint:true,drillAngle:90},volume:8000-A*10-A*r/3,probes:[[0,0,10-r]]},
    {name:'up to the next face (through the top wall of a box)',shellBottom:true,options:{end:'upToNext'},volume:8000-16*16*18-A*2,probes:[[r,0,19]]},
    {name:'up to a surface',options:{end:'upToSurface'},edit:d=>{d.feature.toPlane=before(d,M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:5}));},volume:8000-A*15,probes:[[0,0,5]]},
    {name:'offset from a surface',options:{end:'offsetSurface',toOffset:3},edit:d=>{d.feature.toPlane=before(d,M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:5}));},volume:8000-A*12,probes:[[0,0,8]]},
    {name:'up to a vertex',options:{end:'upToVertex'},edit:d=>{d.feature.toPoint=before(d,M.createFeature(d.doc,'point',{pointType:'coords',x:5,y:5,z:8}));},volume:8000-A*12},
    {name:'up to a surface behind it rejected',options:{end:'upToSurface',toPlane:'front',reverse:true},reject:/behind where it starts/},
    {name:'through with a far-side countersink',options:{end:'through',farCsink:true,farCsinkD:12,farCsinkAngle:90},volume:8000-A*20-(cone(r,6,6-r)-A*(6-r)),probes:[[6,0,0],[r,0,6-r]]},
    {name:'up to next with a far-side countersink',shellBottom:true,options:{end:'upToNext',farCsink:true,farCsinkD:8,farCsinkAngle:90},volume:8000-16*16*18-A*2-(cone(r,4,4-r)-A*(4-r)),probes:[[4,0,18]]},
    {name:'a far-side countersink narrower than the hole rejected',options:{end:'through',farCsink:true,farCsinkD:5},reject:/wider than the hole/},
    {name:'a hole on a curved face (square to it)',cylinder:true,options:{faces:[{p:[10,0,10]}],depth:5},volume:Math.PI*100*20-radial(),rel:1e-6,probes:[[5,0,10]]},
    {name:'a slot through',options:{holeType:'slot',slotLength:10,end:'through'},volume:8000-(10*6.6+A)*20,probes:[[5+r,0,10],[0,r,10]]},
    {name:'a slot turned 90°',options:{holeType:'slot',slotLength:10,slotAngle:90,end:'through'},volume:8000-(10*6.6+A)*20},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.options,{shellBottom:c.shellBottom,cylinder:c.cylinder});c.edit?.(d);
      const r2=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r2.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r2.errors});continue;}
      const body=r2.body?.bodies?.at(-1);
      if(r2.errors.length||!body){results.push({name:c.name,ok:false,errors:r2.errors});continue;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<(c.rel||1e-9)*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,...(missed.length?{missed}:{}),note:r2.notes?.[d.feature.id]});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
