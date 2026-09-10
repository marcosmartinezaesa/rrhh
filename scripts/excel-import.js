const ExcelJS = require('exceljs');
const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  nombre:'name', nombreyapellido:'name', postulante:'name', candidato:'name', candidatonombreyapellido:'name',
  whatsapp:'phone', telefono:'phone', localidad:'locality', localidaddondevive:'locality',
  domicilio:'address', direccion:'address', licencia:'license', registro:'license', licenciadeconducir:'license',
  experiencia:'experience', experienciaenreparto:'experience', disponibilidadhoraria:'availability', observaciones:'notes'
};
function cellText(cell) {
  let value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) value = value.result;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0,10);
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map(part=>part.text).join('');
    if ('text' in value) return String(value.text);
    if (value.error) return `[Error de Excel: ${value.error}]`;
    return '';
  }
  return String(value).trim();
}
async function previewWorkbook(buffer, filename='Excel') {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find(s=>normalize(s.name)==='evaluacion') || workbook.worksheets[0];
  if (!sheet) throw new Error('El Excel no contiene hojas');
  if (sheet.rowCount>2000 || sheet.columnCount>100) throw new Error('Máximo 2000 filas y 100 columnas por importación');
  let headerRow = 0, headers;
  for (let i=1;i<=Math.min(sheet.rowCount,30);i++) {
    const found=[];
    sheet.getRow(i).eachCell((cell,col)=>{const label=cellText(cell);found.push({col,label,field:aliases[normalize(label)]||''});});
    if(found.some(h=>h.field==='name')) {headerRow=i;headers=found;break;}
  }
  if(!headerRow) throw new Error('No se encontró una columna de nombre en las primeras 30 filas');
  const evaluation = headers.some(h=>normalize(h.label)==='archivodelcv');
  if(evaluation) headers=headers.map(h=>({...h,field:normalize(h.label)==='telefono'?'cvPhone':h.field}));
  const rows=[];
  sheet.eachRow((row,index)=>{
    if(index<=headerRow) return;
    const result={row:index,status:'Pendiente',source:`Excel: ${filename} · ${sheet.name} · fila ${index}`};
    const originals=[];
    for(const h of headers) {
      const value=cellText(row.getCell(h.col));
      if(h.field) result[h.field]=value;
      if(value) originals.push(`${h.label.replace(/\s+/g,' ')}: ${value}`);
    }
    if(!result.name) return;
    if(evaluation) {
      // Una opción agrupada de la planilla no acredita cada categoría individual.
      result.license='';
      result.notes='Antecedente del Excel; requiere revisión. Puntaje, resultado y puesto son valores guardados, no decisiones del sistema. La licencia agrupada debe confirmarse.\n\n'+originals.join('\n');
    } else {
      const extras=headers.filter(h=>!h.field).map(h=>[h,cellText(row.getCell(h.col))]).filter(([,v])=>v).map(([h,v])=>`${h.label}: ${v}`);
      result.notes=[result.notes,...extras].filter(Boolean).join('\n');
    }
    if(result.notes.length>12000) throw new Error(`La fila ${index} supera el tamaño de notas admitido; no se importará parcialmente`);
    rows.push(result);
  });
  return {sheet:sheet.name,headerRow,headers,rows,evaluation};
}
module.exports={previewWorkbook};
