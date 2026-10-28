import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Routing: a DN50 pipe (60.3 × 3.91) along a 3D route of three lines (500 along X, 400 up Y, 300 along Z) with two
// 90° corners; long radius elbows (R 76.2) or bends; flanges at the ends. Exact volumes: each straight a tube of the
// annulus' area, each elbow the annulus swept a quarter turn at R (Pappus). A cable along a spline route.
const ro=60.3/2,ri=ro-3.91,A=Math.PI*(ro*ro-ri*ri),R=76.2,QUARTER=A*R*Math.PI/2;
const STRAIGHT=[500-R,400-2*R,300-R],PIPE=STRAIGHT.reduce((a,b)=>a+b,0)*A+2*QUARTER;
export function fixture(type,options={},pts=[[0,0,0],[500,0,0],[500,400,0],[500,400,300]],kind='lines'){
  const doc=M.newDoc(),g=M.createFeature(doc,'sketch3d',{segs:null,pts:pts.map(([x,y,z])=>({x,y,z})),kind,radius:0});
  const feature=M.createFeature(doc,type,{path:g.id,...options});doc.features.push(g,feature);
  return {doc,feature};
}
// (a route drawn as sketch lines on Top: a run along X with a branch at x = 500, or one line)
export function sketchFixture(type,options={},lines=[[[0,0],[500,0]],[[500,0],[1000,0]],[[500,0],[500,400]]]){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const ids=new Map(),pt=(q)=>{const k=q.join();if(!ids.has(k))ids.set(k,S.addPoint(sk,...q));return ids.get(k);};
  for(const [a,b] of lines)S.addLine(sk,pt(a),pt(b));
  const feature=M.createFeature(doc,type,{path:sk.id,...options});doc.features.push(sk,feature);
  return {doc,feature};
}
const TEE=Math.PI*(ro*ro-ri*ri)*3*64-8*(ro**3-ri**3)/3;
const r2o=33.4/2,r2i=r2o-3.38,RED=Math.PI*76/3*(ro*ro+ro*r2o+r2o*r2o)-Math.PI*76/3*(ri*ri+ri*r2i+r2i*r2i);
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const total=async(r)=>{let v=0;for(const b of r.body.bodies)v+=(await measure(b.id)).volume;return v;};
  const FL=Math.PI*(82.5*82.5-ro*ro)*18;
  const cases=[
    {name:'elbows: three straight pipes and two elbows, each a body',type:'pipeRoute',options:{size:'50'},bodies:5,volume:PIPE,note:/3 straight pipes .* 2 elbows/},
    {name:'bends: one bent tube',type:'pipeRoute',options:{size:'50',corner:'bend',radius:R},bodies:1,volume:PIPE,note:/bent tube, 2 bends/},
    {name:'flanges at both ends',type:'pipeRoute',options:{size:'50',flanges:true,flangeD:165,flangeT:18},bodies:7,volume:PIPE+2*FL,note:/2 flanges/},
    {name:'a custom tube with a 45° corner',type:'pipeRoute',options:{size:'custom',od:20,wall:2,radius:40},pts:[[0,0,0],[100,0,0],[200,100,0]],bodies:3,volume:Math.PI*(100-64)*(100-40*Math.tan(Math.PI/8)+Math.hypot(100,100)-40*Math.tan(Math.PI/8))+Math.PI*(100-64)*40*Math.PI/4},
    {name:'a line too short for its elbows refused',type:'pipeRoute',options:{size:'50'},pts:[[0,0,0],[500,0,0],[500,100,0],[500,100,300]],reject:/too short/},
    {name:'a branch refused',type:'pipeRoute',options:{size:'50'},pts:[[0,0,0],[500,0,0],[0,0,0],[0,400,0]],reject:/branch|back on itself|end to end/},
    {name:'a tee where a line branches off a straight run',sketch:true,type:'pipeRoute',options:{size:'50'},bodies:4,volume:A*(2*(500-64)+(400-64))+TEE,note:/3 straight pipes .* 1 tee/},
    {name:'a reducer to DN25 at the end, a flange at the start',sketch:true,lines:[[[0,0],[500,0]]],type:'pipeRoute',options:{size:'50',reduceAt:'end',reduceSize:'25',flanges:true,flangeD:165,flangeT:18},bodies:3,volume:A*(500-76)+RED+FL,note:/1 reducer, 1 flange/},
    {name:'a branch off a corner refused',sketch:true,lines:[[[0,0],[500,0]],[[500,0],[500,400]],[[500,0],[800,300]]],type:'pipeRoute',options:{size:'50'},reject:/square to it/},
    {name:'a cable Ø6 along a spline',type:'cable',options:{diameter:6,slack:10},pts:[[0,0,0],[100,50,0],[200,0,80],[300,40,100]],kind:'spline',bodies:1,cable:6,note:/cut length/},
    {name:'a bundle of 7 wires Ø1.6',type:'cable',options:{sizeBy:'wires',wires:7,wireD:1.6},pts:[[0,0,0],[100,50,0],[200,0,80]],kind:'spline',bodies:1,cable:1.15*1.6*Math.sqrt(7)},
  ];
  try{
    for(const c of cases){
      const d=c.sketch?sketchFixture(c.type,c.options,c.lines):fixture(c.type,c.options,c.pts,c.kind);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      if(r.errors.length||!r.body?.bodies?.length){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const note=r.notes?.[d.feature.id]||'',v=await total(r);
      let want=c.volume;
      if(c.cable){const L=+/route ([\d.]+) mm/.exec(note)?.[1];want=Math.PI*(c.cable/2)**2*L;}
      const ok=r.body.bodies.length===c.bodies&&Math.abs(v-want)<(c.cable?2e-4:1e-6)*want&&(!c.note||c.note.test(note));
      results.push({name:c.name,ok,bodies:r.body.bodies.length,volume:v,expected:want,note});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
