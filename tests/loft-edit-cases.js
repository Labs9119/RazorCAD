import * as M from '/js/model.js';
import * as S from '/js/sketchmodel.js';

function fixture() {
  const doc = M.newDoc(); doc.name = 'Guided loft regeneration';
  const plane = M.createFeature(doc, 'plane', { refs: [{kind:'plane',id:'top'}], offset:100 });
  doc.features.push(plane);
  const profiles = ['top', plane.id].map((ref) => {
    const sketch = M.createFeature(doc, 'sketch', {plane:{ref}});
    const p = [[-20,-20],[20,-20],[20,20],[-20,20]].map(([x,y]) => S.addPoint(sketch,x,y));
    p.forEach((a,i) => S.addLine(sketch,a,p[(i+1)%4]));
    doc.features.push(sketch); return sketch;
  });
  const guide = M.createFeature(doc,'sketch',{plane:{ref:'front'}});
  S.addCtrlSpline(guide,[[20,0],[26,100/3],[26,200/3],[20,100]].map(([x,y])=>S.addPoint(guide,x,y)),3);
  doc.features.push(guide);
  const loft = M.createFeature(doc,'loft',{profiles:profiles.map((p)=>p.id),guides:[guide.id],guideMethod:'constrained',guideContinuity:'C0'});
  doc.features.push(loft);
  return {doc,profileId:profiles[1].id,guideId:guide.id,loftId:loft.id};
}

export async function run({modes=['C0','G1','G2']}={}) {
  document.querySelectorAll('.modal-back .modal-h .x').forEach((button)=>button.click());
  const app = window.app, results = [], initial = await app.kernel.stats(), restarts=app.kernel.restarts;
  let savedDocument;
  const check = async (mode,stage,ids) => {
    if(app.result.errors.size)throw new Error(`${mode}/${stage}: ${JSON.stringify([...app.result.errors])}`);
    const bodies = app.result.body?.bodies || [];
    if(bodies.length!==1||bodies[0].kind!=='solid')throw new Error(`${mode}/${stage}: expected one solid`);
    const note = app.result.notes.get(ids.loftId) || '';
    if(!note.includes(`${mode}, 1 seams`))throw new Error(`${mode}/${stage}: ${note}`);
    const angle = Number(note.match(/normal mismatch ([\d.e+\-]+) deg/)?.[1]);
    const curvature = Number(note.match(/curvature mismatch ([\d.e+\-]+) 1\/mm/)?.[1]);
    if(mode!=='C0'&&!(angle<=0.5))throw new Error('Tangency tolerance exceeded');
    if(mode==='G2'&&!(curvature<=0.001))throw new Error('Curvature tolerance exceeded');
    const measured = await app.kernel.request('measure',{refs:[{kind:'body',id:bodies[0].id}]});
    const volume = measured.items[0].volume;
    if(!(Number.isFinite(volume)&&volume>0))throw new Error('Invalid solid volume');
    const guide = M.findFeature(app.doc,ids.guideId);
    let contactError = 0;
    for(const t of [0.23,0.51,0.79]){
      const u=1-t, p=[guide.points.reduce((s,p,i)=>s+p.x*[u**3,3*u*u*t,3*u*t*t,t**3][i],0),100*t,0];
      const m=await app.kernel.request('measure',{refs:[{kind:'point',p},{kind:'face',p}]});
      if(!Number.isFinite(m.distance))throw new Error('CAD contact measurement unavailable');
      contactError=Math.max(contactError,m.distance);
    }
    if(contactError>1e-4)throw new Error('Guide contact tolerance exceeded');
    const item={mode,stage,volume,contactError,note};results.push(item);return item;
  };
  for(const mode of modes){
    const ids=fixture();await app.setDoc(ids.doc);
    app.editFeature(ids.loftId);
    const select=[...document.querySelectorAll('#pm select')].find((s)=>[...s.options].some((o)=>o.value==='G2'));
    if(!select)throw new Error('Continuity selector missing');
    select.value=mode;select.dispatchEvent(new Event('change'));await app.okPM();
    if(M.findFeature(app.doc,ids.loftId).guideContinuity!==mode)throw new Error('Continuity choice was not saved');
    const baseline=await check(mode,'baseline',ids);

    await app.enterSketch(M.findFeature(app.doc,ids.profileId),false);
    if(app.mode!=='sketch')throw new Error('Could not edit the end profile');
    app.sketcher.f.points.forEach((p)=>{p.y*=1.2;});app.sketcher.changed();
    app.exitSketch(true);await app.rebuild();
    const profile=await check(mode,'profile height 40 → 48 mm',ids);
    if(profile.volume<=baseline.volume*1.01)throw new Error('Profile edit did not update the solid');

    await app.enterSketch(M.findFeature(app.doc,ids.guideId),false);
    if(app.mode!=='sketch')throw new Error('Could not edit the guide');
    app.sketcher.f.points[1].x=29;app.sketcher.f.points[2].x=29;app.sketcher.changed();
    app.exitSketch(true);await app.rebuild();
    const guide=await check(mode,'guide bend 6 → 9 mm',ids);
    if(Math.abs(guide.volume-profile.volume)<1)throw new Error('Guide edit did not update the solid');
    savedDocument=JSON.parse(JSON.stringify(app.doc));
  }
  // (the app's own kernel, used by the tests before this one too, and its memory never shrinks: what this test may add
  // is bounded, 512 MB in all from a fresh kernel)
  const health=await app.kernel.stats();
  if(app.kernel.restarts!==restarts||!health.freeing||!health.stackReset||health.memoryMB>Math.max(512,initial.memoryMB+256)||health.freed<=initial.freed)throw new Error('Kernel health check failed: '+JSON.stringify({...health,memoryMBBefore:initial.memoryMB}));
  app.viewport.setStandardView('trimetric',false);app.viewport.zoomToFit(null,false);
  return {ok:true,results,health,document:savedDocument};
}
