const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'rrhh-reception-'));
const {db,services}=require('../server');const {repo,cv,extraction,identity,experience,exports:exportsService}=services;cv.extraction=null;
const {categories,ExperienciaLaboral}=require('../lib/experience');const {dateRange}=require('../lib/whatsapp');const {csvCell}=require('../lib/export');
const zip=require('jszip');
const bytes=n=>Buffer.from('%PDF-1.7\nfixture '+n);
const page=(name,job='')=>[{page:1,text:`Nombre: ${name}\nDNI: 12345678\nExperiencia laboral:\n${job}\n\nEducación\nSecundario`,method:'fixture'}];
const job='Empresa: Ejemplo\nPuesto: Repartidor\nTareas: repartía mercadería, atendía clientes y cobraba\n2020-01-01 a 2021-01-01';
function receive(n,{chat='111@c.us',stamp='2026-09-09T12:00:00-03:00',file='a',candidate,caption='Mi CV'}={}){return cv.receive({account:'test',chat,message_id:n,received:stamp,original:'CV.pdf',caption,candidate_id:candidate,isCV:true},bytes(file)).receipt;}
async function read(r,pages){db.prepare("UPDATE cv_files SET read_state='done',pages=?,extracted=? WHERE hash=?").run(JSON.stringify(pages),JSON.stringify(require('../lib/cv').extractFields(pages)),r.hash);await extraction.process(r.hash);return db.prepare('SELECT * FROM cv_receipts WHERE id=?').get(r.id);}
test('Recepciones, versiones cronológicas, identidad conservadora, fuentes y ZIP por fecha',async()=>{
 let r=await read(receive('m1'),page('Persona Uno',job));const id=r.candidate_id;assert.ok(id);
 for(let n=2;n<=10;n++)receive('m'+n);await extraction.process(r.hash);
 assert.equal(repo.list().length,1);assert.equal(db.prepare('SELECT count(*) n FROM cv_files').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM cv_receipts').get().n,10);
 receive('m1');assert.equal(db.prepare('SELECT count(*) n FROM cv_receipts').get().n,10);
 const original=repo.versions(id)[0];assert.equal(experience.list(id).length,1);
 const s=experience.list(id)[0];experience.save(id,{id:s.id,revision:s.revision,data:{...s.data,tasks:'Corrección manual'},confirm:true},1);
 await extraction.process(r.hash);assert.equal(experience.list(id)[0].data.tasks,'Corrección manual');assert.equal(experience.list(id)[0].history.length,1);
 let updated=await read(receive('updated',{stamp:'2026-09-10T23:59:59-03:00',file:'b'}),page('Persona Uno',job.replace('2021-01-01','2022-01-01')));
 assert.equal(updated.candidate_id,id);assert.equal(repo.versions(id).length,2);assert.equal(experience.list(id).length,2);assert.ok(experience.list(id)[1].conflict);
 await read(receive('old',{stamp:'2026-09-08T12:00:00-03:00',file:'old'}),page('Persona Uno',job));assert.equal(repo.versions(id)[0].hash,updated.hash);
 receive('resend',{stamp:'2026-09-11T12:00:00-03:00',file:'a'});await extraction.process(r.hash);assert.equal(repo.versions(id)[0].hash,updated.hash);
 await read(receive('future',{stamp:'2026-09-11T14:00:00-03:00',file:'future'}),page('Persona Uno',job));
 let preview=exportsService.preview({start:'2026-09-09',end:'2026-09-10',mode:'updated'});assert.equal(preview.people,1);assert.equal(preview.rows[0].hash,updated.hash);
 assert.equal(exportsService.preview({start:'2026-09-09',end:'2026-09-10',mode:'new'}).people,0);
 const other=await read(receive('other-person',{chat:'222@lid',file:'b',caption:'CV de mi hermano'}),page('Persona Uno',job));assert.equal(other.candidate_id,null);assert.equal(db.prepare('SELECT count(*) n FROM cv_files').get().n,4);
 const separate=identity.createForReceipt(other,{name:{value:'Persona Dos'}});await extraction.process(other.hash);assert.notEqual(separate.candidate_id,id);
 const conflict=await read(receive('third',{file:'third'}),page('Otra Persona',job));assert.equal(conflict.candidate_id,null);
 db.prepare("UPDATE cv_receipts SET classification='other' WHERE id=?").run(conflict.id);
 preview=exportsService.preview({start:'2026-09-09',end:'2026-09-10',mode:'updated'});assert.equal(preview.people,2);assert.equal(preview.files,1);
 const task=exportsService.start({start:'2026-09-09',end:'2026-09-10',mode:'updated'},1);
 while(task.state==='building')await new Promise(r=>setTimeout(r,10));assert.equal(task.state,'ready',task.error);
 const archive=await zip.loadAsync(fs.readFileSync(task.path));assert.equal(Object.keys(archive.files).filter(n=>n.endsWith('.pdf')).length,1);
 const csv=await archive.file('experiencias.csv').async('string');assert.ok(csv.includes('2022-01-01'));assert.ok(csv.includes('Reparto'));assert.equal(csv.includes('Corrección manual'),false);
 const task2=exportsService.start({start:'2026-09-09',end:'2026-09-10',mode:'updated'},1);while(task2.state==='building')await new Promise(r=>setTimeout(r,10));assert.equal(task2.state,'ready');
 assert.equal(original.incorporated,'2026-09-09T15:00:00.000Z');
});
test('Experiencias múltiples, categorías por tareas y períodos superpuestos',()=>{
 assert.deepEqual(categories('repartía mercadería, atendía clientes y cobraba'),['Atención al cliente','Reparto','Cobranza o manejo de dinero']);
 assert.equal(categories('Empresa Coca Cola').length,0);
 const id=repo.list()[0].id,v=repo.versions(id)[0];
 const manual={employer:'Otra empresa',role:'Operario',tasks:'Carga y descarga',start:'2020-01-01',end:'2021-01-01',categories:['Carga y descarga','Depósito y logística']};
 experience.save(id,{data:manual,version_id:v.id,confirm:true},1);
 const totals=experience.totals([{data:manual},{data:{...manual,start:'2020-06-01',end:'2021-06-01'}}],'2026-09-10');
 assert.equal(totals['Carga y descarga'].days,(Date.parse('2021-06-01')-Date.parse('2020-01-01'))/86400000);
 assert.equal(new ExperienciaLaboral({...manual,start:'2020',end:'2021'}).duration('2026-09-10'),null);
 assert.equal(dateRange('2026-09-09','2026-09-10').end,'2026-09-11T03:00:00.000Z');
 assert.equal(csvCell('=HYPERLINK("evil")').startsWith('"\''),true);assert.equal(csvCell('  +SUM(1)').startsWith('"\''),true);
});
test('Archivo guardado aunque falle lectura y ZIP incompleto bloqueado',async()=>{
 const r=receive('bad',{chat:'333@c.us',file:'invalid-pdf'});const previous=process.env.PYTHON_BIN;process.env.PYTHON_BIN='nonexistent-python-rrhh';
 extraction.enqueue(r.hash);while(extraction.running||extraction.queue.length)await new Promise(r=>setTimeout(r,10));if(previous)process.env.PYTHON_BIN=previous;else delete process.env.PYTHON_BIN;
 assert.equal(repo.file(r.hash).read_state,'error');assert.ok(fs.existsSync(path.join(repo.root,'cv',repo.file(r.hash).path)));
 assert.throws(()=>exportsService.start({start:'2026-09-09',end:'2026-09-10'},1),/pendientes/);
});
after(async()=>{await services.close();db.close();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});});
