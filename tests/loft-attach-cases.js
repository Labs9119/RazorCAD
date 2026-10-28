import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import * as LC from '/js/loftcorrespondence.js';
import {KernelClient} from '/js/kernelclient.js';
// Loft correspondence by hand beyond vertices: a connector inside a curve (the profile gains a point there), holes paired
// and started by hand, Thin lofts' connectors, and CAD guide constraints with holes. Two profiles on Front and 20 mm
// in front of it; straight (ruled) lofts, whose volume is exact by Simpson's rule (the section's area is quadratic in
// the height), and holes between circles, whose volume is the circle's area times the height however they lean.
const H=20;
const area=(pts)=>Math.abs(pts.reduce((s,p,i)=>{const q=pts[(i+1)%pts.length];return s+p[0]*q[1]-q[0]*p[1];},0))/2;
const ruled=(A,B)=>H/6*(area(A)+4*area(A.map((p,i)=>p.map((x,k)=>(x+B[i][k])/2)))+area(B));
function polygon(sk,pts){const ids=pts.map(q=>S.addPoint(sk,...q));const lines=ids.map((id,i)=>S.addLine(sk,id,ids[(i+1)%ids.length]));return {ids,lines};}
// profiles: for each, (sk) => draws it; returns the feature, the sketches and the refs (region with holes when there are)
export function fixture(draw,options={}){
  const doc=M.newDoc(),sketches=[],profiles=[];
  for(let i=0;i<2;i++){
    let ref='front';if(i){const p=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:H});doc.features.push(p);ref=p.id;}
    const sk=M.createFeature(doc,'sketch',{plane:{ref}}),made=draw[i](sk);doc.features.push(sk);sketches.push({sk,...made});
    const regions=LR.selectableRegions(sk);profiles.push(LR.regionRef(sk.id,regions.reduce((b,r)=>(r.holes.length>b.holes.length?r:b),regions[0])));
  }
  const feature=M.createFeature(doc,'loft',{profiles,correspondenceMode:'manual',loftCorrespondence:{},ruled:true,...options});doc.features.push(feature);
  return {doc,feature,sketches,profiles,set:(i,c)=>{feature.loftCorrespondence[LR.refKey(profiles[i])]=c;}};
}
const SQ=[[-5,-5],[5,-5],[5,5],[-5,5]],TRI=[[-6,-6],[6,-6],[0,6]];
const square=(half,x=0,y=0)=>[[-half+x,-half+y],[half+x,-half+y],[half+x,half+y],[-half+x,half+y]];
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  const holeKey=(sk,curve)=>JSON.stringify([curve]);
  const cases=[
    {name:'a triangle to a square through a point inside an edge (50 %)',draw:[sk=>polygon(sk,SQ),sk=>polygon(sk,TRI)],edit:d=>{d.set(0,{point:d.sketches[0].ids[0]});d.set(1,{curve:d.sketches[1].lines[0],at:50});},
      volume:ruled(SQ,[[0,-6],[6,-6],[0,6],[-6,-6]]),probes:[[0,-6,H],[-5,-5,0]]},
    {name:'the point inside the edge a quarter along it',draw:[sk=>polygon(sk,SQ),sk=>polygon(sk,TRI)],edit:d=>{d.set(0,{point:d.sketches[0].ids[0]});d.set(1,{curve:d.sketches[1].lines[0],at:25});},
      volume:ruled(SQ,[[-3,-6],[6,-6],[0,6],[-6,-6]]),probes:[[-3,-6,H]]},
    {name:'a triangle to a square without the point rejected',draw:[sk=>polygon(sk,SQ),sk=>polygon(sk,TRI)],edit:d=>{d.set(0,{point:d.sketches[0].ids[0]});},reject:/same number of points/},
    {name:'a point inside a curve that is gone rejected',draw:[sk=>polygon(sk,SQ),sk=>polygon(sk,TRI)],edit:d=>{d.set(1,{curve:'gone',at:50});},reject:/no longer on this boundary|reselect/},
    // (holes: circles r 2 at x = ±8 on the first profile, moved 8 up and 8 down on the second; paired by hand)
    {name:'holes paired by hand',draw:[sk=>{polygon(sk,square(15));return {h:[S.addCircle(sk,S.addPoint(sk,-8,0),2),S.addCircle(sk,S.addPoint(sk,8,0),2)]};},sk=>{polygon(sk,square(15));return {h:[S.addCircle(sk,S.addPoint(sk,8,-8),2),S.addCircle(sk,S.addPoint(sk,-8,8),2)]};}],
      edit:d=>{d.set(0,{holeOrder:d.sketches[0].h.map(c=>holeKey(d.sketches[0].sk,c))});d.set(1,{holeOrder:[d.sketches[1].h[1],d.sketches[1].h[0]].map(c=>holeKey(d.sketches[1].sk,c))});},
      volume:900*H-2*4*Math.PI*H,probes:[[-6,4,H/2],[10,-4,H/2]]},
    {name:'holes paired the other way by hand',draw:[sk=>{polygon(sk,square(15));return {h:[S.addCircle(sk,S.addPoint(sk,-8,0),2),S.addCircle(sk,S.addPoint(sk,8,0),2)]};},sk=>{polygon(sk,square(15));return {h:[S.addCircle(sk,S.addPoint(sk,8,-8),2),S.addCircle(sk,S.addPoint(sk,-8,8),2)]};}],
      edit:d=>{d.set(0,{holeOrder:d.sketches[0].h.map(c=>holeKey(d.sketches[0].sk,c))});d.set(1,{holeOrder:d.sketches[1].h.map(c=>holeKey(d.sketches[1].sk,c))});},
      volume:900*H-2*4*Math.PI*H,probes:[[-2,-4,H/2],[2,4,H/2]]},
    // (a square hole started a vertex on in the second profile: it turns a quarter)
    {name:'a hole started by hand',draw:[sk=>{polygon(sk,square(15));return {hole:polygon(sk,square(3))};},sk=>{polygon(sk,square(15));return {hole:polygon(sk,square(3))};}],
      edit:d=>{const key=(i)=>LC.holeKey({segs:d.sketches[i].hole.lines.map(c=>({sourceCurve:c}))});d.set(0,{holeStarts:{[key(0)]:{point:d.sketches[0].hole.ids[0]}}});d.set(1,{holeStarts:{[key(1)]:{point:d.sketches[1].hole.ids[1]}}});},
      volume:900*H-2/3*36*H},
    {name:'a hole left automatic (as before)',draw:[sk=>({...polygon(sk,square(15)),hole:polygon(sk,square(3))}),sk=>({...polygon(sk,square(15)),hole:polygon(sk,square(3))})],edit:d=>{d.set(0,{point:d.sketches[0].ids[0]});d.set(1,{point:d.sketches[1].ids[0]});},volume:900*H-36*H},
    // (Thin: the wall inside the square, 1 mm thick; the second profile started a vertex on: both walls turn a quarter)
    {name:'a Thin loft started by hand',draw:[sk=>polygon(sk,SQ),sk=>polygon(sk,SQ)],options:{thin:true,thinT:1,thinDir:'other'},edit:d=>{d.set(0,{point:d.sketches[0].ids[0]});d.set(1,{point:d.sketches[1].ids[1]});},volume:2/3*(100-64)*H},
    // (CAD guide constraints with a hole: a straight guide up a corner, the hole lofted straight)
    {name:'CAD guide constraints with a hole',draw:[sk=>{polygon(sk,SQ);return {h:S.addCircle(sk,'O',1)};},sk=>{polygon(sk,SQ);return {h:S.addCircle(sk,'O',1)};}],options:{correspondenceMode:'auto',ruled:false,guideMethod:'constrained'},
      edit:d=>{const g=M.createFeature(d.doc,'sketch3d',{segs:null,pts:[{x:-5,y:-5,z:0},{x:-5,y:-5,z:H}],kind:'lines',radius:0});d.doc.features.splice(-1,0,g);d.feature.guides=[g.id];},volume:100*H-Math.PI*H,probes:[[1,0,H/2]]},
  ];
  try{
    for(const c of cases){
      let d;try{d=fixture(c.draw,c.options);c.edit?.(d);}catch(e){results.push({name:c.name,ok:false,setup:String(e.stack||e).slice(0,300)});continue;}
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<1e-6*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,...(missed.length?{missed}:{})});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
