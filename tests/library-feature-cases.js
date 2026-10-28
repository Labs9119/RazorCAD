import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LF from '/js/libfeatures.js';
import {KernelClient} from '/js/kernelclient.js';
// Library features: a 10 × 6 pocket (depth: variable dep = 3) with its corners rounded R1, sketched on the top face of a
// 40 × 40 block, kept as a library feature and put on the faces of a 30 × 30 × 20 block (x, y ±15, z 0 to 20). Exact volumes.
function rect(sk,x0,y0,x1,y1){const p=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
export function source(){
  const doc=M.newDoc();doc.equations=[{name:'dep',expr:'3'},{name:'other',expr:'7'}];
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});rect(sk,-20,-20,20,20);
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}));
  const pk=M.createFeature(doc,'sketch',{plane:{ref:'face',frame:{o:[0,10,0],u:[1,0,0],v:[0,0,-1],n:[0,1,0]}}});rect(pk,0,-3,10,3);
  const cut=M.createFeature(doc,'extrude',{sketch:pk.id,op:'cut',depth:'dep',reverse:true});
  const fil=M.createFeature(doc,'fillet',{radius:1,edges:[{p:[0,8.5,-3]},{p:[10,8.5,-3]},{p:[10,8.5,3]},{p:[0,8.5,3]}]});
  doc.features.push(pk,cut,fil);
  return {doc,pocket:[cut.id,fil.id],cut};
}
export function cube(){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});rect(sk,-15,-15,15,15);
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:20}));
  return doc;
}
const TOP={o:[0,0,20],u:[1,0,0],v:[0,1,0],n:[0,0,1]},BOTTOM={o:[0,0,0],u:[1,0,0],v:[0,-1,0],n:[0,0,-1]};
// (the pocket: 10 × 6 less its four rounded vertical corners, times the depth)
const POCKET=(d)=>(60-4*(1-Math.PI/4))*d;
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const solid=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-6;
  try{
    const src=source(),r0=await k.rebuild(src.doc);
    if(r0.errors.length)return {ok:false,errors:r0.errors};
    {const v=(await measure(r0.body.bodies.at(-1).id)).volume;results.push({name:'the source part',ok:Math.abs(v-16000+POCKET(3))<1e-6*v,volume:v,expected:16000-POCKET(3),notes:r0.notes});}
    const frameOf=(id)=>r0.sketches?.[id]?.frame||null;
    const lib=LF.makeLibraryFeature(src.doc,src.pocket,frameOf,'Pocket');
    results.push({name:'kept: the sketch, the cut, the fillet and only the variable used',ok:lib.items.length===3&&lib.equations.length===1&&lib.equations[0].name==='dep'&&lib.items[0].plane.ref==='face',items:lib.items.map(x=>x.type),equations:lib.equations});
    const cases=[
      {name:'on the cube’s top, deeper (4), turned 90°',place:[[TOP,{values:{dep:'4'},angle:90}]],volume:18000-POCKET(4),air:[[0,5,18]],solid:[[5,0,18]]},
      {name:'two copies (top and bottom): the second gets a variable of its own',place:[[TOP,{}],[BOTTOM,{values:{dep:'2'}}]],volume:18000-POCKET(3)-POCKET(2),air:[[5,0,18],[5,0,1]],eqs:['dep','dep_2']},
    ];
    for(const c of cases){
      const doc=cube();let out=null;
      for(const [W,opt] of c.place)out=LF.insertLibraryFeature(doc,lib,W,opt);
      const r=await k.rebuild(doc);
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body||r.body.bodies.length!==1){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<1e-6*c.volume;const bad=[];
      for(const p of c.air||[])if(await solid(p,body.id)){ok=false;bad.push(['air',p]);}
      for(const p of c.solid||[])if(!(await solid(p,body.id))){ok=false;bad.push(['solid',p]);}
      if(c.eqs&&JSON.stringify(doc.equations.map(e=>e.name))!==JSON.stringify(c.eqs))ok=false;
      const folders=(doc.featureFolders||[]).map(g=>g.name);if(folders.length!==c.place.length||folders.some(x=>x!=='Pocket'))ok=false;
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,equations:doc.equations,folders,...(bad.length?{bad}:{})});
    }
    // (a feature using a plane outside the group is refused)
    const d=source(),pl=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:8});d.doc.features.splice(3,0,pl);Object.assign(d.cut,{end:'upToPlane',toPlane:pl.id});
    const r1=await k.rebuild(d.doc);let msg='';
    try{LF.makeLibraryFeature(d.doc,[d.cut.id],(id)=>r1.sketches?.[id]?.frame||null,'X');}catch(e){msg=e.message;}
    results.push({name:'a feature using a plane outside it refused',ok:/not in the library feature/.test(msg),msg});
    return {ok:results.every(r=>r.ok),results,lib};
  }finally{k.worker.terminate();}
}
