import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import * as P3 from '/js/print3d.js';
// 3D printing fits and joints, each to the volume worked out from its shape; Auto-Orient on an L bracket.
const rect=(sk,x0,z0,x1,z1)=>{const p=[[x0,z0],[x1,z0],[x1,z1],[x0,z1]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));};
function block(doc,{x=20,z=10,h=10}={}){const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});rect(sk,-x,-z,x,z);doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:h}));}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vols=async(r)=>Promise.all((r.body?.bodies||[]).map(async b=>(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume));
  const close=(x,y)=>Math.abs(x-y)<1e-6*Math.max(1,Math.abs(y));
  try{
    // Fit Clearance (sliding 0.3, loose 0.5): a Ø10 pin 10 high thinner by a ring 0.3 thick; a Ø10 hole through 10 wider
    // by 0.5; a 20 × 10 end face in by 0.3
    const fit=async(name,make,face,options,removed)=>{
      const d0=M.newDoc();make(d0);const v0=(await vols(await k.rebuild(d0)))[0];
      const d=M.newDoc();make(d);const f=M.createFeature(d,'fitClearance',{faces:[face],...options});d.features.push(f);
      const r=await k.rebuild(d),v=(await vols(r))[0];
      results.push({name,ok:!r.errors.length&&close(v0-v,removed),removed:v0-v,expected:removed,note:r.notes?.[f.id],errors:r.errors});
    };
    const pinned=d=>{block(d);const pl=M.createFeature(d,'plane',{refs:[{kind:'plane',id:'top'}],offset:10}),s=M.createFeature(d,'sketch',{plane:{ref:pl.id}});S.addCircle(s,'O',5);d.features.push(pl,s,M.createFeature(d,'extrude',{sketch:s.id,depth:10}));};
    await fit('a pin made thinner by the sliding fit (0.3)',pinned,{p:[5,15,0]},{fit:'sliding'},Math.PI*(25-4.7*4.7)*10);
    const holed=d=>{block(d);const s=M.createFeature(d,'sketch',{plane:{ref:'top'}});S.addCircle(s,'O',5);d.features.push(s,M.createFeature(d,'extrude',{sketch:s.id,op:'cut',end:'through2'}));};
    await fit('a hole made wider by the loose fit (0.5)',holed,{p:[5,5,0]},{fit:'loose'},Math.PI*(5.5*5.5-25)*10);
    await fit('a flat face moved in by the sliding fit',d=>block(d),{p:[20,5,0],n:[1,0,0]},{fit:'sliding'},0.3*20*10);
    // Print-in-Place Hinge on the block's top front edge (40 long): 5 knuckles Ø8 on a Ø4 pin, 0.4 apart: each 7.68 long;
    // body A: knuckles 1, 3, 5 and the pin all along; knuckles 2 and 4, bored Ø4.8, a body each (until joined to a part)
    {
      const d=M.newDoc();block(d);const f=M.createFeature(d,'printHinge',{edge:{p:[0,10,10]},gap:0.4});d.features.push(f);
      const r=await k.rebuild(d),v=await vols(r),kk=(40-4*0.4)/5,A=3*Math.PI*16*kk+Math.PI*4*(40-3*kk),B=2*Math.PI*(16-2.4*2.4)*kk;
      results.push({name:'a print-in-place hinge: the pin with its knuckles, and the others turning on it',ok:!r.errors.length&&v.length===4&&close(v[1],A)&&close(v[2],B/2)&&close(v[3],B/2),volumes:v,expected:[8000,A,B/2,B/2],note:r.notes?.[f.id],errors:r.errors});
    }
    // Split for Printing: a 250 × 20 × 20 bar at its middle (Right), 2 dowels Ø3 (holes Ø3.3, the snug fit, 6 deep each side)
    {
      const d=M.newDoc();block(d,{x:125,z:10,h:20});const f=M.createFeature(d,'printSplit',{tool:'right'});d.features.push(f);
      const r=await k.rebuild(d),v=await vols(r),each=125*20*20-2*Math.PI*1.65*1.65*6;
      results.push({name:'a 250 mm bar split in two with 2 dowel holes each side',ok:!r.errors.length&&v.length===2&&v.every(x=>close(x,each)),volumes:v,expected:each,note:r.notes?.[f.id],errors:r.errors});
    }
    // Auto-Orient: an L (a base 40 × 20 × 4, an upright 40 × 4 × 30 at its back): the best is no support, the upright's
    // back (40 × 30) on the bed, 20 high
    {
      const d=M.newDoc();block(d,{h:4});const s=M.createFeature(d,'sketch',{plane:{ref:'top'}});rect(s,-20,6,20,10);d.features.push(s,M.createFeature(d,'extrude',{sketch:s.id,depth:30}));
      const r=await k.rebuild(d),c=P3.autoOrient(r.body,P3.BUILTIN_PROFILES[0]);
      results.push({name:'Auto-Orient lays an L bracket on its long leg, no support',ok:!r.errors.length&&c.length===3&&c[0].support<1e-9&&close(c[0].contact,1200)&&close(c[0].height,20),best:c[0]&&{support:c[0].support,contact:c[0].contact,height:c[0].height,n:c[0].n},errors:r.errors});
    }
    // the fit test piece's pegs for PLA: 6 less twice 0.05, 0.15, 0.3, 0.5
    const pegs=P3.calibrationPegs(P3.BUILTIN_PROFILES[0]).map(g=>g.d);
    results.push({name:'calibration pegs Ø5.9, 5.7, 5.4, 5.0',ok:[5.9,5.7,5.4,5].every((x,i)=>Math.abs(pegs[i]-x)<1e-12),pegs});
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
