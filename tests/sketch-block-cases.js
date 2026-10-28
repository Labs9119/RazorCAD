import * as S from '/js/sketchmodel.js';
import {solveSketch,analyzeSketch} from '/js/solver.js';
// Linked sketch blocks: a 10 × 4 rectangle (horizontal / vertical, its width and height dimensioned) with a Ø2 hole at
// its middle, made a block, put in a sketch turned 30° at (20, 5); it moves as one, follows the block when that
// changes (with a line from the origin to one of its corners kept), and explodes back into plain geometry.
const ev=(x)=>+x;
function blockDef(w=10,h=4,r=1){
  const sk=S.newSketchData();
  const p=[[0,0],[w,0],[w,h],[0,h]].map(q=>S.addPoint(sk,...q)),l=p.map((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  S.addRel(sk,'horizontal',[l[0]]);S.addRel(sk,'vertical',[l[1]]);S.addRel(sk,'horizontal',[l[2]]);S.addRel(sk,'vertical',[l[3]]);
  S.addRel(sk,'dim',[p[0],p[1]],{kind:'distance',value:w});S.addRel(sk,'dim',[p[1],p[2]],{kind:'distance',value:h});
  const c=S.addPoint(sk,w/2,h/2);S.addCircle(sk,c,r);
  return {name:'Plate',data:S.blockData(sk,[...l,sk.curves.at(-1).id])};
}
const pts=(sk,b)=>b.def.points.map(q=>S.getPoint(sk,b.map[q.id]));
const dists=(P)=>P.flatMap((a,i)=>P.slice(i+1).map(b=>Math.hypot(a.x-b.x,a.y-b.y)));
export async function run(){
  const results=[];
  const blk=blockDef(),sk=S.newSketchData();
  const {id}=S.insertBlockInstance(sk,blk,20,5,30);
  const inst=sk.blocks[0];
  {const P=pts(sk,inst),corner=P[0],a=Math.PI/6,want=blk.data.points[0];
   const ok=Math.abs(corner.x-(20+want.x*Math.cos(a)-want.y*Math.sin(a)))<1e-9&&Math.abs(corner.y-(5+want.x*Math.sin(a)+want.y*Math.cos(a)))<1e-9&&sk.constraints.filter(k=>k.type==='block').length===1&&sk.constraints.length===1;
   results.push({name:'put in turned 30°, one rigid relation and no other',ok,constraints:sk.constraints.map(k=>k.type)});}
  {const an=analyzeSketch(sk,ev);results.push({name:'three freedoms left (it moves and turns as one)',ok:an.dof===3,dof:an.dof});}
  {const before=dists(pts(sk,inst));const A={...pts(sk,inst)[0]};const r=solveSketch(sk,ev,{pin:[{id:inst.map[blk.data.points[0].id],x:A.x+3,y:A.y-2}]});
   const after=dists(pts(sk,inst)),moved=Math.hypot(pts(sk,inst)[0].x-A.x-3,pts(sk,inst)[0].y-A.y+2);
   const c=sk.curves.find(x=>x.type==='circle');
   results.push({name:'dragged by a corner: the shape stays (sizes kept)',ok:r.ok&&moved<1e-6&&before.every((d,i)=>Math.abs(d-after[i])<1e-6)&&Math.abs(c.r-1)<1e-9,moved});}
  // (a line from the origin to the instance's first corner, kept through the update)
  const corner=inst.map[blk.data.points[0].id],ln=S.addLine(sk,'O',S.addPoint(sk,0,0));const lc=S.getCurve(sk,ln);S.addRel(sk,'coincident',[lc.p2,corner]);
  solveSketch(sk,ev);
  {const nb=blockDef(16,6,2),n=S.updateBlockInstances(sk,nb),b2=sk.blocks[0],P=pts(sk,b2),c=sk.curves.find(x=>x.type==='circle');
   const d=dists(P),still=sk.constraints.some(k=>k.type==='coincident'&&k.refs.includes(lc.p2)&&k.refs.includes(b2.map[nb.data.points[0].id]));
   const r=solveSketch(sk,ev),end=S.getPoint(sk,lc.p2),A=S.getPoint(sk,b2.map[nb.data.points[0].id]);
   results.push({name:'the block changed (16 × 6, Ø4): the copy follows where it is, the line to its corner kept',ok:n===1&&b2.id===id&&Math.abs(Math.max(...d)-Math.hypot(16,6))<1e-6&&Math.abs(c.r-2)<1e-9&&still&&r.ok&&Math.hypot(end.x-A.x,end.y-A.y)<1e-6,n,still});}
  {S.explodeBlock(sk,id);const types=sk.constraints.map(k=>k.type);
   results.push({name:'exploded: plain geometry with its own relations and dimensions back',ok:!sk.blocks&&!types.includes('block')&&types.filter(t=>t==='horizontal').length===2&&types.filter(t=>t==='dim').length===2,types});}
  {const sk2=S.newSketchData();const p=S.addPoint(sk2,0,0);S.addCircle(sk2,p,3);const b={name:'Dot',data:S.blockData(sk2,[sk2.curves[0].id])};
   const sk3=S.newSketchData();S.insertBlockInstance(sk3,b,5,5);const an=analyzeSketch(sk3,ev);
   results.push({name:'a one-point block (a circle): it moves, its size stays',ok:an.dof===2,dof:an.dof});}
  return {ok:results.every(r=>r.ok),results};
}
