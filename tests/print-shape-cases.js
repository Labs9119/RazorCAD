import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {Y_UP} from '/js/print3d.js';
// 3D printing shapes, printed with the model's Y up (Y_UP): each change of volume worked out from its shape.
function block(doc,h=10){
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:h}));
}
const shoelace=(P)=>Math.abs(P.reduce((s,p,i)=>{const q=P[(i+1)%P.length];return s+p[0]*q[1]-q[0]*p[1];},0))/2;
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vol=async(r)=>r.body?.bodies?.length===1?(await k.request('measure',{refs:[{kind:'body',id:r.body.bodies[0].id}]})).items[0].volume:NaN;
  const pair=async(name,make,feature,delta)=>{
    const d0=M.newDoc();d0.print={R:Y_UP};make(d0);const r0=await k.rebuild(d0),v0=await vol(r0);
    const d=M.newDoc();d.print={R:Y_UP};make(d);const f=M.createFeature(d,feature.type,feature.options||{});d.features.push(f);
    const r=await k.rebuild(d),v=await vol(r),got=v-v0;
    results.push({name,ok:!r0.errors.length&&!r.errors.length&&Math.abs(got-delta)<1e-6*Math.max(1,Math.abs(v0)),change:got,expected:delta,note:r.notes?.[f.id],errors:[...r0.errors,...r.errors]});
  };
  try{
    // a Ø10 hole along z through a 40 × 20 × 30 block, its axis 15 up: the teardrop's kite (area r²) less the circle's top
    // quarter, along its 20 mm; cut flat at the hole's top: the kite's top taken off at height r
    const holed=(d)=>{block(d,30);const s=M.createFeature(d,'sketch',{plane:{ref:'front'}});S.addCircle(s,S.addPoint(s,0,15),5);d.features.push(s,M.createFeature(d,'extrude',{sketch:s.id,op:'cut',end:'through2'}));};
    const r=5,a=r/Math.SQRT2,b=(Math.SQRT2-1)*r;
    await pair('teardrop on a hole lying on its side',holed,{type:'printableHole',options:{}},-(r*r*(1-Math.PI/4))*20);
    await pair('teardrop cut flat at the top of the hole',holed,{type:'printableHole',options:{shape:'flattop'}},-(shoelace([[-a,a],[-b,r],[b,r],[a,a],[0,0]])-Math.PI*r*r/4)*20);
    // the first layer's edges (the block's bottom, 40 × 20) chamfered 0.4: 0.08 per mm of its 120 mm, less the corners' c³/3
    await pair('first-layer chamfer 0.4 round the bottom',(d)=>block(d),{type:'bedChamfer',options:{size:0.4}},-(0.08*120-4*0.4**3/3));
    // rounds R2 on the bottom front edge (facing down) and the top front edge: the bottom one becomes a 2 × 45° chamfer
    // (takes 2 a mm instead of 4 − π), the top one stays a round
    const rounded=(d)=>{block(d);d.features.push(M.createFeature(d,'fillet',{radius:2,edges:[{p:[0,0,10]},{p:[0,10,10]}]}));};
    await pair('a round facing down turned into a 45° chamfer (the one facing up left)',rounded,{type:'printableOverhangs',options:{}},-(2-(4-Math.PI))*40);
    // an M6 counterbore (Ø11 × 6.5) over a Ø6.6 hole through, printed upside down: its floor stepped one layer (0.2) at a
    // time, a strip 6.6 wide across the Ø11 opening, then a 6.6 square, each less the hole already there; or a skin
    const cb=(d)=>{block(d);d.features.push(M.createFeature(d,'hole',{holeType:'cbore',size:'M6',end:'through',faces:[{p:[0,10,0],n:[0,1,0]}]}));};
    const R2=5.5,h2=3.3,strip=2*(h2*Math.sqrt(R2*R2-h2*h2)+R2*R2*Math.asin(h2/R2)),hole=Math.PI*h2*h2;
    const floor={p:[4.4,3.5,0],n:[0,1,0]};
    await pair('bridging steps over a counterbore printed upside down',cb,{type:'bridgingLayer',options:{faces:[floor],layer:0.2}},-(0.2*(strip-hole)+0.2*(6.6*6.6-hole)));
    await pair('a skin one layer thick over the hole',cb,{type:'bridgingLayer',options:{faces:[floor],layer:0.2,mode:'skin'}},hole*0.2);
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
