// Surface Fill: explicit boundary continuity, independently checked on CAD
// trimming curves. Inputs are borrowed; returned shapes belong to the caller.
import {compareSurfaceContinuity,surfaceNormalAtUV} from './surfacecontinuity.js';
const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const read=p=>{try{return p.toTuple();}finally{p.delete();}};
const point=(e,t)=>read(e.pointAt(t));
export const patchContinuity=f=>f.continuity??(f.tangent?'G1':'G0');
export function patchBoundary(R,entries){
  if(!entries.length)throw new Error('Select one closed loop of patch boundary edges');
  const remaining=[...entries],ordered=[remaining.shift()],owned=[];
  let end=read(ordered[0].edge.endPoint),start=read(ordered[0].edge.startPoint);
  if(ordered[0].edge.orientation==='backward'){
    const edge=ordered[0].edge.flipOrientation();owned.push(edge);ordered[0]={...ordered[0],edge};
  }
  try{
    while(remaining.length){
      const index=remaining.findIndex(({edge})=>distance(read(edge.startPoint),end)<1e-5||distance(read(edge.endPoint),end)<1e-5);
      if(index<0||distance(end,start)<1e-5)throw new Error('Patch requires one connected closed loop without branches or extra loops');
      const next=remaining.splice(index,1)[0];let edge=next.edge;
      const reverse=distance(read(edge.startPoint),end)>=1e-5,nextEnd=read(reverse?edge.startPoint:edge.endPoint);
      if((edge.orientation==='backward')!==reverse){edge=edge.flipOrientation();owned.push(edge);}
      ordered.push({...next,edge});end=nextEnd;
    }
    if(distance(start,end)>1e-5)throw new Error('The patch boundary is open; select one closed loop');
    return R.assembleWire(ordered.map(x=>x.edge));
  }finally{owned.forEach(e=>e.delete());}
}
// Match the native boundary of a constructed/sewn face, allowing reversal and
// reparameterization. Checks use the matched trimming pcurve, not an inverse
// projection onto a potentially dense surface.
export function verifyPatch(R,shape,entries,reference=null){
  const faces=shape.faces,oc=R.getOC();let contact=0,angle=0,curvature=0;
  const closest=(edge,p,t)=>{
    if(distance(point(edge,t),p)<1e-6)return t;
    if(distance(point(edge,1-t),p)<1e-6)return 1-t;
    let best=0,gap=Infinity;
    for(let j=0;j<=32;j++){const d=distance(point(edge,j/32),p);if(d<gap){gap=d;best=j;}}
    let a=Math.max(0,(best-1)/32),b=Math.min(1,(best+1)/32);
    for(let j=0;j<40;j++){const x=a+(b-a)/3,y=b-(b-a)/3;if(distance(point(edge,x),p)<distance(point(edge,y),p))b=y;else a=x;}
    return (a+b)/2;
  };
  const uv=(edge,face,t)=>{const p=oc.RazorCADSurfacePatch.UV(edge.wrapped,face.wrapped,t);try{return [p.X(),p.Y()];}finally{p.delete();}};
  try{
    for(const entry of entries){
      const candidates=[];
      for(const face of faces){
        if(reference&&!face.isSame(reference)&&distance(read(face.pointOnSurface(.37,.41)),read(reference.pointOnSurface(.37,.41)))>1e-6)continue;
        const edges=face.edges;try{for(const edge of edges){
        if([.13,.5,.87].every(t=>{const p=point(entry.edge,t);return distance(point(edge,closest(edge,p,t)),p)<=1e-4;}))candidates.push({face,edge:edge.clone()});
      }}finally{edges.forEach(e=>e.delete());}}
      try{
        if(candidates.length!==1)throw new Error('The patch lost a unique CAD boundary edge');
        const {face,edge}=candidates[0];
        for(let j=0;j<33;j++){
          const t=(1-Math.cos(Math.PI*(j+.5)/33))/2,p=point(entry.edge,t),s=closest(edge,p,t),leftUV=uv(edge,face,s);
          const q=surfaceNormalAtUV(R,face,leftUV);let error=distance(q.position,p);
          if(entry.continuity!=='G0'){
            const check=compareSurfaceContinuity(R,face,entry.support,p,read(entry.edge.tangentAt(t)),{leftUV,rightUV:uv(entry.edge,entry.support,t)});
            error=Math.max(error,check.positionError);angle=Math.max(angle,check.angle);
            if(check.angle>.5)throw new Error(`The requested ${entry.continuity} patch tangency could not be satisfied`);
            if(entry.continuity==='G2'){
              curvature=Math.max(curvature,check.curvatureError);
              if(check.curvatureError>.001)throw new Error('The requested G2 patch curvature could not be satisfied');
            }
          }
          contact=Math.max(contact,error);
          if(!Number.isFinite(error)||error>1e-4)throw new Error('The patch exceeds the CAD boundary contact tolerance (0.0001 mm)');
        }
      }finally{candidates.forEach(c=>c.edge.delete());}
    }
    return {contact,angle,curvature};
  }finally{faces.forEach(f=>f.delete());}
}
// interior: { edges: [Edge], points: [[x, y, z]] } the patch must pass through (not boundaries); an entry's reach
// (G1 edges, mm): the patch also passes through points that far in from the edge along the support's tangent plane,
// so it keeps to it further before turning. Both go to MakeFilling as constraints and are checked on the result
export function buildSurfacePatch(R,entries,{fatal=()=>false,message=e=>e.message||String(e),stack=null,interior=null}={}){
  const oc=R.getOC();
  if(typeof oc.RazorCADSurfacePatch?.UV!=='function')throw new Error('Patch continuity verification requires the updated kernel; reload RazorCAD');
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
    const a=entries[i],b=entries[j];if(a.continuity==='G0'||b.continuity==='G0')continue;
    for(const p of [read(a.edge.startPoint),read(a.edge.endPoint)]){
      if(![read(b.edge.startPoint),read(b.edge.endPoint)].some(q=>distance(p,q)<1e-5))continue;
      const na=read(a.support.normalAt(p)),nb=read(b.support.normalAt(p));
      const cosine=Math.abs(na.reduce((s,x,k)=>s+x*nb[k],0))/(Math.hypot(...na)*Math.hypot(...nb));
      if(!Number.isFinite(cosine)||cosine<Math.cos(.5*Math.PI/180))throw new Error('The patch supports have incompatible tangent planes at a boundary corner');
    }
  }
  const wire=patchBoundary(R,entries);let last='';
  // (the reach's points: along the support's tangent plane, square to the edge, into the opening)
  const size=(()=>{const b=wire.boundingBox;try{return Math.hypot(...[0,1,2].map(k=>b.bounds[1][k]-b.bounds[0][k]));}finally{b.delete?.();}})();
  const reachPoints=[];
  for(const e of entries){
    const r=e.reach||0;if(!(r>0))continue;
    if(e.continuity!=='G1')throw new Error('Tangent reach applies to tangent (G1) edges');
    for(const t of [1/6,2/6,3/6,4/6,5/6]){
      const p=read(e.edge.pointAt(t)),d=read(e.edge.tangentAt(t)),n=read(e.support.normalAt(p));
      let w=[n[1]*d[2]-n[2]*d[1],n[2]*d[0]-n[0]*d[2],n[0]*d[1]-n[1]*d[0]];const l=Math.hypot(...w);w=w.map(x=>x/l);
      // (into the opening: the side away from the support face)
      const probe=p.map((x,k)=>x+w[k]*size*1e-3),v=R.makeVertex(probe),q=new R.DistanceQuery(v);
      try{if(q.distanceTo(e.support)<size*1e-4)w=w.map(x=>-x);}finally{q.delete();v.delete();}
      reachPoints.push(p.map((x,k)=>x+w[k]*r));
    }
  }
  const throughPoints=[...(interior?.points||[]),...reachPoints],throughEdges=interior?.edges||[],through=throughPoints.length||throughEdges.length;
  const accept=shape=>{
    try{
      const analyzer=new oc.BRepCheck_Analyzer(shape.wrapped,true);
      try{if(!analyzer.IsValid())throw new Error('The patch produced an invalid CAD face');}finally{analyzer.delete();}
      const quality=verifyPatch(R,shape,entries);
      if(through){
        // (every point, and points along every curve, on the patch to 0.0001 mm)
        const q=new R.DistanceQuery(shape);let worst=0;
        try{
          for(const p of throughPoints){const v=R.makeVertex(p);try{worst=Math.max(worst,q.distanceTo(v));}finally{v.delete();}}
          for(const e of throughEdges)for(let k=0;k<=16;k++){const v=R.makeVertex(read(e.pointAt(k/16)));try{worst=Math.max(worst,q.distanceTo(v));}finally{v.delete();}}
        }finally{q.delete();}
        if(!(worst<=1e-4))throw new Error(`The patch passes ${worst.toExponential(2)} mm from a point or curve it must pass through`);
        quality.through=worst;
      }
      return {shape,...quality};
    }catch(e){shape.delete();throw e;}
  };
  const attempt=fn=>{
    const sp=stack?.get();
    try{return fn();}catch(e){if(fatal(e))throw e;last=message(e);return null;}finally{if(sp!=null)stack.set(sp);}
  };
  try{
    // A circular opening in a spherical support has an exact continuation.
    // Keep its CAD surface instead of approximating it with a plate.
    if(!through&&entries.length===1&&entries[0].continuity!=='G0'&&entries[0].support.geomType==='SPHERE'){
      const result=attempt(()=>{
        const {edge,support}=entries[0],sample=t=>{const p=oc.RazorCADSurfacePatch.UV(edge.wrapped,support.wrapped,t);try{return p.Y();}finally{p.delete();}};
        const v=sample(.13),bounds=support.UVBounds;
        if(Math.abs(sample(.71)-v)>1e-8)throw new Error('The spherical opening is not a latitude boundary');
        let a,b;
        if(Math.abs(v-bounds.vMax)<1e-8){a=v;b=Math.PI/2;}
        else if(Math.abs(v-bounds.vMin)<1e-8){a=-Math.PI/2;b=v;}
        else throw new Error('The spherical opening has no unambiguous continuation');
        const adaptor=support.surface;let sphere,maker;
        try{
          sphere=adaptor.wrapped.Sphere();maker=new oc.BRepBuilderAPI_MakeFace(sphere,0,2*Math.PI,a,b);
          const raw=maker.Face();let shape;try{shape=R.cast(raw);}finally{raw.delete();}return accept(shape);
        }finally{maker?.delete();sphere?.delete();adaptor.delete();}
      });
      if(result)return result;
    }
    if(!through&&entries.length>=3&&oc.RazorCADSurfacePatch?.Build){
      const order=entries.some(e=>e.continuity==='G2')?2:entries.some(e=>e.continuity==='G1')?1:0;
      const references=R.makeCompound([...new Set(entries.filter(e=>e.continuity!=='G0').map(e=>e.support))].map(face=>face.clone()));
      try{
        // A C2 interpolation can preserve tangency/contact better than the
        // G1 plate's approximation. It is a stronger solve, never a downgrade.
        for(const solveOrder of order===1?[1,2]:[order])for(const resolution of [16,32,64,128]){
          const result=attempt(()=>{const raw=oc.RazorCADSurfacePatch.Build(wire.wrapped,references.wrapped,solveOrder,1e-4,resolution,12,1);let shape;try{shape=R.cast(raw);}finally{raw.delete();}return accept(shape);});
          if(result)return result;
          if(/did not converge|no matching support boundary/.test(last))break;
        }
      }finally{references.delete();}
    }
    // Mixed per-edge conditions are supported directly by MakeFilling. A failed
    // G1/G2 request remains an error, never a contact-only replacement.
    // (with curves or points inside: finer sampling of the constraints until the patch passes within 0.0001 mm)
    for(const [points,iterations,segments,tol3d] of through?[[33,3,16,1e-5],[33,3,64,1e-6],[65,4,64,1e-7],[129,6,128,1e-7]]:[[33,3,16,1e-5]]){
    const result=attempt(()=>{
      const mk=new oc.BRepOffsetAPI_MakeFilling(3,points,iterations,false,1e-6,tol3d,1e-4,1e-4,12,segments);
      try{
        for(const {edge,support,continuity} of entries){
          if(continuity==='G0')mk.Add(edge.wrapped,oc.GeomAbs_Shape.GeomAbs_C0,true);
          else {
            // OCCT's filling forwards this enum directly to the plate's integer
            // derivative order (0/1/2). GeomAbs_G2 is 3 and is rejected there;
            // the enum value 2 supplies the actual second-order constraint.
            const order=continuity==='G2'?oc.GeomAbs_Shape.GeomAbs_C1:oc.GeomAbs_Shape.GeomAbs_G1;
            mk.Add(edge.wrapped,support.wrapped,order,true);
          }
        }
        // (curves and points inside the opening the patch passes through)
        for(const e of throughEdges)mk.Add(e.wrapped,oc.GeomAbs_Shape.GeomAbs_C0,false);
        for(const p of throughPoints){const g=new oc.gp_Pnt(...p);try{mk.Add(g);}finally{g.delete();}}
        mk.Build();if(!mk.IsDone())throw new Error('The patch constraints did not converge');
        return accept(R.cast(mk.Shape()));
      }finally{mk.delete();}
    });
    if(result)return result;
    }
    throw new Error(`Patch continuity could not be satisfied: ${last}`);
  }finally{wire.delete();}
}
