import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Plastic part features: Mounting Boss (draft, hole, ribs), Snap Hook, Lip / Groove on a shelled part's rim and Vent.
// A 60 × 40 plate 5 thick on Top (y 0 to 5), or a 20 mm box (y 0 to 20) shelled 2 thick, open at the top; exact volumes.
function rect(sk,hx,hz){const p=[[-hx,-hz],[hx,-hz],[hx,hz],[-hx,hz]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));}
export function fixture(type,options={},{box=false}={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  if(box)rect(sk,10,10);else rect(sk,30,20);
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:box?20:5}));
  if(box)doc.features.push(M.createFeature(doc,'shell',{faces:[{p:[0,20,0],n:[0,1,0]}],thickness:2}));
  const feature=M.createFeature(doc,type,options);doc.features.push(feature);
  return {doc,feature};
}
const TOPP={p:[0,5,0],n:[0,1,0]},PLATE=60*40*5,BOX=8000-16*16*18;
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const on=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance<1e-6;
  const T=(d)=>Math.tan(d*Math.PI/180),frustum=(a,b,h)=>Math.PI*h/3*(a*a+a*b+b*b);
  // (a rib's sliver between the boss's round wall and its flat side, half width w/2, radius R, height h)
  const sliver=(R,w,h)=>{let v=0;const n=4000,d=w/n;for(let i=0;i<n;i++){const y=-w/2+(i+.5)*d;v+=(R-Math.sqrt(R*R-y*y))*d;}return v*h;};
  const hh=1/T(30);
  const cases=[
    {name:'a boss with its hole',type:'boss',options:{faces:[TOPP],outerD:8,height:10,holeD:3,draft:0},volume:PLATE+Math.PI*(16-2.25)*10,probes:[[4,10,0],[1.5,12,0]]},
    {name:'a boss drafted 2°, its hole 6 deep',type:'boss',options:{faces:[TOPP],outerD:8,height:10,holeD:3,holeDepth:6,draft:2},volume:PLATE+frustum(4,4-10*T(2),10)-Math.PI*2.25*6,probes:[[4-10*T(2),15,0],[1.5,10,0]]},
    {name:'a boss with four ribs',type:'boss',options:{faces:[TOPP],outerD:8,height:10,holeD:0,draft:0,ribs:4,ribWidth:1,ribLength:4,ribHeight:6},volume:PLATE+Math.PI*16*10+4*(1*4*6/2+sliver(4,1,6)),rel:1e-6,probes:[[8,5,0],[4,11,0]]},
    {name:'a boss whose draft leaves no wall rejected',type:'boss',options:{faces:[TOPP],outerD:8,height:10,holeD:6,draft:10},reject:/no wall/},
    {name:'a snap hook',type:'snapHook',options:{faces:[TOPP],length:12,thickness:1.5,width:6,overhang:1,insertAngle:30,retainAngle:90},volume:PLATE+6*(1.5*12+1*hh/2),probes:[[1.75,17-hh,0],[0.75,17,3]]},
    {name:'a snap hook with a sloped catch',type:'snapHook',options:{faces:[TOPP],length:12,thickness:1.5,width:6,overhang:1,insertAngle:30,retainAngle:45},volume:PLATE+6*(1.5*12+1*(hh+1)/2),probes:[[1.75,17-hh,0],[0.75,17-hh-1,0]]},
    {name:'a snap hook turned 90°',type:'snapHook',options:{faces:[TOPP],length:12,thickness:1.5,width:6,overhang:1,angle:90},volume:PLATE+6*(1.5*12+1*hh/2),probes:[[0,17-hh,-1.75]]},
    {name:'a lip along the inner edge of a rim',type:'lipGroove',box:true,options:{face:{p:[0,20,9],n:[0,1,0]},kind:'lip',side:'inner',width:1,height:1},volume:BOX+(18*18-16*16)*1,probes:[[8.5,21,0]]},
    {name:'a groove along the outer edge of a rim',type:'lipGroove',box:true,options:{face:{p:[0,20,9],n:[0,1,0]},kind:'groove',side:'outer',width:0.5,height:1},volume:BOX-(20*20-19*19)*1,probes:[[9.5,19,0]]},
    {name:'a lip wider than the rim rejected',type:'lipGroove',box:true,options:{face:{p:[0,20,9],n:[0,1,0]},kind:'lip',side:'inner',width:3,height:1},reject:/wider than the rim|runs off/},
    {name:'a vent through a plate',type:'vent',edit:(d)=>{const pl=M.createFeature(d.doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:5}),s=M.createFeature(d.doc,'sketch',{plane:{ref:pl.id}});rect(s,10,5);d.doc.features.splice(-1,0,pl,s);d.feature.sketch=s.id;},options:{slotWidth:2,barWidth:2,margin:1,end:'through'},volume:PLATE-18*(2+1+1)*5},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.type,c.options,{box:c.box});c.edit?.(d);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body||r.body.bodies.length!==1){results.push({name:c.name,ok:false,errors:r.errors,bodies:r.body?.bodies?.length});continue;}
      const m=await measure(body.id);let ok=Math.abs(m.volume-c.volume)<(c.rel||1e-9)*c.volume;const missed=[];
      for(const p of c.probes||[])if(!(await on(p,body.id))){ok=false;missed.push(p);}
      results.push({name:c.name,ok,volume:m.volume,expected:c.volume,...(missed.length?{missed}:{})});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
