import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Sheet metal forms on a 100 × 60 plate 2 thick (Top, y 0 to 2), placed by a sketch on its top face: a dimple, a bead
// (the material pushed out: the volume the same), a lance (the strip pressed out, ramped: the same), an emboss 20 × 10
// raised 3 with straight walls a thickness thick (its top and walls, less the footprint: + 312). Probes where the
// pressed material must be, and where the hole under it must be.
const T=2,PLATE=100*60*T;
export function fixture(formType,options,draw){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-50,-30],[50,-30],[50,30],[-50,30]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:T}),fs=M.createFeature(doc,'sketch',{plane:{ref:pl.id}});draw(fs);
  const f=M.createFeature(doc,'smForm',{formType,sketch:fs.id,...options});
  doc.features.push(sk,M.createFeature(doc,'smBase',{sketch:sk.id,thickness:T,radius:2,kFactor:0.44}),pl,fs,f);
  return {doc,feature:f};
}
const line=(a,b)=>(s)=>S.addLine(s,S.addPoint(s,...a),S.addPoint(s,...b));
const rect=(x0,y0,x1,y1)=>(s)=>{const p=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(q=>S.addPoint(s,...q));p.forEach((id,i)=>S.addLine(s,id,p[(i+1)%4]));};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const solid=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-6;
  // (sketch y on the Top plane is −z)
  const cases=[
    {name:'a dimple Ø10 × 2',type:'dimple',options:{diameter:10,depth:2},draw:(s)=>S.addPoint(s,0,0),volume:PLATE,solid:[[0,3,0]],air:[[0,0.5,0]]},
    {name:'a bead 6 wide, 1.5 high, 40 long',type:'bead',options:{width:6,height:1.5},draw:line([-20,10],[20,10]),volume:PLATE,solid:[[0,3,-10],[20.5,2.8,-10],[-20.5,2.8,-10]],air:[[0,1,-10]]},
    {name:'a lance 30 × 8, pressed out 3',type:'lance',options:{width:8,height:3},draw:line([-15,-5],[15,-5]),volume:PLATE,solid:[[0,4,5-4]],air:[[0,1,5-4]],note:/1 lance/},
    {name:'an emboss 20 × 10 raised 3',type:'emboss',options:{height:3},draw:rect(10,-25,30,-15),volume:PLATE+200*(3+T)-16*6*3-200*T,solid:[[20,4.5,20],[10.5,3,20]],air:[[20,1,20]],note:/1 emboss/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.type,c.options,c.draw),r=await k.rebuild(d.doc),b=r.body?.bodies?.at(-1);
      if(r.errors.length||!b){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const v=(await measure(b.id)).volume,bad=[];
      for(const p of c.solid||[])if(!(await solid(p,b.id)))bad.push(['solid',p,(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id:b.id}]})).distance]);
      for(const p of c.air||[])if(await solid(p,b.id))bad.push(['air',p]);
      const note=r.notes?.[d.feature.id]||'';
      results.push({name:c.name,ok:Math.abs(v-c.volume)<1e-4*c.volume&&!bad.length&&(!c.note||c.note.test(note)),volume:v,expected:c.volume,note,...(bad.length?{bad}:{})});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
