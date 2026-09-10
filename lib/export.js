const fs=require('fs');const path=require('path');const crypto=require('crypto');const {ZipArchive}=require('archiver');
const {dateRange}=require('./whatsapp');const {error,now}=require('./storage');const {ExperienciaLaboral}=require('./experience');
function csvCell(value){let s=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/.test(s)||/^[\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
const csv=rows=>'\ufeff'+rows.map(r=>r.map(csvCell).join(';')).join('\r\n');
const safe=s=>String(s||'Sin_nombre').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,70);
class ExportacionService{
  constructor(repo,experiences){this.repo=repo;this.db=repo.db;this.experiences=experiences;this.jobs=new Map();fs.mkdirSync(path.join(repo.root,'exports'),{recursive:true});}
  preview(body){
    const range=dateRange(body.start,body.end);const mode=body.mode||'new';if(!['new','updated'].includes(mode))throw error('Modo inválido');const rows=[];
    for(const p of this.repo.list()){
      const versions=this.repo.versions(p.id).filter(v=>v.date_known&&v.incorporated<range.end);
      if(!versions.length)continue;const first=this.db.prepare('SELECT min(incorporated) first FROM cv_versions WHERE candidate_id=? AND date_known=1').get(p.id).first;
      const include=mode==='new'?first>=range.start&&first<range.end:versions.some(v=>v.incorporated>=range.start);
      if(include){const v=versions[0],f=this.repo.file(v.hash);rows.push({candidate_id:p.id,name:p.name,contact:p.cvPhone||p.phone,version_id:v.id,date:v.incorporated,hash:v.hash,path:f.path,filename:`POST_${String(p.id).padStart(6,'0')}_${safe(p.name)}${path.extname(f.path)}`,reading:f.read_state});}
    }
    const hashes=new Map();for(const row of rows){if(hashes.has(row.hash))row.filename=hashes.get(row.hash);else hashes.set(row.hash,row.filename);}
    const missing=rows.filter(r=>!fs.existsSync(path.join(this.repo.root,'cv',r.path))).map(r=>r.candidate_id);
    const unresolved=this.db.prepare("SELECT count(*) n FROM cv_receipts WHERE received>=? AND received<? AND (state IN ('error','pending') OR (state='saved' AND classification<>'other' AND candidate_id IS NULL))").get(range.start,range.end).n;
    const reading=rows.filter(r=>r.reading!=='done').length;
    return {rows,people:rows.length,files:hashes.size,missing,unresolved,reading,range,mode};
  }
  start(body,user){
    const preview=this.preview(body);if(preview.missing.length||preview.unresolved)throw error('Hay adjuntos pendientes o archivos faltantes en el rango. Resolvelos antes de generar el ZIP',409);
    const id=crypto.randomUUID(),job={id,user,state:'building',created:now(),people:preview.people,files:preview.files,error:null};
    this.jobs.set(id,job);
    // Capturar fuentes de experiencia al crear el trabajo, antes de cambios posteriores.
    const experienceRows=[['postulante_id','experiencia_id','cv_version_id','empresa','puesto','tareas','inicio','fin','actual','duracion_declarada','duracion_calculada','categorias','fuente','pagina','fragmento','estado','contradiccion']];
    for(const r of preview.rows){const grouped=new Map();for(const s of this.experiences.list(r.candidate_id,r.version_id)){if(s.version_id===null)continue;if(!grouped.has(s.employment_id))grouped.set(s.employment_id,[]);grouped.get(s.employment_id).push(s);}for(const sources of grouped.values()){
      const source=sources.find(s=>s.state==='confirmed')||sources.at(-1);
      // Cargas globales sin versión no se atribuyen retroactivamente a CV anteriores.
      if(source.version_id===null)continue;
      const d=source.data;let duration=null;try{duration=new ExperienciaLaboral(d).duration(body.end);}catch{}
      experienceRows.push([r.candidate_id,source.employment_id,r.version_id,d.employer,d.role,d.tasks,d.start,d.end,d.current===null?'Por confirmar':d.current?'Sí':'No',d.declaredDuration,duration?`${duration.value} ${duration.unit}`:'Por confirmar',d.categories.join(' | '),sources.map(s=>s.receipt_id?'Mensaje '+s.receipt_id:'CV '+r.hash).join(' | '),source.page,sources.map(s=>s.fragment).join('\n---\n'),source.state,sources.map(s=>s.conflict).filter(Boolean).join(' | ')]);
    }}
    setImmediate(()=>this.build(job,preview,experienceRows).catch(e=>{job.state='error';job.error=e.message;}));return job;
  }
  async build(job,preview,experienceRows){
    const target=path.join(this.repo.root,'exports',job.id+'.zip'),temp=target+'.tmp';
    const archive=new ZipArchive({zlib:{level:6}}),output=fs.createWriteStream(temp,{flags:'wx'});
    try{await new Promise((resolve,reject)=>{
      output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.on('warning',reject);archive.pipe(output);
      const seen=new Set();for(const r of preview.rows){if(seen.has(r.hash))continue;seen.add(r.hash);archive.file(path.join(this.repo.root,'cv',r.path),{name:r.filename});}
      archive.append(csv([['id','nombre','contacto','fecha_cv','archivo','hash','version_cv','estado_lectura'],...preview.rows.map(r=>[r.candidate_id,r.name,r.contact,r.date,r.filename,r.hash,r.version_id,r.reading])]),{name:'indice.csv'});
      archive.append(csv(experienceRows),{name:'experiencias.csv'});
      archive.append(`Rango horario argentino: ${preview.range.start} inclusive a ${preview.range.end} exclusivo.\n${preview.people} postulantes; ${preview.files} archivos únicos.\nLecturas pendientes o con error: ${preview.reading}. Experiencia pendiente no equivale a ausencia de experiencia.\nSHA-256 deduplica bytes idénticos; no imágenes visualmente equivalentes.\n`,{name:'LEEME.txt'});
      archive.finalize().catch(reject);
    });fs.renameSync(temp,target);job.state='ready';job.path=target;}catch(e){archive.abort();output.destroy();if(fs.existsSync(temp))fs.unlinkSync(temp);throw e;}
  }
  get(id,user){const job=this.jobs.get(id);if(!job||job.user!==user)throw error('Exportación no encontrada',404);return job;}
}
module.exports={ExportacionService,csv,csvCell};
