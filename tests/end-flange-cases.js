import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// End Flange: a flat ring on the end of a part, a plate of its own, each against its volume by hand.
// A round pipe Ø304 / Ø300, 200 long (extruded along Z): butt, 40 wide, 6 thick, 8 Ø10 holes: 6 · (π (190² − 150²) − 8 · 25π),
// from z 200 to 206; slipped on (clearance 1): the opening Ø306, 194 to 200 (flush), 196 to 202 set in 2.
// A square duct 404 / 400: butt, 20 holes round it: 6 · (480² − 400² − 20 · 25π), as a Transition's.
// A Transition's square spigot in 2 pieces, bent at its corners (radius 2): both end faces picked, the bends squared
// off: the opening 400 × 400. No end face: refused; a butt flange on a solid end (no opening): refused.
// Several ends in one: both ends of the pipe (z 200 to 206, −6 to 0) and of the square duct; two pipes side by side
// (their ends in one plane: a flange each); a Ø254 pipe beside the Ø304: refused (one size of flange).
const ring=(doc,shape,x=0,ro=152)=>{
  const s=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  if(shape==='round'){S.addCircle(s,S.addPoint(s,x,0),ro);S.addCircle(s,S.addPoint(s,x,0),ro-2);}
  else for(const h of shape==='solid'?[202]:[202,200]){const q=[[-h,-h],[h,-h],[h,h],[-h,h]].map(([x,y])=>S.addPoint(s,x,y));q.forEach((p,i)=>S.addLine(s,p,q[(i+1)%4]));}
  doc.features.push(s,M.createFeature(doc,'extrude',{sketch:s.id,depth:200}));
};
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const close=(x,y,t=1e-6)=>Math.abs(x-y)<=t*Math.max(1,Math.abs(y));
  const vol=async(b)=>(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume;
  // (the flange: the body 6 thick; its span along an axis)
  const span=(B,b,ax)=>{let lo=Infinity,hi=-Infinity;for(let q=b.triStart;q<b.triStart+b.triCount;q++){const v=B.vertices[3*B.triangles[q]+ax];lo=Math.min(lo,v);hi=Math.max(hi,v);}return [lo,hi];};
  const build=async(make,opts)=>{const d=M.newDoc();make(d);const f=M.createFeature(d,'smEndFlange',opts);d.features.push(f);const r=await k.rebuild(d);const fls=(r.body?.bodies||[]).filter(b=>b.sheet?.t===6),fl=fls[0];let vs=[];for(const b of fls)vs.push(await vol(b));return {r,f,fl,fls,vs,v:fl?await vol(fl):0,errors:r.errors.map(e=>e[1]),note:r.notes?.[f.id]};};
  const P=Math.PI,hole=25*P,end=[{p:[151,0,200],n:[0,0,1]}];
  try{
    {
      const b=await build(d=>ring(d,'round'),{faces:end}),want=6*(P*(190**2-150**2)-8*hole),z=b.fl&&span(b.r.body,b.fl,2);
      results.push({name:'Round pipe, butt: 40 wide, 6 thick, 8 Ø10 holes, out past the end',ok:!b.errors.length&&close(b.v,want)&&close(z[0],200,1e-5)&&close(z[1],206,1e-5)&&/Butt · opening Ø300 · 8 bolt holes/.test(b.note)&&!!b.fl.sheet.flatArea,volume:b.v,expected:want,z,note:b.note,errors:b.errors});
      const s=await build(d=>ring(d,'round'),{faces:end,flMount:'socket',flHoleD:0}),want2=6*P*(193**2-153**2),z2=s.fl&&span(s.r.body,s.fl,2);
      results.push({name:'Round pipe, slipped on: opening Ø306, flush with the end',ok:!s.errors.length&&close(s.v,want2)&&close(z2[0],194,1e-5)&&close(z2[1],200,1e-5),volume:s.v,expected:want2,z:z2,errors:s.errors});
      const s2=await build(d=>ring(d,'round'),{faces:end,flMount:'socket',flOffset:2,flHoleD:0}),z3=s2.fl&&span(s2.r.body,s2.fl,2);
      results.push({name:'Slipped on, the end 2 in from the face',ok:!s2.errors.length&&close(z3[0],196,1e-5)&&close(z3[1],202,1e-5),z:z3,errors:s2.errors});
    }
    {
      const b=await build(d=>ring(d,'square'),{faces:[{p:[201,0,200],n:[0,0,1]}]}),want=6*(480**2-400**2-20*hole);
      results.push({name:'Square duct, butt: 20 holes round it',ok:!b.errors.length&&close(b.v,want)&&/opening 400 × 400 · 20 bolt holes/.test(b.note),volume:b.v,expected:want,note:b.note,errors:b.errors});
    }
    {
      // (a Transition square 400 → round 200, a bottom spigot 50 in 2 pieces bent at radius 2: its end faces at y 0)
      const tr=(d)=>{const s=M.createFeature(d,'sketch',{plane:{ref:'front'}});S.addLine(s,S.addPoint(s,0,0),S.addPoint(s,0,300));d.features.push(s,M.createFeature(d,'smTransition',{sketch:s.id,bShape:'square',bSize:400,tShape:'round',tD:200,parts:4,thickness:2,spigotBot:50}));};
      const faces=[{p:[201,0,-100],n:[0,-1,0]},{p:[201,0,100],n:[0,-1,0]}];
      const b=await build(tr,{faces,flHoleD:0}),want=6*(480**2-400**2),y=b.fl&&span(b.r.body,b.fl,1);
      results.push({name:'A spigot in 2 pieces, bent corners: both ends picked, the corners squared off',ok:!b.errors.length&&close(b.v,want)&&/opening 400 × 400/.test(b.note)&&close(y[0],-6,1e-5)&&close(y[1],0,1e-5),volume:b.v,expected:want,y,note:b.note,errors:b.errors});
      const one=await build(tr,{faces:faces.slice(0,1),flHoleD:0});
      results.push({name:'Only one of the pieces picked: refused',ok:one.errors.some(e=>/no opening|one piece/.test(e)),errors:one.errors,note:one.note});
    }
    {
      const none=await build(d=>ring(d,'round'),{faces:[]});
      const solid=await build(d=>ring(d,'solid'),{faces:[{p:[0,0,200],n:[0,0,1]}]});
      const solidS=await build(d=>ring(d,'solid'),{faces:[{p:[0,0,200],n:[0,0,1]}],flMount:'socket',flHoleD:0}),wantS=6*(486**2-406**2);
      results.push({name:'No end face, or a butt flange on a solid end: refused; slipped over a solid end',ok:none.errors.some(e=>/Click the flat end face/.test(e))&&solid.errors.some(e=>/no opening/.test(e))&&!solidS.errors.length&&close(solidS.v,wantS),volume:solidS.v,expected:wantS,errors:[...none.errors,...solid.errors,...solidS.errors]});
    }
    {
      // a rolled sheet metal pipe (a circle Ø300 extruded 100, the material inside it, a 0.5 seam gap): the gap closed,
      // the flange round the whole end, its opening the inside Ø296; with gaps closed up to 0 only: refused
      const rolled=(d)=>{const s=M.createFeature(d,'sketch',{plane:{ref:'front'}});S.addCircle(s,S.addPoint(s,0,0),150);d.features.push(s,M.createFeature(d,'smExtrude',{sketch:s.id,depth:100}));};
      const at=[{p:[0,149,100],n:[0,0,1]}];
      const b=await build(rolled,{faces:at,flHoleD:0}),want=6*P*(188**2-148**2);
      const s=await build(rolled,{faces:at,flHoleD:0,flMount:'socket'}),wantS=6*P*(191**2-151**2);
      const no=await build(rolled,{faces:at,flHoleD:0,flGap:0});
      results.push({name:'A rolled pipe with a seam gap: the gap closed, butt and slipped on; not closed: refused',ok:!b.errors.length&&close(b.v,want)&&/opening Ø296/.test(b.note)&&!s.errors.length&&close(s.v,wantS)&&no.errors.some(e=>/no opening/.test(e)),volume:[b.v,s.v],expected:[want,wantS],note:[b.note,s.note],errors:[...b.errors,...s.errors,...no.errors]});
    }
    {
      // several ends in one End Flange
      const both=[{p:[151,0,200],n:[0,0,1]},{p:[151,0,0],n:[0,0,-1]}],want=6*(P*(190**2-150**2)-8*hole);
      const b=await build(d=>ring(d,'round'),{faces:both}),z=b.fls.map(x=>span(b.r.body,x,2)).sort((p,q)=>p[0]-q[0]);
      results.push({name:'Both ends of a pipe: a flange on each, out past each end',ok:!b.errors.length&&b.fls.length===2&&b.vs.every(v=>close(v,want))&&close(z[0][0],-6,1e-5)&&close(z[0][1],0,1e-5)&&close(z[1][0],200,1e-5)&&close(z[1][1],206,1e-5)&&/^2 flanges · Butt · opening Ø300 · 8 bolt holes each/.test(b.note),volume:b.vs,expected:want,z,note:b.note,errors:b.errors});
      const sq=await build(d=>ring(d,'square'),{faces:[{p:[201,0,200],n:[0,0,1]},{p:[201,0,0],n:[0,0,-1]}]}),wantS=6*(480**2-400**2-20*hole);
      results.push({name:'Both ends of a square duct',ok:!sq.errors.length&&sq.fls.length===2&&sq.vs.every(v=>close(v,wantS)),volume:sq.vs,expected:wantS,note:sq.note,errors:sq.errors});
      const two=(d)=>{ring(d,'round');ring(d,'round',500);};
      const t=await build(two,{faces:[{p:[151,0,200],n:[0,0,1]},{p:[651,0,200],n:[0,0,1]},{p:[651,0,0],n:[0,0,-1]}]});
      results.push({name:'Two pipes, ends in one plane and another end: three flanges',ok:!t.errors.length&&t.fls.length===3&&t.vs.every(v=>close(v,want))&&/^3 flanges/.test(t.note),volume:t.vs,expected:want,note:t.note,errors:t.errors});
      const mix=await build(d=>{ring(d,'round');ring(d,'round',500,127);},{faces:[{p:[151,0,200],n:[0,0,1]},{p:[626,0,200],n:[0,0,1]}]});
      results.push({name:'A Ø254 pipe beside the Ø304: refused (one size)',ok:mix.errors.some(e=>/End 2 is Ø254 outside, not Ø304/.test(e)),errors:mix.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
