import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Delete / Resize Fillet and Defeature. A 40 × 20 block 10 high on Top (x ±20, z ±10, y 0 to 10); a Ø10 boss 10 high
// on it, or a step (x −20 to 0 raised to y 20). Taking a fillet, chamfer or hole out gives back the volume without it.
function rect(sk,x0,z0,x1,z1){const p=[[x0,z0],[x1,z0],[x1,z1],[x0,z1]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
export function fixture(steps=[],feature=null){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});rect(sk,-20,-10,20,10);
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}));
  const top=()=>{const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:10});doc.features.push(pl);return pl.id;};
  for(const s of steps){
    if(s==='boss'){const b=M.createFeature(doc,'sketch',{plane:{ref:top()}});S.addCircle(b,'O',5);doc.features.push(b,M.createFeature(doc,'extrude',{sketch:b.id,depth:10}));}
    else if(s==='step'){const b=M.createFeature(doc,'sketch',{plane:{ref:top()}});rect(b,-20,-10,0,10);doc.features.push(b,M.createFeature(doc,'extrude',{sketch:b.id,depth:10}));}
    else if(s.hole){const b=M.createFeature(doc,'sketch',{plane:{ref:'top'}});const c=S.addPoint(b,s.hole[0],s.hole[1]);S.addCircle(b,c,s.r);doc.features.push(b,M.createFeature(doc,'extrude',{sketch:b.id,op:'cut',end:'through',reverse:false}));}
    else doc.features.push(M.createFeature(doc,s.type,s.options));
  }
  if(feature)doc.features.push(feature=M.createFeature(doc,feature.type,feature.options));
  return {doc,feature};
}
const BLOCK=8000,BOSS=Math.PI*25*10,STEP=4000,c45=Math.SQRT1_2;
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-6;
  const fil=(r,p)=>({type:'fillet',options:{radius:r,edges:[{p}]}});
  const ring=(R,r)=>(r*r-Math.PI*r*r/4)*2*Math.PI*(R); // (the corner's area times the path of its centroid, for checks)
  const cases=[
    {name:'a round on a straight edge deleted',steps:[fil(2,[0,10,10])],feature:{type:'editFillet',options:{faces:[{p:[0,8+2*c45,8+2*c45]}]}},volume:BLOCK,probes:[[0,10,10],[20,10,10]]},
    {name:'a round resized from 2 to 4',steps:[fil(2,[0,10,10])],feature:{type:'editFillet',options:{faces:[{p:[0,8+2*c45,8+2*c45]}],mode:'resize',radius:4}},volume:BLOCK-(16-4*Math.PI)*40,probes:[[0,6+4*c45,6+4*c45]]},
    {name:'a chamfer deleted',steps:[{type:'chamfer',options:{distance:2,edges:[{p:[0,10,10]}]}}],feature:{type:'editFillet',options:{faces:[{p:[0,9,9],n:[0,c45,c45]}]}},volume:BLOCK,probes:[[0,10,10]]},
    {name:'a chamfer resized to 3',steps:[{type:'chamfer',options:{distance:2,edges:[{p:[0,10,10]}]}}],feature:{type:'editFillet',options:{faces:[{p:[0,9,9],n:[0,c45,c45]}],mode:'resize',radius:3}},volume:BLOCK-4.5*40},
    {name:'a concave round (inside a step) deleted',steps:['step',fil(3,[0,10,0])],feature:{type:'editFillet',options:{faces:[{p:[3-3*c45,13-3*c45,0]}]}},volume:BLOCK+STEP,probes:[[0,10,0]]},
    {name:'the round at a boss’s foot deleted',steps:['boss',fil(2,[5,10,0])],feature:{type:'editFillet',options:{faces:[{p:[7-2*c45,12-2*c45,0]}]}},volume:BLOCK+BOSS,probes:[[5,10,0]]},
    {name:'the round on a boss’s top rim deleted',steps:['boss',fil(2,[5,20,0])],feature:{type:'editFillet',options:{faces:[{p:[3+2*c45,18+2*c45,0]}]}},volume:BLOCK+BOSS,probes:[[5,20,0]]},
    {name:'a flat face is not a fillet',feature:{type:'editFillet',options:{faces:[{p:[0,10,0],n:[0,1,0]}]}},reject:/not a chamfer|not a fillet/},
    {name:'defeature: small holes and rounds out, a big hole stays',steps:[{hole:[-10,0],r:2},{hole:[10,0],r:4},fil(1,[0,10,10]),fil(1,[0,10,-10])],feature:{type:'defeature',options:{filletR:1.5,holeD:5}},volume:BLOCK-Math.PI*16*10,probes:[[0,10,10],[0,10,-10],[-10,5,0]],note:/2 fillets and 1 hole/},
    {name:'defeature: a counterbored hole with a drill point filled',steps:[{type:'hole',options:{faces:[{p:[0,10,0],n:[0,1,0]}],holeType:'cbore',size:'M6',cboreD:11,cboreDepth:3,end:'blind',depth:7,drillPoint:true}}],feature:{type:'defeature',options:{holeD:12,fillets:false}},volume:BLOCK,probes:[[0,10,0],[0,5,0]],note:/1 hole/},
    {name:'defeature: a hole wider than the limit stays',steps:[{type:'hole',options:{faces:[{p:[0,10,0],n:[0,1,0]}],holeType:'cbore',size:'M6',cboreD:11,cboreDepth:3,end:'through',drillPoint:false}}],feature:{type:'defeature',options:{holeD:8,fillets:false}},same:true,note:/0 holes/},
    {name:'defeature: a boss’s rounds out',steps:['boss',fil(2,[5,10,0]),fil(1,[5,20,0])],feature:{type:'defeature',options:{filletR:2,holes:false}},volume:BLOCK+BOSS,note:/2 fillets/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.steps||[],c.feature);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body||r.body.bodies.length!==1){results.push({name:c.name,ok:false,errors:r.errors,bodies:r.body?.bodies?.length});continue;}
      if(c.same){const d0=fixture(c.steps||[]);const r0=await k.rebuild(d0.doc);c.volume=(await measure(r0.body.bodies.at(-1).id)).volume;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<1e-6*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      const note=r.notes?.[d.feature.id];if(c.note&&!c.note.test(note||''))ok=false;
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,note,faces:m.faces,...(missed.length?{missed}:{})});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
