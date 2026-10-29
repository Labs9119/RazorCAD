import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Structural members round a frame face the same way whichever way each line was drawn. A U of 75 PFC on Top: legs
// at x ±100 from z 0 to −200 (the sketch's y 0 to 200), the bottom along x at z 0. Each channel's web side (its
// surface's centre, the web being the widest face) as seen from its own line: the same side of the frame (all
// outward or all inward) for the three, with the right leg drawn the other way round (top to bottom) as with it drawn
// the same way as the rest; and as before for a U drawn tidily. A closed rectangle with one line reversed: the same.
// Standing up (on Front, its legs upright): every channel's web on the same side out of the frame's plane (z), its
// depth in the plane, the legs as the bottom, the bottom and top of a rectangle drawn either way alike.
function frame(doc,lines,plane='top'){
  const s=M.createFeature(doc,'sketch',{plane:{ref:plane}});
  for(const [a,b] of lines)S.addLine(s,S.addPoint(s,...a),S.addPoint(s,...b));
  doc.features.push(s);
  const f=M.createFeature(doc,'structMember',{path:s.id,paths:[s.id],ptype:'channel',size:'75 PFC',corner:'mitre'});doc.features.push(f);return f;
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  // each member's surface centre (area-weighted over its mesh) less its line's nearest point: which way the web is
  const sides=(r)=>{const B=r.body;return (B?.bodies||[]).filter(b=>b.member?.axis).map(b=>{
    let A=0,c=[0,0,0];const V=(i)=>[0,1,2].map(j=>B.vertices[3*i+j]);
    for(let q=b.triStart;q<b.triStart+b.triCount;q+=3){const p=[0,1,2].map(j=>V(B.triangles[q+j])),u=p[1].map((x,j)=>x-p[0][j]),v=p[2].map((x,j)=>x-p[0][j]);
      const cr=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],a=Math.hypot(...cr)/2;A+=a;for(let j=0;j<3;j++)c[j]+=a*(p[0][j]+p[1][j]+p[2][j])/3;}
    c=c.map(x=>x/A);const {a,b:e}=b.member.axis,d=e.map((x,j)=>x-a[j]),L=Math.hypot(...d),t=d.reduce((s,x,j)=>s+x*(c[j]-a[j]),0)/L/L;
    const foot=a.map((x,j)=>x+d[j]*t),off=c.map((x,j)=>x-foot[j]),mid=a.map((x,j)=>(x+e[j])/2);return {mid,off};});};
  // outward from the frame's middle (in the plane: x and z)
  const outward=(m,ctr)=>{const o=[m.mid[0]-ctr[0],0,m.mid[2]-ctr[2]],l=Math.hypot(...o)||1;return (m.off[0]*o[0]+m.off[2]*o[2])/l;};
  const build=async(lines,ctr)=>{const d=M.newDoc();frame(d,lines);const r=await k.rebuild(d);const ms=sides(r);return {errors:r.errors.map(e=>e[1]),n:ms.length,out:ms.map(m=>+outward(m,ctr).toFixed(3))};};
  const same=(x)=>x.out.length&&(x.out.every(v=>v>1e-3)||x.out.every(v=>v<-1e-3));
  try{
    const ctrU=[0,0,-100];
    const tidy=await build([[[-100,200],[-100,0]],[[-100,0],[100,0]],[[100,0],[100,200]]],ctrU);
    const odd=await build([[[-100,200],[-100,0]],[[-100,0],[100,0]],[[100,200],[100,0]]],ctrU);
    results.push({name:'A U of 75 PFC drawn tidily: the three channels face the same way round it',ok:!tidy.errors.length&&tidy.n===3&&same(tidy),out:tidy.out,errors:tidy.errors});
    results.push({name:'Its right leg drawn the other way round: still the same way, as the tidy U',ok:!odd.errors.length&&odd.n===3&&same(odd)&&Math.sign(odd.out[0])===Math.sign(tidy.out[0]),out:odd.out,errors:odd.errors});
    const first=await build([[[-100,0],[-100,200]],[[-100,0],[100,0]],[[100,0],[100,200]]],ctrU);
    results.push({name:'Its first line drawn the other way round: the other two kept, the first turned to them',ok:!first.errors.length&&same(first)&&Math.sign(first.out[1])===Math.sign(tidy.out[1]),out:first.out,errors:first.errors});
    const rect=await build([[[-100,0],[100,0]],[[100,0],[100,200]],[[-100,200],[100,200]],[[-100,200],[-100,0]]],[0,0,-100]);
    results.push({name:'A closed rectangle with a line reversed: all four the same way',ok:!rect.errors.length&&rect.n===4&&same(rect),out:rect.out,errors:rect.errors});
    // (on Front the sketch's (x, y) is the model's (x, y): each web's side along z, the same for all (the mitres move
    // each one's centre in the plane, not out of it))
    const standing=async(lines)=>{const d=M.newDoc();frame(d,lines,'front');const r=await k.rebuild(d);const ms=sides(r);return {errors:r.errors.map(e=>e[1]),n:ms.length,z:ms.map(m=>+m.off[2].toFixed(3)),inPlane:ms.map(m=>+Math.hypot(m.off[0],m.off[1]).toFixed(3))};};
    const oneSide=(x)=>x.z.length&&(x.z.every(v=>v>1e-3)||x.z.every(v=>v<-1e-3))&&Math.max(...x.z)-Math.min(...x.z)<0.01;
    const up=await standing([[[-100,200],[-100,0]],[[-100,0],[100,0]],[[100,200],[100,0]]]);
    results.push({name:'A U standing up (on Front), a leg drawn the other way: every web on the same side out of its plane',ok:!up.errors.length&&up.n===3&&oneSide(up),z:up.z,inPlane:up.inPlane,errors:up.errors});
    const box=await standing([[[-100,0],[100,0]],[[100,0],[100,200]],[[-100,200],[100,200]],[[-100,200],[-100,0]]]);
    results.push({name:'A rectangle standing up, its top drawn the same way as its bottom: all four alike',ok:!box.errors.length&&box.n===4&&oneSide(box),z:box.z,inPlane:box.inPlane,errors:box.errors});
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
