const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const now=()=>new Date().toISOString();
const json=s=>{try{return JSON.parse(s);}catch{return null;}};
function migrate(db,root){
  db.exec('CREATE TABLE IF NOT EXISTS rrhh_migrations(version INTEGER PRIMARY KEY, applied TEXT)');
  if(db.prepare('SELECT 1 FROM rrhh_migrations WHERE version=2').get()) return;
  const backup=path.join(root,'migration-backups',Date.now()+'.sqlite');
  fs.mkdirSync(path.dirname(backup),{recursive:true});
  db.prepare('VACUUM INTO ?').run(backup);
  db.transaction(()=>{
    const existing=db.prepare('PRAGMA table_info(candidates)').all().map(c=>c.name);
    for(const [name,type] of Object.entries({dniExtracted:"TEXT DEFAULT ''",dniConfirmed:"TEXT DEFAULT ''",birthDate:"TEXT DEFAULT ''",declaredAge:"TEXT DEFAULT ''",ageReference:"TEXT DEFAULT ''",mergedInto:'INTEGER',reviewState:"TEXT DEFAULT 'Por confirmar'"})) if(!existing.includes(name))db.exec(`ALTER TABLE candidates ADD COLUMN ${name} ${type}`);
    db.exec(`
      CREATE TABLE cv_files(hash TEXT PRIMARY KEY,path TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,original TEXT NOT NULL,created TEXT NOT NULL,read_state TEXT DEFAULT 'pending',read_error TEXT DEFAULT '',pages TEXT DEFAULT '[]',extracted TEXT DEFAULT '{}',extraction_version INTEGER DEFAULT 0);
      CREATE TABLE cv_versions(id INTEGER PRIMARY KEY,candidate_id INTEGER NOT NULL REFERENCES candidates(id),hash TEXT NOT NULL REFERENCES cv_files(hash),incorporated TEXT NOT NULL,date_known INTEGER DEFAULT 1,UNIQUE(candidate_id,hash));
      CREATE TABLE cv_receipts(id INTEGER PRIMARY KEY,account TEXT NOT NULL,chat TEXT NOT NULL,message_id TEXT NOT NULL,received TEXT NOT NULL,hash TEXT REFERENCES cv_files(hash),candidate_id INTEGER REFERENCES candidates(id),phone TEXT DEFAULT '',caption TEXT DEFAULT '',context TEXT DEFAULT '',original TEXT DEFAULT '',state TEXT DEFAULT 'pending',error TEXT DEFAULT '',attempts INTEGER DEFAULT 0,classification TEXT DEFAULT 'review',created TEXT NOT NULL,UNIQUE(account,chat,message_id));
      CREATE TABLE chat_people(account TEXT,chat TEXT,candidate_id INTEGER REFERENCES candidates(id),PRIMARY KEY(account,chat,candidate_id));
      CREATE TABLE person_evidence(id INTEGER PRIMARY KEY,candidate_id INTEGER REFERENCES candidates(id),version_id INTEGER REFERENCES cv_versions(id),field TEXT,value TEXT,fragment TEXT,page INTEGER,state TEXT DEFAULT 'pending',UNIQUE(version_id,field,value));
      CREATE TABLE employment(id INTEGER PRIMARY KEY,candidate_id INTEGER REFERENCES candidates(id),match_key TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE employment_sources(id INTEGER PRIMARY KEY,employment_id INTEGER REFERENCES employment(id),version_id INTEGER REFERENCES cv_versions(id),source_key TEXT NOT NULL,receipt_id INTEGER REFERENCES cv_receipts(id),page INTEGER,fragment TEXT NOT NULL,data TEXT NOT NULL,state TEXT DEFAULT 'pending',revision INTEGER DEFAULT 1,conflict TEXT DEFAULT '',UNIQUE(employment_id,source_key));
      CREATE TABLE employment_history(id INTEGER PRIMARY KEY,source_id INTEGER REFERENCES employment_sources(id),data TEXT,state TEXT,revision INTEGER,changed TEXT,user_id INTEGER);
      CREATE TABLE sync_jobs(id INTEGER PRIMARY KEY,account TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,state TEXT NOT NULL,chat_ids TEXT DEFAULT '[]',cursor INTEGER DEFAULT 0,progress TEXT DEFAULT '{}',created TEXT,updated TEXT);
      CREATE TABLE legacy_document_map(document_id INTEGER PRIMARY KEY,version_id INTEGER REFERENCES cv_versions(id));
      CREATE INDEX receipt_dates ON cv_receipts(received);
      CREATE INDEX version_dates ON cv_versions(incorporated);
    `);
    // Originales heredados se mantienen; su fecha de recepción no se inventa.
    for(const doc of db.prepare('SELECT * FROM documents').all()){
      const filename=path.join(root,'cv',doc.path);if(!fs.existsSync(filename))continue;
      const bytes=fs.readFileSync(filename),hash=digest(bytes),ext=path.extname(filename).toLowerCase();
      db.prepare('INSERT OR IGNORE INTO cv_files(hash,path,mime,size,original,created,read_state,pages) VALUES (?,?,?,?,?,?,?,?)').run(hash,doc.path,ext==='.pdf'?'application/pdf':ext==='.png'?'image/png':'image/jpeg',bytes.length,doc.original,now(),doc.text?'done':'pending',JSON.stringify(doc.text?[{page:null,text:doc.text,method:'legacy'}]:[]));
      db.prepare('INSERT OR IGNORE INTO cv_versions(candidate_id,hash,incorporated,date_known) VALUES (?,?,?,0)').run(doc.candidate_id,hash,now());
      const version=db.prepare('SELECT id FROM cv_versions WHERE candidate_id=? AND hash=?').get(doc.candidate_id,hash);
      db.prepare('INSERT INTO legacy_document_map VALUES (?,?)').run(doc.id,version.id);
    }
    db.prepare('INSERT INTO rrhh_migrations VALUES (2,?)').run(now());
  })();
}
class Postulante{constructor(row){Object.assign(this,row);this.label=`Postulante N.º ${row.id}`;}}
class DocumentoCV{constructor(row){Object.assign(this,row);}}
class RecepcionCV{constructor(row){Object.assign(this,row);}}
class Repositorios{
  constructor(db,root){this.db=db;this.root=root;}
  file(hash){return this.db.prepare('SELECT * FROM cv_files WHERE hash=?').get(hash);}
  person(id){const p=this.db.prepare('SELECT * FROM candidates WHERE id=? AND mergedInto IS NULL').get(id);if(!p)throw error('Postulante no encontrado',404);return new Postulante(p);}
  versions(id){return this.db.prepare('SELECT v.*,f.original,f.read_state,f.read_error,f.mime FROM cv_versions v JOIN cv_files f ON f.hash=v.hash WHERE candidate_id=? ORDER BY incorporated DESC,v.id DESC').all(id);}
  list(){return this.db.prepare('SELECT * FROM candidates WHERE mergedInto IS NULL ORDER BY id DESC').all().map(row=>{const versions=this.versions(row.id);const receipt=this.db.prepare("SELECT min(received) first,max(received) last FROM cv_receipts WHERE candidate_id=? AND classification='cv' AND hash IS NOT NULL").get(row.id);return {...new Postulante(row),current:versions[0]||null,firstReceived:receipt.first,lastReceived:receipt.last};});}
  log(action,user=null){this.db.prepare('INSERT INTO audit(user_id,action) VALUES (?,?)').run(user,action);}
}
module.exports={migrate,Repositorios,Postulante,DocumentoCV,RecepcionCV,digest,error,now,json};
