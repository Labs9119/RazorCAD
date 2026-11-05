// Clamped tensor lofts: cubic for directions/G1, quintic in V for G2.
// G2 imposes normal acceleration from the adjacent CAD second fundamental
// form. CAD contact, normals and curvatures are checked after sewing.
// Refinement checks are sampled numerical bounds, not a global proof.
import {surfaceNormalAtUV,surfaceDifferential,compareSurfaceContinuity} from './surfacecontinuity.js';
const supported=mode=>mode==='tangent'||mode==='curvature';
const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]),mul=(a,s)=>a.map(x=>x*s);
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),length=a=>Math.hypot(...a);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const l=length(a);if(!(l>1e-12))throw new Error('An endpoint direction is singular');return mul(a,1/l);};
const read=p=>{try{return p.toTuple();}finally{p.delete();}};
const at=(e,t)=>read(e.pointAt(e.orientation === 'backward' ? 1-t : t));
function orderedEdges(R,wire){
  const pool=wire.edges,out=[];
  if(pool.length===1&&pool[0].geomType==='CIRCLE'){
    const edge=pool.pop();try{return [0,1,2,3].map(i=>R.makeThreePointArc(at(edge,i/4),at(edge,(i+.5)/4),at(edge,(i+1)/4)));}finally{edge.delete();}
  }
  let point=read(wire.startPoint);
  try{while(pool.length){
    const i=pool.findIndex(e=>length(sub(at(e,0),point))<1e-5||length(sub(at(e,1),point))<1e-5);
    if(i<0)throw new Error('A loft profile has a disconnected curve chain');
    let edge=pool.splice(i,1)[0];if(length(sub(at(edge,0),point))>=1e-5){const flipped=edge.flipOrientation();edge.delete();edge=flipped;}
    out.push(edge);point=at(edge,1);
  }return out;}catch(e){[...out,...pool].forEach(x=>x.delete());throw e;}
}
// Match complete CAD boundaries before applying endpoint derivatives. Faces on
// opposite ends of a body often expose their loops in opposite directions.
export function alignLoftWires(R,wires){
  const rows=[],made=[];
  const center=pts=>mul(pts.reduce((a,p)=>add(a,p),[0,0,0]),1/pts.length);
  try{
    for(const wire of wires)rows.push(orderedEdges(R,wire));
    if(rows.some(row=>row.length!==rows[0].length))throw new Error('Endpoint conditions require matching curve counts in all profiles');
    const reference=rows[0].map(e=>at(e,0)),origin=center(reference),dirs=reference.map(p=>sub(p,origin));
    for(const row of rows){
      let best=null,cost=Infinity;
      for(const reverse of [false,true]){
        const list=reverse?row.slice().reverse():row,points=list.map(e=>at(e,reverse?1:0)),c=center(points);
        for(let shift=0;shift<row.length;shift++){
          const score=dirs.reduce((s,d,i)=>{const q=sub(points[(i+shift)%row.length],c);return s+length(sub(mul(d,1/(length(d)||1)),mul(q,1/(length(q)||1))))**2;},0);
          if(score<cost){cost=score;best={list,reverse,shift};}
        }
      }
      const edges=best.list.map((_,i)=>{const e=best.list[(i+best.shift)%row.length];return best.reverse?e.flipOrientation():e.clone();});
      try{made.push(R.assembleWire(edges));}finally{edges.forEach(e=>e.delete());}
    }
    return made;
  }catch(e){made.forEach(w=>w.delete());throw e;}finally{rows.flat().forEach(e=>e.delete());}
}
const derivative=(fn,t)=>{const h=1e-5;return t===0?mul(add(add(mul(fn(0),-3),mul(fn(h),4)),mul(fn(2*h),-1)),1/(2*h)):t===1?mul(add(add(mul(fn(1),3),mul(fn(1-h),-4)),fn(1-2*h)),1/(2*h)):mul(sub(fn(t+h),fn(t-h)),1/(2*h));};
function cubicPoles(values,d0,d1){
  const n=values.length-1,h=1/n,p=Array(n+3);
  p[0]=values[0];p[1]=add(p[0],mul(d0,h/3));p[n+2]=values[n];p[n+1]=sub(p[n+2],mul(d1,h/3));
  if(n===1)return p;
  if(n===2){p[2]=mul(sub(values[1],mul(add(p[1],p[3]),.25)),2);return p;}
  const diag=Array(n-1).fill(2/3),rhs=values.slice(1,-1).map(v=>[...v]);diag[0]=diag[n-2]=7/12;
  rhs[0]=sub(rhs[0],mul(p[1],.25));rhs[n-2]=sub(rhs[n-2],mul(p[n+1],.25));
  for(let i=1;i<n-1;i++){const f=(1/6)/diag[i-1];diag[i]-=f/6;rhs[i]=sub(rhs[i],mul(rhs[i-1],f));}
  p[n]=mul(rhs[n-2],1/diag[n-2]);for(let i=n-3;i>=0;i--)p[i+2]=mul(sub(rhs[i],mul(p[i+3],1/6)),1/diag[i]);return p;
}
// Quintic interpolation adds two endpoint acceleration constraints to the cubic
// contract. Factor the collocation matrix once and reuse it for every U pole.
function quinticInterpolator(n){
  const degree=5,size=n+5,knots=[...Array(6).fill(0),...Array.from({length:n-1},(_,i)=>(i+1)/n),...Array(6).fill(1)];
  const basis=(i,p,t,d=0)=>{
    if(d>p)return 0;
    if(!p)return (knots[i]<=t&&t<knots[i+1])||(t===1&&i===size-1)?1:0;
    const a=knots[i+p]-knots[i],b=knots[i+p+1]-knots[i+1];
    if(d)return (a?p/a*basis(i,p-1,t,d-1):0)-(b?p/b*basis(i+1,p-1,t,d-1):0);
    return (a?(t-knots[i])/a*basis(i,p-1,t):0)+(b?(knots[i+p+1]-t)/b*basis(i+1,p-1,t):0);
  };
  const row=(t,d=0)=>Array.from({length:size},(_,i)=>basis(i,degree,t,d));
  const matrix=[...Array.from({length:n+1},(_,i)=>row(i/n)),row(0,1),row(1,1),row(0,2),row(1,2)],swaps=[];
  for(let k=0;k<size;k++){
    let pivot=k;for(let i=k+1;i<size;i++)if(Math.abs(matrix[i][k])>Math.abs(matrix[pivot][k]))pivot=i;
    if(Math.abs(matrix[pivot][k])<1e-12)throw new Error('The curvature endpoint interpolation is singular');
    swaps.push(pivot);[matrix[k],matrix[pivot]]=[matrix[pivot],matrix[k]];
    for(let i=k+1;i<size;i++){matrix[i][k]/=matrix[k][k];for(let j=k+1;j<size;j++)matrix[i][j]-=matrix[i][k]*matrix[k][j];}
  }
  return (values,d0,d1,a0,a1)=>{
    const rhs=[...values,d0,d1,a0,a1].map(p=>[...p]);
    for(let k=0;k<size;k++){const pivot=swaps[k];[rhs[k],rhs[pivot]]=[rhs[pivot],rhs[k]];}
    for(let i=0;i<size;i++)for(let j=0;j<i;j++)rhs[i]=sub(rhs[i],mul(rhs[j],matrix[i][j]));
    for(let i=size-1;i>=0;i--){for(let j=i+1;j<size;j++)rhs[i]=sub(rhs[i],mul(rhs[j],matrix[i][j]));rhs[i]=mul(rhs[i],1/matrix[i][i]);}return rhs;
  };
}
function tensorFace(R,rows,d0,d1,accelerations=null){
  const degree=accelerations?5:3,interpolate=accelerations?quinticInterpolator(rows.length-1):null;
  const oc=R.getOC(),nu=rows[0].length,nv=rows.length+degree-1,arrays=[];
  const keep=x=>(arrays.push(x),x),points=keep(new oc.NCollection_Array2_gp_Pnt(1,nu,1,nv));
  const knots=(n,d)=>{const k=keep(new oc.NCollection_Array1_double(1,n+1)),m=keep(new oc.NCollection_Array1_int(1,n+1));for(let i=0;i<=n;i++){k.SetValue(i+1,i/n);m.SetValue(i+1,i===0||i===n?d+1:1);}return [k,m];};
  let surface,maker;
  try{
    for(let i=0;i<nu;i++){const values=rows.map(r=>r[i]),poles=interpolate?interpolate(values,d0[i],d1[i],accelerations[0][i],accelerations[1][i]):cubicPoles(values,d0[i],d1[i]);poles.forEach((p,j)=>{const q=new oc.gp_Pnt(...p);try{points.SetValue(i+1,j+1,q);}finally{q.delete();}});}
    const [uk,um]=knots(nu-3,3),[vk,vm]=knots(rows.length-1,degree);
    surface=new oc.Geom_BSplineSurface(points,uk,vk,um,vm,3,degree,false,false);
    maker=new oc.BRepBuilderAPI_MakeFace(surface,1e-7);if(!maker.IsDone())throw new Error('The constrained loft surface could not be built');
    const raw=maker.Face();try{return R.cast(raw);}finally{raw.delete();}
  }finally{maker?.delete();surface?.delete();arrays.reverse().forEach(a=>a.delete());}
}
// A valid topological B-rep can still contain a collapsed parameter strip.
// Resolve abrupt normal changes on the actual surface, rather than accepting
// a meshed pinch caused by excessive curvature/influence. This sampled check
// detects local folds; it is not a general surface self-intersection proof.
function checkCurvatureRegularity(R,face){
  const normal=(u,v)=>surfaceNormalAtUV(R,face,[u,v]).normal;
  const check=(u,a,b,na,nb,depth=0)=>{
    if(dot(na,nb)>.5)return;
    if(depth===24)throw new Error('The G2 loft collapses or folds between profiles; reduce Influence or add an intermediate profile');
    const mid=(a+b)/2,n=normal(u,mid);check(u,a,mid,na,n,depth+1);check(u,mid,b,n,nb,depth+1);
  };
  for(const u of [.17,.5,.83]){
    let previous=normal(u,0);
    for(let j=1;j<=64;j++){const next=normal(u,j/64);check(u,(j-1)/64,j/64,previous,next);previous=next;}
  }
}
export function hasLoftEnds(f){return [f.startCondition,f.endCondition].some(x=>x&&x!=='none');}
export function endConstrainedLoft(R,wires,conditions,{surface=false,sew,solid,holes=[],constraintWires=wires,constraintHoles=holes}){
  const tolerance=1e-4,owned=[],loopRows=[wires,...holes].map(loop=>loop.map(w=>orderedEdges(R,w))),baselineRows=[constraintWires,...constraintHoles].map(loop=>loop.map(w=>orderedEdges(R,w))),patches=[],supports=conditions.map(c=>(c.faces||[]).map(face=>({face,edges:face.edges,used:false})));let sewn,result;
  const distance=(p,shape)=>{const v=R.makeVertex(p),q=new R.DistanceQuery(v);try{return q.distanceTo(shape);}finally{q.delete();v.delete();}};
  const findSupport=(edge,side)=>{
    const candidates=supports[side].filter(s=>[.13,.5,.87].every(t=>s.edges.some(e=>distance(at(edge,t),e)<=tolerance)));
    if(candidates.length!==1)throw new Error(candidates.length?'The selected support faces are ambiguous at a profile edge':'Every endpoint profile edge must coincide with a boundary of a selected adjacent face');
    candidates[0].used=true;return candidates[0].face;
  };
  try{
    for(let loopIndex=0;loopIndex<loopRows.length;loopIndex++){
    const edgeRows=loopRows[loopIndex],baseline=baselineRows[loopIndex];
    if(edgeRows.some(r=>r.length!==edgeRows[0].length)||baseline.some(r=>r.length!==edgeRows[0].length))throw new Error('Endpoint conditions require matching curve counts in all profiles');
    for(let edgeIndex=0;edgeIndex<edgeRows[0].length;edgeIndex++){
      const edges=edgeRows.map(r=>r[edgeIndex]),endSupports=conditions.map((c,i)=>supported(c.mode)?findSupport(edges[i===0?0:edges.length-1],i):null),cache=new Map();
      const data=(u)=>{
        if(cache.has(u))return cache.get(u);
        const points=edges.map(e=>at(e,u)),reference=baseline.map(row=>at(row[edgeIndex],u)),derivatives=conditions.map((c,side)=>{
          const i=side===0?0:edges.length-1,ri=side===0?0:reference.length-1,rj=side===0?1:ri-1,chord=side===0?sub(reference[rj],reference[ri]):sub(reference[ri],reference[rj]);
          if(c.mode==='none'){
            // At a free guided end, a first secant creates an artificial kink.
            // Estimate the derivative from three refined sections instead;
            // requested constraints still use the original profile spacing.
            if(edges.length>reference.length&&edges.length>=3){
              const n=edges.length-1;
              return side===0?mul(add(add(mul(points[0],-3),mul(points[1],4)),mul(points[2],-1)),n/2):mul(add(add(mul(points[n],3),mul(points[n-1],-4)),points[n-2]),n/2);
            }
            const j=side===0?1:i-1;return mul(side===0?sub(points[j],points[i]):sub(points[i],points[j]),edges.length-1);
          }
          let d;
          if(supported(c.mode)){
            const n=unit(read(endSupports[side].normalAt(points[i]))),t=unit(derivative(t=>at(edges[i],t),u));d=unit(cross(t,n));
          }else d=unit(c.direction);
          const alignment=dot(d,chord);
          if(Math.abs(alignment)<1e-8*Math.max(1,length(chord)))throw new Error('The endpoint direction or support tangent plane cannot extend toward the next profile');
          if(alignment<0)d=mul(d,-1);
          return mul(d,length(chord)*(reference.length-1)*c.strength*(c.reverse?-1:1));
        });
        const accelerations=conditions.some(c=>c.mode==='curvature')?conditions.map((c,side)=>{
          if(c.mode==='curvature'){
            const i=side===0?0:points.length-1,d=surfaceDifferential(R,endSupports[side],points[i]);
            return mul(d.normal,d.second(derivatives[side],derivatives[side]));
          }
          // Preserve the unconstrained endpoint's cubic acceleration.
          const poles=cubicPoles(points,...derivatives),n=points.length-1;
          const a=side===0?poles.slice(0,3):poles.slice(-3).reverse();
          return mul(sub(mul(sub(a[2],a[1]),n===1?1:.5),sub(a[1],a[0])),6*n*n);
        }):null;
        const value={points,derivatives,accelerations};cache.set(u,value);return value;
      };
      let patch,quality;
      for(const count of [8,16,32,64,128]){
        const samples=Array.from({length:count+1},(_,i)=>data(i/count));
        const interpolate=fn=>cubicPoles(samples.map((_,i)=>fn(i/count)),derivative(fn,0),derivative(fn,1));
        const rows=edges.map((_,i)=>interpolate(u=>data(u).points[i])),d0=interpolate(u=>data(u).derivatives[0]),d1=interpolate(u=>data(u).derivatives[1]);
        const accelerations=samples[0].accelerations?[0,1].map(side=>interpolate(u=>data(u).accelerations[side])):null;
        patch=tensorFace(R,rows,d0,d1,accelerations);quality={contact:0,angle:0,jet:0,curvature:0};let good=true;
        // Test off-node positions at every profile and endpoint tangent planes.
        for(let j=0;j<count&&good;j++)for(const fraction of [.23,.61,.89]){
          const u=(j+fraction)/count,expected=data(u);
          for(let k=0;k<edges.length;k++){
            const q=surfaceNormalAtUV(R,patch,[u,k/(edges.length-1)]),error=length(sub(q.position,expected.points[k]));quality.contact=Math.max(quality.contact,error);
            if(!Number.isFinite(error)||error>tolerance*.25){good=false;break;}
            if(k===0||k===edges.length-1){
              const side=k===0?0:1;if(conditions[side].mode==='none')continue;
              const target=endSupports[side]?unit(read(endSupports[side].normalAt(expected.points[k]))):unit(cross(derivative(t=>at(edges[k],t),u),expected.derivatives[side]));
              const angle=Math.acos(Math.min(1,Math.abs(dot(target,q.normal))))*180/Math.PI;quality.angle=Math.max(quality.angle,angle);
              const jetError=length(sub(q.vDerivative,expected.derivatives[side]))/length(expected.derivatives[side]);quality.jet=Math.max(quality.jet,jetError);
              if(conditions[side].mode==='curvature'){
                const check=compareSurfaceContinuity(R,patch,endSupports[side],expected.points[k],derivative(t=>at(edges[k],t),u),{leftUV:[u,side]});
                quality.curvature=Math.max(quality.curvature,check.curvatureError);
                if(check.curvatureError>.00025||check.positionError>tolerance*.25){good=false;break;}
              }
              if(!Number.isFinite(angle)||angle>.25||!Number.isFinite(jetError)||jetError>1e-4){good=false;break;}
            }
          }
        }
        if(good)break;patch.delete();patch=null;
      }
      if(!patch)throw new Error(`The ${loopIndex?'inner':'outer'} loft wall could not meet endpoint tolerances (contact ${quality.contact.toExponential(2)} mm, normal mismatch ${quality.angle.toFixed(4)} deg, curvature mismatch ${quality.curvature.toExponential(2)} 1/mm)`);
      owned.push(patch);
      if(conditions.some(c=>c.mode==='curvature'))checkCurvatureRegularity(R,patch);
      patches.push({face:patch,edges,endSupports,quality,data});
    }
    }
    if(supports.some(list=>list.some(s=>!s.used)))throw new Error('A selected support face is not adjacent to the endpoint profile');
    const faces=patches.map(p=>p.face);
    if(!surface){for(const index of [0,wires.length-1]){let cap=R.makeFace(wires[index]);if(holes.length){const outer=cap;try{cap=R.addHolesInFace(outer,holes.map(loop=>loop[index]));}finally{outer.delete();}}owned.push(cap);faces.push(cap);}}
    sewn=sew(faces,tolerance);
    result=surface?sewn:solid(sewn);if(!result)throw new Error('The endpoint loft could not be closed into a solid');
    if(result===sewn)sewn=null;
    const check=new (R.getOC()).BRepCheck_Analyzer(result.wrapped,true);try{if(!check.IsValid())throw new Error('The endpoint loft produced an invalid boundary representation');}finally{check.delete();}
    // Sewing may alter tolerances/topology: validate positions and normals again
    // on the final CAD faces, using their unchanged surface parameters.
    const finalFaces=result.faces;let contact=0,angle=0,curvature=0;
    try{for(const p of patches){
      const probe=surfaceNormalAtUV(R,p.face,[.37,.41]).position;
      const found=finalFaces.find(face=>length(sub(surfaceNormalAtUV(R,face,[.37,.41]).position,probe))<1e-7);
      if(!found)throw new Error('A final endpoint loft face could not be verified');
      for(let j=0;j<33;j++)for(const side of [0,1]){
        const mode=conditions[side].mode;if(mode==='none')continue;
        const u=(j+.37)/33,q=surfaceNormalAtUV(R,found,[u,side]),edge=p.edges[side===0?0:p.edges.length-1],point=at(edge,u);
        const target=p.endSupports[side]?unit(read(p.endSupports[side].normalAt(point))):unit(cross(derivative(t=>at(edge,t),u),conditions[side].direction));
        const error=length(sub(q.position,point)),a=Math.acos(Math.min(1,Math.abs(dot(target,q.normal))))*180/Math.PI;
        contact=Math.max(contact,error);angle=Math.max(angle,a);
        const expected=p.data(u).derivatives[side],jetError=length(sub(q.vDerivative,expected))/length(expected);
        if(mode==='curvature'){
          const check=compareSurfaceContinuity(R,found,p.endSupports[side],point,derivative(t=>at(edge,t),u),{leftUV:[u,side]});
          curvature=Math.max(curvature,check.curvatureError);
          if(check.curvatureError>.001||check.positionError>tolerance)throw new Error('The final CAD loft failed endpoint curvature or support contact verification (G2)');
        }
        if(!Number.isFinite(error)||!Number.isFinite(a)||error>tolerance||a>.5||!Number.isFinite(jetError)||jetError>1e-4)throw new Error('The final CAD loft failed endpoint contact or tangency verification');
      }
    }}finally{finalFaces.forEach(f=>f.delete());}
    const out={shape:result,contact,angle,curvature};result=null;return out;
  }finally{result?.delete();sewn?.delete();owned.forEach(x=>x.delete());loopRows.flat(2).forEach(e=>e.delete());baselineRows.flat(2).forEach(e=>e.delete());supports.flat().forEach(s=>s.edges.forEach(e=>e.delete()));}
}

// Reject contradictory endpoint tangents before attempting guide refinement.
// This uses native curve attachment and tangents, independent of fit stations.
export function checkLoftEndGuides(R,guides,wires,conditions,slack=0){
  const rows=[wires[0],wires.at(-1)].map(w=>orderedEdges(R,w)),neighbors=[wires[1],wires.at(-2)].map(w=>orderedEdges(R,w));
  const distance=(p,shape)=>{const v=R.makeVertex(p),q=new R.DistanceQuery(v);try{return q.distanceTo(shape);}finally{q.delete();v.delete();}};
  try{if(rows.some((row,i)=>row.length!==neighbors[i].length))throw new Error('Endpoint conditions require matching curve counts in all profiles');
  for(const guide of guides){
    const ends=guide.contacts?guide.contacts.map(c=>c.p):[read(guide.wire.pointAt(0)),read(guide.wire.pointAt(1))];
    const reverse=guide.contacts?false:distance(ends[1],wires[0])<distance(ends[0],wires[0]);
    for(const side of [0,1]){
      const c=conditions[side];if(c.mode==='none')continue;
      const t=reverse?1-side:side,p=ends[t],tangent=guide.contacts?unit(guide.contacts[side].tangent):mul(unit(read(guide.wire.tangentAt(t))),reverse?-1:1),candidates=rows[side].map((edge,index)=>({edge,index,gap:distance(p,edge)}));
      const nearest=Math.min(...candidates.map(e=>e.gap));
      if(nearest>1e-4+slack)throw new Error(`The guide ${guide.name} must meet both endpoint profiles`);
      for(const {edge,index:edgeIndex} of candidates.filter(e=>e.gap<nearest+1e-5)){
        let index=0,best=Infinity;for(let j=0;j<=64;j++){const d=length(sub(at(edge,j/64),p));if(d<best){best=d;index=j;}}
        let lo=Math.max(0,(index-1)/64),hi=Math.min(1,(index+1)/64);
        for(let j=0;j<40;j++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;if(length(sub(at(edge,a),p))<length(sub(at(edge,b),p)))hi=b;else lo=a;}
        const u=(lo+hi)/2,point=at(edge,u),along=unit(derivative(t=>at(edge,t),u));let direction;
        if(supported(c.mode)){
          const faces=c.faces.filter(face=>{const es=face.edges;try{return [.19,.53,.83].every(t=>es.some(e=>distance(at(edge,t),e)<1e-4));}finally{es.forEach(e=>e.delete());}});
          if(faces.length!==1)throw new Error('A guided endpoint needs an unambiguous adjacent support face');
          direction=cross(along,unit(read(faces[0].normalAt(point))));
        }else direction=c.direction;
        let across=unit(sub(direction,mul(along,dot(direction,along))));
        const other=at(neighbors[side][edgeIndex],u),chord=side===0?sub(other,point):sub(point,other);
        if(dot(across,chord)<0)across=mul(across,-1);if(c.reverse)across=mul(across,-1);
        const normal=unit(cross(along,across));
        if(Math.abs(dot(tangent,normal))>Math.sin(.5*Math.PI/180))throw new Error(`The guide ${guide.name} has a tangent incompatible with the ${side?'end':'start'} condition`);
        // The guide must cross the profile, rather than running along its edge.
        if(dot(tangent,across)<=1e-8)throw new Error(`The guide ${guide.name} has a direction incompatible with the endpoint condition`);
      }
    }
  }}finally{[...rows,...neighbors].flat().forEach(e=>e.delete());}
}

// Bounded projection onto the full [0,1]² CAD domains produced above. Unlike a
// global extrema grid, its memory does not grow with the B-spline knot count.
// A returned point inside this rectangle is on the actual untrimmed side face.
export function tensorFaceDistance(R,face,point,limit){
  const oc=R.getOC(),surface=face.surface,p=new oc.gp_Pnt(),du=new oc.gp_Vec(0,0,0),dv=new oc.gp_Vec(0,0,0);
  const xyz=p=>[p.X(),p.Y(),p.Z()];
  const evaluate=(u,v)=>{surface.wrapped.D1(u,v,p,du,dv);const q=xyz(p);return {q,u:xyz(du),v:xyz(dv),error:length(sub(point,q))};};
  let best=Infinity;
  try{
    const seeds=[];for(let i=0;i<=8;i++)for(let j=0;j<=8;j++){const a=i/8,b=j/8,q=evaluate(a,b);seeds.push({a,b,error:q.error});}
    seeds.sort((a,b)=>a.error-b.error);
    for(const seed of seeds.slice(0,4)){
      let {a,b}=seed,q=evaluate(a,b);best=Math.min(best,q.error);
      for(let i=0;i<24&&best>limit;i++){
        const r=sub(point,q.q),E=dot(q.u,q.u),F=dot(q.u,q.v),G=dot(q.v,q.v),det=E*G-F*F;
        if(!(det>1e-14*E*G))break;
        const A=(dot(r,q.u)*G-dot(r,q.v)*F)/det,B=(dot(r,q.v)*E-dot(r,q.u)*F)/det;
        let improved=false;
        for(let scale=1;scale>=1/128;scale/=2){
          const x=Math.max(0,Math.min(1,a+scale*A)),y=Math.max(0,Math.min(1,b+scale*B)),next=evaluate(x,y);
          if(next.error<q.error){a=x;b=y;q=next;best=Math.min(best,q.error);improved=true;break;}
        }
        if(!improved)break;
      }
      if(best<=limit)break;
    }
    return best;
  }finally{p.delete();du.delete();dv.delete();surface.delete();}
}
