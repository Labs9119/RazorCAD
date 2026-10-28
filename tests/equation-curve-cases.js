import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {analyzeSketch} from '/js/solver.js';
import {KernelClient} from '/js/kernelclient.js';
// Equation driven curves: y = x² through its points; a parametric circle x = r·cos(t), y = r·sin(t) (t in degrees,
// r a part variable) closed by itself and extruded 10 — its area follows r; an equation that fails is refused.
export function fixture(r='10'){
  const doc=M.newDoc();doc.equations=[{name:'r',expr:r}];
  const sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  S.addEquationCurve(sk,{kind:'parametric',x:'r*cos(t)',y:'r*sin(t)',t1:'0',t2:'360',n:'72'},{r:+r});
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}));
  return {doc,sk};
}
export async function run({threads=1}={}){
  const results=[],ev=(x)=>+x;
  {const P=S.equationPoints({kind:'explicit',y:'x^2',t1:0,t2:2,n:4});results.push({name:'y = x² from 0 to 2 in 4 pieces',ok:JSON.stringify(P)===JSON.stringify([[0,0],[0.5,0.25],[1,1],[1.5,2.25],[2,4]]),P});}
  {const sk=S.newSketchData();S.addEquationCurve(sk,{kind:'explicit',y:'3*x+1',t1:0,t2:10,n:5});const an=analyzeSketch(sk,ev);
   results.push({name:'an equation curve is fully defined, its ends where the equation puts them',ok:an.dof===0&&sk.curves[0].pts.length===6&&S.getPoint(sk,sk.curves[0].p2).y===31,dof:an.dof});}
  {const {sk}=fixture();results.push({name:'a parametric loop is closed',ok:sk.curves[0].closed&&sk.curves[0].pts.length===72});}
  {let msg='';try{S.equationPoints({kind:'explicit',y:'sqrt(x)',t1:-1,t2:1,n:4});}catch(e){msg=e.message;}results.push({name:'an equation with no value somewhere refused',ok:/no number at x = -1/.test(msg),msg});}
  const k=new KernelClient({threads});await k.ready;
  try{
    for(const r of ['10','15']){
      const d=fixture('10');d.doc.equations[0].expr=r;
      const res=await k.rebuild(d.doc),b=res.body?.bodies?.at(-1);
      if(res.errors.length||!b){results.push({name:`r = ${r}`,ok:false,errors:res.errors});continue;}
      const v=(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume,want=Math.PI*r*r*10;
      results.push({name:`the circle with r = ${r} (the variable) extruded`,ok:Math.abs(v-want)<1e-5*want,volume:v,expected:want});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
