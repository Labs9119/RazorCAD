import * as M from '/js/model.js';
import * as DU from '/js/ducts.js';
import {KernelClient} from '/js/kernelclient.js';
// Duct fittings: a Ø300 × 1 segmented elbow (90°, R450, 5 gores: each cut plane turns 22.5°) whose volume is exactly
// 2(n − 1)·R·A·tan(a/2) (each gore's length along a generatrix at ρ from the bend axis is ρ·tan per cut, the annulus'
// centroid at R); a cone Ø300 to Ø200 over 300 (a frustum shell); its flat patterns: gore heights, the cone's sector, a
// transition's and an offset's edges as long as the rectangle's and circles' perimeters (true lengths unfolded), a
// lateral's branch and main.
const D=300,t=1,ro=D/2,ri=ro-t,A=Math.PI*(ro*ro-ri*ri);
export function fixture(options={}){const doc=M.newDoc(),f=M.createFeature(doc,'ductFitting',options);doc.features.push(f);return {doc,feature:f};}
const perim=(pts)=>pts.reduce((s,p,i)=>{const q=pts[(i+1)%pts.length];return s+Math.hypot(q[0]-p[0],q[1]-p[1]);},0);
export async function run({threads=1}={}){
  const results=[],k=new KernelClient({threads});await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  try{
    {const r=await k.rebuild(fixture({kind:'elbow',D,t,angle:90,R:450,gores:5}).doc),b=r.body?.bodies?.[0];
     const want=2*4*450*A*Math.tan(Math.PI/16),v=b&&(await measure(b.id)).volume;
     results.push({name:'a 5 gore 90° elbow: its exact volume',ok:!r.errors.length&&Math.abs(v-want)<1e-6*want,volume:v,expected:want});}
    {const r=await k.rebuild(fixture({kind:'cone',D,t,D2:200,L:300}).doc),b=r.body?.bodies?.[0];
     const fr=(a,c,h)=>Math.PI*h/3*(a*a+a*c+c*c),want=fr(ro,100,300)-fr(ri,99,300),v=b&&(await measure(b.id)).volume;
     results.push({name:'a cone Ø300 to Ø200: a frustum shell',ok:!r.errors.length&&Math.abs(v-want)<1e-6*want,volume:v,expected:want});}
    for(const kind of ['transition','offset','lateral']){
      const r=await k.rebuild(fixture({kind,D,t,W:400,H:300,L:300,offset:150,branchD:200,branchAngle:45,branchL:300}).doc);
      results.push({name:`a ${kind} is a solid`,ok:!r.errors.length&&r.body?.bodies?.length===1,errors:r.errors});
    }
  }finally{k.worker.terminate();}
  // (the patterns)
  const rm=(D-t)/2,a=Math.PI/2/4,tk=Math.tan(a/2);
  {const p=DU.ductPatterns(DU.ductSpec({kind:'elbow',D,t,angle:90,R:450,gores:5,seam:10}));
   const end=p.find(x=>x.name==='Elbow end gore'),mid=p.find(x=>x.name==='Elbow middle gore');
   const ok=end.qty===2&&mid.qty===3&&Math.abs(end.size[1]-(450+rm)*tk)<1e-9&&Math.abs(mid.size[1]-2*(450+rm)*tk)<1e-9&&Math.abs(end.size[0]-(2*Math.PI*rm+10))<1e-9;
   results.push({name:'elbow gores: 2 ends and 3 middles, heights (R + r)·tan, width πd + seam',ok,end:end.size,mid:mid.size});}
  {const p=DU.ductPatterns(DU.ductSpec({kind:'cone',D,t,D2:200,L:300,seam:0}))[0];
   const r1=ro-t/2,r2=100-t/2,sl=Math.hypot(300,r1-r2),R1=sl*r1/(r1-r2),R2=R1-sl,want=(2*Math.PI*r1/R1)*(R1*R1-R2*R2)/2;
   results.push({name:'the cone’s sector: its area that of the cone’s side',ok:Math.abs(p.area-want)<1e-3*want&&Math.abs(p.area-Math.PI*(r1+r2)*sl)<1e-3*want,area:p.area,expected:want});}
  {const R=DU.rulings(DU.ductSpec({kind:'transition',D,t,W:400,H:300,L:300})),p=DU.ductPatterns(DU.ductSpec({kind:'transition',D,t,W:400,H:300,L:300,seam:0}))[0];
   // (unfolded: the bottom edge as long as the rectangle round, the top as the circle; the 3D rulings' lengths kept)
   const n=R.length,bottom=p.outline.slice(1,n+1),top=p.outline.slice(n+1,2*n+1);
   const L=(pts)=>pts.slice(1).reduce((s,q,i)=>s+Math.hypot(q[0]-pts[i][0],q[1]-pts[i][1]),0);
   const wantB=2*(399+299),wantT=2*Math.PI*rm*(96/96);
   const lenTop=L(top),lenBot=L(bottom),circle=R.slice(1).reduce((s,q,i)=>s+Math.hypot(q[1][0]-R[i][1][0],q[1][1]-R[i][1][1],q[1][2]-R[i][1][2]),0);
   results.push({name:'a transition unfolded: the bottom edge 2(w + h), the top the circle’s length',ok:Math.abs(lenBot-wantB)<1e-6*wantB&&Math.abs(lenTop-circle)<1e-6*circle&&Math.abs(circle-wantT)<2e-3*wantT,bottom:lenBot,top:lenTop,circle});}
  {const p=DU.ductPatterns(DU.ductSpec({kind:'offset',D,t,L:300,offset:150,seam:0}))[0],n=97,bottom=p.outline.slice(1,n+1);
   const L=bottom.slice(1).reduce((s,q,i)=>s+Math.hypot(q[0]-bottom[i][0],q[1]-bottom[i][1]),0),want=2*Math.PI*rm*Math.sin(Math.PI/96)*96/Math.PI;
   results.push({name:'an offset unfolded: its ends as long as the circles',ok:Math.abs(L-want)<1e-6*want,len:L,want});}
  {const p=DU.ductPatterns(DU.ductSpec({kind:'lateral',D,t,L:600,branchD:200,branchAngle:45,branchL:300,seam:10}));
   const br=p.find(x=>x.name==='Lateral branch'),mn=p.find(x=>x.name==='Lateral main');
   const holeIn=mn.holes[0].every(([x,y])=>x>0&&x<mn.size[0]&&y>0&&y<mn.size[1]);
   results.push({name:'a lateral: the branch πd wide, the main with the hole inside it',ok:Math.abs(br.size[0]-(Math.PI*199+10))<1e-9&&Math.abs(mn.size[0]-(Math.PI*299+10))<1e-9&&holeIn&&mn.area<mn.size[0]*600,branch:br.size,main:mn.size});}
  return {ok:results.every(r=>r.ok),results};
}
