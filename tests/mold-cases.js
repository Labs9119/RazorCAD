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
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const cases=[
    {name:'parted at the largest section (the middle)',options:{},want:[PART(10),1600*15-PART(5),1600*15-PART(5)]},
    {name:'parted 3 up the part',options:{parting:'at',partingAt:3},want:[PART(10),1600*17-PART(7),1600*13-PART(3)]},
    {name:'with 1 % shrinkage',options:{shrink:1},want:[PART(10),40.2*40.2*15.05-1.01**3*PART(5),40.2*40.2*15.05-1.01**3*PART(5)]},
    {name:'without the part',options:{keepPart:false},want:[1600*15-PART(5),1600*15-PART(5)]},
    {name:'a parting plane off the part rejected',options:{parting:'at',partingAt:12},reject:/cross the part/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.options);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const list=r.body?.bodies||[];
      if(r.errors.length||list.length!==c.want.length){results.push({name:c.name,ok:false,errors:r.errors,bodies:list.length});continue;}
      const vs=[];for(const b of list)vs.push((await measure(b.id)).volume);
      const got=[...vs].sort((x,y)=>x-y),want=[...c.want].sort((x,y)=>x-y);
      results.push({name:c.name,ok:got.every((v,i)=>Math.abs(v-want[i])<1e-6*want[i]),volumes:got,expected:want});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
