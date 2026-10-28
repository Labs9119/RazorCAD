import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {fixture} from '/tests/extrusion-sides-cases.js';
// A flat model face as an Extrude / Revolve profile ({ kind: 'modelFace', p, n } in profiles), and the second side's
// own draft (draft2Own, draft2, draftOutward2: a second side, or Two sides' second depth). A 20 × 20 × 20 block on
// Front (z 0 to 20) whose top face is the profile; exact volumes and probes where the corners must be.
const T=(deg)=>Math.tan(deg*Math.PI/180);
// a frustum of square ends a and b, h high
const frustum=(a,b,h)=>h/3*(a*a+a*b+b*b);
function square(sk,half,x=0){const p=[[-half,-half],[half,-half],[half,half],[-half,half]].map(q=>S.addPoint(sk,q[0]+x,q[1]));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
// the block (centred on x), with a hole of radius `hole` through it; then the feature
export function base(type,options={},{x=0,hole=0}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});square(sk,10,x);doc.features.push(sk);
  const block=M.createFeature(doc,'extrude',{sketch:sk.id,depth:20});doc.features.push(block);
  if(hole){const h=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addCircle(h,'O',hole);doc.features.push(h,M.createFeature(doc,'extrude',{sketch:h.id,op:'cut',end:'through'}));}
  const feature=M.createFeature(doc,type,{profiles:[{kind:'modelFace',p:[x,5,20],n:[0,0,1]}],sketch:null,...options});doc.features.push(feature);
  return {doc,feature};
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-5;
  const check=async(name,d,{volume,bodies=1,probes=[],reject=false})=>{
    const r=await k.rebuild(d.doc);
    if(reject){results.push({name,ok:r.errors.some(([e])=>e===d.feature.id),errors:r.errors});return;}
    const list=r.body?.bodies||[];
    if(r.errors.length||list.length!==bodies){results.push({name,ok:false,errors:r.errors,bodies:list.length});return;}
    const body=list.at(-1),v=(await measure(body.id)).volume,missed=[];
    let ok=Math.abs(v-volume)<1e-4*Math.max(1,volume/1000);
    for(const p of probes)if(!(await on(p,body.id))){ok=false;missed.push(p);}
    results.push({name,ok,volume:v,expected:volume,...(missed.length?{missed}:{})});
  };
  try{
    // (the second side's own draft: the 20 mm square on a plane 10 mm in front of Front)
    const a5=20-10*T(5);
    await check('second side undrafted, first drafted',fixture({side2:true,depth2:3,draft:5,draft2Own:true,draft2:0}),{volume:frustum(20,a5,5)+400*3,probes:[[10-5*T(5),0,15],[10,10,7]]});
    await check('second side drafted outward on its own',fixture({side2:true,depth2:3,draft:5,draft2Own:true,draft2:10,draftOutward2:true}),{volume:frustum(20,a5,5)+frustum(20,20+6*T(10),3),probes:[[10-5*T(5),0,15],[10+3*T(10),0,7]]});
    await check('second side to a plane with its own draft',(()=>{const d=fixture({side2:true,end2:'upToSurface',draft2Own:true,draft2:4});d.feature.toPlane2='front';return d;})(),{volume:400*5+frustum(20,20-20*T(4),10),probes:[[10,10,15],[10-10*T(4),0,0]]});
    await check('two sides, the second depth drafted on its own',fixture({end:'twoSides',depth2:3,draft:5,draft2Own:true,draft2:2}),{volume:frustum(20,a5,5)+frustum(20,20-6*T(2),3),probes:[[10-5*T(5),0,15],[10-3*T(2),0,7]]});
    await check('two sides reversed, the drafts go with their depths',fixture({end:'twoSides',depth2:3,reverse:true,draft:5,draft2Own:true,draft2:2}),{volume:frustum(20,a5,5)+frustum(20,20-6*T(2),3),probes:[[10-5*T(5),0,5],[10-3*T(2),0,13]]});
    await check('two sides, one draft for both (as before)',fixture({end:'twoSides',depth2:3,draft:5}),{volume:frustum(20,a5,5)+frustum(20,20-6*T(5),3)});
    // (a model face as the profile)
    await check('face extruded out of its body',base('extrude',{depth:5}),{volume:8000+2000,probes:[[10,10,25],[-10,-10,25]]});
    await check('face extruded as a new body',base('extrude',{depth:5,merge:false}),{volume:2000,bodies:2,probes:[[10,10,25]]});
    await check('face cut into its body',base('extrude',{depth:5,op:'cut',reverse:true}),{volume:6000,probes:[[10,10,15]]});
    await check('face with a hole keeps the hole',base('extrude',{depth:5},{hole:3}),{volume:(400-9*Math.PI)*25,probes:[[3,0,23],[10,10,25]]});
    await check('face drafted',base('extrude',{depth:5,draft:5}),{volume:8000+frustum(20,a5,5),probes:[[10-5*T(5),0,25]]});
    await check('face up to a plane',(()=>{const d=base('extrude',{end:'upToSurface'});const p=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:32});d.doc.features.splice(2,0,p);d.feature.toPlane=p.id;return d;})(),{volume:8000+400*12,probes:[[10,10,32]]});
    await check('face as a thin profile rejected',base('extrude',{depth:5,thin:true}),{reject:true});
    await check('face that is not there rejected',(()=>{const d=base('extrude',{depth:5});d.feature.profiles=[{kind:'modelFace',p:[0,5,60],n:[0,1,0]}];return d;})(),{reject:true});
    // (revolved about the block's top edge at x = 10: a whole turn makes a cylinder of radius 20 round it, which
    // covers a quarter of the block's section)
    const edge={p:[10,0,20]};
    await check('face revolved about a model edge',base('revolve',{axis:'edge',axisEdge:edge,extent:'full'},{x:20}),{volume:20*(400*Math.PI+400-100*Math.PI),probes:[[10,0,40],[30,10,0]]});
    await check('face revolved a quarter turn out of its body',base('revolve',{axis:'edge',axisEdge:{p:[10,0,20]},extent:'angle',angle:90},{x:20}),{volume:8000+2000*Math.PI,probes:[[10,10,40]]});
    await check('face revolved about a sketch axis rejected',base('revolve',{axis:'v',extent:'full'},{x:20}),{reject:true});
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
