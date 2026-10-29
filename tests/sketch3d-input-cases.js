import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture as moldFixture} from '/tests/mold-cases.js';
// Features that take a 3D sketch where they took a sketch: each against the same part made from a sketch (the same
// volume), or the geometry worked out by hand. A block 40 × 20 × 10 (x ±20, z ±10, y 0 to 10) for the features at
// points: from a 3D sketch each goes square to the face its point is on, so one on the top face and one on the side
// face take out (or add) twice what one from a sketch on the top face does (a nut pocket without its clearance hole,
// which runs through the part). The helix: within 1e-5 of its radius (the kernel's helix is an approximation).
const s3d=(doc,pts,segs=[])=>{const f=M.createFeature(doc,'sketch3d');f.pts=pts.map(([x,y,z],i)=>({id:'p'+(i+1),x,y,z}));f.segs=segs;f.nextId=pts.length+segs.length+1;doc.features.push(f);return f;};
const chain=(n,closed)=>Array.from({length:closed?n:n-1},(_,i)=>({id:'s'+(i+1),a:'p'+(i+1),b:'p'+((i+1)%n+1)}));
// (a sketch on a plane `at` above Top: (x, y) on it is (x, at, −y) in the model)
const planeSketch=(doc,at,draw)=>{let ref='top';if(at){const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:at});doc.features.push(pl);ref=pl.id;}const s=M.createFeature(doc,'sketch',{plane:{ref}});draw(s);doc.features.push(s);return s;};
const poly=(s,pts,closed)=>{const p=pts.map(q=>S.addPoint(s,...q));p.forEach((id,i)=>{if(closed||i<p.length-1)S.addLine(s,id,p[(i+1)%p.length]);});};
function block(doc){planeSketch(doc,0,s=>poly(s,[[-20,-10],[20,-10],[20,10],[-20,10]],true));doc.features.push(M.createFeature(doc,'extrude',{sketch:doc.features.at(-1).id,depth:10}));}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vols=async(r)=>(await Promise.all((r.body?.bodies||[]).map(async b=>(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume))).reduce((x,y)=>x+y,0);
  const close=(x,y,t=1e-6)=>Math.abs(x-y)<=t*Math.max(1,Math.abs(y));
  const build=async(make)=>{const d=M.newDoc();const f=make(d);const r=await k.rebuild(d);return {r,f,v:await vols(r),errors:r.errors.map(e=>e[1])};};
  try{
    const base=(await build(d=>{block(d);})).v;
    // ---- at points: Hole, Boss, Snap Hook, Insert Hole, Nut Pocket, Screw Hole for Plastic
    for(const [type,options] of [['hole',{depth:5}],['boss',{}],['snapHook',{}],['insertHole',{}],['nutPocket',{hole:false}],['plasticScrewHole',{}]]){
      const one=await build(d=>{block(d);const s=planeSketch(d,10,s=>S.addPoint(s,0,0));const f=M.createFeature(d,type,{sketch:s.id,...options});d.features.push(f);return f;});
      const two=await build(d=>{block(d);const s=s3d(d,[[0,10,0],[20,5,0]]);const f=M.createFeature(d,type,{sketch:s.id,...options});d.features.push(f);return f;});
      const each=one.v-base,both=two.v-base;
      results.push({name:`${type}: at a 3D sketch's points on the top and the side face, square to each`,ok:!one.errors.length&&!two.errors.length&&Math.abs(each)>1&&close(both,2*each),each,both,errors:[...one.errors,...two.errors],note:two.r.notes?.[two.f.id]});
    }
    {
      const off=await build(d=>{block(d);const s=s3d(d,[[0,10,0],[0,30,0]]);const f=M.createFeature(d,'hole',{sketch:s.id,depth:5});d.features.push(f);return f;});
      results.push({name:'a 3D sketch point off the part: refused, saying which',ok:off.errors.some(e=>/Point 2 of .* is not on a face/.test(e)),errors:off.errors});
    }
    // ---- Sketch Pattern: a Ø4 hole through a 200 × 200 × 5 plate (on Front) at (10, 10), copied at a 3D sketch's
    // points (30, 10) and (50, −20): 3 holes in all
    {
      const r=await build(d=>{
        const sk=M.createFeature(d,'sketch',{plane:{ref:'front'}});poly(sk,[[-100,-100],[100,-100],[100,100],[-100,100]],true);
        const hs=M.createFeature(d,'sketch',{plane:{ref:'front'}});S.addCircle(hs,S.addPoint(hs,10,10),2);
        const hole=M.createFeature(d,'extrude',{sketch:hs.id,op:'cut',end:'through'});
        d.features.push(sk,M.createFeature(d,'extrude',{sketch:sk.id,depth:5}),hs,hole);
        const s=s3d(d,[[10,10,0],[30,10,0],[50,-20,0]]);
        const f=M.createFeature(d,'spattern',{feature:hole.id,features:[hole.id],sketch:s.id});d.features.push(f);return f;});
      const want=200*200*5-3*Math.PI*4*5;
      results.push({name:'Sketch Pattern: copies at a 3D sketch\'s points',ok:!r.errors.length&&close(r.v,want),volume:r.v,expected:want,errors:r.errors,note:r.r.notes?.[r.f.id]});
    }
    // ---- Helix on a 3D sketch's circle: centre (5, 5, 5), Ø20, its axis along X; pitch 5, 2 turns: every point 10 from
    // the axis, from x 5 to 15
    {
      const r=await build(d=>{const s=s3d(d,[[5,5,5]],[{id:'k1',type:'circle',c:'p1',r:10,n:[1,0,0]}]);const f=M.createFeature(d,'helix',{sketch:s.id,pitch:5,revolutions:2});d.features.push(f);return f;});
      const pts=r.r.curves?.[r.f.id]||[],rad=pts.map(q=>Math.hypot(q[1]-5,q[2]-5)),xs=pts.map(q=>q[0]);
      const ok=!r.errors.length&&pts.length>10&&rad.every(x=>Math.abs(x-10)<1e-5)&&close(Math.min(...xs),5)&&close(Math.max(...xs),15);
      results.push({name:'Helix on a 3D sketch\'s circle, its axis along X',ok,radius:[Math.min(...rad),Math.max(...rad)],x:[Math.min(...xs),Math.max(...xs)],errors:r.errors});
    }
    // ---- Reference Axis along a 3D sketch's line (0, 0, 0) to (10, 10, 10); a reference point at its end
    {
      const r=await build(d=>{const s=s3d(d,[[0,0,0],[10,10,10]],chain(2));
        d.features.push(M.createFeature(d,'axis',{referenceDefinition:true,axisType:'references',refs:[{kind:'sketch',sketch:s.id,curve:'s1'}]}));
        const p=M.createFeature(d,'point',{referenceDefinition:true,pointType:'references',refs:[{kind:'sketch',sketch:s.id,point:'p2'}]});d.features.push(p);return {axis:d.features.at(-2),point:p};});
      const ax=r.r.axes?.[r.f.axis.id],pt=r.r.points?.[r.f.point.id],u=1/Math.sqrt(3);
      const ok=!r.errors.length&&ax&&Math.abs(Math.abs(ax.d.reduce((s,v)=>s+v*u,0)/Math.hypot(...ax.d))-1)<1e-9&&pt&&[10,10,10].every((x,i)=>close((pt.p||pt)[i],x));
      results.push({name:'Reference Axis along a 3D sketch\'s line, a reference point at its end',ok:!!ok,axis:ax,point:pt,errors:r.errors});
    }
    // ---- Loft: a 20 square at y 0 to a 10 square at y 30, from sketches and from 3D sketches (the same); and a saddle
    // (a closed 3D chain out of a plane) to the square
    {
      const sq=(h,at)=>[[-h,at,-h],[h,at,-h],[h,at,h],[-h,at,h]];
      const flat=await build(d=>{const a=planeSketch(d,0,s=>poly(s,[[-10,-10],[10,-10],[10,10],[-10,10]],true)),b=planeSketch(d,30,s=>poly(s,[[-5,-5],[5,-5],[5,5],[-5,5]],true));const f=M.createFeature(d,'loft',{profiles:[a.id,b.id]});d.features.push(f);return f;});
      const in3d=await build(d=>{const a=s3d(d,sq(10,0),chain(4,true)),b=s3d(d,sq(5,30),chain(4,true));const f=M.createFeature(d,'loft',{profiles:[a.id,b.id]});d.features.push(f);return f;});
      const saddle=await build(d=>{const a=s3d(d,[[-10,0,-10],[10,4,-10],[10,0,10],[-10,4,10]],chain(4,true)),b=s3d(d,sq(5,30),chain(4,true));const f=M.createFeature(d,'loft',{profiles:[a.id,b.id]});d.features.push(f);return f;});
      results.push({name:'Loft from 3D sketch profiles: the same as from sketches',ok:!flat.errors.length&&!in3d.errors.length&&flat.v>1000&&close(in3d.v,flat.v),flat:flat.v,in3d:in3d.v,errors:[...flat.errors,...in3d.errors]});
      results.push({name:'Loft from a saddle (a closed 3D chain out of a plane)',ok:!saddle.errors.length&&saddle.v>1000&&Math.abs(saddle.v-flat.v)>1,volume:saddle.v,errors:saddle.errors});
    }
    // ---- Lofted Bend between two open chains (at y 0 and y 50), from sketches and from 3D sketches (the same); and with
    // the second's corner raised out of its plane
    {
      const A=[[-20,-10],[20,-10],[20,10]],B=[[-10,-5],[10,-5],[10,5]],W=(q,at)=>[q[0],at,-q[1]];
      const flat=await build(d=>{const a=planeSketch(d,0,s=>poly(s,A)),b=planeSketch(d,50,s=>poly(s,B));const f=M.createFeature(d,'smLoft',{profileA:a.id,profileB:b.id});d.features.push(f);return f;});
      const in3d=await build(d=>{const a=s3d(d,A.map(q=>W(q,0)),chain(3)),b=s3d(d,B.map(q=>W(q,50)),chain(3));const f=M.createFeature(d,'smLoft',{profileA:a.id,profileB:b.id});d.features.push(f);return f;});
      const bent=await build(d=>{const a=s3d(d,A.map(q=>W(q,0)),chain(3)),b=s3d(d,[W(B[0],50),W(B[1],56),W(B[2],50)],chain(3));const f=M.createFeature(d,'smLoft',{profileA:a.id,profileB:b.id});d.features.push(f);return f;});
      results.push({name:'Lofted Bend from 3D sketch profiles: the same as from sketches',ok:!flat.errors.length&&!in3d.errors.length&&flat.v>100&&close(in3d.v,flat.v,1e-5),flat:flat.v,in3d:in3d.v,errors:[...flat.errors,...in3d.errors]});
      results.push({name:'Lofted Bend to a profile out of a plane',ok:!bent.errors.length&&bent.v>100&&Math.abs(bent.v-flat.v)>0.1,volume:bent.v,errors:bent.errors});
    }
    // ---- Sprue and Runners along a 3D sketch's line, (−18, 5, 0) to (−10, 5, 0): the same mould as from a sketch line
    {
      const mould=async(add)=>{const d=moldFixture({});add(d.doc);const r=await k.rebuild(d.doc);return {v:await vols(r),errors:r.errors.map(e=>e[1])};};
      const flat=await mould(doc=>{const s=planeSketch(doc,5,s=>{S.addLine(s,S.addPoint(s,-18,0),S.addPoint(s,-10,0));});doc.features.push(M.createFeature(doc,'moldRunner',{sketch:s.id,runnerD:4,sprueD:3,taper:1}));});
      const in3d=await mould(doc=>{const s=s3d(doc,[[-18,5,0],[-10,5,0]],chain(2));doc.features.push(M.createFeature(doc,'moldRunner',{sketch:s.id,runnerD:4,sprueD:3,taper:1}));});
      results.push({name:'Sprue and Runners along a 3D sketch\'s line: the same mould as from a sketch',ok:!flat.errors.length&&!in3d.errors.length&&close(in3d.v,flat.v),flat:flat.v,in3d:in3d.v,errors:[...flat.errors,...in3d.errors]});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
