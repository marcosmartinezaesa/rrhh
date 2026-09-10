const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const helmet = require('helmet');
const {rateLimit} = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {execFile} = require('child_process');
const {promisify} = require('util');
const ExcelJS = require('exceljs');
const pdf = require('pdf-parse');
const run = promisify(execFile);
const root = path.resolve(process.env.DATA_DIR || path.join(__dirname,'data'));
fs.mkdirSync(path.join(root,'cv'),{recursive:true});
const db = new Database(path.join(root,'rrhh.sqlite'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS candidates(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT DEFAULT '', cvPhone TEXT DEFAULT '', locality TEXT DEFAULT '', address TEXT DEFAULT '', license TEXT DEFAULT '', licenseExpiry TEXT DEFAULT '', adult TEXT DEFAULT 'Por confirmar', distance REAL, availability TEXT DEFAULT '', experience TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT DEFAULT 'Pendiente', source TEXT DEFAULT 'Carga manual', version INTEGER DEFAULT 1, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY,candidate_id INTEGER REFERENCES candidates(id),original TEXT,path TEXT,text TEXT,status TEXT);
CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY,title TEXT,date TEXT,time TEXT,capacity INTEGER);
CREATE TABLE IF NOT EXISTS invitations(campaign_id INTEGER REFERENCES campaigns(id),candidate_id INTEGER REFERENCES candidates(id),status TEXT DEFAULT 'Seleccionado',PRIMARY KEY(campaign_id,candidate_id));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,user_id INTEGER,action TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);`);
const app = express(); app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{'upgrade-insecure-requests':null}}, strictTransportSecurity:false}));
app.use(express.json({limit:'1mb'}));
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store'); if(!['GET','HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({error:'Origen no permitido'});next();});
const wrap = fn => (req,res,next)=>Promise.resolve().then(()=>fn(req,res,next)).catch(next);
const fail = (message,status=400)=>{const e=new Error(message);e.status=status;throw e;};
const audit = (req,action)=>db.prepare('INSERT INTO audit(user_id,action) VALUES (?,?)').run(req.user?.id||null,action);
function hash(password){const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(password,salt,64).toString('hex');}
function verify(password,stored){const [salt,value]=stored.split(':');return crypto.timingSafeEqual(Buffer.from(value,'hex'),crypto.scryptSync(password,salt,64));}
function credentials(body){if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(body.username||''))fail('Usuario: 3 a 40 letras, números, punto o guion');if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)fail('La contraseña debe tener entre 12 y 128 caracteres');}
const loginLimit=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
let setupToken;
if(!db.prepare('SELECT id FROM users LIMIT 1').get()){setupToken=crypto.randomBytes(18).toString('hex');fs.writeFileSync(path.join(root,'clave-inicial.txt'),setupToken);}
app.get('/api/auth', (req,res)=>res.json({needsSetup:!db.prepare('SELECT id FROM users LIMIT 1').get()}));
app.post('/api/setup',loginLimit,wrap((req,res)=>{if(!setupToken||req.body.token!==setupToken)fail('Clave de instalación incorrecta',403); credentials(req.body);db.prepare('INSERT INTO users(username,hash,role) VALUES (?,?,?)').run(req.body.username,hash(req.body.password),'admin');setupToken=null;fs.rmSync(path.join(root,'clave-inicial.txt'),{force:true});res.json({ok:true});}));
app.post('/api/login',loginLimit,wrap((req,res)=>{const {username,password}=req.body;if(typeof password!=='string'||password.length>128)fail('Credenciales incorrectas',401);const user=db.prepare('SELECT * FROM users WHERE username=?').get(String(username||''));if(!user||!verify(password,user.hash))fail('Credenciales incorrectas',401);const token=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),user.id,Date.now()+8*3600000);res.cookie('rrhh',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='1',maxAge:8*3600000});res.json({ok:true});}));
app.use('/api',(req,res,next)=>{const token=(req.headers.cookie||'').match(/(?:^|;\s*)rrhh=([a-f0-9]+)/)?.[1]||'';req.user=db.prepare('SELECT users.id,username,role FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?').get(crypto.createHash('sha256').update(token).digest('hex'),Date.now());if(!req.user)return res.status(401).json({error:'Iniciá sesión para continuar'});next();});
app.get('/api/me',(req,res)=>res.json(req.user));
app.post('/api/logout',(req,res)=>{const token=(req.headers.cookie||'').match(/(?:^|;\s*)rrhh=([a-f0-9]+)/)?.[1]||'';db.prepare('DELETE FROM sessions WHERE token=?').run(crypto.createHash('sha256').update(token).digest('hex'));res.clearCookie('rrhh');res.json({ok:true});});
app.post('/api/users',wrap((req,res)=>{if(req.user.role!=='admin')fail('Solo administradores',403);credentials(req.body);if(db.prepare('SELECT id FROM users WHERE username=?').get(req.body.username))fail('El usuario ya existe');db.prepare('INSERT INTO users(username,hash,role) VALUES (?,?,?)').run(req.body.username,hash(req.body.password),'recruiter');audit(req,'Usuario creado');res.json({ok:true});}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:15*1024*1024,files:1}});
const services=require('./lib/application').install(app,db,root,upload,wrap);
const fields=['name','phone','cvPhone','locality','address','license','licenseExpiry','adult','distance','availability','experience','notes','status','source','dniConfirmed','birthDate','declaredAge','ageReference','reviewState'];
const statuses=['Pendiente','Revisado','Preseleccionado','Archivado'];
function candidate(body){const row={};for(const key of fields)row[key]=String(body[key]??'').trim().slice(0,key==='notes'||key==='experience'?12000:500);if(!row.name)fail('Completá nombre y apellido');row.distance=body.distance===''||body.distance==null?null:Number(body.distance);if(row.distance!==null&&(!Number.isFinite(row.distance)||row.distance<0||row.distance>10000))fail('Distancia inválida');row.status=row.status||'Pendiente';if(!statuses.includes(row.status))fail('Estado inválido');row.adult=row.adult||'Por confirmar';if(!['Por confirmar','Sí','No'].includes(row.adult))fail('Mayoría de edad inválida');row.source=row.source||'Carga manual';return row;}
const insert=db.prepare(`INSERT INTO candidates(${fields.join(',')}) VALUES (${fields.map(k=>'@'+k).join(',')})`);
app.get('/api/candidates',(req,res)=>res.json(db.prepare('SELECT * FROM candidates ORDER BY id DESC').all()));
app.post('/api/candidates',wrap((req,res)=>{const info=insert.run(candidate(req.body));audit(req,`Ficha creada ${info.lastInsertRowid}`);res.json({id:info.lastInsertRowid});}));
app.put('/api/candidates/:id',wrap((req,res)=>{const info=db.prepare(`UPDATE candidates SET ${fields.map(k=>k+'=@'+k).join(',')},version=version+1 WHERE id=@id AND version=@version`).run({...candidate(req.body),id:Number(req.params.id),version:Number(req.body.version)});if(!info.changes)fail('Otra persona modificó la ficha. Cerrala y volvé a abrirla antes de guardar.',409);audit(req,`Ficha editada ${req.params.id}`);res.json({ok:true});}));
const {previewWorkbook}=require('./scripts/excel-import');
app.post('/api/import/preview',upload.single('file'),wrap(async(req,res)=>{if(!req.file||path.extname(req.file.originalname).toLowerCase()!=='.xlsx')fail('Seleccioná un archivo XLSX');try{res.json(await previewWorkbook(req.file.buffer,path.basename(req.file.originalname)));}catch(error){fail(error.message);}}));
app.post('/api/import/commit',wrap((req,res)=>{if(!Array.isArray(req.body.rows)||req.body.rows.length>2000)fail('Importación inválida');let added=0,skipped=0;db.transaction(()=>{for(const raw of req.body.rows){const row=candidate({...raw,status:'Pendiente',source:raw.source||'Excel · revisión pendiente'});if(db.prepare('SELECT id FROM candidates WHERE name=? AND phone=? AND cvPhone=?').get(row.name,row.phone,row.cvPhone)){skipped++;continue;}insert.run(row);added++;}})();audit(req,`Excel: ${added} fichas importadas`);res.json({added,skipped});}));
app.get('/api/campaigns',(req,res)=>res.json(db.prepare('SELECT * FROM campaigns ORDER BY date DESC').all().map(c=>({...c,invitations:db.prepare('SELECT i.*,c.name,c.phone FROM invitations i JOIN candidates c ON c.id=i.candidate_id WHERE campaign_id=?').all(c.id)}))));
app.post('/api/campaigns',wrap((req,res)=>{const {title,date,time,capacity}=req.body;if(!title||String(title).length>200||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time)||!Number.isInteger(Number(capacity))||capacity<1||capacity>1000)fail('Completá título, fecha, hora y cupo válido');const info=db.prepare('INSERT INTO campaigns(title,date,time,capacity) VALUES (?,?,?,?)').run(title,date,time,capacity);audit(req,'Convocatoria creada');res.json({id:info.lastInsertRowid});}));
const invitationStatuses=['Seleccionado','Invitado','Confirmó','No puede asistir','Sin respuesta','Asistió','No asistió'];
app.post('/api/campaigns/:id/invitations',wrap((req,res)=>{const ids=req.body.ids;if(!Array.isArray(ids)||!ids.length||ids.length>1000)fail('Seleccioná postulantes');db.transaction(()=>{const campaign=db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);if(!campaign)fail('Convocatoria no encontrada',404);const current=db.prepare('SELECT candidate_id FROM invitations WHERE campaign_id=?').all(campaign.id).map(r=>r.candidate_id);const total=new Set([...current,...ids.map(Number)]);if(total.size>campaign.capacity)fail('La selección supera el cupo de la convocatoria');for(const id of ids){if(!db.prepare('SELECT id FROM candidates WHERE id=?').get(Number(id)))fail('Postulante inexistente');db.prepare('INSERT OR IGNORE INTO invitations(campaign_id,candidate_id) VALUES (?,?)').run(campaign.id,Number(id));}})();audit(req,'Postulantes agregados a convocatoria');res.json({ok:true});}));
app.put('/api/campaigns/:id/invitations/:candidate',wrap((req,res)=>{if(!invitationStatuses.includes(req.body.status))fail('Estado inválido');const info=db.prepare('UPDATE invitations SET status=? WHERE campaign_id=? AND candidate_id=?').run(req.body.status,req.params.id,req.params.candidate);if(!info.changes)fail('Invitación no encontrada',404);audit(req,`Invitación ${req.params.id}/${req.params.candidate}: ${req.body.status}`);res.json({ok:true});}));
app.post('/api/backup',wrap(async(req,res)=>{if(req.user.role!=='admin')fail('Solo administradores',403);const dest=path.resolve(__dirname,'backups',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(dest,{recursive:true});await db.backup(path.join(dest,'rrhh.sqlite'));fs.cpSync(path.join(root,'cv'),path.join(dest,'cv'),{recursive:true});audit(req,'Copia de seguridad creada');res.json({path:dest});}));
app.use(express.static(path.join(__dirname,'public')));
app.use((err,req,res,next)=>{console.error(err.message);res.status(err.status||400).json({error:err.code==='LIMIT_FILE_SIZE'?'El archivo supera 15 MB':err.status?err.message:'No se pudo completar la operación. Revisá el archivo o los datos.'});});
if(require.main===module){services.start();const port=Number(process.env.PORT||3050);app.listen(port,process.env.HOST||'0.0.0.0',()=>{console.log(`RRHH IVESS disponible en http://localhost:${port}`);if(setupToken)console.log('Primera instalación: consultá data/clave-inicial.txt para crear el administrador.');});}
module.exports={app,db,services};
