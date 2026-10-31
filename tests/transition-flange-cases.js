import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Transition flanges: flat rings at the ends, bodies of their own, inside the axis line's length (their outer faces
// at its ends), with bolt holes. Each flange body against its volume by hand:
// round 300 → round 200, 300 high, inside sizes: the bottom flange 40 wide, 6 thick, 8 Ø10 holes:
// 6 · (π (190² − 150²) − 8 · 25π). Square 400 → round 200, both flanged: the square one (440 a side at its bolt line:
// 5 holes a side at a pitch of at most 100, 20 in all) 6 · (480² − 400² − 20 · 25π), the round one
// 6 · (π (140² − 100²) − 8 · 25π). Outside sizes, t 2: the round opening less the thickness across the wall's slope.
// A bolt circle set: Ø400 on the 300 end. Holes as wide as the flange: refused. Spigots: straight lengths of the
// ends' shapes from the flanges' inner faces, the taper what is left; slipped-on flanges: the opening the outside of
// the part and the clearance, the part through it to the offset from its face; too long for the line: refused.
const axis=(doc,h)=>{const s=M.createFeature(doc,'sketch',{plane:{ref:'front'}});const a=S.addPoint(s,0,0),b=S.addPoint(s,0,h);S.addLine(s,a,b);doc.features.push(s);return s;};
export function transition(doc,opts={}){
  const s=axis(doc,300);
  const f=M.createFeature(doc,'smTransition',{sketch:s.id,bShape:'round',bD:300,tShape:'round',tD:200,parts:2,thickness:2,...opts});
  doc.features.push(f);return f;
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vols=async(r)=>(await Promise.all((r.body?.bodies||[]).map(async b=>(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume))).reduce((x,y)=>x+y,0);
  const close=(x,y,t=1e-6)=>Math.abs(x-y)<=t*Math.max(1,Math.abs(y));
  const build=async(opts)=>{const d=M.newDoc();const f=transition(d,opts);const r=await k.rebuild(d);return {r,f,v:await vols(r),n:r.body?.bodies?.length||0,errors:r.errors.map(e=>e[1]),note:r.notes?.[f.id]};};
  // (the flange bodies' volume: the plates 6 thick; each body's span along the axis (Y))
  const flVol=async(r)=>{let v=0;for(const b of (r.body?.bodies||[]).filter(b=>b.sheet?.t===6))v+=(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume;return v;};
  const spans=(r)=>{const B=r.body;return (B?.bodies||[]).map(b=>{let lo=Infinity,hi=-Infinity;for(let q=b.triStart;q<b.triStart+b.triCount;q++){const y=B.vertices[3*B.triangles[q]+1];lo=Math.min(lo,y);hi=Math.max(hi,y);}return {lo,hi,t:b.sheet?.t};});};
  const P=Math.PI,hole=25*P;
  try{
    {
      const plain=await build({}),fl=await build({flangeBot:true});
      const want=6*(P*(190**2-150**2)-8*hole),flv=await flVol(fl.r);
      results.push({name:'Round end: a flange 40 wide, 6 thick, 8 Ø10 holes, a body of its own',ok:!plain.errors.length&&!fl.errors.length&&close(flv,want)&&fl.n===plain.n+1&&/1 flange, 8 bolt holes/.test(fl.note),flange:flv,expected:want,bodies:[plain.n,fl.n],note:fl.note,errors:[...plain.errors,...fl.errors]});
      const pcd=await build({flangeBot:true,flW:60,flPCD:400});
      const want2=6*(P*(210**2-150**2)-8*hole);
      const pv=await flVol(pcd.r);
      results.push({name:'A bolt circle set (Ø400 on a flange 60 wide)',ok:!pcd.errors.length&&close(pv,want2),flange:pv,expected:want2,errors:pcd.errors});
      const off=await build({flangeBot:true,flPCD:390});
      results.push({name:'A bolt circle that puts the holes off the flange: refused',ok:off.errors.some(e=>/puts the holes off the flange/.test(e)),errors:off.errors});
      const wide=await build({flangeBot:true,flHoleD:40});
      results.push({name:'Holes as wide as the flange: refused',ok:wide.errors.some(e=>/as wide as the flange/.test(e)),errors:wide.errors});
    }
    {
      const opts={bShape:'square',bSize:400,tShape:'round',tD:200,parts:4};
      const plain=await build(opts),fl=await build({...opts,flangeBot:true,flangeTop:true});
      const want=6*(480**2-400**2-20*hole)+6*(P*(140**2-100**2)-8*hole);
      // (the flanges, the bodies 6 thick: from y 0 to 6 and from 294 to 300, inside the line's length)
      const B=fl.r.body,ys=(b)=>{let lo=Infinity,hi=-Infinity;for(let q=b.triStart;q<b.triStart+b.triCount;q++){const y=B.vertices[3*B.triangles[q]+1];lo=Math.min(lo,y);hi=Math.max(hi,y);}return [lo,hi];};
      const at=(B?.bodies||[]).map(ys).filter(([lo,hi])=>close(hi-lo,6,1e-5)).sort((x,y)=>x[0]-y[0]),placed=at.length===2&&close(at[0][0],0,1e-5)&&close(at[0][1],6,1e-5)&&close(at[1][0],294,1e-5)&&close(at[1][1],300,1e-5);
      // (each a flat sheet metal plate: its flat pattern the ring, the opening and the holes cut out of it)
      const sq=(B?.bodies||[]).filter(b=>b.sheet?.t===6).map(b=>b.sheet).sort((x,y)=>y.flatArea-x.flatArea)[0],flat=!!sq&&close(sq.flatArea,480**2-400**2-20*hole,1e-6);
      results.push({name:'Square to round, both ends flanged: 20 holes round the square one, 8 on the round one, inside the length of the line; flat patterns',flat:sq&&{area:sq.flatArea,pierces:sq.pierces},ok:!plain.errors.length&&!fl.errors.length&&close(await flVol(fl.r),want)&&fl.n===plain.n+2&&/2 flanges, 28 bolt holes/.test(fl.note)&&placed&&flat,expected:want,y:at,note:fl.note,errors:[...plain.errors,...fl.errors]});
    }
    {
      const plain=await build({dims:'outside'}),fl=await build({dims:'outside',flangeBot:true,flHoleD:0});
      const slope=Math.hypot(294,50)/294,ri=150-2*slope,want=6*P*((ri+40)**2-ri**2),ov=await flVol(fl.r);
      results.push({name:'Outside sizes: the opening less the thickness across the wall\'s slope; no holes',ok:!fl.errors.length&&close(ov,want),flange:ov,expected:want,errors:fl.errors});
    }
    {
      // spigots: 50 at the bottom, 30 at the top, both ends flanged (butt): flanges 0–6 and 294–300, the bottom
      // spigot 6–56, the top's 264–294 (round: one part each unless set), the taper between; nothing past the line
      const sp=await build({flangeBot:true,flangeTop:true,spigotBot:50,spigotTop:30,flHoleD:0});
      const S=spans(sp.r),has=(lo,hi,pred=()=>true)=>S.filter(x=>pred(x)&&close(x.lo,lo,1e-4)&&close(x.hi,hi,1e-4)).length;
      const lo=Math.min(...S.map(x=>x.lo)),hi=Math.max(...S.map(x=>x.hi));
      results.push({name:'Spigots 50 and 30 between the flanges and the taper; the whole part as long as the line',ok:!sp.errors.length&&has(0,6)===1&&has(294,300)===1&&has(6,56,x=>x.t===2)===1&&has(264,294,x=>x.t===2)===1&&close(lo,0,1e-5)&&close(hi,300,1e-5)&&/taper 208 mm/.test(sp.note)&&/2 spigot parts/.test(sp.note),spans:S,note:sp.note,errors:sp.errors});
      // slipped over the end, clearance 1: the opening Ø(300 + 2·2 + 2·1) = Ø306; the part's straight end through it
      // from the flange's face (0–6), the taper from 6
      const so=await build({flangeBot:true,flMount:'socket',flHoleD:0}),sv=await flVol(so.r),want=6*P*((153+40)**2-153**2),S2=spans(so.r);
      results.push({name:'Slipped-on flange: opening the outside of the part and 1 mm all round; the end through it, flush',ok:!so.errors.length&&close(sv,want)&&S2.filter(x=>x.t===2&&close(x.lo,0,1e-4)&&close(x.hi,6,1e-4)).length===1,flange:sv,expected:want,spans:S2,errors:so.errors});
      // (the end 2 in from the flange's face, a clearance of 0.5)
      const so2=await build({flangeBot:true,flMount:'socket',flOffset:2,flClear:0.5,flHoleD:0}),sv2=await flVol(so2.r),want2=6*P*((152.5+40)**2-152.5**2),S3=spans(so2.r);
      results.push({name:'Slipped-on flange, the end 2 in from its face, clearance 0.5',ok:!so2.errors.length&&close(sv2,want2)&&S3.filter(x=>x.t===2&&close(x.lo,2,1e-4)&&close(x.hi,6,1e-4)).length===1,flange:sv2,expected:want2,spans:S3,errors:so2.errors});
      // a round spigot rolled true round (not facets): square 400 → round 200, the top spigot 40 long in 4 parts, its
      // volume π (102² − 100²) · 40 exactly, each part a quarter
      const rs=await build({bShape:'square',bSize:400,tShape:'round',tD:200,parts:4,spigotTop:40,spPartsTop:4});
      const S4=spans(rs.r),top=(rs.r.body?.bodies||[]).filter((b,i)=>close(S4[i].lo,260,1e-4)&&close(S4[i].hi,300,1e-4));
      let rv=0;for(const b of top)rv+=(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume;
      const wantR=P*(102**2-100**2)*40;
      results.push({name:'A round spigot rolled true round: 4 parts, the volume of the ring exactly',ok:!rs.errors.length&&top.length===4&&close(rv,wantR,1e-6),volume:rv,expected:wantR,parts:top.length,errors:rs.errors});
      // a square spigot bent at its corners, inside radius the thickness (2) unless set: 2 parts unless set; its
      // section the outer square (404, corners R4) less the inner (400, corners R2); 1 part (a small gap at the seam);
      // 3 parts for a square: refused
      const bodyVols=async(r,pred)=>{const S=spans(r);let v=0,n=0;for(const [i,b] of (r.body?.bodies||[]).entries())if(pred(S[i])){v+=(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume;n++;}return {v,n};};
      const sqo={bShape:'square',bSize:400,tShape:'round',tD:200,parts:4,spigotBot:50};
      const ss=await build(sqo),sv3=await bodyVols(ss.r,x=>close(x.lo,0,1e-4)&&close(x.hi,50,1e-4)),wantS=(404**2-400**2-(4-P)*(16-4))*50;
      results.push({name:'A square spigot bent at its corners (radius the thickness), in 2 parts',ok:!ss.errors.length&&sv3.n===2&&close(sv3.v,wantS,1e-6),volume:sv3.v,expected:wantS,parts:sv3.n,errors:ss.errors});
      const sr=await build({...sqo,spigotR:10,spPartsBot:4}),sv4=await bodyVols(sr.r,x=>close(x.lo,0,1e-4)&&close(x.hi,50,1e-4)),wantS4=(404**2-400**2-(4-P)*(12**2-10**2))*50;
      results.push({name:'A square spigot, bend radius 10, in 4 parts',ok:!sr.errors.length&&sv4.n===4&&close(sv4.v,wantS4,1e-6),volume:sv4.v,expected:wantS4,parts:sv4.n,errors:sr.errors});
      const s1=await build({...sqo,spPartsBot:1}),sv5=await bodyVols(s1.r,x=>close(x.lo,0,1e-4)&&close(x.hi,50,1e-4)),s3=await build({...sqo,spPartsBot:3});
      results.push({name:'A square spigot in one part; in 3: refused',ok:!s1.errors.length&&sv5.n===1&&close(sv5.v,wantS-0.02*2*50,1e-4)&&s3.errors.some(e=>/splits into 1 or 2 or 4 equal parts/.test(e)),volume:sv5.v,errors:[...s1.errors,...s3.errors]});
      const long=await build({flangeBot:true,spigotBot:200,spigotTop:100});
      results.push({name:'Flanges and spigots as long as the line: refused',ok:long.errors.some(e=>/as long as the axis line/.test(e)),errors:long.errors});
      const deep=await build({flangeBot:true,flMount:'socket',flOffset:6});
      results.push({name:'The end set in as deep as the flange (no spigot): refused',ok:deep.errors.some(e=>/can sit from flush/.test(e)),errors:deep.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
