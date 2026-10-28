import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import * as LC from '/js/loftcorrespondence.js';
import {KernelClient} from '/js/kernelclient.js';
const close=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]))<1e-6;
export function fixture({type='loft',circle=false,open=false}={}){
  const doc=M.newDoc(),profiles=[],sources=[];
  for(let i=0;i<2;i++){
    let ref='front';if(i){const p=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:20});doc.features.push(p);ref=p.id;}
    const sk=M.createFeature(doc,'sketch',{plane:{ref}});let points=[];
    if(circle)S.addCircle(sk,'O',10);
    else if(open)S.addLine(sk,S.addPoint(sk,0,0),S.addPoint(sk,i?0:10,i?10:0));
    else {points=[[-5,-5],[5,-5],[5,5],[-5,5]].map(q=>S.addPoint(sk,...q));points.forEach((p,j)=>S.addLine(sk,p,points[(j+1)%4]));}
    doc.features.push(sk);profiles.push(open?LR.chainRef(sk,sk.id,sk.curves[0].id):LR.regionRef(sk.id,LR.selectableRegions(sk)[0]));sources.push({sk,points});
  }
  const feature=M.createFeature(doc,type,{profiles,correspondenceMode:'manual',loftCorrespondence:{},ruled:true});doc.features.push(feature);
  return {doc,feature,sources,profiles};
}
export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];
  try{await kernel.ready;
    const base=fixture(),baseline=await kernel.rebuild(base.doc),rows=baseline.info?.[base.feature.id]?.loftConnections?.sections;
    if(baseline.errors.length||!rows)return {ok:false,baseline};
    const next=rows[1].points[1],point=base.sources[1].sk.points.find(p=>close([p.x,p.y,20],next)).id;
    const cases=[
      {name:'manual baseline preserves prism',volume:2000},
      {name:'quarter-turn correspondence changes actual solid',volume:4000/3,edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};}},
      {name:'both starts shifted preserves prism',volume:2000,edit:d=>{d.profiles.forEach((ref,i)=>{const q=rows[i].points[1],p=d.sources[i].sk.points.find(p=>close([p.x,p.y,i*20],q));d.feature.loftCorrespondence[LR.refKey(ref)]={point:p.id};});}},
      {name:'automatic ignores dormant missing anchor',volume:2000,edit:d=>{d.feature.correspondenceMode='auto';d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point:'gone'};}},
      {name:'missing manual anchor reports error',reject:/connector point.*missing/,edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point:'gone'};}},
      {name:'opposite closed traversal is rejected',reject:/invalid|could not|loft/i,edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={reverse:true};}},
      {name:'reorder retains profile keyed correspondence',volume:4000/3,edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};d.feature.profiles.reverse();}},
      {name:'source rename preserves connector',volume:4000/3,edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};d.sources[1].sk.name='Fret 12';}},
      {name:'surface closed correspondence',type:'surfLoft',edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};}},
      {name:'open surface direction is applied',type:'surfLoft',open:true,probe:[0,5,10],edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={reverse:true};}},
      {name:'open surface endpoint anchor is applied',type:'surfLoft',open:true,probe:[0,5,10],edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point:d.sources[1].sk.curves[0].p2};}},
      {name:'circle default manual seam',circle:true,volume:2000*Math.PI},
      {name:'circle auto seam ignores sketch-axis rotation',circle:true,volume:2000*Math.PI,edit:d=>{d.doc.features.find(f=>f.type==='plane').turn=45;}},
      {name:'circle auto traversal handles opposite normals',circle:true,volume:2000*Math.PI,edit:d=>{d.doc.features.find(f=>f.type==='plane').reverse=true;}},
      {name:'circular seam angle is geometric',circle:true,volume:4000*Math.PI/3,edit:d=>{d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={circle:d.sources[1].sk.curves[0].id,angle:'90'};}},
      {name:'manual Thin follows the connectors (both walls turn a quarter)',volume:2/3*(100-64)*20,edit:d=>{d.feature.thin=true;d.feature.thinT=1;d.feature.thinDir='other';d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};}},
      {name:'normal endpoint conditions retain connectors',edit:d=>{d.feature.ruled=false;d.feature.startCondition='normal';d.feature.endCondition='normal';d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};}},
      {name:'solid holes retain automatic inner correspondence',volume:4000/3-80*Math.PI,edit:d=>{
        d.feature.profiles=d.sources.map(({sk})=>{S.addCircle(sk,'O',2);return LR.regionRef(sk.id,LR.selectableRegions(sk).find(r=>r.holes.length));});d.feature.loftCorrespondence[LR.refKey(d.feature.profiles[1])]={point};
      }},
      ...['adaptive','constrained'].map(method=>({name:method+' guides retain manual correspondence',edit:d=>{
        const a=rows[0].points[0],b=rows[1].points[1],guide=M.createFeature(d.doc,'sketch3d',{segs:null,pts:[{x:a[0],y:a[1],z:a[2]},{x:b[0],y:b[1],z:b[2]}],kind:'lines',radius:0});d.doc.features.splice(-1,0,guide);d.feature.guides=[guide.id];d.feature.guideMethod=method;d.feature.ruled=false;d.feature.loftCorrespondence[LR.refKey(d.profiles[1])]={point};
      }})),
    ];
    for(const c of cases){const d=fixture(c);c.edit?.(d);const r=await kernel.rebuild(d.doc),info=r.info?.[d.feature.id]?.loftConnections,item={name:c.name,errors:r.errors,ok:false};
      if(c.reject)item.ok=r.errors.some(([,e])=>c.reject.test(e));
      else if(!r.errors.length){
        const body=r.body?.bodies?.at(-1),m=body&&(await kernel.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];item.measure=m;item.connections=info;
        item.ok=!!m&&m.solid===(d.feature.type==='loft')&&(d.feature.correspondenceMode==='auto'||!!info);
        if(c.volume)item.ok&&=Math.abs(m.volume-c.volume)/c.volume<2e-5;
        if(c.probe){const q=await kernel.request('measure',{refs:[{kind:'point',p:c.probe},{kind:'body',id:body.id}]});item.distance=q.distance;item.ok&&=q.distance<1e-5;}
      }
      results.push(item);
    }
    const {curvatureFixture}=await import('./loft-end-cases.js'),g2=curvatureFixture({both:true});g2.loft.correspondenceMode='manual';g2.loft.loftCorrespondence={[LR.refKey(g2.loft.profiles[1])]:{circle:g2.profiles[1].curves[0].id,angle:15}};
    const endResult=await kernel.rebuild(g2.doc);results.push({name:'manual circular seam with G2 at both ends',ok:!endResult.errors.length&&endResult.body?.bodies?.some(b=>b.kind==='solid'),errors:endResult.errors});
    // several connectors: a square (corners at 0°, 90°, 180°, 270°, radius 14) lofted ruled to a hexagon (radius 12) 20
    // above, corners 1 to 4 of the square to the hexagon's 0, 1, 3 and 4. The square's sides between corners 2 and 3 and
    // between corners 4 and 1 are halved (the hexagon has two sides there), so the vertices pair as listed below; the
    // sides are bilinear, the section's area quadratic in height: Simpson gives the volume exactly
    const polygonLoft=({hexExtra=[1,3,4],squareExtra=[1,2,3]}={})=>{
      const doc=M.newDoc(),plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:20}),sks=[],refs=[];
      for(const [ref,n,R] of [['front',4,14],[plane.id,6,12]]){
        const sk=M.createFeature(doc,'sketch',{plane:{ref}}),pts=Array.from({length:n},(_,i)=>S.addPoint(sk,R*Math.cos(2*Math.PI*i/n),R*Math.sin(2*Math.PI*i/n)));
        pts.forEach((q,i)=>S.addLine(sk,q,pts[(i+1)%n]));sks.push({sk,pts});
      }
      doc.features.push(sks[0].sk,plane,sks[1].sk);
      for(const {sk} of sks)refs.push(LR.regionRef(sk.id,LR.selectableRegions(sk)[0]));
      const feature=M.createFeature(doc,'loft',{profiles:refs,correspondenceMode:'manual',ruled:true,loftCorrespondence:{
        [LR.refKey(refs[0])]:{point:sks[0].pts[0],extra:squareExtra.map(i=>sks[0].pts[i])},[LR.refKey(refs[1])]:{point:sks[1].pts[0],extra:hexExtra.map(i=>sks[1].pts[i])}}});
      doc.features.push(feature);return {doc,feature};
    };
    {
      const sq=i=>[14*Math.cos(Math.PI*i/2),14*Math.sin(Math.PI*i/2)],hx=i=>[12*Math.cos(Math.PI*i/3),12*Math.sin(Math.PI*i/3)],mid=(p,q)=>[(p[0]+q[0])/2,(p[1]+q[1])/2];
      const P=[sq(0),sq(1),mid(sq(1),sq(2)),sq(2),sq(3),mid(sq(3),sq(0))],Q=[0,1,2,3,4,5].map(hx),Mm=P.map((p,i)=>mid(p,Q[i]));
      const area=V=>Math.abs(V.reduce((s,p,i)=>{const q=V[(i+1)%V.length];return s+p[0]*q[1]-q[0]*p[1];},0))/2,want=20/6*(area(P)+4*area(Mm)+area(Q));
      const d=polygonLoft(),r=await kernel.rebuild(d.doc),body=r.body?.bodies?.at(-1),m=body&&(await kernel.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];
      results.push({name:'four connectors pair a square with a hexagon',ok:!r.errors.length&&!!m&&m.solid&&Math.abs(m.volume-want)<1e-6*want,volume:m?.volume,expected:want,errors:r.errors});
      for(const [name,o,re] of [['crossed connectors rejected',{hexExtra:[4,3,1]},/same order/],['unequal connector counts rejected',{squareExtra:[1,2]},/same number of connectors/]]){
        const e=polygonLoft(o),x=await kernel.rebuild(e.doc);results.push({name,ok:x.errors.some(([,msg])=>re.test(msg)),errors:x.errors});
      }
    }
    const health=await kernel.stats();return {ok:results.every(r=>r.ok)&&!kernel.restarts,results,health};
  }finally{kernel.dispose();}
}
