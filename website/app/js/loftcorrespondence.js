// Stable, profile-keyed loft correspondence. Cyclic shifts preserve boundary
// order; arbitrary vertex permutations would cross the section topology.
import * as S from './sketchmodel.js';
import * as LR from './loftrefs.js';
const sub=(a,b)=>a.map((x,i)=>x-b[i]),add=(a,b)=>a.map((x,i)=>x+b[i]),mul=(a,k)=>a.map(x=>x*k),length=a=>Math.hypot(...a),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const connectionFor=(feature,ref)=>Object.hasOwn(feature.loftCorrespondence||{},LR.refKey(ref))?feature.loftCorrespondence[LR.refKey(ref)]:null;
export const hasManualConnections=feature=>feature.correspondenceMode==='manual'||feature.correspondenceMode!=='auto'&&(feature.profiles||[]).some(ref=>{const c=connectionFor(feature,ref);return !!(c&&(c.point||c.circle||c.curve||c.reverse||c.holeOrder?.length||c.holeStarts&&Object.keys(c.holeStarts).length));});

// A loop's circle (when it is one whole circle), the sketch points at its vertices and the curves round it
function loopOptions(sk,subset,segs,closed){
  const circle=segs.length===1&&segs[0].type==='circle'?subset.curves.find(c=>c.id===segs[0].sourceCurve)||subset.curves.find(c=>{const p=c.type==='circle'&&S.getPoint(sk,c.c);return p&&Math.hypot(p.x-segs[0].c[0],p.y-segs[0].c[1])<1e-6&&Math.abs(c.r-segs[0].r)<1e-6;}):null;
  const ends=segs.length===1&&circle?[]:closed?segs.flatMap(g=>[g.a,g.b]).filter(Boolean):[segs[0].a,segs.at(-1).b];
  const points=[{id:'O',x:0,y:0},...sk.points].filter(p=>ends.some(q=>Math.hypot(p.x-q[0],p.y-q[1])<1e-6));
  // (the curves a connector can attach inside: those round a closed loop that is not one circle)
  const curves=closed&&!circle?[...new Set(segs.map(g=>g.sourceCurve).filter(Boolean))]:[];
  return {circle:circle?{curve:circle.id,c:S.getPoint(sk,circle.c),r:segs[0].r}:null,points:[...new Map(points.map(p=>[p.id,p])).values()],curves,segs};
}
// A hole's stable key: its boundary curves
export const holeKey=loop=>JSON.stringify([...new Set(loop.segs.map(g=>g.sourceCurve).filter(Boolean))].sort());
export function profileConnectionOptions(sk,ref){
  const resolved=typeof ref==='string'?{sketch:sk}:LR.resolveContour(sk,ref),subset=resolved.sketch;
  const regions=resolved.region?[resolved.region]:S.profileRegions(subset,true),chains=S.curveChains(subset);
  const closed=!!resolved.region||chains.length===1&&chains[0].closed;
  const segs=closed&&regions.length===1?regions[0].outer.segs:chains.length===1?S.chainSegs(subset,chains[0]):[];
  if(!segs.length)throw new Error('Select one profile contour before editing its correspondence');
  const outer=loopOptions(sk,subset,segs,closed);
  const holes=closed&&regions.length===1?regions[0].holes.map(h=>({key:holeKey(h),...loopOptions(sk,subset,h.segs,true)})):[];
  return {closed,...outer,holes};
}
// ---- points along a segment (2D or 3D: { type: line | arc (a, m, b) | bezier (a, c1, c2, b) })
const lift=p=>p.length===2?[p[0],p[1],0]:p;
function arcFrame(g){
  const A=lift(g.a),M=lift(g.m),B=lift(g.b),u=sub(M,A),v=sub(B,A),w=cross(u,v),ww=dot(w,w);
  if(!(ww>1e-24))return null;
  const c=add(A,mul(add(mul(cross(w,u),dot(v,v)),mul(cross(v,w),dot(u,u))),1/(2*ww))),nn=cross(sub(M,A),sub(B,M)),n=mul(nn,1/length(nn));
  const r=length(sub(A,c)),e1=mul(sub(A,c),1/r),e2=cross(n,e1);
  const angle=q=>{const d=sub(lift(q),c);let t=Math.atan2(dot(d,e2),dot(d,e1));if(t<-1e-12)t+=2*Math.PI;return Math.max(0,t);};
  const span=angle(g.b)||2*Math.PI;
  return {c,r,e1,e2,span,angle,at:t=>{const q=add(c,add(mul(e1,r*Math.cos(t)),mul(e2,r*Math.sin(t))));return g.a.length===2?[q[0],q[1]]:q;}};
}
const bez=(g,t)=>{const s=1-t;return add(add(mul(g.a,s*s*s),mul(g.c1,3*s*s*t)),add(mul(g.c2,3*s*t*t),mul(g.b,t*t*t)));};
const bezD=(g,t)=>{const s=1-t;return add(add(mul(sub(g.c1,g.a),3*s*s),mul(sub(g.c2,g.c1),6*s*t)),mul(sub(g.b,g.c2),3*t*t));};
const GX=[-0.9602898564975363,-0.7966664774136267,-0.5255324099163290,-0.1834346424956498,0.1834346424956498,0.5255324099163290,0.7966664774136267,0.9602898564975363],GW=[0.1012285362903763,0.2223810344533745,0.3137066458778873,0.3626837833783620,0.3626837833783620,0.3137066458778873,0.2223810344533745,0.1012285362903763];
const bezLength=(g,t0=0,t1=1)=>{let s=0;GX.forEach((x,k)=>{s+=GW[k]*length(bezD(g,(t0+t1)/2+(t1-t0)/2*x));});return s*(t1-t0)/2;};
const segLength=g=>{if(g.type==='line')return length(sub(g.b,g.a));if(g.type==='arc'){const f=arcFrame(g);return f?f.r*f.span:length(sub(g.b,g.a));}if(g.type==='bezier')return bezLength(g);throw new Error('A connector attaches inside a line, an arc or a smooth curve');};
// the point a length s along a segment
function segAt(g,s){
  const L=segLength(g),u=Math.max(0,Math.min(1,s/L));
  if(g.type==='line')return add(g.a,mul(sub(g.b,g.a),u));
  if(g.type==='arc'){const f=arcFrame(g);return f?f.at(f.span*u):add(g.a,mul(sub(g.b,g.a),u));}
  let lo=0,hi=1;for(let k=0;k<60;k++){const m=(lo+hi)/2;if(bezLength(g,0,m)<s)lo=m;else hi=m;}return bez(g,(lo+hi)/2);
}
// The nearest point of a segment to p: { q, d, s } (s: the length along the segment to it)
function nearestOnSeg(g,p){
  if(g.type==='line'){const d=sub(g.b,g.a),t=Math.max(0,Math.min(1,dot(sub(p,g.a),d)/dot(d,d))),q=add(g.a,mul(d,t));return {q,d:length(sub(q,p)),s:t*length(d)};}
  if(g.type==='arc'){const f=arcFrame(g);if(!f)return nearestOnSeg({type:'line',a:g.a,b:g.b},p);const th=f.angle(p),t=th<=f.span?th:(th-f.span<2*Math.PI-th?f.span:0),q=f.at(t);return {q,d:length(sub(q,p)),s:t*f.r};}
  if(g.type==='bezier'){let bt=0,bd=Infinity;for(let k=0;k<=200;k++){const d=length(sub(bez(g,k/200),p));if(d<bd){bd=d;bt=k/200;}}let lo=Math.max(0,bt-.005),hi=Math.min(1,bt+.005);for(let k=0;k<80;k++){const x=lo+(hi-lo)/3,y=hi-(hi-lo)/3;if(length(sub(bez(g,x),p))<length(sub(bez(g,y),p)))hi=y;else lo=x;}const t=(lo+hi)/2,q=bez(g,t);return {q,d:length(sub(q,p)),s:bezLength(g,0,t)};}
  return {q:g.a,d:Infinity,s:0};
}
// The nearest point to p (2D) on a loop's curves: { curve, at (percent along the curve, in its own direction), q, d }
export function nearestCurvePoint2D(segs,curves,p){
  let best=null;
  for(const curve of curves){
    let parts=segs.filter(g=>g.sourceCurve===curve);if(!parts.length)continue;
    if(parts[0].sourceDirection===-1)parts=parts.slice().reverse().map(g=>({...g,a:g.b,b:g.a,...(g.type==='bezier'?{c1:g.c2,c2:g.c1}:{})}));
    const lengths=parts.map(segLength),total=lengths.reduce((x,y)=>x+y,0);let before=0;
    parts.forEach((g,i)=>{const n=nearestOnSeg(g,p);if(!best||n.d<best.d)best={curve,at:100*(before+n.s)/total,q:n.q,d:n.d};before+=lengths[i];});
  }
  return best;
}
// The point a share (0 to 1) of the way along a sketch curve of a loop, by length, in the curve's own direction (segs:
// the loop's segments, with sourceCurve / sourceDirection)
export function curveAnchor2D(segs,curve,share){
  let parts=segs.filter(g=>g.sourceCurve===curve);
  if(!parts.length)throw new Error('The connector’s curve is no longer on this profile’s boundary; reselect it');
  if(!(share>=0&&share<=1))throw new Error('The connector’s position along its curve must be between 0 and 100 %');
  // (in the curve's own direction: a loop that runs it backwards is turned round)
  if(parts[0].sourceDirection===-1)parts=parts.slice().reverse().map(g=>({...g,a:g.b,b:g.a,...(g.type==='bezier'?{c1:g.c2,c2:g.c1}:{})}));
  const lengths=parts.map(segLength),total=lengths.reduce((x,y)=>x+y,0);let s=share*total;
  for(let i=0;i<parts.length;i++){if(s<=lengths[i]||i===parts.length-1)return segAt(parts[i],Math.min(s,lengths[i]));s-=lengths[i];}
}
// A section (3D segments) with the segment that a connector point lies inside split there (the point a vertex of it);
// as it is when the point is one already, or the section is a circle
export function splitSectionAt(section,p,tol=1e-6){
  if(!p||!section?.segs)return section;
  const size=Math.max(1,...section.segs.map(g=>length(sub(g.b,g.a))));
  if(section.segs.some(g=>length(sub(g.a,p))<=1e-5*size))return section;
  let best=null;
  section.segs.forEach((g,i)=>{
    let t=null,q=null;
    if(g.type==='line'){const d=sub(g.b,g.a);t=Math.max(0,Math.min(1,dot(sub(p,g.a),d)/dot(d,d)));q=add(g.a,mul(d,t));}
    else if(g.type==='arc'){const f=arcFrame(g);if(f){const th=Math.min(f.angle(p),f.span);t=th/f.span;q=f.at(th);}}
    else if(g.type==='bezier'){let bt=0,bd=Infinity;for(let k=0;k<=200;k++){const d=length(sub(bez(g,k/200),p));if(d<bd){bd=d;bt=k/200;}}let lo=Math.max(0,bt-.005),hi=Math.min(1,bt+.005);for(let k=0;k<80;k++){const x=lo+(hi-lo)/3,y=hi-(hi-lo)/3;if(length(sub(bez(g,x),p))<length(sub(bez(g,y),p)))hi=y;else lo=x;}t=(lo+hi)/2;q=bez(g,t);}
    if(q){const d=length(sub(q,p));if(!best||d<best.d)best={i,t,d};}
  });
  if(!best||best.d>tol*size)throw new Error('The connector point is not on this profile’s boundary; reselect it');
  const g=section.segs[best.i],t=best.t;let parts;
  if(g.type==='line')parts=[{type:'line',a:g.a,b:p},{type:'line',a:p,b:g.b}];
  else if(g.type==='arc'){const f=arcFrame(g),th=f.span*t;parts=[{type:'arc',a:g.a,m:f.at(th/2),b:p},{type:'arc',a:p,m:f.at((th+f.span)/2),b:g.b}];}
  else{const l=(x,y)=>add(x,mul(sub(y,x),t)),p01=l(g.a,g.c1),p12=l(g.c1,g.c2),p23=l(g.c2,g.b),p012=l(p01,p12),p123=l(p12,p23);parts=[{type:'bezier',a:g.a,c1:p01,c2:p012,b:p},{type:'bezier',a:p,c1:p123,c2:p23,b:g.b}];}
  return {...section,segs:[...section.segs.slice(0,best.i),...parts,...section.segs.slice(best.i+1)]};
}

export function connectionAnchor(sk,ref,frame,control,evaluate=Number){
  if(!control)return null;
  const options=profileConnectionOptions(sk,ref);
  return loopAnchor(sk,options,frame,control,evaluate);
}
// A loop's connector point (3D): a vertex (point), a seam angle on a circle (circle, angle), or a share of the way along
// one of its curves (curve, at: percent)
function loopAnchor(sk,options,frame,control,evaluate=Number){
  if(control.point){
    const p=options.points.find(p=>p.id===control.point);if(!p)throw new Error(`${sk.name}: the connector point is missing or is no longer on this profile boundary; reselect it`);
    return S.fromFrame2D(frame,p.x,p.y);
  }
  if(control.curve){
    if(!options.curves.includes(control.curve))throw new Error(`${sk.name}: the connector’s curve is no longer on this boundary (or is a whole circle); reselect it`);
    const share=evaluate(control.at??50)/100;if(!Number.isFinite(share))throw new Error('The connector’s position along its curve must be finite');
    const q=curveAnchor2D(options.segs,control.curve,share);return S.fromFrame2D(frame,q[0],q[1]);
  }
  if(control.circle){
    if(options.circle?.curve!==control.circle)throw new Error(`${sk.name}: the circular connector source changed; reselect it`);
    const angle=evaluate(control.angle??0)*Math.PI/180;if(!Number.isFinite(angle))throw new Error('The connector seam angle must be finite');
    return S.fromFrame2D(frame,options.circle.c.x+options.circle.r*Math.cos(angle),options.circle.c.y+options.circle.r*Math.sin(angle));
  }
  return null;
}

// The connector point of a profile's hole (key: holeKey), from control.holeStarts[key]; null when it has none
export function holeAnchor(sk,ref,frame,control,key,evaluate=Number){
  const hc=control?.holeStarts?.[key];if(!hc)return null;
  const hole=profileConnectionOptions(sk,ref).holes.find(h=>h.key===key);if(!hole)throw new Error(`${sk.name}: a hole with a connector is gone; reselect it`);
  return loopAnchor(sk,hole,frame,hc,evaluate);
}
// A profile's holes in the order a manual correspondence pairs them (control.holeOrder: hole keys, slot by slot), as
// indices into its holes (keys: their holeKeys)
export function holeOrder(control,keys){
  const order=control?.holeOrder;if(!order?.length)return keys.map((_,i)=>i);
  const out=order.map(k=>keys.indexOf(k));
  if(out.length!==keys.length||out.some(i=>i<0)||new Set(out).size!==out.length)throw new Error('The holes paired by hand changed: pair them again');
  return out;
}
// A profile's further connectors (control.extra: vertex ids after its start, in order round it), as 3D points
export function connectionExtras(sk,ref,frame,control){
  const extra=control?.extra||[];if(!extra.length)return [];
  if(!control.point)throw new Error(`${sk.name}: pick a start vertex before adding more connectors`);
  const options=profileConnectionOptions(sk,ref);
  return extra.map(id=>{const p=options.points.find(q=>q.id===id);if(!p)throw new Error(`${sk.name}: a connector point is missing or is no longer on this profile boundary; reselect it`);return S.fromFrame2D(frame,p.x,p.y);});
}
// Closed sections turned to run the same way round as the first (by their outlines' Newell normals)
export function orientAlike(secs){
  const newell=s=>{let n=[0,0,0];const pts=s.segs.map(g=>g.a);pts.forEach((p,i)=>{n=add(n,cross(p,pts[(i+1)%pts.length]));});return n;};
  const ref=newell(secs[0]);
  return secs.map((s,i)=>i&&dot(newell(s),ref)<0?reverseSection(s):s);
}
// Several connectors on every profile (anchors[i]: its K points, in the same order round each): each section split at
// them and started at the first; between each two connectors, the profiles with fewer segments have their longest ones
// halved (by length) until they all have as many. Connectors in another order round a profile would cross the loft's
// sides, and are refused. Returns the sections, segment for segment matching.
export function connectorChains(secs,anchors,names){
  const K=anchors[0].length;
  if(anchors.some(a=>a.length!==K))throw new Error(`Every profile needs the same number of connectors (${names[0]} has ${K})`);
  const halve=g=>{const p=segAt(g,segLength(g)/2);return splitSectionAt({segs:[g]},p).segs;};
  const chains=secs.map((s,i)=>{
    let sec=s;for(const p of anchors[i])sec=splitSectionAt(sec,p);
    const n=sec.segs.length,size=Math.max(1,...sec.segs.map(g=>length(sub(g.b,g.a))));
    const at=anchors[i].map(p=>sec.segs.findIndex(g=>length(sub(g.a,p))<=1e-5*size));
    if(at.some(j=>j<0))throw new Error(`${names[i]}: a connector is not on its outline; reselect it`);
    const r=at.map(j=>(j-at[0]+n)%n);
    for(let k=1;k<K;k++)if(!(r[k]>r[k-1]))throw new Error(`${names[i]}: its connectors are not in the same order round it as on the other profiles, so the loft's sides would cross; reorder them`);
    const segs=[...sec.segs.slice(at[0]),...sec.segs.slice(0,at[0])];
    return r.map((start,k)=>segs.slice(start,k+1<K?r[k+1]:n));
  });
  for(let k=0;k<K;k++){
    const M=Math.max(...chains.map(c=>c[k].length));
    for(const c of chains)while(c[k].length<M){let j=0;c[k].forEach((g,m)=>{if(segLength(g)>segLength(c[k][j]))j=m;});c[k].splice(j,1,...halve(c[k][j]));}
  }
  return chains.map(c=>({segs:c.flat()}));
}
export const reverseSection=s=>({...s,segs:s.segs.slice().reverse().map(g=>({...g,a:g.b,b:g.a,...(g.type==='bezier'?{c1:g.c2,c2:g.c1}:{}),...(g.type==='pts'?{pts:g.pts.slice().reverse(),L:g.L.map(x=>g.L.at(-1)-x).reverse()}: {})}))});

export function applySectionConnections(matched,original,controls,expandCircles=false){
  if(controls.some(c=>!!c?.reverse!==!!controls[0]?.reverse))throw new Error('Invalid loft correspondence: closed profiles must share the same traversal direction; reverse all profiles together or change their start points');
  const allCircles=matched.every(s=>s.circle);
  if(allCircles&&(expandCircles||controls.some(c=>c?.anchor||c?.reverse))){
    const reference=matched[0].circle;
    matched=matched.map(s=>{
      const {c,r}=s.circle,n=dot(s.circle.n,reference.n)<0?mul(s.circle.n,-1):s.circle.n,projected=sub(reference.u,mul(n,dot(reference.u,n))),u=length(projected)>1e-9?mul(projected,1/length(projected)):s.circle.u,v=cross(n,u),at=t=>add(c,add(mul(u,r*Math.cos(t)),mul(v,r*Math.sin(t))));
      return {segs:Array.from({length:4},(_,i)=>({type:'arc',a:at(i*Math.PI/2),m:at((i+.5)*Math.PI/2),b:at((i+1)*Math.PI/2)}))};
    });
  }
  return matched.map((section,i)=>{
    const control=controls[i];if(!control||!control.anchor&&!control.reverse)return section;
    if(section.circle)throw new Error('The circular connector could not be expanded into matching sections');
    let s=section;
    if(control.anchor){
      if(original[i].circle){
        const {c,n}=original[i].circle,a=sub(s.segs[0].a,c),b=sub(control.anchor,c),angle=Math.atan2(dot(cross(a,b),n),dot(a,b));
        const rotate=p=>{const q=sub(p,c);return add(c,add(add(mul(q,Math.cos(angle)),mul(cross(n,q),Math.sin(angle))),mul(n,dot(n,q)*(1-Math.cos(angle)))));};
        s={segs:s.segs.map(g=>({...g,a:rotate(g.a),b:rotate(g.b),...(g.m?{m:rotate(g.m)}:{})}))};
      }else{
        const start=s.segs.findIndex(g=>length(sub(g.a,control.anchor))<=1e-5);
        if(start<0)throw new Error('The connector must attach to an existing profile vertex; split the curve at the desired location first');
        s={segs:[...s.segs.slice(start),...s.segs.slice(0,start)]};
      }
    }
    return control.reverse?reverseSection(s):s;
  });
}
