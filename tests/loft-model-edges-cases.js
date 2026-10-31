import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import * as LR from '/js/loftrefs.js';
import {KernelClient} from '/js/kernelclient.js';

export function fixture(){
  const doc=M.newDoc(),sources=[];
  for(const z of [0,20]){
    const plane=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'front'}],offset:z}),sk=M.createFeature(doc,'sketch',{plane:{ref:plane.id}});
    S.buildCenterRect(sk,S.addPoint(sk,0,5),0,5,5,5);
    const surface=M.createFeature(doc,'surfPlanar',{profiles:[sk.id]});doc.features.push(plane,sk,surface);sources.push(surface);
  }
  const cut=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:7});doc.features.push(cut);
  const split=M.createFeature(doc,'splitLine',{tool:cut.id,faces:sources.map((surface,i)=>({body:surface.id,p:[0,5,i*20]}))});doc.features.push(split);
  const profiles=sources.map((surface,i)=>({kind:'modelEdgeChain',edges:[{body:surface.id,feature:split.id,p:[5,8.5,i*20]}]}));
  const loft=M.createFeature(doc,'surfLoft',{profiles});doc.features.push(loft);
  return {doc,sources,cut,split,loft};
}

export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  try{
    const cases=[
      {name:'only the trimmed 3 mm strips',area:60,faces:1},
      {name:'two selected edges per open profile',area:260,faces:2,edit:d=>d.loft.profiles.forEach((r,i)=>r.edges.push({body:d.sources[i].id,p:[0,10,i*20]}))},
      {name:'closed loops of the trimmed portions',area:520,faces:4,edit:d=>d.loft.profiles.forEach((r,i)=>r.edges.push(...[[0,7],[-5,8.5],[0,10]].map(([x,y])=>({body:d.sources[i].id,p:[x,y,i*20]}))))},
      {name:'disconnected edges rejected',reject:/one profile|disconnected/,edit:d=>d.loft.profiles[0].edges.push({body:d.sources[0].id,p:[-5,8.5,0]})},
      {name:'branches rejected',reject:/unbranched/,edit:d=>d.loft.profiles[0].edges.push(...[[5,3.5],[0,7]].map(([x,y])=>({body:d.sources[0].id,p:[x,y,0]})))},
      {name:'duplicate edge rejected',reject:/same edge twice/,edit:d=>d.loft.profiles[0].edges.push(structuredClone(d.loft.profiles[0].edges[0]))},
      {name:'missing owner rejected',reject:/missing or ambiguous/,edit:d=>d.loft.profiles[0].edges[0].body='missing'},
      {name:'mixed open and closed rejected',reject:/all be open|all closed/,edit:d=>d.loft.profiles[0].edges.push(...[[0,7],[-5,8.5],[0,10]].map(([x,y])=>({body:d.sources[0].id,p:[x,y,0]})))},
      {name:'manual connectors reported as unsupported',reject:/automatic correspondence/,edit:d=>d.loft.correspondenceMode='manual'},
    ];
    for(const c of cases){
      const d=fixture();c.edit?.(d);const r=await k.rebuild(d.doc),body=r.body?.bodies?.find(b=>b.id===d.loft.id),item={name:c.name,errors:r.errors,ok:false};
      if(c.reject)item.ok=r.errors.some(([,e])=>c.reject.test(e));
      else if(!r.errors.length&&body){
        const m=(await k.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];
        let lo=Infinity,hi=-Infinity;
        for(const v of r.body.triangles.slice(body.triStart,body.triStart+body.triCount)){const y=r.body.vertices[v*3+1];lo=Math.min(lo,y);hi=Math.max(hi,y);}
        item.ok=r.body.bodies.length===3&&body.faceCount===c.faces&&Math.abs(m.area-c.area)<c.area*1e-6&&lo>=7-1e-5&&hi<=10+1e-5;item.area=m.area;item.faces=body.faceCount;item.range=[lo,hi];
      }
      results.push(item);
    }
    const d=fixture(),r=await k.rebuild(d.doc),again=await k.rebuild(JSON.parse(JSON.stringify(d.doc)));
    results.push({name:'save/reopen retains model-edge profiles',ok:!r.errors.length&&!again.errors.length&&again.body.bodies.at(-1).faceCount===1,errors:again.errors});
    d.cut.offset=6;const changed=await k.rebuild(d.doc),body=changed.body?.bodies?.find(b=>b.id===d.loft.id);
    const m=body&&(await k.request('measure',{refs:[{kind:'body',id:body.id}]})).items[0];
    results.push({name:'profile follows split-plane edit',ok:!changed.errors.length&&!!m&&Math.abs(m.area-80)<1e-5,area:m?.area,errors:changed.errors});
    const refs=M.referencesOf(d.doc,d.loft);
    results.push({name:'source-body and split dependencies retained',ok:d.sources.every(source=>refs.has(source.id))&&refs.has(d.split.id)&&LR.refKey(d.loft.profiles[0])!==LR.refKey(d.loft.profiles[1])});
    return {ok:results.every(r=>r.ok),results};
  }finally{k.dispose();}
}
