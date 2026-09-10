const {digest,error,now,json}=require('./storage');
const CATEGORIES=['Ventas','Atención al cliente','Reparto','Conducción de vehículos','Cobranza o manejo de dinero','Depósito y logística','Carga y descarga','Otras tareas'];
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function categories(text){
  // Sólo tareas explícitas; los nombres de empleadores nunca se pasan a esta función.
  const t=text.toLowerCase();const found=[];
  for(const [label,re] of [
    ['Ventas',/\b(vend[íie]|venta de|vendedor|comercializ)/],['Atención al cliente',/atenci[oó]n al (?:cliente|p[uú]blico)|atend[íi]a? (?:a )?clientes/],
    ['Reparto',/\b(repart[íi]|reparto|repartidor|distribu[íi]a|entrega(?:ba)? de mercader)/],['Conducción de vehículos',/\b(chofer|conductor|conduc[íi]a|maneja(?:ba)? (?:camiones|veh[íi]culos|colectivos))/],
    ['Cobranza o manejo de dinero',/\b(cobraba|cobranza|cobr[oó]|cajero|manejo de (?:dinero|caja))/],['Depósito y logística',/\b(log[íi]stica|operario de dep[oó]sito|control de stock|almacenamiento|preparaci[oó]n de pedidos)/],
    ['Carga y descarga',/\b(carga y descarga|cargaba|descargaba|descarga de)/]
  ])if(re.test(t))found.push(label);
  return found;
}
function partialDate(value){
  if(!value)return '';
  if(!/^\d{4}(-\d{2})?(-\d{2})?$/.test(value))throw error('Fecha: usar AAAA, AAAA-MM o AAAA-MM-DD');
  const [y,m,d]=value.split('-').map(Number);if(y<1900||y>2200||(m!=null&&(m<1||m>12))||(d!=null&&(d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate())))throw error('Fecha laboral inválida');return value;
}
class ExperienciaLaboral{
  constructor(input={}){
    for(const key of ['employer','role','tasks','declaredDuration'])this[key]=String(input[key]||'').trim().slice(0,12000);
    this.start=partialDate(input.start||'');this.end=partialDate(input.end||'');
    this.current=input.current===true?true:input.current===false?false:null;
    this.categories=Array.isArray(input.categories)?[...new Set(input.categories.filter(v=>CATEGORIES.includes(v)))]:[];
    if(this.start&&this.end&&this.start.length===this.end.length&&this.start>this.end)throw error('La finalización precede al inicio');
    if(this.current===true&&this.end)throw error('Un trabajo actual no puede tener fecha final');
    if(!this.role&&!this.tasks&&!this.employer)throw error('Completá empresa, puesto o tareas');
  }
  duration(cutoff){
    const end=this.end||(this.current===true?cutoff:'');
    if(this.start.length===10&&end?.length===10){const days=Math.max(0,Math.floor((Date.parse(end)-Date.parse(this.start))/86400000));return {value:days,unit:'días',kind:'calculada',asOf:end};}
    if(this.start.length===7&&end?.length===7){const [y,m]=this.start.split('-').map(Number),[ey,em]=end.split('-').map(Number);return {value:Math.max(0,(ey-y)*12+em-m),unit:'meses',kind:'calculada'};}
    return null;
  }
}
function extractExperiences(pages){
  const jobs=[];
  for(const page of pages){
    const text=page.text||'';
    const section=text.match(/(?:experiencia(?:\s+laboral)?|antecedentes laborales|historial laboral)\s*[:\n]([\s\S]*?)(?=\n\s*(?:educaci[oó]n|formaci[oó]n|estudios|referencias|habilidades|idiomas)\b|$)/i);
    if(!section)continue;
    const blocks=section[1].trim().split(/\n\s*\n|\n(?=\s*(?:empresa|empleador)\s*:)/i).filter(Boolean);
    for(const block of blocks){
      if(block.length<10)continue;
      const get=label=>block.match(new RegExp('(?:^|\\n)\\s*(?:'+label+')\\s*:\\s*([^\\n]+)','i'))?.[1]?.trim()||'';
      const employer=get('empresa|empleador'),role=get('puesto|cargo');
      const task=get('tareas|funciones|responsabilidades');
      // Si el diseño no tiene etiquetas se conserva íntegro, sin inventar empresa ni cargo.
      const tasks=task||block.split('\n').filter(l=>!/^\s*(empresa|empleador|puesto|cargo)\s*:/i.test(l)&&/\b(repartía|atendía|cobraba|vendía|conducía|cargaba|descargaba|realizaba|realicé|trabajé|trabajaba|me encargaba)\b/i.test(l)).join('\n');
      const dates=block.match(/\b(?:19|20)\d{2}(?:-\d{2}(?:-\d{2})?)?\b/g)||[];
      let start='',end='';try{start=partialDate(dates[0]||'');end=partialDate(dates[1]||'');}catch{}
      const current=/\b(actualidad|actualmente|presente|contin[uú]o trabajando)\b/i.test(block)?true:null;
      const declaredDuration=block.match(/\b\d+\s*(?:a[ñn]os|meses|semanas)\b/i)?.[0]||'';
      try{jobs.push({data:new ExperienciaLaboral({employer,role,tasks,start,end:current?'':end,current,declaredDuration,categories:categories([role,tasks].join('\n'))}),page:page.page,fragment:block});}catch{jobs.push({data:{employer:'',role:'',tasks:'',start:'',end:'',current:null,declaredDuration:'',categories:[]},page:page.page,fragment:block});}
    }
  }
  return jobs;
}
class ExperienciaService{
  constructor(repo){this.repo=repo;this.db=repo.db;}
  ingest(version,jobs,receipt=null){this.db.transaction(()=>{const used=new Map();for(const job of jobs){
    let key=job.data.employer&&job.data.role?'job:'+norm(job.data.employer)+'|'+norm(job.data.role):'text:'+digest(Buffer.from(job.fragment.trim()));
    if(used.has(key)&&used.get(key)!==job.fragment)key+='|period:'+job.data.start+'|'+job.data.end;
    used.set(key,job.fragment);
    let employment=this.db.prepare('SELECT * FROM employment WHERE candidate_id=? AND match_key=?').get(version.candidate_id,key);
    if(!employment&&key.startsWith('text:')){
      const tokens=s=>new Set(String(s).toLowerCase().replace(/\b\d+\b/g,'').split(/\W+/).filter(t=>t.length>3));
      const target=tokens(job.fragment),candidates=this.db.prepare('SELECT e.id,s.fragment FROM employment e JOIN employment_sources s ON s.employment_id=e.id WHERE e.candidate_id=? AND s.version_id<>?').all(version.candidate_id,version.id);
      const matches=new Set(candidates.filter(s=>{const other=tokens(s.fragment),shared=[...target].filter(t=>other.has(t)).length;return target.size>=5&&shared/Math.max(target.size,other.size)>=0.8;}).map(s=>s.id));
      if(matches.size===1)employment={id:[...matches][0]};
    }
    if(!employment)employment={id:this.db.prepare('INSERT INTO employment(candidate_id,match_key,created) VALUES (?,?,?)').run(version.candidate_id,key,now()).lastInsertRowid};
    const previous=this.db.prepare('SELECT * FROM employment_sources WHERE employment_id=? ORDER BY id DESC LIMIT 1').get(employment.id);
    const conflict=previous&&previous.data!==JSON.stringify(job.data)?'La nueva fuente difiere de otra versión. Revisar fechas, tareas y categorías.':'';
    this.db.prepare('INSERT OR IGNORE INTO employment_sources(employment_id,version_id,source_key,receipt_id,page,fragment,data,conflict) VALUES (?,?,?,?,?,?,?,?)').run(employment.id,version.id,receipt?'message:'+receipt.id:'cv:'+version.id,receipt?.id||null,job.page,job.fragment,JSON.stringify(job.data),conflict);
  }})();}
  list(candidate,version){
    let rows=this.db.prepare(`SELECT s.*,e.candidate_id FROM employment_sources s JOIN employment e ON e.id=s.employment_id WHERE e.candidate_id=? ${version?'AND (s.version_id=? OR s.version_id IS NULL)':''} ORDER BY e.id,s.id`).all(...(version?[candidate,version]:[candidate]));
    return rows.map(s=>{const data=json(s.data);let duration=null;try{duration=new ExperienciaLaboral(data).duration(now().slice(0,10));}catch{}return {...s,data,duration,history:this.db.prepare('SELECT data,state,revision,changed FROM employment_history WHERE source_id=? ORDER BY id DESC').all(s.id).map(h=>({...h,data:json(h.data)}))};});
  }
  save(candidate,body,user){
    this.repo.person(candidate);const data=new ExperienciaLaboral(body.data);
    return this.db.transaction(()=>{
      if(body.id){const source=this.db.prepare('SELECT s.* FROM employment_sources s JOIN employment e ON e.id=s.employment_id WHERE s.id=? AND e.candidate_id=?').get(body.id,candidate);if(!source)throw error('Experiencia no encontrada',404);if(source.revision!==Number(body.revision))throw error('La experiencia fue modificada; volvé a abrirla',409);
        this.db.prepare('INSERT INTO employment_history(source_id,data,state,revision,changed,user_id) VALUES (?,?,?,?,?,?)').run(source.id,source.data,source.state,source.revision,now(),user);
        let version=source.version_id;if(version===null&&body.version_id){if(!this.db.prepare('SELECT 1 FROM cv_versions WHERE id=? AND candidate_id=?').get(body.version_id,candidate))throw error('La versión no pertenece al postulante');version=Number(body.version_id);}
        this.db.prepare('UPDATE employment_sources SET data=?,state=?,revision=revision+1,conflict=?,version_id=? WHERE id=?').run(JSON.stringify(data),body.confirm?'confirmed':'pending',body.confirm?'':source.conflict,version,source.id);return source.id;
      }
      const version=body.version_id?this.db.prepare('SELECT id FROM cv_versions WHERE id=? AND candidate_id=?').get(body.version_id,candidate):null;
      if(body.version_id&&!version)throw error('La versión no pertenece al postulante');
      const employment=this.db.prepare('INSERT INTO employment(candidate_id,match_key,created) VALUES (?,?,?)').run(candidate,'manual:'+require('crypto').randomUUID(),now()).lastInsertRowid;
      const source=this.db.prepare('INSERT INTO employment_sources(employment_id,version_id,source_key,page,fragment,data,state) VALUES (?,?,?,?,?,?,?)').run(employment,version?.id||null,'manual',null,String(body.fragment||'Carga manual'),JSON.stringify(data),body.confirm?'confirmed':'pending').lastInsertRowid;
      this.repo.log(`Experiencia manual ${source} creada`,user);return source;
    })();
  }
  totals(rows,cutoff){
    const result={};for(const category of CATEGORIES){const intervals=[];let incomplete=0;
      for(const row of rows){const d=row.data;if(!d.categories.includes(category))continue;const end=d.end||(d.current===true?cutoff:'');if(d.start.length!==10||end.length!==10){incomplete++;continue;}const a=Date.parse(d.start),b=Math.min(Date.parse(end),Date.parse(cutoff));if(b>a)intervals.push([a,b]);}
      intervals.sort((a,b)=>a[0]-b[0]);const union=[];for(const interval of intervals){const last=union.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else union.push([...interval]);}
      if(intervals.length||incomplete)result[category]={days:union.reduce((n,[a,b])=>n+(b-a)/86400000,0),incomplete};
    }return result;
  }
}
module.exports={ExperienciaLaboral,ExperienciaService,extractExperiences,CATEGORIES,categories};
