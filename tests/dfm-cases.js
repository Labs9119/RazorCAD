import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// DFM check: a 40 × 40 block 20 high (Top, y 0 to 20) with a 10 × 10 pocket 5 deep (sharp inside corners: 4 upright,
// 4 round its floor), a Ø2.2 hole through (9 × its diameter), a Ø1 hole 15 deep (15 ×), a Ø0.8 hole 4 deep and a
// pocket with R0.5 inside rounds.
const TOPF={o:[0,20,0],u:[1,0,0],v:[0,0,-1],n:[0,1,0]};
function rect(sk,x0,y0,x1,y1){const p=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(q=>S.addPoint(sk,...q));const l=p.map((id,i)=>S.addLine(sk,id,p[(i+1)%4]));return {p,l};}
export function fixture({rounds=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});rect(sk,-20,-20,20,20);
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:20}));
  const pk=M.createFeature(doc,'sketch',{plane:{ref:'face',frame:TOPF}});rect(pk,-15,-15,-5,-5);
  doc.features.push(pk,M.createFeature(doc,'extrude',{sketch:pk.id,op:'cut',depth:5,reverse:true}));
  const hole=(x,y,d,depth)=>{const s=M.createFeature(doc,'sketch',{plane:{ref:'face',frame:TOPF}});S.addCircle(s,S.addPoint(s,x,y),d/2);doc.features.push(s,M.createFeature(doc,'extrude',depth==='through'?{sketch:s.id,op:'cut',end:'through',reverse:true}:{sketch:s.id,op:'cut',depth,reverse:true}));};
  hole(10,10,2.2,'through');hole(10,-10,1,15);hole(0,10,0.8,4);
  if(rounds){const r=M.createFeature(doc,'sketch',{plane:{ref:'face',frame:TOPF}});rect(r,5,-15,15,-5);const c=M.createFeature(doc,'extrude',{sketch:r.id,op:'cut',depth:3,reverse:true});doc.features.push(r,c,M.createFeature(doc,'fillet',{radius:0.5,edges:[[5,-5],[15,-5],[15,-15],[5,-15]].map(([x,y])=>({p:[x,18.5,-y]}))}));}
  return doc;
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  try{
    const count=(f,kind)=>f.filter(x=>x.kind===kind).length;
    {const r=await k.rebuild(fixture());if(r.errors.length)return {ok:false,errors:r.errors};
     const f=await k.request('dfmCheck',{opts:{minR:1,minHole:1,maxRatio:10}});
     results.push({name:'the pocket’s 8 sharp inside corners',ok:count(f,'corner')===8,n:count(f,'corner')});
     results.push({name:'the Ø1 hole 15 deep (15 ×) found, the Ø2.2 through (9 ×) not',ok:count(f,'deep')===1&&/Ø1 is 15 deep/.test(f.find(x=>x.kind==='deep')?.text||''),deep:f.filter(x=>x.kind==='deep').map(x=>x.text)});
     results.push({name:'the Ø0.8 hole is too small',ok:count(f,'hole')===1&&/Ø0\.8/.test(f.find(x=>x.kind==='hole').text)});
     results.push({name:'Ø2.2 and Ø0.8 are not standard drills (Ø1 is)',ok:count(f,'drill')===2,drills:f.filter(x=>x.kind==='drill').map(x=>x.text)});
     results.push({name:'every finding has its place',ok:f.every(x=>x.p&&x.p.length===3)});}
    {const r=await k.rebuild(fixture({rounds:true}));if(r.errors.length)return {ok:false,errors:r.errors,results};
     const f=await k.request('dfmCheck',{opts:{minR:1}});
     results.push({name:'a pocket’s R0.5 inside rounds are below the R1 cutter',ok:count(f,'radius')===4,n:count(f,'radius')});}
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
