import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Fillet and Chamfer, option by option: an edge's own size (edges[i].size), a fillet sized by chord width (sizeBy
// 'chord'), a full round (filletType 'fullRound': side, middle and side faces) and a vertex chamfer (chamferType
// 'vertex'). A 20 mm cube on Front (x, y ±10, z 0 to 20), or a 4 mm wall (y ±2); exact volumes.
const K=1-Math.PI/4;
export function fixture(type,options={},{wall=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}}),h=wall?2:10;
  const p=[[-10,-h],[10,-h],[10,h],[-10,h]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const block=M.createFeature(doc,'extrude',{sketch:sk.id,depth:20});
  const feature=M.createFeature(doc,type,{edges:[],...options});doc.features.push(sk,block,feature);
  return {doc,feature};
}
const TOP={p:[0,10,20]},BOTTOM={p:[0,-10,0]};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  const cases=[
    {name:'fillet (as before)',type:'fillet',options:{radius:3,edges:[TOP]},volume:8000-K*9*20},
    {name:'fillet: an edge of its own radius',type:'fillet',options:{radius:3,edges:[TOP,{...BOTTOM,size:5}]},volume:8000-K*20*(9+25)},
    {name:'fillet: an own radius in an expression',type:'fillet',options:{radius:3,edges:[TOP,{...BOTTOM,size:'2 + 3'}]},volume:8000-K*20*(9+25)},
    {name:'fillet by chord width',type:'fillet',options:{radius:3*Math.SQRT2,sizeBy:'chord',edges:[TOP]},volume:8000-K*9*20},
    {name:'chamfer: an edge of its own distance',type:'chamfer',options:{distance:2,edges:[TOP,{...BOTTOM,size:4}]},volume:8000-20*(2+8)},
    {name:'chamfer with two distances and an own size rejected',type:'chamfer',options:{chamferType:'twoDist',distance:2,distance2:3,edges:[TOP,{...BOTTOM,size:4}]},reject:/equal-distance/},
    {name:'full round on a wall',type:'fillet',wall:true,options:{filletType:'fullRound',faces:[{p:[0,2,10],n:[0,1,0]},{p:[0,0,20],n:[0,0,1]},{p:[0,-2,10],n:[0,-1,0]}]},volume:20*4*20-(8-2*Math.PI)*20,rel:1e-6,probes:[[0,0,20],[5,2,18]]},
    {name:'full round across faces that are not parallel rejected',type:'fillet',options:{filletType:'fullRound',faces:[{p:[0,10,10],n:[0,1,0]},{p:[0,0,20],n:[0,0,1]},{p:[10,0,10],n:[1,0,0]}]},reject:/parallel/},
    {name:'full round with two faces rejected',type:'fillet',wall:true,options:{filletType:'fullRound',faces:[{p:[0,2,10],n:[0,1,0]},{p:[0,0,20],n:[0,0,1]}]},reject:/three faces/},
    {name:'vertex chamfer',type:'chamfer',options:{chamferType:'vertex',distance:3,vertices:[{p:[10,10,20]}]},volume:8000-27/6,probes:[[7,10,20],[10,7,20],[10,10,17]]},
    {name:'vertex chamfer, distances along X, Y and Z',type:'chamfer',options:{chamferType:'vertex',vertexDistances:true,distance:2,distance2:3,distance3:4,vertices:[{p:[10,10,20]}]},volume:8000-24/6,probes:[[8,10,20],[10,7,20],[10,10,16]]},
    {name:'two vertex chamfers',type:'chamfer',options:{chamferType:'vertex',distance:3,vertices:[{p:[10,10,20]},{p:[-10,-10,0]}]},volume:8000-9},
    {name:'vertex chamfer longer than its edge rejected',type:'chamfer',options:{chamferType:'vertex',distance:25,vertices:[{p:[10,10,20]}]},reject:/as long as its edge/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.type,c.options,{wall:c.wall});
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<(c.rel||1e-9)*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,...(missed.length?{missed}:{}),note:r.notes?.[d.feature.id]});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
