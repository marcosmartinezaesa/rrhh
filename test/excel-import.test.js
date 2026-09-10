const {test}=require('node:test');
const assert=require('node:assert/strict');
const ExcelJS=require('exceljs');
const {previewWorkbook}=require('../scripts/excel-import');
test('Evaluación con fila 8, fórmulas, fechas UTC y categorías agrupadas sin descarte automático',async()=>{
  const w=new ExcelJS.Workbook();w.addWorksheet('INSTRUCTIVO').getCell('A1').value='Referencia';
  const s=w.addWorksheet('EVALUACION');
  s.getRow(8).values=['Candidato (nombre y apellido)','Archivo del CV','Teléfono','Fecha de nac.\n(opcional)','Licencia de conducir','RESULTADO','Observaciones','PUNTAJE\n/100'];
  s.getRow(9).values=['Persona ficticia','ejemplo.pdf','1100000000',new Date('1990-01-22T00:00:00Z'),'Profesional vigente (D1 / D2 / E1)',{formula:'"DESCARTAR"',result:'DESCARTAR'},'Confirmar categoría',0];
  s.getRow(10).values=[null,null,null,null,null,{formula:'""',result:''}];
  const p=await previewWorkbook(await w.xlsx.writeBuffer(),'prueba.xlsx');
  assert.equal(p.headerRow,8);assert.equal(p.rows.length,1);const r=p.rows[0];
  assert.equal(r.cvPhone,'1100000000');assert.equal(r.phone,undefined);assert.equal(r.license,'');assert.equal(r.status,'Pendiente');
  assert.match(r.notes,/1990-01-22/);assert.match(r.notes,/RESULTADO: DESCARTAR/);assert.match(r.notes,/PUNTAJE \/100: 0/);assert.match(r.notes,/Confirmar categoría/);assert.doesNotMatch(r.notes,/object Object/);
});
