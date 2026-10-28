import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';
import {KernelClient} from '/js/kernelclient.js';
// 3D printing fasteners on a 40 × 20 × 10 block (Top, x ±20, z ±10, y 0 to 10), each at the middle of its top face, with
// the volume each takes away worked out from its shape: a hexagon s across its flats has area (√3 / 2) s².
export function fixture(type,options={},doc0=null){
  const doc=doc0||M.newDoc(),sk=M.createFeature(doc,'sketch',{plane:{ref:'top'}});
  const p=[[-20,-10],[20,-10],[20,10],[-20,10]].map(q=>S.addPoint(sk,...q));p.forEach((id,i)=>S.addLine(sk,id,p[(i+1)%4]));
  const f=M.createFeature(doc,type,{faces:[{p:[0,10,0],n:[0,1,0]}],...options});
  doc.features.push(sk,M.createFeature(doc,'extrude',{sketch:sk.id,depth:10}),f);
  return {doc,feature:f};
}
const hex=s=>Math.sqrt(3)/2*s*s,disc=(d,h)=>Math.PI*d*d/4*h;
export async function run({threads=1}={}){
  const k=new KernelClient({threads}),results=[];await k.ready;
  const vol=async(r)=>r.body?.bodies?.length===1?(await k.request('measure',{refs:[{kind:'body',id:r.body.bodies[0].id}]})).items[0].volume:NaN;
  const one=async(name,type,options,removed,{alt=null,doc=null}={})=>{
    const d=fixture(type,options,doc),r=await k.rebuild(d.doc),v=await vol(r),gone=8000-v,want=[removed,...(alt!=null?[alt]:[])];
    results.push({name,ok:!r.errors.length&&want.some(w=>Math.abs(gone-w)<1e-6*8000),removed:gone,expected:want,note:r.notes?.[d.feature.id],errors:r.errors});
  };
  try{
    // nut pocket M3 (5.5 across flats, 2.4 high, clearance 0.2: 5.9 × 2.6) and the Ø3.4 hole through the rest
    await one('nut pocket M3 from the face','nutPocket',{size:'M3'},hex(5.9)*2.6+disc(3.4,10-2.6));
    // captive slot 3 below the face: the hexagon's half behind its middle, two corner slivers (0.010363 s² together) and
    // the slot s wide out to the edge D away (20 or 10, by the face's X direction), 2.6 high; the hole through the rest
    const s=5.9,sliver=2*0.5*s*(1-Math.sqrt(3)/2)*(s/Math.sqrt(3)-s/2),slot=(D)=>(hex(s)/2+sliver+s*D)*2.6+disc(3.4,10-2.6);
    await one('captive nut slot M3, 3 below the face, out to the edge','nutPocket',{size:'M3',slot:true,slotDepth:3},slot(20),{alt:slot(10)});
    // the print profile's clearance (0.3): 6.1 × 2.7
    const doc=M.newDoc();doc.print={profile:'Loose printer',p:{name:'Loose printer',clearance:0.3,width:0.4,overhang:45,bridge:10,bed:[200,200,200],fits:{}}};
    await one('nut pocket sized from the part’s print profile (clearance 0.3)','nutPocket',{size:'M3'},hex(6.1)*2.7+disc(3.4,10-2.7),{doc});
    // insert hole M3 (Ø4 × 5.7, relief 1: 6.7 deep), a 0.5 chamfer: the frustum Ø5 to Ø4 over 0.5 less the cylinder in it
    const cham=Math.PI*0.5/3*(2.5*2.5+2.5*2+2*2)-disc(4,0.5);
    await one('insert hole M3 with its chamfer and relief','insertHole',{size:'M3'},disc(4,6.7)+cham);
    await one('insert hole of your own sizes (Ø4.2 × 6, no chamfer)','insertHole',{size:'M3',diameter:4.2,length:6,relief:0,chamfer:0},disc(4.2,6));
    // screw holes for plastic: pilot 0.85 × 3 = Ø2.55 × 6; with an M3 cap screw's counterbore (Ø6.5 × 3.4, ISO 4762)
    await one('screw hole M3 into plastic (pilot Ø2.55)','plasticScrewHole',{size:'M3',depth:6},disc(2.55,6));
    await one('screw hole M3 with a counterbore','plasticScrewHole',{size:'M3',depth:6,head:'cbore'},disc(6.5,3.4)+disc(2.55,6-3.4));
  }finally{k.worker.terminate();}
  return {ok:results.every(r=>r.ok),results};
}
