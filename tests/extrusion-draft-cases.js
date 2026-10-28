import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Extrude with draft: the walls tilted about the profile's plane (kernel.worker.js draftPrism), checked against the
// exact volumes of the frustums they make. A 20 mm square (and a 2 mm circle, a square with a 3 mm hole) on Front,
// 10 mm deep.
const T=(deg)=>Math.tan(deg*Math.PI/180);
const squareFrustum=(a,b,h)=>h/3*(a*a+a*b+b*b);
const coneFrustum=(r0,r1,h)=>Math.PI*h/3*(r0*r0+r0*r1+r1*r1);
function square(sk,half){const p=[[-half,-half],[half,-half],[half,half],[-half,half]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
export function fixture(options={},profile='square'){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  if(profile==='circle')S.addCircle(sk,'O',2);else{square(sk,10);if(profile==='holed')S.addCircle(sk,'O',3);}
  doc.features.push(sk);
  const feature=M.createFeature(doc,'extrude',{sketch:sk.id,depth:10,...options});doc.features.push(feature);return {doc,sk,feature};
}
// a 20 × 20 × 20 block on Front, for the cuts
function block(d){const sk=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}});square(sk,10);const solid=M.createFeature(d.doc,'extrude',{sketch:sk.id,depth:20});d.doc.features.unshift(sk,solid);}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  try{
    const cases=[
      {name:'no draft (as before)',options:{draft:0},volume:4000},
      {name:'inward',options:{draft:5},volume:squareFrustum(20,20-20*T(5),10),probes:[[0,0,10],[10-10*T(5),0,10],[10,0,0]]},
      {name:'outward',options:{draft:5,draftOutward:true},volume:squareFrustum(20,20+20*T(5),10),probes:[[10+10*T(5),0,10],[10,0,0]]},
      {name:'angle as an expression',options:{draft:'2+3'},volume:squareFrustum(20,20-20*T(5),10)},
      {name:'reversed',options:{draft:5,reverse:true},volume:squareFrustum(20,20-20*T(5),10),probes:[[10-10*T(5),0,-10],[10,0,0]]},
      {name:'from an offset start',options:{draft:5,startFrom:'offset',startOffset:5},volume:squareFrustum(20,20-20*T(5),10),probes:[[10,0,5],[10-10*T(5),0,15]]},
      {name:'circle',profile:'circle',options:{draft:3},volume:coneFrustum(2,2-10*T(3),10),probes:[[2-10*T(3),0,10]]},
      {name:'hole widens as the walls narrow',profile:'holed',options:{draft:5},volume:squareFrustum(20,20-20*T(5),10)-coneFrustum(3,3+10*T(5),10),probes:[[3+10*T(5),0,10],[3,0,0]]},
      {name:'cut narrowing into the block',profile:'circle',options:{op:'cut',draft:5},edit:block,volume:8000-coneFrustum(2,2-10*T(5),10)},
      {name:'cut widening into the block',profile:'circle',options:{op:'cut',draft:5,draftOutward:true},edit:block,volume:8000-coneFrustum(2,2+10*T(5),10)},
      {name:'symmetric: each half drafted away from the profile',options:{draft:5,end:'midplane'},volume:2*squareFrustum(20,20-10*T(5),5),probes:[[10-5*T(5),0,5],[10-5*T(5),0,-5],[10,0,0]]},
      {name:'two sides',options:{draft:5,end:'twoSides',depth2:3},volume:squareFrustum(20,20-20*T(5),10)+squareFrustum(20,20-6*T(5),3),probes:[[10-10*T(5),0,10],[10-3*T(5),0,-3]]},
      {name:'89 degrees rejected',options:{draft:89},reject:true},
      {name:'walls that meet rejected',profile:'circle',options:{draft:30},reject:true},
    ];
    for(const c of cases){const d=fixture(c.options,c.profile);c.edit?.(d);const r=await k.rebuild(d.doc);if(c.reject){results.push({name:c.name,ok:r.errors.some(([id])=>id===d.feature.id),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const measurement=(await k.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];let ok=Math.abs(measurement.volume-c.volume)<1e-4*Math.max(1,c.volume/1000);
      for(const p of c.probes||[]){const m=await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id:body.id}]});ok&&=Math.abs(m.distance)<1e-5;}
      results.push({name:c.name,ok,volume:measurement.volume,expected:c.volume});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
