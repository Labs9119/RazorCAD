import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Transition flanges: flat rings at the ends, bodies of their own, out past the end by their thickness, with bolt
// holes. Each against its volume by hand (the part with the flanges less the same part without them):
// round 300 → round 200, 300 high, inside sizes: the bottom flange 40 wide, 6 thick, 8 Ø10 holes:
// 6 · (π (190² − 150²) − 8 · 25π). Square 400 → round 200, both flanged: the square one (440 a side at its bolt line:
// 5 holes a side at a pitch of at most 100, 20 in all) 6 · (480² − 400² − 20 · 25π), the round one
// 6 · (π (140² − 100²) − 8 · 25π). Outside sizes, t 2: the round opening less the thickness across the wall's slope.
// A bolt circle set: Ø400 on the 300 end. Holes as wide as the flange: refused.
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
  const P=Math.PI,hole=25*P;
  try{
    {
      const plain=await build({}),fl=await build({flangeBot:true});
      const want=6*(P*(190**2-150**2)-8*hole);
      results.push({name:'Round end: a flange 40 wide, 6 thick, 8 Ø10 holes, a body of its own',ok:!plain.errors.length&&!fl.errors.length&&close(fl.v-plain.v,want)&&fl.n===plain.n+1&&/1 flange, 8 bolt holes/.test(fl.note),flange:fl.v-plain.v,expected:want,bodies:[plain.n,fl.n],note:fl.note,errors:[...plain.errors,...fl.errors]});
      const pcd=await build({flangeBot:true,flW:60,flPCD:400});
      const want2=6*(P*(210**2-150**2)-8*hole);
      results.push({name:'A bolt circle set (Ø400 on a flange 60 wide)',ok:!pcd.errors.length&&close(pcd.v-plain.v,want2),flange:pcd.v-plain.v,expected:want2,errors:pcd.errors});
      const off=await build({flangeBot:true,flPCD:390});
      results.push({name:'A bolt circle that puts the holes off the flange: refused',ok:off.errors.some(e=>/puts the holes off the flange/.test(e)),errors:off.errors});
      const wide=await build({flangeBot:true,flHoleD:40});
      results.push({name:'Holes as wide as the flange: refused',ok:wide.errors.some(e=>/as wide as the flange/.test(e)),errors:wide.errors});
    }
    {
      const opts={bShape:'square',bSize:400,tShape:'round',tD:200,parts:4};
      const plain=await build(opts),fl=await build({...opts,flangeBot:true,flangeTop:true});
      const want=6*(480**2-400**2-20*hole)+6*(P*(140**2-100**2)-8*hole);
      // (the flanges, the bodies 6 thick: from y −6 to 0 and from 300 to 306, out past the ends)
      const B=fl.r.body,ys=(b)=>{let lo=Infinity,hi=-Infinity;for(let q=b.triStart;q<b.triStart+b.triCount;q++){const y=B.vertices[3*B.triangles[q]+1];lo=Math.min(lo,y);hi=Math.max(hi,y);}return [lo,hi];};
      const at=(B?.bodies||[]).map(ys).filter(([lo,hi])=>close(hi-lo,6,1e-5)).sort((x,y)=>x[0]-y[0]),placed=at.length===2&&close(at[0][0],-6,1e-5)&&close(at[0][1],0,1e-5)&&close(at[1][0],300,1e-5)&&close(at[1][1],306,1e-5);
      // (each a flat sheet metal plate: its flat pattern the ring, the opening and the holes cut out of it)
      const sq=(B?.bodies||[]).filter(b=>b.sheet?.t===6).map(b=>b.sheet).sort((x,y)=>y.flatArea-x.flatArea)[0],flat=!!sq&&close(sq.flatArea,480**2-400**2-20*hole,1e-6);
      results.push({name:'Square to round, both ends flanged: 20 holes round the square one, 8 on the round one, out past the ends; flat patterns',flat:sq&&{area:sq.flatArea,pierces:sq.pierces},ok:!plain.errors.length&&!fl.errors.length&&close(fl.v-plain.v,want)&&fl.n===plain.n+2&&/2 flanges, 28 bolt holes/.test(fl.note)&&placed&&flat,flange:fl.v-plain.v,expected:want,y:at,note:fl.note,errors:[...plain.errors,...fl.errors]});
    }
    {
      const plain=await build({dims:'outside'}),fl=await build({dims:'outside',flangeBot:true,flHoleD:0});
      const slope=Math.hypot(300,50)/300,ri=150-2*slope,want=6*P*((ri+40)**2-ri**2);
      results.push({name:'Outside sizes: the opening less the thickness across the wall\'s slope; no holes',ok:!fl.errors.length&&close(fl.v-plain.v,want),flange:fl.v-plain.v,expected:want,errors:fl.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
