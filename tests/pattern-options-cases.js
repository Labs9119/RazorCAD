import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Linear and Circular Pattern options: a total length, symmetric copies, the second direction for the feature only,
// instances to skip, and circular rings. A 200 mm square plate 5 thick on Front with a Ø4 hole at (10, 10),
// patterned: each copy takes out π·4·5; probes where a hole must be (no material) or must not be.
const HOLE=Math.PI*4*5,PLATE=200*200*5;
export function fixture(type,options={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  const p=[[-100,-100],[100,-100],[100,100],[-100,100]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const plate=M.createFeature(doc,'extrude',{sketch:sk.id,depth:5});
  const hs=M.createFeature(doc,'sketch',{plane:{ref:'front'}});S.addCircle(hs,S.addPoint(hs,10,10),2);
  const hole=M.createFeature(doc,'extrude',{sketch:hs.id,op:'cut',end:'through'});
  const feature=M.createFeature(doc,type,{feature:hole.id,features:[hole.id],...options});doc.features.push(sk,plate,hs,hole,feature);
  return {doc,feature};
}
const at=(x,y)=>[x,y,2.5];
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const measure=async(id)=>(await k.request('measure',{refs:[{kind:'body',id}]})).items[0];
  const dist=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance;
  const s=10/Math.SQRT2;
  const cases=[
    {name:'linear (as before)',type:'lpattern',options:{dir1:'x',dist1:20,count1:3},n:3,holes:[at(50,10)]},
    {name:'linear by total length',type:'lpattern',options:{dir1:'x',spacing1:'total',dist1:40,count1:3},n:3,holes:[at(30,10),at(50,10)]},
    {name:'linear symmetric',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,sym1:true},n:5,holes:[at(-30,10),at(50,10)]},
    {name:'linear skipping the second',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,skip:'2'},n:2,holes:[at(50,10)],solid:[at(30,10)]},
    {name:'linear skipping one the other way',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,sym1:true,skip:'-2'},n:4,holes:[at(-30,10)],solid:[at(-10,10)]},
    {name:'two directions',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,dir2:'y',dist2:20,count2:2},n:6,holes:[at(50,30)]},
    {name:'second direction for the feature only',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,dir2:'y',dist2:20,count2:2,seedOnly2:true},n:4,holes:[at(10,30),at(50,10)],solid:[at(30,30)]},
    {name:'two directions skipping 2.2',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,dir2:'y',dist2:20,count2:2,skip:'2.2'},n:5,solid:[at(30,30)],holes:[at(50,30)]},
    {name:'linear spacing growing by 5',type:'lpattern',options:{dir1:'x',dist1:10,count1:4,inc1:5},n:4,holes:[at(20,10),at(35,10),at(55,10)],solid:[at(30,10),at(40,10)]},
    {name:'circular angle growing by 30°',type:'cpattern',options:{axis:'z',angle:30,count:3,equal:false,angleInc:30},n:3,holes:[at(-10,10)],solid:[at(10,-10)]},
    {name:'table driven (the hole’s sketch plane)',type:'tablePattern',options:{table:'20, 0; 0, 20; 30, -40'},n:4,holes:[at(30,10),at(10,30),at(40,-30)],solid:[at(30,30)]},
    {name:'table driven on a plane, a header row, sums and an angle',type:'tablePattern',options:{plane:'front',table:'x\ty\tangle\n10+10\t0\n-30\t-30\t45'},n:3,holes:[at(30,10),at(-20,-20)]},
    {name:'a table row that is not numbers rejected',type:'tablePattern',options:{table:'20, 0; 5'},reject:/Row 2/},
    {name:'a skip that is not an instance number rejected',type:'lpattern',options:{dir1:'x',dist1:20,count1:3,skip:'second'},reject:/not an instance number/},
    {name:'circular (as before)',type:'cpattern',options:{axis:'z',angle:360,count:4,equal:true},n:4,holes:[at(-10,-10)]},
    {name:'circular symmetric',type:'cpattern',options:{axis:'z',angle:90,count:2,equal:false,sym:true},n:3,holes:[at(-10,10),at(10,-10)],solid:[at(-10,-10)]},
    {name:'circular in two rings',type:'cpattern',options:{axis:'z',angle:360,count:4,equal:true,rings:2,ringStep:10},n:8,holes:[at(10+s,10+s),at(-10-s,-10-s)]},
    {name:'circular skipping the third',type:'cpattern',options:{axis:'z',angle:360,count:4,equal:true,skip:'3'},n:3,solid:[at(-10,-10)],holes:[at(-10,10)]},
  ];
  try{
    for(const c of cases){
      const d=fixture(c.type,c.options);
      const r=await k.rebuild(d.doc);
      if(c.reject){results.push({name:c.name,ok:r.errors.some(([id,m])=>id===d.feature.id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      const m=await measure(body.id),want=PLATE-(c.n+0)*HOLE;let ok=Math.abs(m.volume-want)<1e-6*want;const bad=[];
      for(const p of c.holes||[])if(!((await dist(p,body.id))>1e-3)){ok=false;bad.push({hole:p});}
      for(const p of c.solid||[])if(!((await dist(p,body.id))<1e-9)){ok=false;bad.push({solid:p});}
      results.push({name:c.name,ok,volume:m.volume,expected:want,copies:Math.round((PLATE-m.volume)/HOLE),...(bad.length?{bad}:{})});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
