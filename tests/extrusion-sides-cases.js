import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Extrude: a second side with its own end condition (side2), the draft to an angled end or from an angled start, and
// the Intersect operation (kernel.worker.js extrude / apply). A 20 mm square or a 2 mm circle on a plane 10 mm in
// front of Front, a 20 × 20 × 20 block for the cuts and intersects; exact volumes, or integrated ones for the
// angled ends, and probes where the corners must be.
const T=(deg)=>Math.tan(deg*Math.PI/180);
function square(sk,half,x=0){const p=[[-half,-half],[half,-half],[half,half],[-half,half]].map(q=>S.addPoint(sk,q[0]+x,q[1]));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
export function fixture(options={},profile='square'){
  const doc=M.newDoc(),plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:10});doc.features.push(plane);
  const sk=M.createFeature(doc,'sketch',{plane:{ref:plane.id}});
  if(profile==='circle')S.addCircle(sk,'O',2);else if(profile==='wide')S.addCircle(sk,'O',5);else square(sk,10);
  doc.features.push(sk);
  const feature=M.createFeature(doc,'extrude',{sketch:sk.id,depth:5,...options});doc.features.push(feature);return {doc,plane,sk,feature};
}
// a 20 × 20 × 20 block on Front (z 0 to 20), x: its centre
function block(d,x=0,merge=true){const sk=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}});square(sk,10,x);const solid=M.createFeature(d.doc,'extrude',{sketch:sk.id,depth:20,merge});d.doc.features.unshift(sk,solid);return solid;}
// a plane through the line x = 0 on a plane C mm in front of Front, turned `deg` about it: z = C + m·x
const C=20;
function tilt(d,deg){const base=plane(d,C),s=M.createFeature(d.doc,'sketch',{plane:{ref:base.id}}),line=S.addLine(s,S.addPoint(s,0,-30),S.addPoint(s,0,30)),p=M.createFeature(d.doc,'plane',{referenceDefinition:true,refs:[{kind:'sketch',sketch:s.id,curve:line,relation:'coincident'},{kind:'plane',id:'front',relation:'angle',angle:deg}]});d.doc.features.splice(d.doc.features.indexOf(d.sk),0,s,p);return p;}
function plane(d,offset){const p=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset});d.doc.features.splice(d.doc.features.indexOf(d.sk),0,p);return p;}
// a volume as the integral of its columns' heights over [-r, r]² (midpoints, n × n)
function integrate(r,n,height){const h=2*r/n;let v=0;for(let i=0;i<n;i++){const x=-r+(i+.5)*h;for(let j=0;j<n;j++)v+=Math.max(0,height(x,-r+(j+.5)*h));}return v*h*h;}
// the square drafted inward (outward) by `a` from the profile at z = 10 to the end plane z = C + m·x
const draftedToTilt=(a,m)=>integrate(10,1200,(x,y)=>Math.min(C-10+m*x,(10-Math.max(Math.abs(x),Math.abs(y)))/T(a)));
const draftedOutToTilt=(a,m)=>integrate(13,1600,(x,y)=>{const e=Math.max(Math.abs(x),Math.abs(y));return C-10+m*x-(e<=10?0:(e-10)/T(a));});
// its corners: where the corner edges meet the end plane (sign: -1 inward, +1 outward)
const tiltCorners=(a,m,sign)=>[1,-1].flatMap(sx=>[1,-1].map(sy=>{const z=(C-10+10*m*sx)/(1+sign*-1*sx*m*T(a)),w=10+sign*z*T(a);return [sx*w,sy*w,10+z];}));
// the square from the tilted start z = C + m·x, 10 mm deep along Front's normal, drafted inward by `a` about the start
function draftedFromTilt(a,m){
  const s=Math.sin(a*Math.PI/180),t=s/Math.sqrt(1-s*s*(1+m*m));
  return integrate(10,1200,(x,y)=>{const zs=C+m*x;const top=Math.min(zs+10,C+10*m+(10-x)/T(a),C-10*m+(x+10)/T(a),zs+(10-y)/t,zs+(y+10)/t);return top-zs;});
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  try{
    const tiltSlope=async(d,deg)=>{const p=tilt(d,deg);const r=await k.rebuild(d.doc),fr=r.planes?.[p.id];return fr?{plane:p,m:-fr.n[0]/fr.n[2]}:null;};
    const cases=[
      {name:'second side blind',options:{side2:true,depth2:4},volume:400*9,probes:[[10,10,15],[10,10,6]]},
      {name:'second side reversed first',options:{side2:true,depth2:4,reverse:true},volume:400*9,probes:[[10,10,5],[10,10,14]]},
      {name:'second side to a plane',options:{side2:true,end2:'upToSurface'},edit:d=>{d.feature.toPlane2=plane(d,-6).id;},volume:400*21,probes:[[10,10,15],[10,10,-6]]},
      {name:'second side offset from a plane',options:{side2:true,end2:'offsetSurface',toOffset2:2},edit:d=>{d.feature.toPlane2='front';},volume:400*13,probes:[[10,10,15],[10,10,2]]},
      {name:'second side to a vertex',profile:'circle',options:{side2:true,end2:'upToVertex',merge:false},edit:d=>{block(d);d.feature.toVertex2={p:[10,10,0]};},volume:4*Math.PI*15,probes:[[2,0,15],[2,0,0]]},
      {name:'first side to a plane behind, second blind ahead',profile:'circle',options:{end:'upToSurface',toPlane:'front',side2:true,depth2:3},volume:4*Math.PI*13,probes:[[2,0,0],[2,0,13]]},
      {name:'both sides the same way rejected',profile:'circle',options:{end:'upToSurface',toPlane:'front',side2:true,end2:'upToSurface',toPlane2:'front'},reject:true},
      {name:'second side through a cut',profile:'circle',options:{op:'cut',side2:true,end2:'through'},edit:d=>{block(d);},volume:8000-4*Math.PI*15},
      {name:'second side drafted away from the profile',options:{side2:true,depth2:3,draft:5},volume:5/3*(400+20*(20-10*T(5))+(20-10*T(5))**2)+1*(400+20*(20-6*T(5))+(20-6*T(5))**2),probes:[[10-5*T(5),0,15],[10-3*T(5),0,7]]},
      {name:'second side left out of a symmetric extrusion',options:{end:'midplane',side2:true,depth2:4},volume:400*5},
      // (angled ends: the end plane z = 10 + m·x)
      {name:'draft to an angled end',tilted:20,options:{end:'upToSurface',draft:5},volume:(m)=>draftedToTilt(5,m),probes:(m)=>tiltCorners(5,m,-1)},
      {name:'draft outward to an angled end',tilted:20,options:{end:'upToSurface',draft:5,draftOutward:true},volume:(m)=>draftedOutToTilt(5,m),probes:(m)=>tiltCorners(5,m,1)},
      {name:'no draft to an angled end (as before)',tilted:20,options:{end:'upToSurface'},volume:(m)=>400*(C-10),probes:(m)=>[[10,10,C+10*m],[-10,-10,C-10*m],[10,10,10]]},
      {name:'draft from an angled start',tilted:20,start:true,options:{startFrom:'surface',depth:10,draft:5},volume:(m)=>draftedFromTilt(5,m),probes:(m)=>[[10,10,C+10*m],[-10,-10,C-10*m]]},
      {name:'draft to an angled end too steep rejected',tilted:20,options:{end:'upToSurface',draft:50},reject:true},
      // (Intersect)
      {name:'intersect keeps the overlap',profile:'wide',options:{op:'intersect',depth:30,startFrom:'offset',startOffset:-15},edit:d=>{block(d);},volume:25*Math.PI*20,probes:[[5,0,0],[5,0,20]]},
      {name:'intersect missing every body rejected',profile:'wide',options:{op:'intersect',startFrom:'offset',startOffset:40},edit:d=>{block(d);},reject:true},
      {name:'intersect leaves a body it misses',profile:'wide',options:{op:'intersect',depth:30,startFrom:'offset',startOffset:-15},edit:d=>{block(d,40,false);block(d);},volumes:[8000,25*Math.PI*20]},
      {name:'intersect scoped to two bodies removes the one it misses',profile:'wide',options:{op:'intersect',depth:30,startFrom:'offset',startOffset:-15,scopeAll:false},edit:d=>{block(d,40,false);block(d);d.scopeAllBodies=true;},volumes:[25*Math.PI*20]},
      {name:'intersect patterned rejected',profile:'wide',options:{op:'intersect',depth:30,startFrom:'offset',startOffset:-15},edit:d=>{block(d);const p=M.createFeature(d.doc,'lpattern',{feature:d.feature.id,dir1:'x',dist1:5,count1:2});d.doc.features.push(p);d.rejectId=p.id;},reject:true},
    ];
    for(const c of cases){
      const d=fixture(c.options,c.profile);c.edit?.(d);
      let m=null;
      if(c.tilted){const t=await tiltSlope(d,c.tilted);if(!t){results.push({name:c.name,ok:false,errors:'no tilted plane'});continue;}m=t.m;if(c.start)d.feature.startPlane=t.plane.id;else d.feature.toPlane=t.plane.id;}
      // (a scope of every body there is: the first rebuild names them)
      if(d.scopeAllBodies){const r0=await k.rebuild(d.doc);d.feature.scope=(r0.body?.bodies||[]).map(b=>b.id);if(d.feature.scope.length!==2){results.push({name:c.name,ok:false,errors:'bodies '+JSON.stringify(d.feature.scope)});continue;}}
      const r=await k.rebuild(d.doc);
      if(c.reject){const id=d.rejectId||d.feature.id;results.push({name:c.name,ok:r.errors.some(([e])=>e===id),errors:r.errors});continue;}
      const bodies=r.body?.bodies||[];
      if(r.errors.length||!bodies.length){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      if(c.volumes){const vs=[];for(const b of bodies)vs.push((await measure(b.id)).volume);const want=[...c.volumes].sort((x,y)=>x-y),got=[...vs].sort((x,y)=>x-y);
        results.push({name:c.name,ok:got.length===want.length&&got.every((v,i)=>Math.abs(v-want[i])<1e-4*Math.max(1,want[i]/1000)),volumes:vs,expected:c.volumes});continue;}
      const body=bodies.at(-1),v=(await measure(body.id)).volume,want=typeof c.volume==='function'?c.volume(m):c.volume;
      // (an integrated volume to 1e-4 of it, an exact one to 1e-4 mm³ a cm³)
      let ok=Math.abs(v-want)<(typeof c.volume==='function'?1e-4*want:1e-4*Math.max(1,want/1000));
      const probes=typeof c.probes==='function'?c.probes(m):c.probes||[],missed=[];
      for(const p of probes)if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:v,expected:want,...(m!=null?{slope:m}:{}),...(missed.length?{missed}:{})});
    }
    // (Intersect from a revolve too: a 5 × 30 rectangle beside Front's vertical axis, turned about it, and the block;
    // half the cylinder lies in the block)
    {const d=fixture();block(d);const sk=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}}),p=[[0,-15],[5,-15],[5,15],[0,15]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
      const rev=M.createFeature(d.doc,'revolve',{sketch:sk.id,extent:'full',axis:'v',op:'intersect'});d.doc.features.splice(2,d.doc.features.length,sk,rev);
      const r=await k.rebuild(d.doc),body=r.body?.bodies?.at(-1),v=body&&(await measure(body.id)).volume;
      results.push({name:'revolve intersect',ok:!r.errors.length&&Math.abs(v-250*Math.PI)<1e-4,volume:v,expected:250*Math.PI,errors:r.errors});}
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
