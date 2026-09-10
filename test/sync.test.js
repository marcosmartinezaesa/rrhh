const {test,after}=require('node:test');const assert=require('assert/strict');const fs=require('fs');const os=require('os');const path=require('path');const {EventEmitter}=require('events');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'rrhh-sync-'));
const {db,services}=require('../server');const {WhatsAppService,SincronizacionService}=require('../lib/whatsapp');
services.cv.extraction=null;
class FakeClient extends EventEmitter{initialize(){return Promise.resolve();}destroy(){return Promise.resolve();}}
test('QR y conflicto, sincronización reanudable, LID, grupos y medio no disponible',async()=>{
 const client=new FakeClient();const wa=new WhatsAppService(services.repo,services.cv,{clientFactory:()=>client});
 await assert.rejects(wa.connect({otherIntegration:true}),/Conflicto/);await wa.connect({exclusiveAccount:true});client.emit('qr','QR-SINTETICO-DE-PRUEBA');await new Promise(r=>setTimeout(r,80));assert.ok(wa.status(true).qr?.startsWith('data:image/png'));assert.equal(wa.status(false).qr,null);await wa.disconnect();
 wa.client=client;wa.account='test';wa.state='ready';
 const sync=new SincronizacionService(services.repo,wa);wa.sync=sync;
 let fail=true;client.getChats=async()=>[{isGroup:true,id:{_serialized:'g@g.us'}},{id:{_serialized:'1@lid'}},{id:{_serialized:'status@broadcast'}}];
 const message={from:'1@lid',id:{_serialized:'m1'},timestamp:Date.parse('2026-09-09T12:00:00Z')/1000,hasMedia:true,body:'mi cv',downloadMedia:async()=>({mimetype:'application/pdf',filename:'cv.pdf',data:Buffer.from('%PDF-1.7 fake').toString('base64')})};
 client.getChatById=async()=>{if(fail)throw Error('Fallo reintentable');return {fetchMessages:async()=>[message]};};
 const started=sync.start({start:'2026-09-09',end:'2026-09-10'});while(sync.active)await new Promise(r=>setTimeout(r,10));assert.equal(sync.list()[0].state,'paused');assert.equal(sync.list()[0].cursor,0);
 fail=false;const restarted=new SincronizacionService(services.repo,wa);restarted.resume(started.id);while(restarted.active)await new Promise(r=>setTimeout(r,10));assert.equal(restarted.list()[0].state,'done');assert.equal(restarted.list()[0].cursor,1);
 let receipt=db.prepare('SELECT * FROM cv_receipts WHERE message_id=?').get('m1');assert.equal(receipt.phone,'');assert.equal(receipt.chat,'1@lid');
 await wa.enqueue(message);assert.equal(db.prepare('SELECT count(*) n FROM cv_receipts').get().n,1);
 await wa.enqueue({...message,id:{_serialized:'missing'},downloadMedia:async()=>null});assert.equal(db.prepare('SELECT state FROM cv_receipts WHERE message_id=?').get('missing').state,'error');
 await wa.enqueue({...message,from:'g@g.us',id:{_serialized:'group'}});assert.equal(db.prepare('SELECT count(*) n FROM cv_receipts').get().n,2);
 await wa.disconnect();
});
after(async()=>{await services.close();db.close();fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});});
