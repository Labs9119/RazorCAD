import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
import {tangentFixture,curvatureFixture} from '/tests/loft-end-cases.js';

// Split two 10 x 10 planar surfaces at x=3. Loft only the 2 x 10
// portions at their right, keeping the original sketches behind the faces.
export function fixture(type='loft', guided=false) {
  const doc=M.newDoc(),profiles=[],faces=[];
  for(const z of [0,20]) {
    const sk=M.createFeature(doc,'sketch',{plane:{ref:'face',frame:{o:[0,0,z],u:[1,0,0],v:[0,1,0],n:[0,0,1]}}});
    const pts=[[-5,-5],[5,-5],[5,5],[-5,5]].map(p=>S.addPoint(sk,...p));
    pts.forEach((p,i)=>S.addLine(sk,p,pts[(i+1)%4]));doc.features.push(sk);
    const face=M.createFeature(doc,'surfPlanar',{sketch:sk.id});doc.features.push(face);faces.push(face);
    profiles.push({kind:'modelFace',body:face.id,p:[4,0,z],n:[0,0,1]});
  }
  const plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'right'}],offset:3});doc.features.push(plane);
  const split=M.createFeature(doc,'splitLine',{tool:plane.id,faces:profiles.map(r=>({p:r.p.slice(),body:r.body}))});doc.features.push(split);
  const guide=M.createFeature(doc,'sketch',{plane:{ref:'face',frame:{o:[0,0,0],u:[1,0,0],v:[0,0,1],n:[0,-1,0]}}});
  const curve=S.addLine(guide,S.addPoint(guide,5,0),S.addPoint(guide,5,20));doc.features.push(guide);
  const feature=M.createFeature(doc,type,{profiles,guides:guided?[{kind:'sketchContour',sketch:guide.id,curves:[curve]}]:[],merge:false});doc.features.push(feature);
  return {doc,feature,guide,faces,split};
}

export async function run({threads=1}={}) {
  const k=new KernelClient({threads}),results=[];await k.ready;
  try {
    for(const type of ['loft','surfLoft'])for(const guided of [false,true]) {
      const d=fixture(type,guided),r=await k.rebuild(d.doc),body=r.body?.bodies?.find(b=>M.bodyOwner(b.id)===d.feature.id);
      const m=body&&(await k.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];
      const expected=type==='loft'?400:480,value=type==='loft'?m?.volume:m?.area;
      results.push({name:`${type}, split face, guide ${guided}`,ok:!r.errors.length&&Math.abs(value-expected)<1e-4,errors:r.errors,value,expected});
      if(guided) {
        // A saved reference must still select the small trimmed face on reload.
        const again=await k.rebuild(JSON.parse(JSON.stringify(d.doc)));
        results.push({name:`${type}, saved face references`,ok:!again.errors.length,errors:again.errors});
        d.guide.points.forEach(p=>p.x+=1);
        const bad=await k.rebuild(d.doc);
        results.push({name:`${type}, guide misses boundary`,ok:bad.errors.some(([id,e])=>id===d.feature.id&&/doesn't touch/.test(e)),errors:bad.errors});
      }
    }
    const missing=fixture();missing.feature.profiles[0].body='deleted-body';
    const r=await k.rebuild(missing.doc);
    results.push({name:'missing face body is not replaced by a nearby face',ok:r.errors.some(([id,e])=>id===missing.feature.id&&/missing/.test(e)),errors:r.errors});
    const curved=fixture('loft',true);curved.guide.curves=[];
    const spline=S.addCtrlSpline(curved.guide,[[5,0],[8,20/3],[8,40/3],[5,20]].map(p=>S.addPoint(curved.guide,...p)),3);
    curved.feature.guides=[{kind:'sketchContour',sketch:curved.guide.id,curves:[spline]}];
    const cr=await k.rebuild(curved.doc),cb=cr.body?.bodies?.find(b=>M.bodyOwner(b.id)===curved.feature.id);
    const gap=cb&&(await k.request('measure',{refs:[{kind:'vertex',p:[7.25,0,10]},{kind:'body',id:cb.id}]})).distance;
    results.push({name:'split faces follow a curved sketch rail',ok:!cr.errors.length&&gap<=.01,errors:cr.errors,gap});
    const splineDoc=M.newDoc(),splineRefs=[];
    for(const [z,depth] of [[0,10],[20,15]]) {
      const sk=M.createFeature(splineDoc,'sketch',{plane:{ref:'face',frame:{o:[0,0,z],u:[1,0,0],v:[0,1,0],n:[0,0,1]}}});
      const pts=[[-5,0],[-5,-1],[-5,-depth],[0,-depth],[5,-depth],[5,-1],[5,0]].map(p=>S.addPoint(sk,...p));
      S.addLine(sk,pts.at(-1),pts[0]);S.addCtrlSpline(sk,pts,5);splineDoc.features.push(sk);splineRefs.push(sk.id);
    }
    const spans=splineDoc.features.map(sk=>S.profileRegions(sk,true)[0].outer.segs.length);
    const sf=M.createFeature(splineDoc,'surfLoft',{profiles:splineRefs});splineDoc.features.push(sf);
    const sr=await k.rebuild(splineDoc);
    const splineBody=sr.body?.bodies?.find(b=>M.bodyOwner(b.id)===sf.id);
    results.push({name:'corresponding degree-five splines retain a single curved loft face',ok:spans[0]!==spans[1]&&!sr.errors.length&&splineBody?.faceCount===2,spans,faces:splineBody?.faceCount,errors:sr.errors});
    const secondSpline=splineDoc.features.find(f=>f.id===splineRefs[1]);secondSpline.points.forEach(p=>{if(p.y===-15)p.y=-11;});
    const sameSpans=S.profileRegions(secondSpline,true)[0].outer.segs.length,ssr=await k.rebuild(splineDoc),ssb=ssr.body?.bodies?.find(b=>M.bodyOwner(b.id)===sf.id);
    results.push({name:'equal fitted span counts still retain the native spline face',ok:sameSpans===spans[0]&&!ssr.errors.length&&ssb?.faceCount===2,spans:sameSpans,faces:ssb?.faceCount,errors:ssr.errors});
    // The heel's high-degree spline is also used as a surface extrusion. Keep
    // it as one face so a later Split Face reference still selects the whole side.
    splineDoc.features.pop();
    const extrusion=M.createFeature(splineDoc,'surfExtrude',{sketch:splineRefs[0],depth:20});splineDoc.features.push(extrusion);
    const er=await k.rebuild(splineDoc),eb=er.body?.bodies?.find(b=>M.bodyOwner(b.id)===extrusion.id);
    results.push({name:'degree-five surface extrusion has no fitted-cubic seams',ok:!er.errors.length&&eb?.faceCount===2,faces:eb?.faceCount,errors:er.errors});
    const cutPlane=M.createFeature(splineDoc,'plane',{refs:[{kind:'plane',id:'top'}],offset:-3});splineDoc.features.push(cutPlane);
    // Pick inside the curved side, away from its shared edge with the flat face.
    const source=splineDoc.features.find(f=>f.id===splineRefs[0]),sourceSpline=source.curves.find(c=>c.type==='spline');
    const q=S.bezierAt(S.splinePieces(source,sourceSpline)[10],.5);
    const splitHigh=M.createFeature(splineDoc,'splitLine',{tool:cutPlane.id,faces:[{p:[...q,10],body:extrusion.id}]});splineDoc.features.push(splitHigh);
    const shr=await k.rebuild(splineDoc),shb=shr.body?.bodies?.find(b=>M.bodyOwner(b.id)===extrusion.id);
    const poles=sourceSpline.pts.map(id=>{const p=S.getPoint(source,id);return [p.x,p.y];}),gaps=[];
    if(shb)for(const piece of S.bsplineBeziers(poles,5))for(const t of [.1,.5,.9]) {
      let points=piece.map(p=>p.slice());
      while(points.length>1)points=points.slice(1).map((p,i)=>p.map((x,j)=>points[i][j]*(1-t)+x*t));
      gaps.push((await k.request('measure',{refs:[{kind:'vertex',p:[...points[0],10]},{kind:'body',id:shb.id}]})).distance);
    }
    // Two crossings split the U-shaped side into three faces; the flat side stays whole.
    results.push({name:'plane splits the complete high-degree extrusion face',ok:!shr.errors.length&&shb?.faceCount===4&&gaps.length===6&&gaps.every(d=>d<1e-6),faces:shb?.faceCount,gaps,errors:shr.errors});
    const ends=tangentFixture({type:'surfLoft'}),{doc:endDoc,profiles:endSketches,loft:endLoft}=ends;
    const upper=M.createFeature(endDoc,'extrude',{sketch:endSketches.at(-1).id,depth:20,merge:false});endDoc.features.splice(-1,0,upper);
    endLoft.profiles=[{kind:'modelFace',p:[0,0,0],body:ends.supportFeature?.id||endDoc.features.find(f=>f.type==='extrude').id},{kind:'modelFace',p:[0,100,0],body:upper.id}];
    endLoft.startCondition=endLoft.endCondition='curvature';
    endLoft.endFaces=[[10,110,0],[-10,110,0],[0,110,10],[0,110,-10]].map(p=>({p,body:upper.id}));
    for(const guided of [false,true]) {
      if(guided){
        const rail=M.createFeature(endDoc,'sketch',{plane:{ref:'front'}});
        const curve=S.addCtrlSpline(rail,[[20,0],[20,20],[20,40],[10,60],[10,80],[10,100]].map(p=>S.addPoint(rail,...p)),5);
        endDoc.features.splice(-1,0,rail);endLoft.guides=[{kind:'sketchContour',sketch:rail.id,curves:[curve]}];
      }
      const result=await k.rebuild(endDoc);
      results.push({name:`model face sections, G2 at both supports, rail ${guided}`,ok:!result.errors.length&&result.notes[endLoft.id]?.includes('G2 curvature mismatch'),errors:result.errors,note:result.notes[endLoft.id]});
    }
    const railFeature=endDoc.features.find(f=>f.id===endLoft.guides[0].sketch),railSpline=railFeature.curves.find(c=>c.type==='spline');
    endLoft.guides[0].curves.push(S.addLine(railFeature,S.addPoint(railFeature,20,-20),railSpline.pts[0]),S.addLine(railFeature,railSpline.pts.at(-1),S.addPoint(railFeature,10,120)));
    const extended=await k.rebuild(endDoc);
    results.push({name:'G2 uses rail contacts inside an extended sketch chain',ok:!extended.errors.length&&extended.notes[endLoft.id]?.includes('Adaptive guides'),errors:extended.errors,note:extended.notes[endLoft.id]});
    const spherical=curvatureFixture({type:'surfLoft',both:true});
    spherical.loft.profiles=spherical.profiles.map((sk,i)=>{
      const cap=M.createFeature(spherical.doc,'surfPlanar',{sketch:sk.id});spherical.doc.features.splice(-1,0,cap);
      return {kind:'modelFace',body:cap.id,p:[0,i?30:0,0]};
    });
    const sphericalResult=await k.rebuild(spherical.doc);
    results.push({name:'model face profiles keep nonzero spherical G2 curvature',ok:!sphericalResult.errors.length&&sphericalResult.notes[spherical.loft.id]?.includes('G2 curvature mismatch'),errors:sphericalResult.errors,note:sphericalResult.notes[spherical.loft.id]});
    const curvedFaces=M.newDoc(),curvedRefs=[];
    for(const x of [0,20]) {
      const sk=M.createFeature(curvedFaces,'sketch',{plane:{ref:'front'}});
      S.addArc(sk,S.addPoint(sk,x,0),S.addPoint(sk,x+5,0),S.addPoint(sk,x,5));curvedFaces.features.push(sk);
      const side=M.createFeature(curvedFaces,'surfExtrude',{sketch:sk.id,depth:20});curvedFaces.features.push(side);
      curvedRefs.push({kind:'modelFace',body:side.id,p:[x+5/Math.sqrt(2),5/Math.sqrt(2),18.5]});
    }
    const cut=M.createFeature(curvedFaces,'plane',{refs:[{kind:'plane',id:'front'}],offset:17});curvedFaces.features.push(cut);
    curvedFaces.features.push(M.createFeature(curvedFaces,'splitLine',{tool:cut.id,faces:curvedRefs.map(r=>({p:r.p.slice(),body:r.body}))}));
    const cf=M.createFeature(curvedFaces,'surfLoft',{profiles:curvedRefs});curvedFaces.features.push(cf);
    const cfr=await k.rebuild(curvedFaces);
    results.push({name:'surface loft between small curved split faces',ok:!cfr.errors.length&&cfr.body?.bodies?.some(b=>M.bodyOwner(b.id)===cf.id),errors:cfr.errors});
    cf.type='loft';const solidCurved=await k.rebuild(curvedFaces);
    results.push({name:'solid loft explains curved profile restriction',ok:solidCurved.errors.some(([id,e])=>id===cf.id&&/flat profile faces/.test(e)),errors:solidCurved.errors});
    return {ok:results.every(r=>r.ok),results};
  } finally { k.dispose(); }
}
