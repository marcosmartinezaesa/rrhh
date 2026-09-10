const fs=require('fs');const path=require('path');const QRCode=require('qrcode');
const {error,now,json}=require('./storage');
function dateRange(start,end){
  const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  if(!valid(start)||!valid(end)||start>end)throw error('Rango de fechas inválido');
  const midnight=day=>{const base=Date.parse(day+'T00:00:00Z');let stamp=base;const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});for(let i=0;i<3;i++){const p=Object.fromEntries(formatter.formatToParts(new Date(stamp)).map(p=>[p.type,p.value]));const shown=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);stamp=base-(shown-stamp);}return new Date(stamp).toISOString();};
  const next=new Date(Date.parse(end+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  return {start:midnight(start),end:midnight(next)};
}
const individual=id=>/@(?:c\.us|lid)$/.test(id||'');
function bounded(promise,ms=90000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('WhatsApp no respondió dentro del plazo; reintentar')),ms);})]).finally(()=>clearTimeout(timer));}
class WhatsAppService{
  constructor(repo,cv,{clientFactory}={}){this.repo=repo;this.db=repo.db;this.cv=cv;this.clientFactory=clientFactory;this.client=null;this.state='disconnected';this.qr=null;this.account=null;this.lastError='';this.tail=Promise.resolve();this.sync=null;this.lock=path.join(repo.root,'whatsapp-client.lock');this.expected=process.env.WHATSAPP_ACCOUNT||'5491151475803';}
  status(admin){return {state:this.state,account:this.account,expected:this.expected,qr:admin?this.qr:null,error:this.lastError,session:'Sesión exclusiva de RRHH',lastSync:this.db.prepare("SELECT updated FROM sync_jobs WHERE state='done' ORDER BY id DESC LIMIT 1").get()?.updated||null};}
  async connect(body){
    if(this.client||this.state==='connecting')throw error('El cliente RRHH ya está iniciado',409);
    if(body.otherIntegration===true)throw error('Conflicto: la cuenta está administrada por otra integración. No se inició otro cliente.',409);
    if(body.exclusiveAccount!==true)throw error('Confirmá que la cuenta prevista no está siendo administrada por otra integración');
    if(fs.existsSync(this.lock)){const pid=Number(fs.readFileSync(this.lock,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw error('Ya hay un proceso RRHH que administra esta sesión',409);fs.unlinkSync(this.lock);}
    fs.writeFileSync(this.lock,String(process.pid),{flag:'wx'});
    const executable=process.env.WHATSAPP_BROWSER||['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p=>fs.existsSync(p));
    if(!executable&&!this.clientFactory){fs.unlinkSync(this.lock);throw error('Configurá WHATSAPP_BROWSER con la ruta del navegador');}
    this.state='connecting';this.lastError='';
    try{
      const {Client,LocalAuth}=require('whatsapp-web.js');
      this.client=this.clientFactory?this.clientFactory():new Client({authStrategy:new LocalAuth({clientId:'rrhh',dataPath:path.join(this.repo.root,'whatsapp-auth')}),takeoverOnConflict:false,webVersionCache:{type:'local',path:path.join(this.repo.root,'whatsapp-cache')},puppeteer:{headless:true,executablePath:executable,args:['--disable-dev-shm-usage']}});
      this.client.on('qr',qr=>{QRCode.toDataURL(qr).then(data=>{this.qr=data;this.state='qr';}).catch(e=>this.fail(e));});
      this.client.on('authenticated',()=>{this.qr=null;this.state='authenticated';});
      this.client.on('ready',()=>{
        this.account=this.client.info?.wid?._serialized||'';const number=this.account.split('@')[0];
        if(number!==this.expected){this.lastError=`Cuenta conectada ${number}; se esperaba ${this.expected}. Recepción detenida.`;this.disconnect().catch(()=>{});return;}
        this.state='ready';this.qr=null;this.retry().catch(e=>this.fail(e));
      });
      this.client.on('change_state',state=>{if(state==='CONFLICT'){this.lastError='Conflicto con otra sesión. No se toma control.';this.disconnect().catch(()=>{});}});
      this.client.on('auth_failure',message=>{this.lastError='Falló la autenticación: '+String(message);this.state='error';this.qr=null;});
      this.client.on('disconnected',reason=>{this.state='disconnected';this.qr=null;this.lastError=String(reason);});
      this.client.on('message',message=>{if(this.state==='ready')this.enqueue(message).catch(e=>this.fail(e));});
      this.client.initialize().catch(async e=>{this.lastError=e.message;await this.disconnect().catch(()=>{});this.state='error';});
    }catch(e){this.state='error';this.lastError=e.message;await this.disconnect();throw e;}
  }
  fail(e){this.lastError=String(e.message||e).slice(0,1000);}
  async disconnect(){this.sync?.cancel();const client=this.client;this.client=null;this.qr=null;this.state='disconnected';if(client)await client.destroy();if(fs.existsSync(this.lock)&&fs.readFileSync(this.lock,'utf8')===String(process.pid))fs.unlinkSync(this.lock);}
  meta(message,context=''){
    const chat=message.from;return {account:this.account,chat,message_id:message.id?._serialized,received:new Date(message.timestamp*1000).toISOString(),phone:chat.endsWith('@c.us')?'+'+chat.split('@')[0]:'',caption:message.body||'',context};
  }
  enqueue(message,context=''){
    if(message.fromMe||!individual(message.from)||!message.hasMedia)return Promise.resolve('ignored');
    const meta=this.meta(message,context);if(!meta.message_id)return Promise.resolve('ignored');
    this.db.prepare('INSERT OR IGNORE INTO cv_receipts(account,chat,message_id,received,phone,caption,context,created) VALUES (?,?,?,?,?,?,?,?)').run(meta.account,meta.chat,meta.message_id,meta.received,meta.phone,meta.caption,context,now());
    const job=this.tail.then(()=>this.process(message,meta));this.tail=job.catch(()=>{});return job;
  }
  async process(message,meta){
    const previous=this.db.prepare('SELECT * FROM cv_receipts WHERE account=? AND chat=? AND message_id=?').get(meta.account,meta.chat,meta.message_id);if(previous?.state==='saved'||previous?.state==='ignored')return 'duplicate';
    try{
      if(meta.chat.endsWith('@lid')&&this.client?.getContactLidAndPhone){try{const ids=await this.client.getContactLidAndPhone([meta.chat]);const pn=ids[0]?.pn;if(pn?.endsWith('@c.us'))meta.phone='+'+pn.split('@')[0];}catch{}}
      let media;for(let attempt=0;attempt<3;attempt++){try{media=await bounded(message.downloadMedia(),30000);if(media)break;}catch(e){if(attempt===2)throw e;}}
      if(!media?.data)throw error('Medio no disponible en WhatsApp; se puede reintentar');
      if(!['application/pdf','image/jpeg','image/png'].includes(media.mimetype)){this.db.prepare("UPDATE cv_receipts SET state='ignored',classification='other',error='' WHERE id=?").run(previous.id);return 'ignored';}
      meta.original=media.filename||('adjunto'+(media.mimetype==='application/pdf'?'.pdf':media.mimetype==='image/png'?'.png':'.jpg'));
      if(media.data.length>22*1024*1024)throw error('Adjunto supera el límite de 15 MB');
      const result=this.cv.receive(meta,Buffer.from(media.data,'base64'));return result.duplicate?'duplicate':'saved';
    }catch(e){this.cv.failure(meta,e.message);return 'error';}
  }
  async retry(){
    if(this.state!=='ready')throw error('WhatsApp no está conectado');
    const pending=this.db.prepare("SELECT * FROM cv_receipts WHERE account=? AND state IN ('error','pending') ORDER BY id").all(this.account);
    for(const r of pending){if(this.state!=='ready')break;try{const message=await this.client.getMessageById(r.message_id);if(!message)throw error('Mensaje no recuperable');await this.enqueue(message,r.context);}catch(e){this.cv.failure(r,e.message);}}
    return {retried:pending.length};
  }
}
class SincronizacionService{
  constructor(repo,wa){this.repo=repo;this.db=repo.db;this.wa=wa;this.active=null;this.cancelled=false;this.db.prepare("UPDATE sync_jobs SET state='paused' WHERE state='running'").run();}
  list(){return this.db.prepare('SELECT * FROM sync_jobs ORDER BY id DESC LIMIT 10').all().map(j=>({...j,progress:json(j.progress),chat_ids:undefined}));}
  start(body){if(this.wa.state!=='ready')throw error('Primero vinculá WhatsApp');if(this.active)throw error('Hay una sincronización en curso',409);const range=dateRange(body.start,body.end);const id=this.db.prepare("INSERT INTO sync_jobs(account,start,end,state,created,updated) VALUES (?,?,?,'paused',?,?)").run(this.wa.account,range.start,range.end,now(),now()).lastInsertRowid;this.resume(id);return {id};}
  resume(id){if(this.active)throw error('Hay una sincronización en curso',409);if(this.wa.state!=='ready')throw error('Primero vinculá WhatsApp');const job=this.db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(id);if(!job||job.account!==this.wa.account)throw error('Trabajo no disponible para esta cuenta');this.cancelled=false;this.active=id;this.db.prepare("UPDATE sync_jobs SET state='running',updated=? WHERE id=?").run(now(),id);setImmediate(()=>this.run(job).catch(e=>{this.db.prepare("UPDATE sync_jobs SET state='paused',progress=?,updated=? WHERE id=?").run(JSON.stringify({...json(this.db.prepare('SELECT progress FROM sync_jobs WHERE id=?').get(id).progress),error:e.message}),now(),id);}).finally(()=>{this.active=null;}));return {id};}
  cancel(){this.cancelled=true;}
  async run(job){
    let ids=json(job.chat_ids)||[];let progress=json(job.progress)||{};
    if(!ids.length){ids=(await bounded(this.wa.client.getChats())).filter(c=>!c.isGroup&&individual(c.id._serialized)).map(c=>c.id._serialized);this.db.prepare('UPDATE sync_jobs SET chat_ids=? WHERE id=?').run(JSON.stringify(ids),job.id);}
    const limit=Number(process.env.WHATSAPP_HISTORY_LIMIT||5000);progress.totalChats=ids.length;progress.chats=progress.chats||{};
    for(let index=job.cursor;index<ids.length;index++){
      if(this.cancelled||this.wa.state!=='ready')break;
      const chatId=ids[index];let stats={messages:0,saved:0,duplicate:0,errors:0,ignored:0};
      try{
        const chat=await bounded(this.wa.client.getChatById(chatId));const messages=await bounded(chat.fetchMessages({limit}));
        stats.recovered=messages.length;stats.oldest=messages.length?new Date(Math.min(...messages.map(m=>m.timestamp))*1000).toISOString():null;stats.limitReached=messages.length>=limit;
        stats.coverage='Sólo historial devuelto por WhatsApp; no garantiza totalidad';
        for(let i=0;i<messages.length;i++){
          if(this.cancelled||this.wa.state!=='ready')break;
          const m=messages[i],stamp=new Date(m.timestamp*1000).toISOString();if(stamp<job.start||stamp>=job.end)continue;stats.messages++;
          const result=await this.wa.enqueue(m,messages.slice(Math.max(0,i-2),i).filter(x=>!x.fromMe&&!x.hasMedia).map(x=>x.body).join('\n').slice(0,12000));
          stats[result==='error'?'errors':result]=(stats[result==='error'?'errors':result]||0)+1;
          progress.chats[chatId]=stats;this.db.prepare('UPDATE sync_jobs SET progress=?,updated=? WHERE id=?').run(JSON.stringify(progress),now(),job.id);
        }
      }catch(e){stats.errors++;stats.error=e.message;}
      progress.chats[chatId]=stats;if(stats.error)this.cancelled=true;const complete=!this.cancelled&&this.wa.state==='ready';
      this.db.prepare('UPDATE sync_jobs SET cursor=?,progress=?,updated=? WHERE id=?').run(complete?index+1:index,JSON.stringify(progress),now(),job.id);
    }
    this.db.prepare('UPDATE sync_jobs SET state=?,updated=? WHERE id=?').run(this.cancelled||this.wa.state!=='ready'?'paused':'done',now(),job.id);
  }
}
module.exports={WhatsAppService,SincronizacionService,dateRange,individual};
