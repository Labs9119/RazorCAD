import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Kernel Lab k14 (defeaturing, semantic PMI): a 40 × 20 × 10 box on Top (x ±20, z ±10, y 0 to 10). Exact defeaturing
// gives back the box exactly where the boolean way cannot (rounds meeting at corners); a STEP file written with PMI
// reads back with it. On a kernel without them every case is skipped.
function box(doc){const sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}));}
const c45=Math.SQRT1_2;
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  try{
    const has=await k.request('ocHas',{names:['LabDefeature','LabPMI']});
    if(!has.includes('LabDefeature')||!has.includes('LabPMI'))return {ok:true,skipped:true,results:[{name:'this kernel has no defeaturing or PMI: skipped',ok:true,has}]};
    const one=async(name,doc,want,note=null)=>{const r=await k.rebuild(doc),b=r.body?.bodies?.at(-1);const v=b&&r.body.bodies.length===1?(await measure(b.id)).volume:NaN;const n=r.notes?.[doc.features.at(-1).id]||'';results.push({name,ok:!r.errors.length&&Math.abs(v-want)<1e-6*want&&(!note||note.test(n)),volume:v,expected:want,note:n,errors:r.errors});};
    // (all 12 edges rounded R2: corner blends where three meet; defeatured exactly)
    {const doc=M.newDoc();box(doc);const E=[];for(const y of [0,10])for(const z of [-10,10])E.push({p:[0,y,z]});for(const x of [-20,20])for(const y of [0,10])E.push({p:[x,y,0]});for(const x of [-20,20])for(const z of [-10,10])E.push({p:[x,5,z]});
     doc.features.push(M.createFeature(doc,'fillet',{radius:2,edges:E}),M.createFeature(doc,'defeature',{filletR:2.5,holes:false}));
     await one('every edge rounded, corners and all: taken out exactly',doc,8000,/([1-9]\d*) fillet faces and 0 holes taken out exactly/);}
    {const doc=M.newDoc();box(doc);doc.features.push(M.createFeature(doc,'fillet',{radius:2,edges:[{p:[0,10,10]}]}),M.createFeature(doc,'editFillet',{faces:[{p:[0,8+2*c45,8+2*c45]}],mode:'resize',radius:4}));
     await one('a round resized from 2 to 4 by the kernel',doc,8000-(16-4*Math.PI)*40,/exactly/);}
    {const doc=M.newDoc();box(doc);const pl=M.createFeature(doc,'plane',{refs:[{kind:'plane',id:'top'}],offset:10}),b=M.createFeature(doc,'sketch',{plane:{ref:pl.id}});S.addCircle(b,'O',4);
     doc.features.push(pl,b,M.createFeature(doc,'extrude',{sketch:b.id,depth:6}),M.createFeature(doc,'deleteFace',{faces:[{p:[4,13,0]},{p:[0,16,0],n:[0,1,0]}],mode:'heal'}));
     await one('a boss deleted and healed (its side and top)',doc,8000);}
    // (PMI written and read back)
    {const doc=M.newDoc();box(doc);await k.rebuild(doc);
     const spec=['D|A|0 0 -10','T|flatness|0.02|0|0 10 0|','T|position|0.1|1|20 5 0|A','L|20|0.1|0.05|0 5 -10|0 5 10|30 5 0'].join('\n');
     const {text}=await k.request('stepPMI',{spec,name:'Box'});
     const okText=/AP242/i.test(text)&&/DATUM/.test(text)&&/FLATNESS_TOLERANCE/.test(text)&&/POSITION_TOLERANCE/.test(text)&&/DIMENSIONAL_LOCATION/.test(text);
     results.push({name:'a STEP file with semantic PMI written (AP242: datum, flatness, position, a dimension)',ok:okText});
     const d2=M.newDoc(),imp=M.createFeature(d2,'import',{format:'step',fileName:'box.step',data:text});d2.features.push(imp);
     const r=await k.rebuild(d2),pmi=r.features?.[imp.id]?.pmi||[];
     const ok=pmi.some(l=>/^D\|A\|/.test(l))&&pmi.some(l=>/^T\|flatness\|0\.02\|0\|/.test(l))&&pmi.some(l=>/^T\|position\|0\.1\|1\|.*\|A$/.test(l))&&pmi.some(l=>/^L\|20\|0\.1\|-?0\.05\|/.test(l));
     results.push({name:'and read back from it on import',ok,pmi});}
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
