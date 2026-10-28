import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Shell: walls of a thickness of their own (thickFaces: { p, n, t }) and a hollow body (no faces removed: a closed void).
// A 20 mm cube on Front (x, y ±10, z 0 to 20), its top face removed; exact volumes from the cavity's size.
export function fixture(options={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  const p=[[-10,-10],[10,-10],[10,10],[-10,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const block=M.createFeature(doc,'extrude',{sketch:sk.id,depth:20});
  const feature=M.createFeature(doc,'shell',{faces:[{p:[0,0,20],n:[0,0,1]}],thickness:1,...options});doc.features.push(sk,block,feature);
  return {doc,feature};
}
const XP={p:[10,0,10],n:[1,0,0]},YN={p:[0,-10,10],n:[0,-1,0]},BOT={p:[0,0,0],n:[0,0,-1]};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  const cases=[
    {name:'shell (as before)',volume:8000-18*18*19},
    {name:'a wall 3 mm thick',options:{thickFaces:[{...XP,t:3}]},volume:8000-16*18*19,probes:[[7,0,10]]},
    {name:'two walls and the bottom thicker',options:{thickFaces:[{...XP,t:3},{...YN,t:2},{...BOT,t:4}]},volume:8000-16*17*16,probes:[[7,0,10],[0,-8,10],[0,0,4]]},
    {name:'a wall thinner than the shell rejected',options:{thickness:2,thickFaces:[{...XP,t:1}]},reject:/more than the shell/},
    {name:'a removed face with a thickness rejected',options:{thickFaces:[{p:[0,0,20],n:[0,0,1],t:3}]},reject:/removed face/},
    {name:'outward with walls of their own rejected',options:{outward:true,thickFaces:[{...XP,t:3}]},reject:/inward/},
    {name:'hollow (no faces removed)',options:{faces:[],thickness:2},volume:8000-16*16*16,probes:[[8,0,10],[-8,0,10]]},
    {name:'hollow with a thicker wall',options:{faces:[],thickness:2,thickFaces:[{...XP,t:5}]},volume:8000-13*16*16,probes:[[5,0,10]]},
    {name:'hollow too thick rejected',options:{faces:[],thickness:11},reject:/could not be hollowed/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.options);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<1e-6*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,...(missed.length?{missed}:{}),note:r.notes?.[d.feature.id]});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
