import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture} from '/tests/sweep-options-cases.js';
// Sweep: the profile scaled along the path (scaleEnd, scaleLaw), an eased twist (twistLaw), the profile kept square
// to faces it runs on (orientation 'surface', supportFaces) and model edges as the path (edges). The 10 × 6 rectangle
// on Top swept up a 100 mm line on Front (6000 mm³), or up a 40 mm line and a 40 mm radius quarter arc: the rectangle
// is centred on the path, so the volume is the integral of its area along it, whatever the curve. (A scaled tube's
// walls slope out as it grows: each wall's area its width's integral times the slope's secant.)
const reset=(sk)=>{sk.points=[];sk.curves=[];sk.constraints=[];};
const ease=(t)=>t*t*(3-2*t);
// the integral over the path of the area times the scale squared, the scale going 1 → e evenly or eased by length
const scaled=(L,e,law)=>{let v=0;const n=20000;for(let i=0;i<n;i++){const t=(i+.5)/n,s=1+(e-1)*(law==='smooth'?ease(t):t);v+=s*s;}return 60*L*v/n;};
const lineArc=({path})=>{reset(path);const a=S.addPoint(path,0,0),b=S.addPoint(path,0,40);S.addLine(path,a,b);S.addArc(path,S.addPoint(path,-40,40),b,S.addPoint(path,-40,80));};
const LA=40+20*Math.PI;
// a block on Front: x from x0 to x0 + 20, y 0 to 100, z 0 to -20 (its face at z = 0 is the path's plane)
function block(doc,{x0=-60,w=120,deep=20,y0=-10,h=120}={}){const sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}}),p=[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));const e=M.createFeature(doc,'extrude',{sketch:sk.id,depth:deep,reverse:true});doc.features.unshift(sk,e);}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  const a14=90*ease(.25)*Math.PI/180;
  const cases=[
    {name:'scaled to twice evenly',options:{scaleEnd:2},volume:6000*7/3,probes:[[10,100,0],[5,0,0],[7.5,50,0]]},
    {name:'scaled to half, eased',options:{scaleEnd:.5,scaleLaw:'smooth'},volume:scaled(100,.5,'smooth'),probes:[[2.5,100,0],[5-2.5*ease(.3),30,0]]},
    {name:'scaled by length along a line and an arc',options:{scaleEnd:2},edit:lineArc,volume:scaled(LA,2,'linear'),rel:1e-6},
    {name:'scaled eased along a line and an arc',options:{scaleEnd:3,scaleLaw:'smooth'},edit:lineArc,volume:scaled(LA,3,'smooth'),rel:1e-6},
    {name:'scaled along an unevenly parameterised spline (by length)',options:{scaleEnd:2},edit:({path})=>{reset(path);S.addCtrlSpline(path,[[0,0],[0,2],[0,10],[0,100]].map(([x,y])=>S.addPoint(path,x,y)),3);},volume:14000,rel:1e-6,probes:[[7.5,50,0]]},
    {name:'twist eased',options:{twistAngle:90,twistLaw:'smooth'},volume:6000,probes:[[5*Math.cos(a14),25,-5*Math.sin(a14)],[0,100,-5]]},
    {name:'twisted and scaled',options:{twistAngle:90,scaleEnd:2},volume:14000,probes:[[0,100,-10]]},
    {name:'parallel and scaled',options:{orientation:'parallel',scaleEnd:2},volume:14000,probes:[[10,100,0]]},
    {name:'surface sweep scaled',type:'surfSweep',options:{scaleEnd:2},area:150*(12*Math.hypot(1,.05)+20*Math.hypot(1,.03))},
    {name:'end scale of zero rejected',options:{scaleEnd:0},reject:/greater than zero/},
    {name:'scale with a guide rejected',options:{scaleEnd:2},edit:({doc,sweep})=>{const g=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addLine(g,S.addPoint(g,5,0),S.addPoint(g,5,100));doc.features.splice(-1,0,g);sweep.guide=g.id;},reject:/guide sets/},
    // (square to faces: the path on a block's face at z = 0)
    {name:'square to a face along a line',options:{orientation:'surface',merge:false,supportFaces:[{p:[0,50,0],n:[0,0,1]}]},edit:({doc})=>block(doc),volume:6000,bodies:2},
    {name:'square to a face round an arc',options:{orientation:'surface',merge:false,supportFaces:[{p:[-20,50,0],n:[0,0,1]}]},edit:(d)=>{block(d.doc);lineArc(d);},volume:60*LA,bodies:2,rel:1e-6},
    {name:'square to faces without faces rejected',options:{orientation:'surface'},reject:/faces the profile follows/},
    // (model edges as the path: the block's edge along y at x = 0, z = 0, followed from y = 0 whichever way it runs)
    {name:'a model edge as the path',options:{merge:false,path:null,edges:[{p:[0,50,0]}]},edit:({doc})=>block(doc,{x0:0,w:20,y0:0,h:100}),volume:6000,bodies:2,probes:[[5,100,0]]},
    {name:'a model edge as the path, scaled',options:{merge:false,path:null,edges:[{p:[0,50,0]}],scaleEnd:2},edit:({doc})=>block(doc,{x0:0,w:20,y0:0,h:100}),volume:14000,bodies:2,probes:[[10,100,0]]},
    {name:'model edges apart rejected',options:{path:null,edges:[{p:[0,50,0]},{p:[20,50,-20]}]},edit:({doc})=>block(doc,{x0:0,w:20,y0:0,h:100}),reject:/one chain/},
    {name:'both a path and model edges rejected',options:{edges:[{p:[0,50,0]}]},edit:({doc})=>block(doc,{x0:0,w:20,y0:0,h:100}),reject:/Choose one path/},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.type||'sweep','perpendicular',0);Object.assign(d.sweep,c.options||{});c.edit?.(d);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.sweep.id&&c.reject.test(m)),errors:r.errors});continue;}
      const list=r.body?.bodies||[];
      if(r.errors.length||list.length!==(c.bodies||1)){results.push({name:c.name,ok:false,errors:r.errors,bodies:list.length});continue;}
      const body=list.at(-1),m=await measure(body.id);
      if(c.area){results.push({name:c.name,ok:Math.abs(m.area-c.area)<1e-4*c.area,area:m.area,expected:c.area});continue;}
      let ok=Math.abs(m.volume-c.volume)<(c.rel||1e-7)*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,rel:m.volume/c.volume-1,...(missed.length?{missed}:{})});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.dispose();}
}
