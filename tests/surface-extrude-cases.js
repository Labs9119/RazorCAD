import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Surface Extrude: a start (offset, plane), ends up to a vertex or a surface (angled ones trimming it), a direction of
// its own, a draft for closed contours, and model edges and faces as its contours (also Surface Revolve's model
// edges). A 20 mm square on a plane 10 mm in front of Front (its walls 80 mm round), or a 20 × 20 × 20 block on Front
// (z 0 to 20) whose top edges are picked; exact areas and probes on the surface.
const T=(deg)=>Math.tan(deg*Math.PI/180),C=20;
function square(sk,half,open=false){const p=[[-half,-half],[half,-half],[half,half],[-half,half]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>{if(!open||i<3)S.addLine(sk,id,p[(i+1)%4]);});}
export function fixture(options={},{open=false,block=false,contour=true}={}){
  const doc=M.newDoc();
  if(block){const b=M.createFeature(doc,'sketch',{plane:{ref:'front'}});square(b,10);doc.features.push(b,M.createFeature(doc,'extrude',{sketch:b.id,depth:20}));}
  let sk=null;
  if(contour){const plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:10});sk=M.createFeature(doc,'sketch',{plane:{ref:plane.id}});square(sk,10,open);doc.features.push(plane,sk);}
  const feature=M.createFeature(doc,'surfExtrude',{sketch:sk?.id||null,profiles:sk?[sk.id]:[],depth:5,...options});doc.features.push(feature);
  return {doc,sk,feature};
}
const before=(d,x)=>{d.doc.features.splice(d.doc.features.indexOf(d.feature),0,x);return x.id;};
const plane=(d,offset)=>before(d,M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset}));
const point=(d,x,y,z)=>before(d,M.createFeature(d.doc,'point',{pointType:'coords',x,y,z}));
// a plane through the line x = 0 at z = C, turned `deg` about it: z = C + m·x
function tilt(d,deg){const base=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:C});before(d,base);const s=M.createFeature(d.doc,'sketch',{plane:{ref:base.id}}),line=S.addLine(s,S.addPoint(s,0,-30),S.addPoint(s,0,30));before(d,s);return before(d,M.createFeature(d.doc,'plane',{referenceDefinition:true,refs:[{kind:'sketch',sketch:s.id,curve:line,relation:'coincident'},{kind:'plane',id:'front',relation:'angle',angle:deg}]}));}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  try{
    const sl=5/Math.cos(5*Math.PI/180),d5=(20+20-10*T(5))/2*sl;
    const dir=[5,0,10].map(x=>x/Math.hypot(5,10));
    const cases=[
      {name:'blind (as before)',area:400,probes:[[10,0,10],[10,0,15]]},
      {name:'from an offset',options:{startFrom:'offset',startOffset:3},area:400,probes:[[10,0,13],[10,0,18]]},
      {name:'from a plane',options:{startFrom:'surface',startPlane:'front'},area:400,probes:[[10,0,0],[10,0,5]]},
      {name:'up to a vertex',options:{end:'upToVertex'},edit:d=>{d.feature.toPoint=point(d,0,0,25);},area:1200,probes:[[10,0,25]]},
      {name:'up to a plane',options:{end:'upToSurface'},edit:d=>{d.feature.toPlane=plane(d,30);},area:1600,probes:[[10,0,30]]},
      {name:'offset from a plane',options:{end:'offsetSurface',toOffset:5},edit:d=>{d.feature.toPlane=plane(d,30);},area:1200,probes:[[10,0,25]]},
      {name:'up to a plane behind',options:{end:'upToSurface',toPlane:'front'},area:800,probes:[[10,0,0]]},
      {name:'up to an angled plane (trimmed)',options:{end:'upToSurface'},edit:d=>{d.feature.toPlane=tilt(d,20);},area:800,slope:true},
      {name:'drafted',options:{draft:5},area:4*d5,probes:[[10-5*T(5),0,15]]},
      {name:'drafted outward',options:{draft:5,draftOutward:true},area:4*(20+20+10*T(5))/2*sl,probes:[[10+5*T(5),0,15]]},
      {name:'drafted from an angled start',options:{startFrom:'surface',depth:10,draft:5},edit:d=>{d.feature.startPlane=tilt(d,20);},area:null,slope:true},
      {name:'drafted open contour rejected',open:true,options:{draft:5},reject:true},
      {name:'along an axis of its own',options:{direction:'ax'},edit:d=>{const a=point(d,0,0,0),b=point(d,5,0,10);before(d,{...M.createFeature(d.doc,'axis',{axisType:'twoPoints',pointA:a,pointB:b}),id:'ax'});},area:200+200*10/Math.hypot(5,10),probes:[[10+5*dir[0],10,10+5*dir[2]]]},
      {name:'along the contours’ plane rejected',options:{direction:'x'},reject:true},
      // (model edges and faces)
      {name:'model edges closed round a face',block:true,contour:false,options:{edges:[{p:[10,0,20]},{p:[-10,0,20]},{p:[0,10,20]},{p:[0,-10,20]}]},area:400,probes:[[10,0,25],[-10,-10,22]]},
      {name:'model edges in an open chain',block:true,contour:false,options:{edges:[{p:[10,0,20]},{p:[0,10,20]}]},area:200,probes:[[10,0,25],[0,10,25]]},
      {name:'one straight model edge without a direction rejected',block:true,contour:false,options:{edges:[{p:[10,0,20]}]},reject:true},
      {name:'one straight model edge along an axis',block:true,contour:false,options:{edges:[{p:[10,0,20]}],direction:'z'},area:100,probes:[[10,0,25]]},
      {name:'model edges that branch rejected',block:true,contour:false,options:{edges:[{p:[10,0,20]},{p:[0,10,20]},{p:[10,10,10]}],direction:'x'},reject:true},
      {name:'a model face’s edges',block:true,contour:false,options:{profiles:[{kind:'modelFace',p:[0,5,20],n:[0,0,1]}]},area:400,probes:[[10,0,25]]},
    ];
    for(const c of cases){
      const d=fixture(c.options,{open:c.open,block:c.block,contour:c.contour!==false});c.edit?.(d);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([e])=>e===d.feature.id),errors:r.errors});continue;}
      const list=r.body?.bodies?.filter(b=>b.kind==='surface')||[];
      const body=list.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors,bodies:r.body?.bodies});continue;}
      const m=await measure(body.id);
      let ok=c.area==null?m.area>0:Math.abs(m.area-c.area)<1e-4,probes=c.probes||[];
      if(c.slope){const fr=r.planes?.[d.feature.toPlane||d.feature.startPlane],s=fr?-fr.n[0]/fr.n[2]:null;if(s==null)ok=false;else probes=d.feature.toPlane?[[10,10,C+10*s],[-10,-10,C-10*s]]:[[10,10,C+10*s],[-10,-10,C-10*s]];}
      const missed=[];for(const p of probes)if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,area:m.area,expected:c.area,...(missed.length?{missed}:{})});
    }
    // (Surface Revolve: a block's top edge at x = 10, turned a quarter about its vertical edge at x = y = 10: a quarter disc)
    {const d=fixture({},{block:true,contour:false});d.doc.features.pop();
      const rev=M.createFeature(d.doc,'surfRevolve',{profiles:[],edges:[{p:[10,0,20]}],axis:'edge',axisEdge:{p:[10,10,10]},extent:'angle',angle:90});d.doc.features.push(rev);
      const r=await k.rebuild(d.doc),body=r.body?.bodies?.filter(b=>b.kind==='surface').at(-1),m=body&&await measure(body.id);
      results.push({name:'surface revolve of a model edge',ok:!r.errors.length&&!!m&&Math.abs(m.area-100*Math.PI)<1e-4,area:m?.area,expected:100*Math.PI,errors:r.errors});}
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
