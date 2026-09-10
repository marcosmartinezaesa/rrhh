// Uso local del administrador: node scripts/import-excel.js archivo.xlsx [--apply]
const fs=require('fs');
const path=require('path');
const Database=require('better-sqlite3');
const {previewWorkbook}=require('./excel-import');
async function main(){
  const filename=process.argv[2];
  if(!filename) throw new Error('Indicá la ruta del Excel; --apply confirma la carga local');
  const preview=await previewWorkbook(fs.readFileSync(filename),path.basename(filename));
  console.log(JSON.stringify({sheet:preview.sheet,headerRow:preview.headerRow,candidates:preview.rows.length}));
  if(!process.argv.includes('--apply')) return;
  const root=path.resolve(process.env.DATA_DIR||path.join(__dirname,'../data'));
  const db=new Database(path.join(root,'rrhh.sqlite'),{fileMustExist:true});
  try{
    db.pragma('busy_timeout = 5000');
    const dest=path.join(root,'import-backups',Date.now()+'.sqlite');
    fs.mkdirSync(path.dirname(dest),{recursive:true});await db.backup(dest);
    const keys=['name','phone','cvPhone','locality','address','license','licenseExpiry','adult','distance','availability','experience','notes','status','source'];
    const insert=db.prepare(`INSERT INTO candidates(${keys.join(',')}) VALUES (${keys.map(k=>'@'+k).join(',')})`);
    let added=0,skipped=0;
    db.transaction(()=>{
      for(const raw of preview.rows){
        const row=Object.fromEntries(keys.map(k=>[k,raw[k]??'']));
        row.status='Pendiente';row.adult='Por confirmar';row.distance=null;
        if(db.prepare('SELECT id FROM candidates WHERE name=? AND phone=? AND cvPhone=?').get(row.name,row.phone,row.cvPhone)){skipped++;continue;}
        insert.run(row);added++;
      }
      db.prepare('INSERT INTO audit(user_id,action) VALUES (NULL,?)').run(`Importación local Excel: ${added} fichas; ${skipped} duplicadas omitidas`);
    })();
    console.log(JSON.stringify({added,skipped,backup:dest}));
  }finally{db.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
