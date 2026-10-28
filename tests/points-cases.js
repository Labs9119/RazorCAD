import * as M from '/js/model.js';
import * as PT from '/js/points.js';
import {KernelClient} from '/js/kernelclient.js';
// Point clouds: PLY (ASCII and binary) and XYZ read; surfaces fitted to synthetic scans: a tilted plane, part of a
// sphere R30, a cylinder R20 along a slant, and a saddle z = (x² − y²)/500 (freeform): each within its tolerance.
const enc=(s)=>new TextEncoder().encode(s);
function cloud(fn,n=2000){const out=[];for(let i=0;i<n;i++){const u=((i*0.6180339887)%1),v=((i*0.7548776662)%1);out.push(...fn(u,v));}return Float32Array.from(out);}
export function fixture(P,kind,grid=20){const doc=M.newDoc(),c=M.createFeature(doc,'pointCloud',{fileName:'scan',count:P.length/3,data:PT.encodePoints(P)}),f=M.createFeature(doc,'fitSurface',{cloud:c.id,kind,grid});doc.features.push(c,f);return {doc,feature:f};}
export async function run({threads=1}={}){
  const results=[];
  {const a=PT.parsePoints('a.xyz',enc('# scan\n1 2 3\n4,5,6\n7;8;9\nbad line\n'));results.push({name:'XYZ / CSV text',ok:a.length===9&&a[3]===4&&a[8]===9});}
  {const t='ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nend_header\n1 2 3 255\n4 5 6 0\n';const a=PT.parsePoints('a.ply',enc(t));results.push({name:'PLY ASCII (with colours)',ok:a.length===6&&a[4]===5});}
  {const h=enc('ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty double x\nproperty double y\nproperty double z\nend_header\n'),b=new Uint8Array(h.length+48);b.set(h);const dv=new DataView(b.buffer,h.length);[1.5,2.5,3.5,-1,-2,-3].forEach((x,i)=>dv.setFloat64(i*8,x,true));const a=PT.parsePoints('b.ply',b);results.push({name:'PLY binary (doubles)',ok:a.length===6&&a[0]===1.5&&a[5]===-3});}
  {const P=cloud((u,v)=>{const x=u*100-50,y=v*60-30;return [x,y,0.1*x+5];});const pl=PT.fitPlane(P);results.push({name:'a plane fitted',ok:pl.rms<1e-4&&Math.abs(Math.abs(pl.n[0])-0.1/Math.hypot(1,0.1))<1e-6});}
  const k=new KernelClient({threads});await k.ready;
  try{
    const cases=[
      {name:'a tilted plane',kind:'plane',P:cloud((u,v)=>{const x=u*100-50,y=v*60-30;return [x,y,0.1*x+5];}),tol:1e-3},
      {name:'part of a sphere R30',kind:'sphere',P:cloud((u,v)=>{const t=u*1.2,p=v*2*Math.PI;return [30*Math.sin(t)*Math.cos(p)+5,30*Math.sin(t)*Math.sin(p),30*Math.cos(t)-2];}),tol:1e-3,check:/Sphere R30\b|Sphere R30\.000|Sphere R29\.999/},
      {name:'a slanted cylinder R20',kind:'cylinder',P:cloud((u,v)=>{const t=u*100,p=v*2*Math.PI,d=[0.6,0,0.8],e1=[0,1,0],e2=[0.8,0,-0.6];return [0,1,2].map(i=>d[i]*t+20*(Math.cos(p)*e1[i]+Math.sin(p)*e2[i]));}),tol:1e-3,check:/Cylinder R20\b|Cylinder R20\.000|Cylinder R19\.999/},
      {name:'a saddle (freeform, 24 × 24)',kind:'freeform',grid:24,P:cloud((u,v)=>{const x=u*100-50,y=v*100-50;return [x,y,(x*x-y*y)/500];},4000),tol:0.05},
    ];
    for(const c of cases){
      const d=fixture(c.P,c.kind,c.grid),r=await k.rebuild(d.doc),note=r.notes?.[d.feature.id]||'';
      const m=/([\d.]+) mm RMS, ([\d.]+) mm at most/.exec(note);
      const ok=!r.errors.length&&r.body?.bodies?.length===1&&m&&+m[1]<c.tol&&(!c.check||c.check.test(note));
      results.push({name:c.name,ok,note,errors:r.errors});
    }
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
