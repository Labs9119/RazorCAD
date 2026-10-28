import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
export function fixture({thickness=2,outward=false,faces=[{p:[0,30,0],n:[0,1,0]}],fillet=0,chamfer=0,circle=false}={}){
 const doc=M.newDoc();doc.name='Shell check';
 const sketch=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
 if(circle)S.addCircle(sketch,'O',20);else S.buildCenterRect(sketch,'O',0,0,30,20);
 doc.features.push(sketch);const extrude=M.createFeature(doc,'extrude',{sketch:sketch.id,depth:30});doc.features.push(extrude);
 if(fillet){const blend=M.createFeature(doc,'fillet',{radius:fillet,edges:[{p:[30,30,0]}]});doc.features.push(blend);}
 if(chamfer)doc.features.push(M.createFeature(doc,'chamfer',{distance:chamfer,edges:[{p:[30,30,0]}]}));
 const shell=M.createFeature(doc,'shell',{thickness,outward,faces});doc.features.push(shell);
 return {doc,sketch,extrude,shell};
}
const top={p:[0,30,0],n:[0,1,0]},bottom={p:[0,0,0],n:[0,-1,0]};
// Offset cross-section and the rounded bottom (integral of parallel convex sections).
const outwardVolume=(area,perimeter,t=2,h=30)=>h*(perimeter*t+Math.PI*t*t)+area*t+perimeter*Math.PI*t*t/4+2*Math.PI*t*t*t/3;
export async function run({threads=1}={}){
 const k=new KernelClient({threads}),results=[];
 const cases=[
  {name:'box inward',expected:15552},
  {name:'box outward',outward:true,expected:outwardVolume(2400,200)},
  {name:'two removed faces',faces:[top,bottom],expected:11520},
  {name:'duplicate removal references',faces:[top,{...top,p:[5,30,0]}],expected:15552},
  {name:'small fillet inward, cavity retained',fillet:1,expected:15552-40*(1-Math.PI/4),note:true},
  {name:'small chamfer inward',chamfer:1},
  {name:'small fillet outward',fillet:1,outward:true},
  {name:'larger fillet never silently returns full body',fillet:4,allowFailure:true},
  {name:'cylinder inward',circle:true,expected:2928*Math.PI},
  {name:'cylinder outward',circle:true,outward:true,expected:outwardVolume(400*Math.PI,40*Math.PI)},
  {name:'excessive thickness',thickness:50,reject:/valid cavity/},
  {name:'collapsed cavity',thickness:20,reject:/valid cavity/},
  {name:'no faces selected hollows the body (a closed void)',faces:[],expected:60*40*30-56*36*26},
  {name:'zero thickness',thickness:0,reject:/greater than zero/},
  {name:'negative thickness',thickness:-2,reject:/greater than zero/},
  {name:'nonfinite thickness',thickness:Infinity,reject:/finite|zero|invalid|empty/i},
 ];
 try{await k.ready;const initial=await k.stats();
  for(const c of cases){
   const data=fixture(c),r=await k.rebuild(data.doc),item={case:c.name,ok:false,errors:r.errors};
   if(c.reject)item.ok=r.errors.length>0&&r.errors.every(([id,m])=>id===data.shell.id&&c.reject.test(m));
   else if(c.allowFailure&&r.errors.length)item.ok=r.errors.every(([id,m])=>id===data.shell.id&&/valid cavity/.test(m));
   else if(!r.errors.length&&r.body?.bodies?.length===1){
    const m=await k.request('measure',{refs:[{kind:'body',id:r.body.bodies[0].id}]}),info=m.items[0];
    item.volume=info.volume;item.note=r.notes[data.shell.id];
    item.ok=info.solid&&Number.isFinite(info.volume)&&info.volume>0&&info.volume<(c.circle?12000*Math.PI:72000)*0.8;
    if(c.expected)item.ok&&=Math.abs(info.volume-c.expected)/c.expected<1e-6;
    if(c.note)item.ok&&=item.note?.includes('sharp corners inside');
   }
   results.push(item);
  }
  // A failed shell must not poison the next valid rebuild in the same worker.
  const recovered=await k.rebuild(fixture().doc),health=await k.stats();
  return {ok:results.every((r)=>r.ok)&&!recovered.errors.length&&!k.restarts&&health.freeing&&health.stackReset&&health.freed>initial.freed&&health.memoryMB<=512,results,health};
 }finally{k.dispose();}
}
