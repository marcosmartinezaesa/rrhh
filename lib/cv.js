const fs=require('fs');const path=require('path');const {execFile}=require('child_process');const {promisify}=require('util');
const {digest,error,now,json}=require('./storage');
const {extractExperiences}=require('./experience');
const execute=promisify(execFile);
function inspectBytes(bytes){
  if(bytes.subarray(0,5).toString()==='%PDF-')return {mime:'application/pdf',ext:'.pdf'};
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'.png'};
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',ext:'.jpg'};
  throw error('Sólo PDF, PNG y JPG válidos');
}
function extractFields(pages){const result={};for(const p of pages){for(const [key,pattern] of Object.entries({name:/(?:nombre(?: completo| y apellido)?|apellido y nombre)\s*:\s*([^\n]+)/i,dni:/\bdni\s*:?\s*([\d. -]{7,14})/i,cvPhone:/(?:tel[eé]fono|celular|whatsapp)\s*:?\s*(\+?[\d ()-]{8,22})/i,birthDate:/(?:fecha de nacimiento|nacim[ie]+nto)\s*:\s*([^\n]+)/i,locality:/(?:localidad)\s*:\s*([^\n]+)/i,address:/(?:domicilio|direcci[oó]n)\s*:\s*([^\n]+)/i,license:/(?:licencia|registro)(?: de conducir)?\s*:\s*([^\n]+)/i,declaredAge:/\bedad\s*:\s*(\d{1,3})\s*(?:años)?/i})){const m=p.text.match(pattern);if(m&&!result[key])result[key]={value:m[1].trim(),fragment:m[0],page:p.page};}}return result;}
class IdentidadService{
  constructor(repo){this.repo=repo;this.db=repo.db;}
  associate(receiptId,candidateId,user=null){
    return this.db.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM cv_receipts WHERE id=?').get(receiptId);if(!r?.hash)throw error('El adjunto todavía no está disponible');
      if(r.candidate_id&&r.candidate_id!==candidateId)throw error('La recepción ya está asociada; utilizá la unión explícita de fichas');
      this.repo.person(candidateId);
      this.db.prepare("UPDATE cv_receipts SET candidate_id=?,classification='cv' WHERE id=?").run(candidateId,r.id);
      this.db.prepare('INSERT OR IGNORE INTO chat_people VALUES (?,?,?)').run(r.account,r.chat,candidateId);
      this.db.prepare('INSERT INTO cv_versions(candidate_id,hash,incorporated) VALUES (?,?,?) ON CONFLICT(candidate_id,hash) DO UPDATE SET incorporated=min(incorporated,excluded.incorporated),date_known=1').run(candidateId,r.hash,r.received);
      this.repo.log(`Recepción ${r.id} asociada al postulante ${candidateId}`,user);
      return this.db.prepare('SELECT * FROM cv_versions WHERE candidate_id=? AND hash=?').get(candidateId,r.hash);
    })();
  }
  createForReceipt(receipt,fields={}){
    const id=this.db.prepare("INSERT INTO candidates(name,phone,source) VALUES (?,?,?)").run(fields.name?.value||'Nombre por confirmar',receipt.phone||'',`WhatsApp · ${receipt.chat}`).lastInsertRowid;
    return this.associate(receipt.id,id);
  }
  automatic(r,fields){
    if(r.candidate_id)return this.associate(r.id,r.candidate_id);
    const people=this.db.prepare('SELECT c.* FROM chat_people cp JOIN candidates c ON c.id=cp.candidate_id WHERE cp.account=? AND cp.chat=? AND c.mergedInto IS NULL').all(r.account,r.chat);
    // Un tercero explícito, una identidad distinta o una actualización sin evidencia quedan pendientes.
    if(/(?:cv|curr[ií]culum) de (?:mi |un |una )|(?:mi hermano|mi hermana|mi hijo|mi hija|mi amigo|mi amiga)/i.test(r.caption))return null;
    if(!people.length){if(this.db.prepare('SELECT 1 FROM cv_versions WHERE hash=?').get(r.hash))return null;return this.createForReceipt(r,fields);}
    const exact=people.filter(p=>this.db.prepare('SELECT 1 FROM cv_versions WHERE candidate_id=? AND hash=?').get(p.id,r.hash));
    if(exact.length===1)return this.associate(r.id,exact[0].id);
    const normalize=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
    // El nombre sólo aporta evidencia dentro del mismo chat; nunca fusiona fichas globalmente.
    if(people.length===1&&fields.name&&normalize(people[0].name)===normalize(fields.name.value)){
      const p=people[0];if(p.dniConfirmed&&fields.dni&&p.dniConfirmed.replace(/\D/g,'')!==fields.dni.value.replace(/\D/g,''))return null;
      return this.associate(r.id,p.id);
    }
    return null;
  }
  merge(from,to,versions,user){
    if(from===to)throw error('Elegí dos fichas diferentes');const a=this.repo.person(from),b=this.repo.person(to);
    if(a.version!==versions.from||b.version!==versions.to)throw error('Las fichas cambiaron; revisá antes de unir',409);
    this.db.transaction(()=>{
      for(const v of this.repo.versions(from)){
        const other=this.db.prepare('SELECT * FROM cv_versions WHERE candidate_id=? AND hash=?').get(to,v.hash);
        if(other){
          this.db.prepare('UPDATE employment_sources SET version_id=? WHERE version_id=?').run(other.id,v.id);
          this.db.prepare('UPDATE OR IGNORE person_evidence SET version_id=?,candidate_id=? WHERE version_id=?').run(other.id,to,v.id);
          this.db.prepare('UPDATE cv_versions SET incorporated=min(incorporated,?) WHERE id=?').run(v.incorporated,other.id);
          this.db.prepare('UPDATE legacy_document_map SET version_id=? WHERE version_id=?').run(other.id,v.id);
          // Mantener versiones antiguas como parte del historial de la ficha unida.
        }else this.db.prepare('UPDATE cv_versions SET candidate_id=? WHERE id=?').run(to,v.id);
      }
      this.db.prepare('UPDATE employment SET candidate_id=? WHERE candidate_id=?').run(to,from);
      this.db.prepare('UPDATE person_evidence SET candidate_id=? WHERE candidate_id=?').run(to,from);
      this.db.prepare('UPDATE cv_receipts SET candidate_id=? WHERE candidate_id=?').run(to,from);
      this.db.prepare('INSERT OR IGNORE INTO chat_people SELECT account,chat,? FROM chat_people WHERE candidate_id=?').run(to,from);
      this.db.prepare('UPDATE candidates SET mergedInto=?,version=version+1 WHERE id=?').run(to,from);
      this.db.prepare('UPDATE candidates SET version=version+1,notes=notes||? WHERE id=?').run(`\nFicha unida N.º ${from}. Notas originales:\n${a.notes}\nExperiencia original:\n${a.experience}`,to);
      this.repo.log(`Unión explícita de ${from} en ${to}; se conserva ficha origen`,user);
    })();
  }
}
class CVService{
  constructor(repo,identity){this.repo=repo;this.db=repo.db;this.identity=identity;this.extraction=null;}
  receive(meta,bytes){
    if(bytes.length>15*1024*1024)throw error('Adjunto mayor de 15 MB');const format=inspectBytes(bytes);const hash=digest(bytes);
    if(!Number.isFinite(Date.parse(meta.received)))throw error('Fecha original no disponible');
    let file=this.repo.file(hash);
    if(!file||!fs.existsSync(path.join(this.repo.root,'cv',file.path))){const filename=file?.path||hash+format.ext,target=path.join(this.repo.root,'cv',filename);if(!fs.existsSync(target)){const temp=target+'.'+require('crypto').randomUUID()+'.tmp';fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,target);}
      this.db.prepare('INSERT OR IGNORE INTO cv_files(hash,path,mime,size,original,created) VALUES (?,?,?,?,?,?)').run(hash,filename,format.mime,bytes.length,String(meta.original||filename).slice(0,300),now());file=this.repo.file(hash);
    }
    const result=this.db.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO cv_receipts(account,chat,message_id,received,phone,caption,context,original,created) VALUES (?,?,?,?,?,?,?,?,?)').run(meta.account,meta.chat,meta.message_id,new Date(meta.received).toISOString(),meta.phone||'',String(meta.caption||'').slice(0,12000),String(meta.context||'').slice(0,12000),meta.original||file.original,now());
      const receipt=this.db.prepare('SELECT * FROM cv_receipts WHERE account=? AND chat=? AND message_id=?').get(meta.account,meta.chat,meta.message_id);
      if(receipt.state==='saved')return {receipt,duplicate:true};
      const duplicate=!!this.db.prepare("SELECT id FROM cv_receipts WHERE account=? AND chat=? AND hash=? AND state='saved'").get(meta.account,meta.chat,hash);
      this.db.prepare("UPDATE cv_receipts SET hash=?,state='saved',error='',classification=? WHERE id=?").run(hash,meta.isCV?'cv':'review',receipt.id);
      if(meta.candidate_id)this.identity.associate(receipt.id,meta.candidate_id);
      return {receipt:this.db.prepare('SELECT * FROM cv_receipts WHERE id=?').get(receipt.id),duplicate};
    })();
    this.extraction?.enqueue(hash);return result;
  }
  failure(meta,reason){
    this.db.prepare("INSERT INTO cv_receipts(account,chat,message_id,received,phone,caption,original,state,error,created,attempts) VALUES (?,?,?,?,?,?,?,'error',?,?,1) ON CONFLICT(account,chat,message_id) DO UPDATE SET state=CASE WHEN state='saved' THEN state ELSE 'error' END,error=CASE WHEN state='saved' THEN '' ELSE excluded.error END,attempts=attempts+1").run(meta.account,meta.chat,meta.message_id,meta.received,meta.phone||'',meta.caption||'',meta.original||'',String(reason).slice(0,1000),now());
  }
}
class ExtraccionService{
  constructor(repo,identity,experiences){this.repo=repo;this.db=repo.db;this.identity=identity;this.experiences=experiences;this.queue=[];this.queued=new Set();this.running=false;this.stopped=false;}
  enqueue(hash){if(!this.queued.has(hash)){this.queued.add(hash);this.queue.push(hash);}if(!this.running)setImmediate(()=>this.drain());}
  resume(){this.db.prepare("UPDATE cv_files SET read_state='pending' WHERE read_state='reading'").run();for(const f of this.db.prepare("SELECT hash FROM cv_files WHERE read_state='pending'").all())this.enqueue(f.hash);}
  async drain(){if(this.running||this.stopped)return;this.running=true;try{while(this.queue.length&&!this.stopped){const hash=this.queue.shift();try{await this.process(hash);}catch(e){this.db.prepare("UPDATE cv_files SET read_state='error',read_error=? WHERE hash=?").run(String(e.message).slice(0,1000),hash);}finally{this.queued.delete(hash);}}}finally{this.running=false;}}
  async process(hash){
    let file=this.repo.file(hash);if(!file)return;
    if(!['done','partial'].includes(file.read_state)){
      this.db.prepare("UPDATE cv_files SET read_state='reading',read_error='' WHERE hash=?").run(hash);
      const spanish=fs.existsSync(path.join(this.repo.root,'tessdata','spa.traineddata'));
      const result=await execute(process.env.PYTHON_BIN||'python',[path.join(__dirname,'../extract_cv.py'),path.join(this.repo.root,'cv',file.path),process.env.TESSERACT_BIN||'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',process.env.OCR_LANG||(spanish?'spa':'eng')],{windowsHide:true,timeout:240000,maxBuffer:8*1024*1024,env:{...process.env,...(spanish&&!process.env.OCR_LANG?{TESSDATA_PREFIX:path.join(this.repo.root,'tessdata')}:{})}});
      const payload=JSON.parse(result.stdout);const fields=extractFields(payload.pages);
      this.db.prepare("UPDATE cv_files SET pages=?,extracted=?,read_state=?,read_error=?,extraction_version=extraction_version+1 WHERE hash=?").run(JSON.stringify(payload.pages),JSON.stringify(fields),payload.errors.length?'partial':'done',payload.errors.join('\n'),hash);file=this.repo.file(hash);
    }
    const pages=json(file.pages)||[],fields=json(file.extracted)||{};const full=pages.map(p=>p.text).join('\n');
    for(const r of this.db.prepare("SELECT * FROM cv_receipts WHERE hash=? AND state='saved' AND classification<>'other'").all(hash)){
      const signal=/\b(cv|curr[ií]culum|curriculum vitae|postulaci[oó]n)\b/i.test([r.original,r.caption].join(' '));
      const contentCV=/experiencia(?: laboral)?|antecedentes laborales/i.test(full)&&/educaci[oó]n|formaci[oó]n|estudios|datos personales/i.test(full);
      if(r.classification==='cv'||signal||contentCV){this.db.prepare("UPDATE cv_receipts SET classification='cv' WHERE id=?").run(r.id);this.identity.automatic({...r,classification:'cv'},fields);}
    }
    const jobs=extractExperiences(pages);
    for(const v of this.db.prepare('SELECT v.* FROM cv_versions v JOIN candidates c ON c.id=v.candidate_id WHERE v.hash=? AND c.mergedInto IS NULL').all(hash)){
      for(const [field,evidence] of Object.entries(fields))this.db.prepare('INSERT OR IGNORE INTO person_evidence(candidate_id,version_id,field,value,fragment,page) VALUES (?,?,?,?,?,?)').run(v.candidate_id,v.id,field,evidence.value,evidence.fragment,evidence.page);
      this.db.prepare("UPDATE candidates SET dniExtracted=? WHERE id=? AND dniExtracted=''").run(fields.dni?.value||'',v.candidate_id);
      this.experiences.ingest(v,jobs);
      for(const receipt of this.db.prepare('SELECT * FROM cv_receipts WHERE candidate_id=? AND hash=?').all(v.candidate_id,hash)){
        if(/experiencia laboral\s*:/i.test(receipt.caption))this.experiences.ingest(v,extractExperiences([{page:null,text:receipt.caption}]),receipt);
      }
    }
  }
}
module.exports={CVService,IdentidadService,ExtraccionService,inspectBytes,extractFields};
