import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Sketches on model faces follow the face. A block 40 × 20 × h (x ±20, z ±10, y 0 to h, from a sketch on Top) and a
// Ø6 boss 5 tall from a sketch on its top face, picked when h was 10 (the first rebuild keeps the bodies' box with the
// face): with h 20 the boss stands on the new top (40 · 20 · 20 + 9π · 5), and the sketch's plane is written back at
// y 20; with h 4 it goes down. A sketch from before faces were kept (only the plane) stays at y 10, so its boss is
// inside the block (40 · 20 · 20). A 20 × 4 pocket cut through the top's right half (x 0 to 20): picked on the left
// half, the boss goes on that half's top. A face that is gone: the sketch where it was, with a note.
const poly=(s,pts)=>{const p=pts.map(q=>S.addPoint(s,...q));p.forEach((id,i)=>S.addLine(s,id,p[(i+1)%p.length]));};
const TOP={o:[0,10,0],u:[1,0,0],v:[0,0,-1],n:[0,1,0]};
export function fixture(doc,h,{plane,pocket=false}={}){
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});poly(sk,[[-20,-10],[20,-10],[20,10],[-20,10]]);
  const block=M.createFeature(doc,'extrude',{sketch:sk.id,depth:h});doc.features.push(sk,block);
  if(pocket){const c=M.createFeature(doc,'sketch',{plane:{ref:'front'}});poly(c,[[0,h-4],[20,h-4],[20,h],[0,h]]);doc.features.push(c,M.createFeature(doc,'extrude',{sketch:c.id,op:'cut',end:'through2'}));}
  const on=M.createFeature(doc,'sketch',{plane:JSON.parse(JSON.stringify(plane))});
  S.addCircle(on,S.addPoint(on,0,0),3);
  const boss=M.createFeature(doc,'extrude',{sketch:on.id,depth:5});doc.features.push(on,boss);
  return {sk,block,on,boss};
}
export const facePlane=(at=[5,10,2])=>({ref:'face',frame:TOP,face:{p:at,n:[0,1,0]}});
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vols=async(r)=>(await Promise.all((r.body?.bodies||[]).map(async b=>(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume))).reduce((x,y)=>x+y,0);
  const close=(x,y,t=1e-6)=>Math.abs(x-y)<=t*Math.max(1,Math.abs(y));
  const build=async(h,o)=>{const d=M.newDoc();const x=fixture(d,h,o);const r=await k.rebuild(d);return {r,x,d,v:await vols(r),errors:r.errors.map(e=>e[1]),y:r.sketches?.[x.on.id]?.frame?.o?.[1],plane:r.features?.[x.on.id]?.plane,note:r.notes?.[x.on.id]};};
  const boss=9*Math.PI*5;
  try{
    {
      const same=await build(10,{plane:facePlane()});
      results.push({name:'On the face it was picked on: the boss on top; the face kept with the bodies\' box',ok:!same.errors.length&&close(same.v,8000+boss)&&close(same.y,10)&&!!same.plane?.face?.box&&close(same.plane.frame.o[1],10),volume:same.v,plane:same.plane,errors:same.errors});
      const kept=same.plane||facePlane();
      const up=await build(20,{plane:kept});
      results.push({name:'The block made taller: the sketch follows its top face (y 20), written back',ok:!up.errors.length&&close(up.v,16000+boss)&&close(up.y,20)&&close(up.plane?.frame?.o?.[1],20)&&close(up.plane?.face?.p?.[1],20)&&up.plane.frame.u.join()==='1,0,0'&&!up.note,volume:up.v,expected:16000+boss,plane:up.plane,errors:up.errors});
      const down=await build(4,{plane:kept});
      results.push({name:'The block made lower: the sketch follows it down (y 4)',ok:!down.errors.length&&close(down.v,3200+boss)&&close(down.y,4),volume:down.v,expected:3200+boss,errors:down.errors});
      const fresh=await build(20,{plane:facePlane()});
      results.push({name:'A face picked on a block 10 high and found in one 20 high without its box: the only top there',ok:!fresh.errors.length&&close(fresh.y,20),y:fresh.y,errors:fresh.errors});
    }
    {
      const old=await build(20,{plane:{ref:'face',frame:TOP}});
      results.push({name:'A sketch with only the face\'s plane (from before): it stays at y 10, its boss inside the block',ok:!old.errors.length&&close(old.v,16000)&&close(old.y,10)&&!old.plane,volume:old.v,errors:old.errors});
    }
    {
      const first=await build(10,{plane:facePlane([-10,10,0]),pocket:true});
      const r=await build(20,{plane:first.plane||facePlane([-10,10,0]),pocket:true});
      const want=16000-20*4*20+boss;
      results.push({name:'A pocket in half the top: picked on the other half, it follows that half up (y 20)',ok:!first.errors.length&&!r.errors.length&&close(first.y,10)&&close(r.y,20)&&close(r.v,want),volume:r.v,expected:want,y:[first.y,r.y],errors:[...first.errors,...r.errors],note:r.note});
    }
    {
      // a cylinder lying along X (nothing flat facing up): the face is gone
      const d=M.newDoc(),sk=M.createFeature(d,'sketch',{plane:{ref:'right'}});S.addCircle(sk,S.addPoint(sk,0,0),8);
      d.features.push(sk,M.createFeature(d,'extrude',{sketch:sk.id,depth:40,end:'midplane'}));
      const on=M.createFeature(d,'sketch',{plane:JSON.parse(JSON.stringify(facePlane()))});S.addCircle(on,S.addPoint(on,0,0),3);
      d.features.push(on,M.createFeature(d,'extrude',{sketch:on.id,depth:5}));
      const r=await k.rebuild(d),errors=r.errors.map(e=>e[1]),note=r.notes?.[on.id]||'';
      results.push({name:'The face gone: the sketch stays where it was, with a note',ok:!errors.length&&/no longer in the model/.test(note)&&close(r.sketches?.[on.id]?.frame?.o?.[1],10),note,errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
