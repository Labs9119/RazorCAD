import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Core and Cavity: a 20 × 20 × 10 block (y 0 to 10) with a Ø4 hole along Y, a 10 mm margin round it. Exact volumes:
// the cavity is the block above the parting plane less the part there, the core the same below.
export function fixture(options={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-10,-10],[10,-10],[10,10],[-10,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const hs=M.createFeature(doc,'sketch',{plane:{ref:'top'}});S.addCircle(hs,'O',2);
  const feature=M.createFeature(doc,'mold',{dir:'y',margin:10,...options});
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}),hs,M.createFeature(doc,'extrude',{sketch:hs.id,op:'cut',end:'through'}),feature);
  return {doc,feature};
}
const PART=(t)=>(400-4*Math.PI)*t;
// (a sketch on a plane `at` above Top: a rectangle (a parting surface's outline) or lines (runners); y on the plane is −z)
function planeSketch(doc,at,draw){const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:at}),s=M.createFeature(doc,'sketch',{plane:{ref:pl.id}});draw(s);doc.features.splice(doc.features.length-1,0,pl,s);return s;}
const rect=(h)=>(s)=>{const p=[[-h,-h],[h,-h],[h,h],[-h,h]].map(q=>S.addPoint(s,...q));p.forEach((id,i)=>S.addLine(s,id,p[(i+1)%4]));};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const cases=[
    {name:'parted at the largest section (the middle)',options:{},want:[PART(10),1600*15-PART(5),1600*15-PART(5)]},
    {name:'parted 3 up the part',options:{parting:'at',partingAt:3},want:[PART(10),1600*17-PART(7),1600*13-PART(3)]},
    {name:'with 1 % shrinkage',options:{shrink:1},want:[PART(10),40.2*40.2*15.05-1.01**3*PART(5),40.2*40.2*15.05-1.01**3*PART(5)]},
    {name:'without the part',options:{keepPart:false},want:[1600*15-PART(5),1600*15-PART(5)]},
    {name:'a parting plane off the part rejected',options:{parting:'at',partingAt:12},reject:/cross the part/},
    {name:'parted by a surface 3 up the part',options:{parting:'surface'},edit:(d)=>{const sk=planeSketch(d.doc,3,rect(30));const pf=M.createFeature(d.doc,'surfPlanar',{sketch:sk.id});d.doc.features.splice(d.doc.features.length-1,0,pf);d.feature.partingSurface=pf.id;},want:[PART(10),1600*17-PART(7),1600*13-PART(3)],surfaces:1},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.options);c.edit?.(d);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const list=(r.body?.bodies||[]).filter(b=>b.kind!=='surface');
      if(r.errors.length||list.length!==c.want.length){results.push({name:c.name,ok:false,errors:r.errors,bodies:list.length});continue;}
      const vs=[];for(const b of list)vs.push((await measure(b.id)).volume);
      const got=[...vs].sort((x,y)=>x-y),want=[...c.want].sort((x,y)=>x-y);
      results.push({name:c.name,ok:got.every((v,i)=>Math.abs(v-want[i])<1e-6*want[i]),volumes:got,expected:want});
    }
    // (a side core for a Ø4 hole along X through the part, at y 5: pulled along +X; 8 × 8 round the hole (margin 2) from
    // x −12 out: the block's material there 2·64 + 10·64, the side hole's 80π and the upright hole's 32π less where they
    // cross (16·2³/3))
    {const d=fixture({});const hs=M.createFeature(d.doc,'sketch',{plane:{ref:'right'}});S.addCircle(hs,S.addPoint(hs,0,5),2);
     d.doc.features.splice(d.doc.features.length-1,0,hs,M.createFeature(d.doc,'extrude',{sketch:hs.id,op:'cut',end:'through',side2:true,end2:'through'}));
     const side=M.createFeature(d.doc,'moldSide',{faces:[{p:[6,7,0]},{p:[-6,7,0]}],dir:'x',margin:2});d.doc.features.push(side);
     const r=await k.rebuild(d.doc),list=r.body?.bodies||[];
     const vols=[];for(const b of list)vols.push((await measure(b.id)).volume);
     const want=768+112*Math.PI-128/3,got=vols.find(v=>Math.abs(v-want)<1e-6*want),sum=vols.reduce((a,b)=>a+b,0),part=PART(10)-Math.PI*4*20;
     results.push({name:'a side core for a side hole',ok:!r.errors.length&&list.length===4&&!!got&&Math.abs(sum-1600*30)<1e-6*1600*30,vols,want,errors:r.errors,note:r.notes?.[side.id]});}
    // (runners: a line on the parting plane (y 5) from x −18 to the part at x −10, Ø4, and a sprue Ø3 up from x −18)
    {const d=fixture({});const sk=planeSketch(d.doc,5,(s)=>S.addLine(s,S.addPoint(s,-18,0),S.addPoint(s,-10,0)));
     d.doc.features.splice(d.doc.features.indexOf(d.feature),1);d.doc.features.splice(d.doc.features.indexOf(sk)-1,0,d.feature);
     const rn=M.createFeature(d.doc,'moldRunner',{sketch:sk.id,runnerD:4,sprueD:3,taper:1});d.doc.features.push(rn);
     const r=await k.rebuild(d.doc),list=r.body?.bodies||[];let mould=0;const ids=[];
     for(const b of list){const v=(await measure(b.id)).volume;if(Math.abs(v-PART(10))>1e-6)mould+=v,ids.push(b.id);}
     const inMould=async(p)=>{for(const id of ids)if((await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-9)return true;return false;};
     const runner=Math.PI*4*8;
     const ok=!r.errors.length&&mould<1600*30-PART(10)-runner*0.95&&!(await inMould([-14,5,0]))&&!(await inMould([-18,15,0]))&&(await inMould([-14,8,0]));
     results.push({name:'a runner to the part and a sprue up the cavity',ok,mould,errors:r.errors,note:r.notes?.[rn.id]});}
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
