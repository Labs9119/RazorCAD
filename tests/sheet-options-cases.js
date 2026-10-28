import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// Sheet metal: the bend calculated from a bend allowance or a bend deduction for a 90° bend (bendCalc 'ba' / 'bd') as
// well as a K-factor, and an edge flange along part of its edge (widthType 'offsets' / 'centered'). A 100 × 60 plate
// 2 thick on Top (x ±50, z ±30, y 0 to 2), bend radius 2, a 20 mm flange (to the outer sharp) on its edge at z = 30:
// flat across = 60 + 20 − 2·(R + t) + BA.
export function fixture(base={},flange={}){
  const doc=M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-50,-30],[50,-30],[50,30],[-50,30]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const b=M.createFeature(doc,'smBase',{sketch:sk.id,thickness:2,radius:2,kFactor:0.44,...base});
  const f=M.createFeature(doc,'smFlange',{edges:[{p:[0,2,30]}],length:20,angle:90,lengthRef:'outer',position:'inside',corner:'open',...flange});
  doc.features.push(sk,b,f);return {doc,base:b,feature:f};
}
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const dist=async(p,id)=>(await k.request('measure',{refs:[{kind:'vertex',p},{kind:'body',id}]})).distance;
  const BAk=Math.PI/2*(2+0.44*2);
  const cases=[
    {name:'K-factor (as before)',flat:72+BAk},
    {name:'a bend allowance of 4.2 for 90°',base:{bendCalc:'ba',bendAllowance:4.2},flat:76.2},
    {name:'a bend deduction of 3.8 for 90° (the same bend)',base:{bendCalc:'bd',bendDeduction:3.8},flat:76.2},
    {name:'a bend allowance in an expression',base:{bendCalc:'ba',bendAllowance:'2.1 * 2'},flat:76.2},
    {name:'a bend table, 90°',base:{bendCalc:'table',bendTable:'45: 2.0; 90: 4.2'},flat:76.2},
    {name:'a bend table, 45° (its row)',base:{bendCalc:'table',bendTable:'45: 2.0; 90: 4.2'},flange:{angle:45},flat:80-2*4*Math.tan(Math.PI/8)+2.0},
    {name:'a bend table, 60° (between its rows)',base:{bendCalc:'table',bendTable:'45: 2.0; 90: 4.2'},flange:{angle:60},flat:80-2*4*Math.tan(Math.PI/6)+2.0+2.2/3},
    {name:'a bend table row that is not one rejected',base:{bendCalc:'table',bendTable:'90 is 4.2'},reject:/not a bend table row/,on:'base'},
    {name:'a bend allowance giving a K-factor over 1 rejected',base:{bendCalc:'ba',bendAllowance:20},reject:/gives a K-factor/,on:'base'},
    {name:'a flange 40 wide in the middle of its edge',flange:{widthType:'centered',flangeWidth:40},flat:72+BAk,on:[[0,15,29],[19,15,29],[-19,15,29]],off:[[30,15,29],[-30,15,29]]},
    {name:'a flange 10 and 30 in from the ends',flange:{widthType:'offsets',startOffset:10,endOffset:30},oneOf:[[-30,15,29],[30,15,29]],on:[[0,15,29]]},
    {name:'the same, the ends swapped',flange:{widthType:'offsets',startOffset:10,endOffset:30,swapEnds:true},oneOf:[[-30,15,29],[30,15,29]],on:[[0,15,29]],pair:true},
    {name:'offsets that leave nothing rejected',flange:{widthType:'offsets',startOffset:60,endOffset:50},reject:/leave nothing/},
    {name:'a flange wider than its edge rejected',flange:{widthType:'centered',flangeWidth:120},reject:/wider than its edge/},
  ];
  let firstOne=null;
  try{
    for(const c of cases){
      const d=fixture(c.base,c.flange);
      const r=await k.rebuild(d.doc);
      if(c.reject){const id=c.on==='base'?d.base.id:d.feature.id;results.push({name:c.name,ok:r.errors.some(([e,m])=>e===id&&c.reject.test(m)),errors:r.errors});continue;}
      const body=r.body?.bodies?.at(-1);
      if(r.errors.length||!body){results.push({name:c.name,ok:false,errors:r.errors});continue;}
      let ok=true;const got={};
      if(c.flat){const fl=await k.request('sheetFlat',{bodyId:body.id,flip:false}),size=[...fl.size].sort((a,b)=>a-b);got.flat=size;ok=Math.abs(size[0]-c.flat)<1e-6&&Math.abs(size[1]-100)<1e-6;}
      for(const p of c.on||[])if(!((await dist(p,body.id))<1e-9)){ok=false;(got.missing||=[]).push(p);}
      for(const p of c.off||[])if(!((await dist(p,body.id))>1e-3)){ok=false;(got.extra||=[]).push(p);}
      if(c.oneOf){const ins=[];for(const p of c.oneOf)ins.push((await dist(p,body.id))<1e-9);got.oneOf=ins;if(ins.filter(Boolean).length!==1)ok=false;
        if(c.pair){if(!firstOne||firstOne.join()===ins.join())ok=false;}else firstOne=ins;}
      results.push({name:c.name,ok,...got});
    }
    return {ok:results.every(r=>r.ok),results};
  }finally{k.worker.terminate();}
}
