// Single-path sweep orientation. Parallel uses OCCT's fixed trihedron. Twist
// uses a rotation-minimizing frame and an auxiliary CAD spine, with bounded
// refinement of both transport and interpolation. Checks are numerical, not
// a certified global error bound.
const add=(a,b)=>a.map((x,i)=>x+b[i]);
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const mul=(a,k)=>a.map(x=>x*k);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length=a=>Math.hypot(...a);
const unit=a=>{const l=length(a);if(!(l>1e-12))throw new Error('The sweep path has a singular tangent');return mul(a,1/l);};
const xyz=p=>[p.X(),p.Y(),p.Z()];
const read=p=>{try{return xyz(p);}finally{p.delete();}};
const readVector=p=>{try{return xyz(p.wrapped);}finally{p.delete();}};
const turn=(v,n,a)=>add(add(mul(v,Math.cos(a)),mul(cross(n,v),Math.sin(a))),mul(n,dot(n,v)*(1-Math.cos(a))));
function transport(x,a,b){
  const c=dot(a,b),v=cross(a,b);
  if(c< -0.999999)throw new Error('Twist requires a tangent-continuous path without reversals');
  const rotated=add(add(x,cross(v,x)),mul(cross(v,cross(v,x)),1/(1+c)));
  return unit(sub(rotated,mul(b,dot(rotated,b))));
}
function interpolate(R,points){
  const oc=R.getOC(),array=new oc.NCollection_Array1_gp_Pnt(1,points.length),parameters=new oc.NCollection_Array1_double(1,points.length);
  let pnts,params,builder,curve;
  try{
    points.forEach((p,i)=>{const q=new oc.gp_Pnt(...p);try{array.SetValue(i+1,q);parameters.SetValue(i+1,i/(points.length-1));}finally{q.delete();}});
    pnts=new oc.NCollection_HArray1_gp_Pnt(array);params=new oc.NCollection_HArray1_double(parameters);
    builder=new oc.GeomAPI_Interpolate(pnts,params,false,1e-9);builder.Perform();
    if(!builder.IsDone())throw new Error('The twist orientation curve could not be interpolated');
    curve=builder.Curve();return curve;
  }finally{builder?.delete();pnts?.delete();params?.delete();array.delete();parameters.delete();}
}
// How much of a twist or a scale change has happened a share t of the way along the path: evenly ('linear') or
// eased in and out ('smooth': 3t²-2t³, flat at both ends)
export const easeOf=(kind)=>kind==='smooth'?(t=>t*t*(3-2*t)):(t=>t);
// A scale law for BRepOffsetAPI_MakePipeShell::SetLaw: 1 at the start of the path to `end` at its end, evenly or
// eased, by the length along the path. The pipe maps the law's domain [0, 1] onto its own parameter: the length at
// each edge's ends, and in between the edge's curve parameter evenly (measured: a line and an arc, the volume to
// 1e-7 of the integral by length; an unevenly parameterised spline 29% off). That is the length on lines and
// circles, so one law does there; with other curves the law is interpolated (Law_Interpol) through points that
// give, at each place's pipe parameter, the scale for its length. Returns { law (a Handle(Law_Function)), at(t) }
// (at: the scale a share t of the way along)
export function scaleLaw(R,spine,end,kind='linear'){
  if(!(Number.isFinite(end)&&end>0))throw new Error('The end scale must be greater than zero');
  const oc=R.getOC(),g=easeOf(kind),at=t=>1+(end-1)*g(t);
  const edges=spine.edges;let samples=null;
  try{
    if(edges.some(e=>!['LINE','CIRCLE'].includes(e.geomType))){
      // (for each edge: [pipe parameter, length] at points along it, both from the path's start)
      const GX=[0.1834346424956498,0.5255324099163290,0.7966664774136267,0.9602898564975363],GW=[0.3626837833783620,0.3137066458778873,0.2223810344533745,0.1012285362903763];
      const pts=[[0,0]];let S0=0;
      for(const e of edges){
        const c=new oc.BRepAdaptor_Curve(e.wrapped);
        try{
          const a=c.FirstParameter(),b=c.LastParameter(),back=e.orientation==='backward',n=['LINE','CIRCLE'].includes(e.geomType)?8:96;
          const speed=u=>length(read(c.DN(u,1)));
          const piece=(u,v)=>{const m=(u+v)/2,r=(v-u)/2;let sum=0;GX.forEach((x,k)=>{sum+=GW[k]*(speed(m-r*x)+speed(m+r*x));});return Math.abs(sum*r);};
          const run=[0];for(let k=1;k<=n;k++){const u=back?b-(b-a)*(k-1)/n:a+(b-a)*(k-1)/n,v=back?b-(b-a)*k/n:a+(b-a)*k/n;run.push(run[k-1]+piece(Math.min(u,v),Math.max(u,v)));}
          const Le=run[n];
          for(let k=1;k<=n;k++)pts.push([S0+Le*k/n,S0+run[k]]);
          S0+=Le;
        }finally{c.delete();}
      }
      samples=pts.map(([p,s])=>[p/S0,at(s/S0)]);
    }
  }finally{edges.forEach(e=>e.delete());}
  if(!samples){
    const law=kind==='smooth'?new oc.Law_S():new oc.Law_Linear();
    try{law.Set(0,1,1,end);return {law:law.Trim(0,1,1e-12),at};}finally{law.delete();}
  }
  const arr=new oc.NCollection_Array1_gp_Pnt2d(1,samples.length),law=new oc.Law_Interpol();
  try{
    samples.forEach(([x,y],i)=>{const q=new oc.gp_Pnt2d(x,y);try{arr.SetValue(i+1,q);}finally{q.delete();}});
    law.Set(arr,false);
    return {law:law.Trim(0,1,1e-12),at};
  }finally{arr.delete();law.delete();}
}
function twistFrame(R,spine,angle,radius,twistLaw='linear'){
  if(spine.isClosed)throw new Error('Twist currently requires an open path');
  const oc=R.getOC(),path=new oc.BRepAdaptor_CompCurve(spine.wrapped,false),first=path.FirstParameter(),span=path.LastParameter()-first;
  const point=t=>read(path.Value(first+span*t));
  const derivative=t=>mul(read(path.DN(first+span*t,1)),span);
  const tangent=t=>unit(derivative(t));
  const edges=spine.edges;
  try{for(let i=1;i<edges.length;i++){
    const a=readVector(edges[i-1].tangentAt(1)),b=readVector(edges[i].tangentAt(0));
    if(dot(unit(a),unit(b))<1-1e-8)throw new Error('Twist requires a tangent-continuous path; round its sharp corners first');
  }}catch(e){path.delete();throw e;}finally{edges.forEach(e=>e.delete());}
  const origin=point(0),n0=tangent(0),seed=[0,1,2].sort((a,b)=>Math.abs(n0[a])-Math.abs(n0[b]))[0],axis=[0,0,0];axis[seed]=1;
  const x0=unit(cross(n0,axis)),y0=cross(n0,x0),total=R.measureLength(spine),railRadius=Math.max(0.001,Math.min(1,total/100));
  const tolerance=1e-5*railRadius/Math.max(radius,railRadius),radians=angle*Math.PI/180;
  let previous,curve;
  try{
    // Simpson integration at each station supplies arc length; comparing two
    // transport grids also catches accumulated orientation error on 3D curves.
    for(let count=32;count<=4096;count*=2){
      if(count<Math.abs(angle)/5.625)continue;
      const frames=[],distances=[0];let x=x0,last=n0;
      for(let i=0;i<=count;i++){
        const t=i/count,n=tangent(t);
        if(i){x=transport(x,last,n);const a=(i-1)/count,b=t,m=(a+b)/2;
          distances.push(distances[i-1]+(length(derivative(a))+4*length(derivative(m))+length(derivative(b)))/(6*count));}
        frames.push({p:point(t),n,x});last=n;
      }
      const measured=distances[count];
      if(!(measured>0)||Math.abs(measured-total)>Math.max(1e-6,total*1e-7)){previous=null;continue;}
      const ease=easeOf(twistLaw);
      frames.forEach((f,i)=>{f.t=distances[i]/measured;f.x=turn(f.x,f.n,radians*ease(f.t));f.y=cross(f.n,f.x);f.q=add(f.p,mul(f.x,railRadius));});
      let error=Infinity;
      if(previous){
        curve?.delete();curve=interpolate(R,previous.map(f=>f.q));error=0;
        for(let i=0;i<=count;i++)error=Math.max(error,length(sub(read(curve.Value(i/count)),frames[i].q)));
      }
      if(error<=tolerance){
        const edgeBuilder=new oc.BRepBuilderAPI_MakeEdge(curve);let edge,wire;
        try{const raw=edgeBuilder.Edge();try{edge=R.cast(raw);}finally{raw.delete();}wire=R.assembleWire([edge]);}finally{edge?.delete();edgeBuilder.delete();}
        return {wire,origin,x0,y0,frames};
      }
      previous=frames;
    }
    throw new Error('The twist orientation exceeds its refinement limit; simplify the path or reduce the angle');
  }finally{curve?.delete();path.delete();}
}
// options: { scale: scaleLaw's { law, at }, twistLaw: 'linear' | 'smooth' }
export function sweepWithOrientation(R,profile,spine,orientation,angle,surface=false,nearFacePoint,options={}){
  if(!['perpendicular','parallel'].includes(orientation))throw new Error('Select Perpendicular or Parallel sweep orientation');
  if(!Number.isFinite(angle))throw new Error('The twist angle must be finite');
  const oc=R.getOC(),start=readVector(spine.startPoint),normal=unit(readVector(spine.tangentAt(0)));
  const edges=profile.edges,samples=[];let radius=0;
  try{for(const edge of edges)for(const t of [0,0.25,0.5,0.75,1]){
    const p=readVector(edge.pointAt(t));radius=Math.max(radius,length(sub(p,start)));
    if(Math.abs(dot(sub(p,start),normal))>1e-4)throw new Error('Place the profile in the normal plane at the start of the path');
    samples.push(p);
  }}finally{edges.forEach(e=>e.delete());}
  let frame,axis,shape;const builder=new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
  try{
    builder.SetTolerance(1e-6,1e-6,1e-3);builder.SetMaxDegree(12);builder.SetMaxSegments(512);
    if(orientation==='parallel'){axis=R.makeAx2(start,normal);builder.SetMode(axis);}
    else{frame=twistFrame(R,spine,angle,radius,options.twistLaw);builder.SetMode(frame.wire.wrapped,false,oc.BRepFill_TypeOfContact.BRepFill_NoContact);}
    if(options.scale)builder.SetLaw(profile.wrapped,options.scale.law,false,false);else builder.Add(profile.wrapped,false,false);builder.Build();
    if(!builder.IsDone()||!surface&&!builder.MakeSolid())throw new Error('The selected orientation could not produce a sweep; check the path and profile');
    if(!Number.isFinite(builder.ErrorOnSurface())||builder.ErrorOnSurface()>1e-4)throw new Error('The oriented sweep exceeds the 0.0001 mm construction tolerance');
    const raw=builder.Shape();try{shape=R.cast(raw);}finally{raw.delete();}
    const validity=new oc.BRepCheck_Analyzer(shape.wrapped,true);
    try{if(!validity.IsValid())throw new Error('The selected orientation produced an invalid sweep');}finally{validity.delete();}
    if(!surface){const solids=shape.solids;try{if(!solids.length)throw new Error('The selected orientation did not produce a solid');}finally{solids.forEach(s=>s.delete());}}
    // Independent final-face probes check the intended rotation at off-grid
    // sections, including the sign, total angle and accumulated 3D transport.
    if(frame){
      const faces=shape.faces;
      try{for(let i=0;i<=16;i++){
        const index=i===0?0:i===16?frame.frames.length-1:Math.min(frame.frames.length-2,Math.round((i+0.37)*(frame.frames.length-1)/17)|1);
        const f=frame.frames[index];
        for(const p of samples.filter((_,j)=>j%5===1)){
          const d=sub(p,frame.origin),k=options.scale?options.scale.at(f.t):1,q=add(f.p,mul(add(mul(f.x,dot(d,frame.x0)),mul(f.y,dot(d,frame.y0))),k));
          const v=R.makeVertex(q),query=new R.DistanceQuery(v);let distance=Infinity;
          try{for(const face of faces){const hit=nearFacePoint?.(face,q);distance=Math.min(distance,hit?length(sub(hit,q)):query.distanceTo(face));if(distance<1e-7)break;}}
          finally{query.delete();v.delete();}
          if(!Number.isFinite(distance)||distance>1e-4)throw new Error('The sweep does not follow the requested twist within 0.0001 mm');
        }
      }}finally{faces.forEach(f=>f.delete());}
    }
    const result=shape;shape=null;return result;
  }finally{shape?.delete();builder.delete();axis?.delete();frame?.wire.delete();}
}
