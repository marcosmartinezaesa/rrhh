const path=require('path');const fs=require('fs');const crypto=require('crypto');
const {migrate,Repositorios,error,json,now}=require('./storage');
const {ExperienciaService,CATEGORIES}=require('./experience');
const {IdentidadService,CVService,ExtraccionService}=require('./cv');
const {WhatsAppService,SincronizacionService}=require('./whatsapp');
const {ExportacionService}=require('./export');
function install(app,db,root,upload,wrap){
  migrate(db,root);
  const repo=new Repositorios(db,root),identity=new IdentidadService(repo),experience=new ExperienciaService(repo);
  const cv=new CVService(repo,identity),extraction=new ExtraccionService(repo,identity,experience);
  cv.extraction=extraction;
  const wa=new WhatsAppService(repo,cv),sync=new SincronizacionService(repo,wa),exports=new ExportacionService(repo,experience);wa.sync=sync;
  const admin=(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({error:'Sólo administradores'});
  const personId=req=>Number(req.params.id);
  app.get('/api/candidates',(req,res)=>res.json(repo.list()));
  app.get('/api/people/:id',wrap((req,res)=>{
    const id=personId(req),p=repo.person(id),versions=repo.versions(id);
    const evidence=db.prepare('SELECT * FROM person_evidence WHERE candidate_id=? ORDER BY id').all(id);
    const matches=p.dniConfirmed||p.dniExtracted?db.prepare('SELECT id,name FROM candidates WHERE id<>? AND mergedInto IS NULL AND ((dniConfirmed<>\'\' AND replace(dniConfirmed,\'.\',\'\')=?) OR (dniExtracted<>\'\' AND replace(dniExtracted,\'.\',\'\')=?))').all(id,(p.dniConfirmed||p.dniExtracted).replace(/\D/g,''),(p.dniConfirmed||p.dniExtracted).replace(/\D/g,'')):[];
    const sources=experience.list(id);const current=versions[0];
    res.json({...p,versions,evidence,receipts:db.prepare('SELECT * FROM cv_receipts WHERE candidate_id=? ORDER BY received').all(id),experiences:sources,categories:CATEGORIES,matches,totals:experience.totals(current?sources.filter(s=>s.version_id===current.id):sources,now().slice(0,10))});
  }));
  app.get('/api/candidates/:id/documents',wrap((req,res)=>{repo.person(personId(req));res.json(repo.versions(personId(req)));}));
  app.post('/api/candidates/:id/documents',upload.single('file'),wrap((req,res)=>{
    const id=personId(req);repo.person(id);if(!req.file)throw error('Seleccioná un archivo');
    const received=req.body.received;if(!received||!Number.isFinite(Date.parse(received)))throw error('Indicá la fecha original de recepción');
    const result=cv.receive({account:'manual',chat:'person:'+id,message_id:crypto.randomUUID(),received,candidate_id:id,original:req.file.originalname,isCV:true},req.file.buffer);
    repo.log(`CV manual guardado para ${id}`,req.user.id);res.json({id:result.receipt.id,duplicate:result.duplicate});
  }));
  app.get('/api/files/:hash',wrap((req,res)=>{const f=repo.file(req.params.hash);if(!f)throw error('Archivo no encontrado',404);const target=path.join(root,'cv',f.path);if(!fs.existsSync(target))throw error('El original falta en el servidor',409);res.download(target,f.original);}));
  app.get('/api/files/:hash/text',wrap((req,res)=>{const f=repo.file(req.params.hash);if(!f)throw error('Archivo no encontrado',404);res.json({state:f.read_state,error:f.read_error,pages:json(f.pages)});}));
  app.post('/api/files/:hash/retry',wrap((req,res)=>{const f=repo.file(req.params.hash);if(!f)throw error('Archivo no encontrado',404);if(f.read_state==='reading')throw error('Lectura en curso',409);db.prepare("UPDATE cv_files SET read_state='pending' WHERE hash=?").run(f.hash);extraction.enqueue(f.hash);res.json({ok:true});}));
  app.get('/api/receipts',(req,res)=>res.json(db.prepare("SELECT r.*,f.read_state FROM cv_receipts r LEFT JOIN cv_files f ON f.hash=r.hash WHERE r.candidate_id IS NULL AND r.classification<>'other' ORDER BY r.received DESC LIMIT 1000").all()));
  app.post('/api/receipts/:id/resolve',wrap((req,res)=>{
    const r=db.prepare('SELECT * FROM cv_receipts WHERE id=?').get(personId(req));if(!r)throw error('Recepción no encontrada',404);
    if(req.body.action==='other'){if(r.candidate_id)throw error('La recepción ya pertenece a una ficha');db.prepare("UPDATE cv_receipts SET classification='other' WHERE id=?").run(r.id);repo.log(`Recepción ${r.id} marcada ajena a la postulación`,req.user.id);return res.json({ok:true});}
    if(!r.hash)throw error('Primero reintentá la descarga desde WhatsApp');
    let version;
    db.transaction(()=>{if(req.body.action==='new'){if(r.candidate_id)throw error('La recepción ya está asociada');version=identity.createForReceipt(r,{name:{value:String(req.body.name||'Nombre por confirmar').slice(0,500)}});}else if(req.body.action==='associate'){version=identity.associate(r.id,Number(req.body.candidate_id),req.user.id);}else throw error('Acción inválida');})();
    extraction.enqueue(r.hash);res.json({ok:true,candidate_id:version.candidate_id});
  }));
  app.post('/api/people/:id/merge',admin,wrap((req,res)=>{identity.merge(personId(req),Number(req.body.target),req.body.versions||{},req.user.id);res.json({ok:true});}));
  app.post('/api/people/:id/experiences',wrap((req,res)=>res.json({id:experience.save(personId(req),req.body,req.user.id)})));
  app.get('/api/whatsapp',(req,res)=>res.json(wa.status(req.user.role==='admin')));
  app.post('/api/whatsapp/connect',admin,wrap(async(req,res)=>{await wa.connect(req.body);repo.log('Inicio de conexión de WhatsApp RRHH',req.user.id);res.json({ok:true});}));
  app.post('/api/whatsapp/disconnect',admin,wrap(async(req,res)=>{await wa.disconnect();res.json({ok:true});}));
  app.post('/api/whatsapp/retry',admin,wrap((req,res)=>{wa.retry().catch(e=>wa.fail(e));res.json({ok:true});}));
  app.get('/api/sync',admin,(req,res)=>res.json(sync.list()));
  app.post('/api/sync',admin,wrap((req,res)=>res.json(sync.start(req.body))));
  app.post('/api/sync/:id/resume',admin,wrap((req,res)=>res.json(sync.resume(personId(req)))));
  app.post('/api/sync/cancel',admin,(req,res)=>{sync.cancel();res.json({ok:true});});
  app.post('/api/exports/preview',wrap((req,res)=>{const p=exports.preview(req.body);res.json({...p,rows:p.rows.map(({path,...r})=>r)});}));
  app.post('/api/exports',wrap((req,res)=>res.json(exports.start(req.body,req.user.id))));
  app.get('/api/exports/:id',wrap((req,res)=>{const {path,...job}=exports.get(req.params.id,req.user.id);res.json(job);}));
  app.get('/api/exports/:id/download',wrap((req,res)=>{const job=exports.get(req.params.id,req.user.id);if(job.state!=='ready')throw error('El ZIP todavía no está listo',409);res.download(job.path,'RRHH_CVs_'+job.id+'.zip');}));
  return {repo,identity,cv,extraction,experience,wa,sync,exports,start:()=>extraction.resume(),close:async()=>{extraction.stopped=true;await wa.disconnect();}};
}
module.exports={install};
