import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import { KernelClient } from '/js/kernelclient.js';

export function fixture(kind='solid') {
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  if(kind==='cylinder')S.addCircle(sk,'O',10);
  else if(kind==='quilt'){
    const p=[[-10,-10],[10,-10],[10,10]].map(q=>S.addPoint(sk,...q));
    S.addLine(sk,p[0],p[1]);S.addLine(sk,p[1],p[2]);
  }else S.buildCenterRect(sk,'O',0,0,10,10);
  const source=M.createFeature(doc,kind==='plane'?'surfPlanar':kind==='solid'?'extrude':'surfExtrude',{sketch:sk.id,profiles:[sk.id],depth:20});
  doc.features.push(sk,source);return {doc,sk,source};
}

function tool(data,kind='face') {
  if(kind==='cylinder'){
    const plane=M.createFeature(data.doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:8}),sk=M.createFeature(data.doc,'sketch',{plane:{ref:plane.id}});
    S.addCircle(sk,'O',5);const surface=M.createFeature(data.doc,'surfExtrude',{profiles:[sk.id],depth:4});
    data.doc.features.push(plane,sk,surface);return surface.id;
  }
  const sk=M.createFeature(data.doc,'sketch',{plane:{ref:'front'}});
  if(kind==='sketch')S.addLine(sk,S.addPoint(sk,-1,10),S.addPoint(sk,1,10));
  else S.buildCenterRect(sk,S.addPoint(sk,0,10),0,10,2,2);
  data.doc.features.push(sk);
  if(kind==='sketch')return sk.id;
  const face=M.createFeature(data.doc,'surfPlanar',{profiles:[sk.id]});data.doc.features.push(face);return face.id;
}

export async function run({threads=1}={}){
  const kernel=new KernelClient({threads}),results=[];await kernel.ready;
  const cases=[
    {name:'solid into two bodies',kind:'solid',count:2,volume:8000},
    {name:'planar surface into two bodies',kind:'plane',count:2,area:400},
    {name:'cylindrical surface into two bodies',kind:'cylinder',count:2,area:400*Math.PI},
    {name:'quilt remains joined away from the cut',kind:'quilt',count:2,area:800},
    {name:'keep positive solid side',kind:'solid',options:{keep:'positive'},count:1,volume:4000},
    {name:'keep negative surface side',kind:'plane',options:{keep:'negative'},count:1,area:200},
    {name:'extend finite surface tool',kind:'solid',tool:'face',options:{extendTool:true},count:2,volume:8000},
    {name:'finite surface tool without extension rejected',kind:'solid',tool:'face',options:{extendTool:false},reject:/does not divide/},
    {name:'extend finite cylindrical tool through solid',kind:'solid',tool:'cylinder',options:{extendTool:true},count:2,volume:8000},
    {name:'finite cylinder without extension rejected',kind:'solid',tool:'cylinder',options:{extendTool:false},reject:/does not divide/},
    {name:'picked face tool extends through solid',kind:'solid',tool:'face',edit:f=>{f.toolFace={body:f.tool,p:[0,10,0],n:[0,0,1]};f.tool='';},count:2,volume:8000},
    {name:'extend open sketch ends',kind:'solid',tool:'sketch',options:{extendTool:true},count:2,volume:8000},
    {name:'finite open sketch without extension rejected',kind:'solid',tool:'sketch',options:{extendTool:false},reject:/does not divide/},
    {name:'explicit body selection required',kind:'solid',edit:f=>{f.bodies=[];},reject:/Select.*bodies/},
    {name:'legacy empty target list still splits solids',kind:'solid',edit:f=>{f.bodies=[];delete f.allBodies;delete f.extendTool;},count:2,volume:8000},
    {name:'missing tool rejected',kind:'plane',options:{tool:''},reject:/Select a splitting tool/},
    {name:'body cannot split itself',kind:'plane',edit:(f,d)=>{f.tool=d.source.id;},reject:/cannot split itself/},
    {name:'all intersected bodies includes surfaces',kind:'plane',options:{allBodies:true},edit:f=>{f.bodies=[];},count:2,area:400},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.kind),toolId=c.tool?tool(d,c.tool):'front';
      const f=M.createFeature(d.doc,'split',{tool:toolId,bodies:[d.source.id],...c.options});c.edit?.(f,d);d.doc.features.push(f);
      const r=await kernel.rebuild(d.doc),bodies=r.body?.bodies?.filter(b=>b.id!==toolId)||[],item={name:c.name,errors:r.errors,ok:false};
      if(c.reject)item.ok=r.errors.some(([,e])=>c.reject.test(e));
      else if(!r.errors.length){
        const measurements=[];for(const b of bodies)measurements.push((await kernel.request('measure',{refs:[{kind:'body',id:b.id}]})).items[0]);
        const total=measurements.reduce((n,m)=>n+(c.volume?m.volume:m.area),0),expected=c.volume||c.area;
        item.ok=bodies.length===c.count&&Math.abs(total-expected)<expected*1e-6;item.bodies=bodies.length;item.total=total;
      }
      results.push(item);
    }
    for(const kind of ['solid','plane','cylinder']){
      const d=fixture(kind),p=kind==='solid'?[0,20,0]:kind==='cylinder'?[0,10,10]:[0,0,0];
      const f=M.createFeature(d.doc,'splitLine',{tool:'front',faces:[{body:d.source.id,p}]});d.doc.features.push(f);
      const r=await kernel.rebuild(d.doc),body=r.body?.bodies?.find(b=>b.id===d.source.id);
      const expected=kind==='solid'?7:2;
      results.push({name:`split faces on ${kind}, body count preserved`,ok:!r.errors.length&&r.body.bodies.length===1&&body?.faceCount===expected,faces:body?.faceCount,errors:r.errors});
    }
    {
      const d=fixture('solid'),sk=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}});
      S.addLine(sk,S.addPoint(sk,0,-10),S.addPoint(sk,0,30));d.doc.features.push(sk);
      const projected=M.createFeature(d.doc,'projCurve',{sketch:sk.id,faces:[{body:d.source.id,p:[0,20,0]}]});d.doc.features.push(projected);
      const r=await kernel.rebuild(d.doc);
      results.push({name:'Projected Curve remains a curve without splitting faces',ok:!r.errors.length&&r.curves[projected.id]?.length===1&&r.body.bodies.length===1&&r.body.bodies[0].faceCount===6,errors:r.errors});
    }
    for(const extendTool of [false,true]){
      const d=fixture('solid'),sk=M.createFeature(d.doc,'sketch',{plane:{ref:'top'}});
      S.addLine(sk,S.addPoint(sk,-1,0),S.addPoint(sk,1,0));d.doc.features.push(sk);
      const split=M.createFeature(d.doc,'splitLine',{tool:sk.id,splitType:'projection',extendTool,faces:[{body:d.source.id,p:[0,20,0]}]});d.doc.features.push(split);
      const r=await kernel.rebuild(d.doc);
      results.push({name:`projected open sketch extension ${extendTool}`,ok:extendTool?!r.errors.length&&r.body.bodies.length===1&&r.body.bodies[0].faceCount===7:r.errors.some(([,e])=>/does not divide/.test(e)),errors:r.errors});
    }
    {
      const d=fixture('plane'),move=M.createFeature(d.doc,'moveBody',{bodies:[d.source.id],copy:true});d.doc.features.push(move);
      const before=await kernel.rebuild(d.doc),other=before.body.bodies.find(b=>b.id!==d.source.id);
      d.doc.features.push(M.createFeature(d.doc,'splitLine',{tool:'front',faces:[{body:d.source.id,p:[0,0,0]}]}));
      const r=await kernel.rebuild(d.doc);
      results.push({name:'coincident unselected surface untouched',ok:!r.errors.length&&r.body.bodies.length===2&&r.body.bodies.find(b=>b.id===d.source.id)?.faceCount===2&&r.body.bodies.find(b=>b.id===other.id)?.faceCount===1,errors:r.errors});
    }
    {
      const d=fixture('solid'),sk=M.createFeature(d.doc,'sketch',{plane:{ref:'front'}});
      S.addLine(sk,S.addPoint(sk,0,-10),S.addPoint(sk,0,30));d.doc.features.push(sk);
      const f=M.createFeature(d.doc,'splitLine',{tool:sk.id,splitType:'projection',projection:'vector',direction:'z',faces:[{body:d.source.id,p:[0,20,0]}]});d.doc.features.push(f);
      const r=await kernel.rebuild(d.doc);
      results.push({name:'projection along explicit vector',ok:!r.errors.length&&r.body.bodies[0].faceCount===7,errors:r.errors});
      f.direction='x';const bad=await kernel.rebuild(d.doc);
      results.push({name:'in-plane projection direction rejected',ok:bad.errors.some(([,e])=>/lies in the sketch plane/.test(e)),errors:bad.errors});
    }
    {
      const d=fixture('plane'),f=M.createFeature(d.doc,'split',{tool:'front',bodies:[d.source.id]});d.doc.features.push(f);
      const original=await kernel.rebuild(d.doc),reopened=await kernel.rebuild(JSON.parse(JSON.stringify(d.doc)));
      const signature=r=>r.body?.bodies?.map(b=>[b.id,b.kind,b.faceCount,b.edgeCount]);
      results.push({name:'saved split retains stable body identities',ok:!reopened.errors.length&&JSON.stringify(signature(original))===JSON.stringify(signature(reopened)),errors:reopened.errors});
      f.suppressed=true;const before=await kernel.rebuild(d.doc);
      results.push({name:'suppress split restores original surface body',ok:!before.errors.length&&before.body.bodies.length===1&&before.body.bodies[0].id===d.source.id&&before.body.bodies[0].faceCount===1,errors:before.errors});
      const sk=tool(d,'sketch'),faceSplit=M.createFeature(d.doc,'splitLine',{tool:sk,faces:[{body:d.source.id,p:[0,0,0]}]});d.doc.features.push(faceSplit);
      const refs=M.referencesOf(d.doc,faceSplit);
      results.push({name:'tool and selected-face dependencies tracked',ok:refs.has(sk)&&refs.has(d.source.id)});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{kernel.dispose();}
}
