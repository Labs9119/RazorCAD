import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Lofted Bend flanges: flat rings at the profiles (flat sheet metal plates of their own), round each profile with its
// gap closed straight across, out past its plane away from the other profile. Open squares 200 (on Top, y 0) and
// 100 (y 200), their gaps on the side at x −100 (−50): flanges 30 wide, 5 thick, Ø10 holes at most 100 apart. The
// opening is the profile when the material is outside it, the profile less t (2) when inside: with the material one
// way the 200 flange is 260² − 200² less 12 holes (3 a side on its 230 bolt line) and the 100 one 160² − 100² less 8;
// the other way 256² − 196² less 12 and 156² − 96² less 8. The two ways give the two. The first profile drawn as a
// 3D sketch (flat): the same. One out of a plane: refused.
const P=Math.PI,hole=25*P;
const openSquare=(h)=>[[-h,-h/4],[-h,-h],[h,-h],[h,h],[-h,h],[-h,-h/5]];
const chain2d=(s,pts)=>{const ids=pts.map(q=>S.addPoint(s,...q));for(let i=1;i<ids.length;i++)S.addLine(s,ids[i-1],ids[i]);};
function sketchAt(doc,at,pts){let ref='top';if(at){const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:at});doc.features.push(pl);ref=pl.id;}const s=M.createFeature(doc,'sketch',{plane:{ref}});chain2d(s,pts);doc.features.push(s);return s;}
// (a 3D sketch of the chain in the plane y = at: (x, y) on Top is (x, at, −y))
function sketch3dAt(doc,at,pts,bend=0){const f=M.createFeature(doc,'sketch3d');f.pts=pts.map(([x,y],i)=>({id:'p'+(i+1),x,y:at+(i===2?bend:0),z:-y}));f.segs=pts.slice(1).map((_,i)=>({id:'s'+(i+1),a:'p'+(i+1),b:'p'+(i+2)}));f.nextId=2*pts.length;doc.features.push(f);return f;}
export function loft(doc,opts={},{a3d=false,bend=0}={}){
  const a=a3d?sketch3dAt(doc,0,openSquare(100),bend):sketchAt(doc,0,openSquare(100)),b=sketchAt(doc,200,openSquare(50));
  const f=M.createFeature(doc,'smLoft',{profileA:a.id,profileB:b.id,thickness:2,...opts});doc.features.push(f);return f;
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vols=async(r)=>(await Promise.all((r.body?.bodies||[]).map(async b=>(await k.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0].volume))).reduce((x,y)=>x+y,0);
  const close=(x,y,t=1e-6)=>Math.abs(x-y)<=t*Math.max(1,Math.abs(y));
  const build=async(opts,o)=>{const d=M.newDoc();const f=loft(d,opts,o);const r=await k.rebuild(d);return {r,f,v:await vols(r),n:r.body?.bodies?.length||0,errors:r.errors.map(e=>e[1]),note:r.notes?.[f.id]};};
  const fl={flangeA:true,flangeB:true,flW:30,flT:5,flHoleD:10,flPitch:100};
  const outside=5*(260**2-200**2-12*hole)+5*(160**2-100**2-8*hole),inside=5*(256**2-196**2-12*hole)+5*(156**2-96**2-8*hole);
  const ys=(r)=>{const B=r.body;return (B?.bodies||[]).map(b=>{let lo=Infinity,hi=-Infinity;for(let q=b.triStart;q<b.triStart+b.triCount;q++){const y=B.vertices[3*B.triangles[q]+1];lo=Math.min(lo,y);hi=Math.max(hi,y);}return [lo,hi];}).filter(([lo,hi])=>close(hi-lo,5,1e-5)).sort((x,y)=>x[0]-y[0]);};
  try{
    const got=[];
    for(const flip of [false,true]){
      const plain=await build({flip}),with_=await build({flip,...fl}),y=ys(with_.r);
      const v=with_.v-plain.v;got.push(v);
      const placed=y.length===2&&close(y[0][0],-5,1e-5)&&close(y[0][1],0,1e-5)&&close(y[1][0],200,1e-5)&&close(y[1][1],205,1e-5);
      results.push({name:`Material ${flip?'on the other side':'as drawn'}: two flanges out past the profiles, 20 holes, flat plates`,ok:!plain.errors.length&&!with_.errors.length&&with_.n===plain.n+2&&placed&&/2 flanges, 20 bolt holes/.test(with_.note)&&(close(v,outside)||close(v,inside)),flanges:v,either:[outside,inside],y,note:with_.note,errors:[...plain.errors,...with_.errors]});
    }
    results.push({name:'The two material sides: one opening the profile, the other the profile less the thickness',ok:got.length===2&&((close(got[0],outside)&&close(got[1],inside))||(close(got[0],inside)&&close(got[1],outside))),got});
    {
      const s2=await build({...fl}),s3=await build({...fl},{a3d:true});
      results.push({name:'The first profile a flat 3D sketch: the same part',ok:!s3.errors.length&&close(s3.v,s2.v),volume:s3.v,expected:s2.v,errors:s3.errors});
      const bent=await build({...fl},{a3d:true,bend:5});
      results.push({name:'A flange on a 3D sketch profile out of a plane: refused',ok:bent.errors.some(e=>/needs a flat profile/.test(e)),errors:bent.errors});
      // an open circle (an arc from 10° round to 350°, r 100 at y 0 and r 50 at y 200), flanged at the first: the ring
      // round the circle with its gap closed by a chord; the holes evenly round it (no corners but the chord's two)
      {
        const d=M.newDoc(),arc=(at,r)=>{let ref='top';if(at){const pl=M.createFeature(d,'plane',{refs:[{kind:'plane',id:'top'}],offset:at});d.features.push(pl);ref=pl.id;}
          const s=M.createFeature(d,'sketch',{plane:{ref}}),c=S.addPoint(s,0,0),a0=10*P/180,p1=S.addPoint(s,r*Math.cos(a0),r*Math.sin(a0)),p2=S.addPoint(s,r*Math.cos(-a0),r*Math.sin(-a0));S.addArc(s,c,p1,p2);d.features.push(s);return s;};
        const A=arc(0,100),B=arc(200,50),f=M.createFeature(d,'smLoft',{profileA:A.id,profileB:B.id,thickness:2,method:'formed',flangeA:true,flW:30,flT:5,flHoleD:10,flPitch:100});d.features.push(f);
        const r=await k.rebuild(d),errors=r.errors.map(e=>e[1]),note=r.notes?.[f.id]||'',n=+(/(\d+) bolt holes/.exec(note)?.[1]||0);
        results.push({name:'An open circle: the flange round it, its holes evenly round',ok:!errors.length&&/1 flange, \d+ bolt holes/.test(note)&&n>=8&&n<=10,holes:n,note,errors});
      }
      const none=await build({flangeA:true,flW:30,flT:5,flHoleD:0});
      results.push({name:'No holes: the first profile\'s flange only',ok:!none.errors.length&&/1 flange$/.test(none.note||'')&&none.n===2,note:none.note,errors:none.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
