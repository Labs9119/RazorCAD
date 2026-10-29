import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Structural Member groups: segments picked from sketches and 3D sketches, each group with its own alignment and
// corners. A 400 × 200 rectangle (x ±200, the sketch's y ±100) on Top in 50 SHS: the long sides as group 1, the short
// ones as group 2: where they meet the later group is trimmed to the earlier, so group 1 runs over the corners (to the
// far side of the short members: 450 long) and group 2 stops at group 1's faces (200 − 50 = 150). The other way round:
// 250 and 400 − 50 = 350. One line picked: one member. A group's line no longer in the sketch: the others built, the
// note says so. A 3D sketch's middle line picked: that one member, as long as it.
function rect(doc){const s=M.createFeature(doc,'sketch',{plane:{ref:'top'}});const p=[[-200,-100],[200,-100],[200,100],[-200,100]].map(q=>S.addPoint(s,...q));const c=p.map((id,i)=>{S.addLine(s,id,p[(i+1)%4]);return s.curves.at(-1).id;});doc.features.push(s);return {s,c};}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const build=async(make)=>{const d=M.newDoc();const f=make(d);d.features.push(f);const r=await k.rebuild(d);return {errors:r.errors.map(e=>e[1]),len:(r.body?.bodies||[]).filter(b=>b.member).map(b=>b.member.length).sort((x,y)=>x-y),note:r.notes?.[f.id]};};
  const member=(d,groups,o={})=>M.createFeature(d,'structMember',{ptype:'shs',size:'50x50x3 SHS',groups,...o});
  const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>Math.abs(x-b[i])<1e-6);
  try{
    {
      const r=await build(d=>{const {s,c}=rect(d);return member(d,[{segs:[c[0],c[2]].map(x=>({s:s.id,c:x}))},{segs:[c[1],c[3]].map(x=>({s:s.id,c:x}))}]);});
      results.push({name:'Long sides group 1, short sides group 2: the short ones trimmed to the long ones',ok:!r.errors.length&&eq(r.len,[150,150,450,450])&&/2 groups/.test(r.note||''),len:r.len,note:r.note,errors:r.errors});
      const r2=await build(d=>{const {s,c}=rect(d);return member(d,[{segs:[c[1],c[3]].map(x=>({s:s.id,c:x}))},{segs:[c[0],c[2]].map(x=>({s:s.id,c:x}))}]);});
      results.push({name:'The other way round: the long ones trimmed to the short ones',ok:!r2.errors.length&&eq(r2.len,[250,250,350,350]),len:r2.len,errors:r2.errors});
      const mit=await build(d=>{const {s,c}=rect(d);return member(d,[{segs:c.map(x=>({s:s.id,c:x})),corner:'mitre'}]);});
      results.push({name:'All four in one group, mitred: each runs to the outside corner',ok:!mit.errors.length&&eq(mit.len,[250,250,450,450]),len:mit.len,errors:mit.errors});
    }
    {
      const one=await build(d=>{const {s,c}=rect(d);return member(d,[{segs:[{s:s.id,c:c[0]}]}]);});
      results.push({name:'One line picked: one member, as long as the line',ok:!one.errors.length&&eq(one.len,[400]),len:one.len,errors:one.errors});
      const lost=await build(d=>{const {s,c}=rect(d);return member(d,[{segs:[{s:s.id,c:c[0]},{s:s.id,c:'nope'}]}]);});
      results.push({name:'A line no longer in its sketch: the others built, the note says so',ok:!lost.errors.length&&eq(lost.len,[400])&&/1 line picked no longer/.test(lost.note||''),note:lost.note,errors:lost.errors});
    }
    {
      const r=await build(d=>{const f3=M.createFeature(d,'sketch3d');f3.pts=[[0,0,0],[0,300,0],[400,300,0],[400,300,250]].map(([x,y,z],i)=>({id:'p'+(i+1),x,y,z}));f3.segs=[1,2,3].map(i=>({id:'s'+i,a:'p'+i,b:'p'+(i+1)}));f3.nextId=8;d.features.push(f3);return member(d,[{segs:[{s:f3.id,c:'s2'}]}]);});
      results.push({name:'A 3D sketch\'s middle line picked: that one member',ok:!r.errors.length&&eq(r.len,[400]),len:r.len,errors:r.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
