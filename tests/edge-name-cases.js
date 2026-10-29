import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Edges named by the extrusion that made them (ref.gen), found again by their name after a change. A block (x ±w,
// z ±10, y 0 to 10) from a sketch on Top. Three Ø6 bosses 5 tall from one sketch on a plane at y 10, at x −20, 0 and
// 20, with a fillet on the middle one's top edge: the first rebuild names it (the boss, its circle, the last level of
// two); with the middle circle moved to x 10 and the third to x 0 (where the middle one was) the fillet goes with the
// middle boss to x 10, where by its place alone it went to the third. A pocket's floor edge follows the floor when the
// pocket is made deeper (its first level along the sketch's normal); a block corner edge, named by its sketch point,
// follows the point when the block is made wider.
const plane=(doc,at)=>{const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:at});doc.features.push(pl);return pl.id;};
const rect=(s,x0,y0,x1,y1)=>{const p=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].map(q=>S.addPoint(s,...q));p.forEach((id,i)=>S.addLine(s,id,p[(i+1)%4]));return p;};
function block(doc,w=30){const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});const pts=rect(sk,-w,-10,w,10);const f=M.createFeature(doc,'extrude',{sketch:sk.id,depth:10});doc.features.push(sk,f);return {sk,pts,f};}
export function bosses(doc,xs,edges){
  block(doc);const s=M.createFeature(doc,'sketch',{plane:{ref:plane(doc,10)}});
  const ids=xs.map(x=>{S.addCircle(s,S.addPoint(s,x,0),3);return s.curves.at(-1).id;});
  const boss=M.createFeature(doc,'extrude',{sketch:s.id,depth:5}),fillet=M.createFeature(doc,'fillet',{radius:1,edges:JSON.parse(JSON.stringify(edges))});
  doc.features.push(s,boss,fillet);return {s,ids,boss,fillet};
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const at=(q,x,y,z)=>q&&Math.abs(Math.hypot(q[0]-x,q[2]-z)-3)<1e-6&&Math.abs(q[1]-y)<1e-6;
  const build=async(make)=>{const d=M.newDoc();const x=make(d);const r=await k.rebuild(d);return {r,x,errors:r.errors.map(e=>e[1])};};
  try{
    {
      const one=await build(d=>bosses(d,[-20,0,20],[{p:[3,15,0]}]));
      const e1=one.r.features?.[one.x.fillet.id]?.edges?.[0],g=e1?.gen;
      results.push({name:'A fillet on a boss\'s top edge: named by the boss, its circle and the last of two levels',ok:!one.errors.length&&g?.f===one.x.boss.id&&g.c===one.x.ids[1]&&g.at==='last'&&g.of===2,gen:g,errors:one.errors});
      const kept=e1?[e1]:[{p:[3,15,0]}];
      const two=await build(d=>bosses(d,[-20,10,0],kept));
      const e2=two.r.features?.[two.x.fillet.id]?.edges?.[0];
      results.push({name:'The bosses rearranged (another where it was): the fillet goes with its boss to x 10',ok:!two.errors.length&&at(e2?.p,10,15,0),p:e2?.p,errors:two.errors});
      const unnamed=kept.map(({gen,...q})=>q);
      const old=await build(d=>bosses(d,[-20,10,0],unnamed));
      const e3=old.r.features?.[old.x.fillet.id]?.edges?.[0];
      results.push({name:'(Without its name, by its place alone: the other boss, at x 0)',ok:!old.errors.length&&!at(e3?.p,10,15,0),p:e3?.p??'not moved: at its old place, x 0',errors:old.errors});
    }
    {
      const pocket=(depth,edges)=>build(d=>{block(d);const s=M.createFeature(d,'sketch',{plane:{ref:plane(d,10)}});rect(s,-10,-5,10,5);
        const cut=M.createFeature(d,'extrude',{sketch:s.id,op:'cut',depth,reverse:true}),fillet=M.createFeature(d,'fillet',{radius:1,edges:JSON.parse(JSON.stringify(edges))});d.features.push(s,cut,fillet);return {cut,fillet};});
      const one=await pocket(4,[{p:[0,6,5]}]),e1=one.r.features?.[one.x.fillet.id]?.edges?.[0];
      const two=await pocket(8.5,e1?[e1]:[{p:[0,6,5]}]),e2=two.r.features?.[two.x.fillet.id]?.edges?.[0];
      results.push({name:'A pocket\'s floor edge (its first level): the pocket made deeper, the fillet on the new floor',ok:!one.errors.length&&!two.errors.length&&e1?.gen?.f===one.x.cut.id&&e1.gen.at==='first'&&Math.abs(e2?.p?.[1]-1.5)<1e-6&&Math.abs(e2.p[2]-5)<1e-6,gen:e1?.gen,p:e2?.p,errors:[...one.errors,...two.errors]});
    }
    {
      const wide=(w,edges)=>build(d=>{const b=block(d,w);const fillet=M.createFeature(d,'fillet',{radius:1,edges:JSON.parse(JSON.stringify(edges))});d.features.push(fillet);return {b,fillet};});
      const one=await wide(30,[{p:[30,5,10]}]),e1=one.r.features?.[one.x.fillet.id]?.edges?.[0];
      const two=await wide(45,e1?[e1]:[{p:[30,5,10]}]),e2=two.r.features?.[two.x.fillet.id]?.edges?.[0];
      results.push({name:'A block\'s corner edge, named by its sketch point: the block made wider, the fillet at x 45',ok:!one.errors.length&&!two.errors.length&&e1?.gen?.pt===one.x.b.pts[1]&&Math.abs(e2?.p?.[0]-45)<1e-6&&Math.abs(e2.p[2]-10)<1e-6,gen:e1?.gen,p:e2?.p,errors:[...one.errors,...two.errors]});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
