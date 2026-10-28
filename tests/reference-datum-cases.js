import {solveReferenceDatum} from '/js/refconstraints.js';
import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
const plane=(n,p=[0,0,0])=>({kind:'plane',n,p}),point=p=>({kind:'point',p}),line=(a,b)=>({kind:'line',start:a,end:b,mid:a.map((v,i)=>(v+b[i])/2),d:b.map((v,i)=>(v-a[i])/Math.hypot(...b.map((v,i)=>v-a[i]))),curve:{type:'line'}});
const close=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]))<1e-7;
export function runSolverCases(){
  const P=plane([0,0,1]),X=plane([1,0,0]),Y=plane([0,1,0]),L=line([0,0,0],[10,0,0]);
  const cases=[
    ['empty plane','plane',[],[],'under'],
    ['one point leaves plane free','plane',[point([2,3,4])],[{}],'under'],
    ['two points leave rotation free','plane',[point([0,0,0]),point([10,0,0])],[{},{}],'under'],
    ['three points','plane',[point([0,0,4]),point([10,0,4]),point([0,10,4])],[{},{},{}],'defined',s=>Math.abs(Math.abs(s.value.h)-4)<1e-7],
    ['collinear points remain underdefined','plane',[point([0,0,0]),point([10,0,0]),point([20,0,0])],[{},{},{}],'under'],
    ['offset plane','plane',[P],[{relation:'offset',offset:7}],'defined',s=>s.value.h===7],
    ['parallel plane lacks position','plane',[P],[{relation:'parallel'}],'under'],
    ['parallel through point','plane',[P,point([5,2,9])],[{relation:'parallel'},{}],'defined',s=>s.value.h===9],
    ['offset conflicting point','plane',[P,point([0,0,9])],[{relation:'offset',offset:7},{}],'conflict'],
    ['contains line through external point','plane',[L,point([0,3,0])],[{relation:'coincident'},{}],'defined',s=>Math.abs(s.value.n[2])>1-1e-7],
    ['normal at midpoint','plane',[L],[{relation:'normal'}],'defined',s=>close(s.value.n,[1,0,0])&&Math.abs(s.value.h-5)<1e-7],
    ['normal through point','plane',[L,point([2,3,4])],[{relation:'perpendicular'},{}],'defined',s=>s.value.h===2],
    ['line angle gives two planes','plane',[L,P],[{relation:'coincident'},{relation:'angle',angle:30}],'defined',s=>s.alternatives===2&&Math.abs(s.value.n[2]-Math.sqrt(3)/2)<1e-7],
    ['incompatible angles','plane',[P,P],[{relation:'angle',angle:30},{relation:'angle',angle:60}],'conflict'],
    ['middle between planes','plane',[P,plane([0,0,1],[0,0,10])],[{},{}],'defined',s=>s.value.h===5],
    ['bisectors give two planes','plane',[P,X],[{},{}],'defined',s=>s.alternatives===2],
    ['cylinder tangent','plane',[{kind:'cylinder',o:[0,0,0],d:[0,0,1],r:5}],[{}],'defined',s=>s.alternatives===2&&s.value.h===5],
    ['impossible parallel tangent','plane',[{kind:'cylinder',o:[0,0,0],d:[0,0,1],r:5},P],[{relation:'tangent'},{relation:'parallel'}],'conflict'],
    ['axis between points','axis',[point([0,0,0]),point([0,0,10])],[{},{}],'defined',s=>close(s.value.d,[0,0,1])],
    ['coincident points do not define axis','axis',[point([1,2,3]),point([1,2,3])],[{},{}],'conflict'],
    ['axis intersection planes','axis',[X,Y],[{},{}],'defined',s=>Math.abs(s.value.d[2])>1-1e-7],
    ['parallel planes have no unique axis','axis',[P,plane([0,0,1],[0,0,5])],[{},{}],'conflict'],
    ['axis normal through point','axis',[P,point([1,2,3])],[{relation:'perpendicular'},{}],'defined',s=>close(s.value.o,[1,2,0])&&close(s.value.d,[0,0,1])],
    ['axis on line','axis',[L],[{}],'defined',s=>close(s.value.d,[1,0,0])],
    ['point three planes','point',[plane([1,0,0],[2,0,0]),plane([0,1,0],[0,3,0]),plane([0,0,1],[0,0,4])],[{},{},{}],'defined',s=>close(s.value,[2,3,4])],
    ['point on plane remains free','point',[P],[{}],'under',s=>s.dof===2],
    ['point line plane intersection','point',[line([2,3,0],[2,3,10]),plane([0,0,1],[0,0,4])],[{},{}],'defined',s=>close(s.value,[2,3,4])],
    ['point on skew lines impossible','point',[L,line([0,0,1],[0,10,1])],[{},{}],'conflict'],
    ['point intersect lines','point',[L,line([2,0,0],[2,10,0])],[{},{}],'defined',s=>close(s.value,[2,0,0])],
    ['midpoint point','point',[L],[{relation:'midpoint'}],'defined',s=>close(s.value,[5,0,0])],
    ['distance point','point',[L],[{relation:'distance',distance:3}],'defined',s=>close(s.value,[3,0,0])],
    ['outside segment rejected','point',[L],[{relation:'distance',distance:12}],'conflict'],
    ['centre of straight line rejected','point',[L],[{relation:'center'}],'conflict'],
    ['antiparallel axis references agree','axis',[L,line([10,0,0],[0,0,0])],[{},{}],'defined'],
    ['opposite plane normals agree','plane',[P,plane([0,0,-1])],[{relation:'coincident'},{relation:'coincident'}],'defined'],
    ['infinite offset rejected','point',[P],[{relation:'offset',offset:Infinity}],'conflict'],
    ['zero length direction rejected','axis',[{...L,d:[0,0,0]}],[{}],'conflict'],
  ];
  const results=cases.map(([name,type,geo,refs,status,check])=>{const solved=solveReferenceDatum(type,geo,refs);return {name,ok:solved.status===status&&(!check||check(solved)),solved};});
  // Independent geometric residuals after rigid rotations/translations: the
  // equations must work away from world axes and a conveniently located origin.
  for(let i=1;i<=12;i++){
    const t=i*.137,c=Math.cos(t),s=Math.sin(t),u=[c,s,0],v=[-s*c,c*c,s],n=[s*s,-c*s,c],origin=[10000+i*3,-5000+i*7,17-i];
    const move=(a,k)=>origin.map((x,j)=>x+a[j]*k),dot=(a,b)=>a.reduce((x,v,j)=>x+v*b[j],0),length=a=>Math.hypot(...a);
    const geo=[point(origin),point(move(u,7)),point(move(v,11))],solved=solveReferenceDatum('plane',geo,[{},{},{}]);
    results.push({name:`rotated translated plane ${i}`,ok:solved.status==='defined'&&Math.abs(Math.abs(dot(solved.value.n,n))-1)<1e-7&&geo.every(g=>Math.abs(dot(solved.value.n,g.p)-solved.value.h)<1e-7)});
    const planes=[plane(u,origin),plane(v,origin),plane(n,origin)],p=solveReferenceDatum('point',planes,[{},{},{}]);
    results.push({name:`rotated plane intersection point ${i}`,ok:p.status==='defined'&&close(p.value,origin)});
    const axis=solveReferenceDatum('axis',planes.slice(0,2),[{},{}]);
    results.push({name:`rotated plane intersection axis ${i}`,ok:axis.status==='defined'&&Math.abs(length(axis.value.d)-1)<1e-7&&planes.slice(0,2).every(g=>Math.abs(dot(g.n,axis.value.d))<1e-7&&Math.abs(dot(g.n,axis.value.o)-dot(g.n,g.p))<1e-7)});
    const gline=line(move(u,-5),move(u,5)),angular=[gline,plane(n,origin)],refs=[{relation:'coincident'},{relation:'angle',angle:30}],a=solveReferenceDatum('plane',angular,refs),b=solveReferenceDatum('plane',angular,refs,{solution:1});
    results.push({name:`rotated angular branches ${i}`,ok:[a,b].every(x=>x.status==='defined'&&x.alternatives===2&&Math.abs(dot(x.value.n,n)-Math.sqrt(3)/2)<1e-7&&Math.abs(dot(x.value.n,gline.start)-x.value.h)<1e-7&&Math.abs(dot(x.value.n,gline.end)-x.value.h)<1e-7)&&length(a.value.n.map((x,j)=>x-b.value.n[j]))>.1});
  }
  return {ok:results.every(r=>r.ok),results};
}

export function fixture(type='plane',refs=[]){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'},visible:false});
  const line=S.addLine(sk,S.addPoint(sk,0,0),S.addPoint(sk,10,0));
  const crossing=S.addLine(sk,S.addPoint(sk,3,-5),S.addPoint(sk,3,5));
  const circle=S.addCircle(sk,'O',5),arc=S.addArc(sk,S.addPoint(sk,20,0),S.addPoint(sk,25,0),S.addPoint(sk,20,5));doc.features.push(sk);
  const points=[[0,0,4],[10,0,4],[0,10,4]].map(([x,y,z])=>{const p=M.createFeature(doc,'point',{pointType:'coords',x,y,z});doc.features.push(p);return p;});
  const feature=M.createFeature(doc,type,{referenceDefinition:true,refs,axisType:'references',...(type==='point'?{pointType:'references'}:{})});doc.features.push(feature);
  return {doc,sk,line,crossing,circle,arc,points,feature};
}

export async function run({threads=1}={}){
  const algebra=runSolverCases();if(!algebra.ok)return {ok:false,algebra};
  const kernel=new KernelClient({threads}),results=[];
  const planeRef=(id,relation,extra={})=>({kind:'plane',id,...(relation?{relation}:{}),...extra});
  const cases=[
    {name:'three linked points',refs:d=>d.points.map(p=>({kind:'point',id:p.id})),check:r=>Math.abs(Math.abs(r.planes?.n?.[2]||0)-1)<1e-7},
    {name:'offset equation',refs:()=>[planeRef('front','offset',{offset:'gap*2'})],edit:d=>{d.doc.equations=[{name:'gap',expr:'3'}];},position:[0,0,6]},
    {name:'underdefined plane',refs:d=>d.points.slice(0,2).map(p=>({kind:'point',id:p.id})),status:'under'},
    {name:'conflicting point and plane',refs:d=>[planeRef('front','offset',{offset:5}),{kind:'point',id:d.points[0].id}],status:'conflict'},
    {name:'normal through linked point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'perpendicular'},{kind:'point',id:d.points[1].id}],normal:[1,0,0],position:[10,0,0]},
    {name:'plane coincident with sketch circle',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.circle}],normal:[0,0,1],position:[0,0,0]},
    {name:'placement after coincident plane',refs:()=>[planeRef('front','coincident')],edit:d=>{d.feature.moveBy=7;},position:[0,0,7]},
    {name:'line and external point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'coincident'},{kind:'point',id:d.points[0].id}],normal:[0,1,0]},
    {name:'two angular solutions',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'coincident'},planeRef('front','angle',{angle:30})],alternatives:2},
    {name:'alternate angular solution',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'coincident'},planeRef('front','angle',{angle:30})],edit:d=>{d.feature.solution=1;},alternatives:2},
    {name:'bisector alternatives',refs:()=>[planeRef('front'),planeRef('right')],alternatives:2},
    {name:'axis from two point refs',type:'axis',refs:d=>d.points.slice(0,2).map(p=>({kind:'point',id:p.id})),direction:[1,0,0]},
    {name:'axis from two planes',type:'axis',refs:()=>[planeRef('front'),planeRef('right')],direction:[0,1,0]},
    {name:'axis from sketch line',type:'axis',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line}],direction:[1,0,0]},
    {name:'axis normal to plane through point',type:'axis',refs:d=>[planeRef('front','perpendicular'),{kind:'point',id:d.points[1].id}],direction:[0,0,1]},
    {name:'axis duplicate points rejected',type:'axis',refs:d=>[{kind:'point',id:d.points[0].id},{kind:'point',id:d.points[0].id}],status:'conflict'},
    {name:'point on plane remains free',type:'point',refs:()=>[planeRef('front')],status:'under'},
    {name:'point three offset planes',type:'point',refs:()=>[planeRef('right','offset',{offset:2}),planeRef('top','offset',{offset:3}),planeRef('front','offset',{offset:4})],point:[2,3,4]},
    {name:'point at sketch midpoint',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'midpoint'}],point:[5,0,0]},
    {name:'point at sketch endpoint',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'end'}],point:[10,0,0]},
    {name:'point on line by distance',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'distance',distance:'2+1'}],point:[3,0,0]},
    {name:'point outside line rejected',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'distance',distance:11}],status:'conflict'},
    {name:'point circle center',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.circle,relation:'center'}],point:[0,0,0]},
    {name:'point arc midpoint is on arc',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.arc,relation:'midpoint'}],point:[20+5/Math.sqrt(2),5/Math.sqrt(2),0]},
    {name:'point at line intersection',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:d.line,relation:'coincident'},{kind:'sketch',sketch:d.sk.id,curve:d.crossing,relation:'coincident'}],point:[3,0,0]},
    {name:'deleted reference reports conflict',type:'point',refs:d=>[{kind:'sketch',sketch:d.sk.id,curve:'gone',relation:'midpoint'}],status:'conflict'},
    ...[
      ['tangent cylinder plane','plane',[{kind:'face',p:[5,5,0],relation:'tangent'}],null],
      ['tangent parallel plane','plane',[{kind:'face',p:[5,5,0],relation:'tangent'},planeRef('front','parallel')],null],
      ['impossible tangent parallel plane','plane',[{kind:'face',p:[5,5,0],relation:'tangent'},planeRef('top','parallel')],'conflict'],
      ['cylinder centre axis','axis',[{kind:'face',p:[5,5,0]}],null],
      ['circular model edge axis','axis',[{kind:'edge',p:[5,0,0]}],null],
      ['circular model edge centre','point',[{kind:'edge',p:[5,0,0],relation:'center'}],null],
    ].map(([name,type,refs,status])=>({name,type,refs:()=>structuredClone(refs),...(status?{status}:{}),bodyRef:true,edit:d=>{
      const s=M.createFeature(d.doc,'sketch',{plane:{ref:'top'}});S.addCircle(s,'O',5);const solid=M.createFeature(d.doc,'extrude',{sketch:s.id,depth:10});d.doc.features.splice(-1,0,s,solid);
    }})),
    // curved references (kernel crossings): the cylinder's bottom edge (radius 5 round the y axis, y = 0) meets Front
    // (z = 0) at x = ±5 (the second choice the other one); its top edge rounded R2 (a torus: centre circle radius 3 at
    // y = 8, tube 2) meets the vertical axis through x = 4 at y = 8 + √3
    ...[
      ['circular model edge meets a plane',[{kind:'edge',p:[5,0,0]},{kind:'plane',id:'front'}],{oneOf:[[5,0,0],[-5,0,0]],alternatives:2}],
      ['other crossing of a circular edge and a plane',[{kind:'edge',p:[5,0,0]},{kind:'plane',id:'front'}],{oneOf:[[5,0,0],[-5,0,0]],alternatives:2,solution:1}],
      ['rounded face meets an axis',[{kind:'face',p:[3+2*Math.SQRT1_2,8+2*Math.SQRT1_2,0]},{kind:'axis'}],{point:[4,8+Math.sqrt(3),0],alternatives:1,round:true}],
      ['rounded face and a plane meet along a curve',[{kind:'face',p:[3+2*Math.SQRT1_2,8+2*Math.SQRT1_2,0]},{kind:'plane',id:'front'}],{status:'conflict',round:true}],
    ].map(([name,refs,o])=>({name,type:'point',refs:()=>structuredClone(refs),bodyRef:true,...(o.status?{status:o.status}:{point:o.point,oneOf:o.oneOf,alternatives:o.alternatives}),edit:d=>{
      const s=M.createFeature(d.doc,'sketch',{plane:{ref:'top'}});S.addCircle(s,'O',5);const solid=M.createFeature(d.doc,'extrude',{sketch:s.id,depth:10});
      const extra=[s,solid];
      if(o.round)extra.push(M.createFeature(d.doc,'fillet',{radius:2,edges:[{p:[5,10,0]}]}));
      const ax=d.feature.refs.find(r=>r.kind==='axis');
      if(ax){const q=[[4,0,0],[4,20,0]].map(([x,y,z])=>M.createFeature(d.doc,'point',{pointType:'coords',x,y,z})),axis=M.createFeature(d.doc,'axis',{referenceDefinition:true,axisType:'references',refs:q.map(p=>({kind:'point',id:p.id}))});extra.push(...q,axis);ax.id=axis.id;}
      if(o.solution)d.feature.solution=o.solution;
      d.doc.features.splice(-1,0,...extra);
    }})),
  ];
  try{await kernel.ready;
    for(const c of cases){
      const d=fixture(c.type||'plane');d.feature.refs=c.refs(d);c.edit?.(d);
      if(c.bodyRef){const base=await kernel.rebuild({...d.doc,features:d.doc.features.slice(0,-1)});d.feature.refs[0].body=base.body.bodies[0].id;}
      const r=await kernel.rebuild(d.doc),info=r.info?.[d.feature.id]?.datum,status=info?.status;
      const item={name:c.name,status,errors:r.errors,ok:status===(c.status||'defined')};
      if(!c.status){
        const value=d.feature.type==='plane'?r.planes[d.feature.id]:d.feature.type==='axis'?r.axes[d.feature.id]:r.points[d.feature.id];item.value=value;
        item.ok&&=!r.errors.length&&!!value;
        if(c.normal)item.ok&&=Math.abs(Math.abs(value.n.reduce((s,v,i)=>s+v*c.normal[i],0))-1)<1e-7;
        if(c.direction)item.ok&&=Math.abs(Math.abs(value.d.reduce((s,v,i)=>s+v*c.direction[i],0))-1)<1e-7;
        if(c.position)item.ok&&=Math.abs(value.n.reduce((s,v,i)=>s+v*(c.position[i]-value.o[i]),0))<1e-7;
        if(c.point)item.ok&&=close(value,c.point);
        if(c.oneOf)item.ok&&=c.oneOf.some(q=>close(value,q));
        if(c.alternatives)item.ok&&=info.alternatives===c.alternatives;
        if(c.check)item.ok&&=c.check({planes:value});
        const cached=await kernel.rebuild(d.doc);item.ok&&=cached.info?.[d.feature.id]?.datum?.status==='defined';
      }
      results.push(item);
    }
    const crossings=['circular model edge meets a plane','other crossing of a circular edge and a plane'].map(n=>results.find(r=>r.name===n)?.value);
    results.push({name:'the two crossings are the two choices',ok:crossings.every(Boolean)&&!close(...crossings)});
    const chain=fixture();chain.feature.refs=chain.points.map(p=>({kind:'point',id:p.id}));
    const profile=M.createFeature(chain.doc,'sketch',{plane:{ref:chain.feature.id}});S.addCircle(profile,'O',2);const solid=M.createFeature(chain.doc,'extrude',{sketch:profile.id,depth:3});chain.doc.features.push(profile,solid);
    const before=await kernel.rebuild(chain.doc);for(const p of chain.points)p.z=8;const after=await kernel.rebuild(chain.doc);
    const vertices=after.body?.vertices||[],zs=Array.from(vertices).filter((_,i)=>i%3===2);
    const measurement=after.body?.bodies?.[0]&&await kernel.request('measure',{refs:[{kind:'body',id:after.body.bodies[0].id}]});
    results.push({name:'source points update plane and downstream extrusion',ok:!before.errors.length&&!after.errors.length&&zs.length>0&&Math.abs(Math.min(...zs)-8)<1e-6&&Math.abs(Math.max(...zs)-11)<1e-6&&Math.abs(measurement.items[0].volume-12*Math.PI)<1e-6,errors:after.errors});
    const health=await kernel.stats();return {ok:results.every(r=>r.ok)&&!kernel.restarts,algebra,results,health};
  }finally{kernel.dispose();}
}
