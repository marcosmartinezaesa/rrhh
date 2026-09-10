# RRHH IVESS

Aplicación web interna para centralizar postulantes y organizar entrevistas. Node.js 20, Express y SQLite; los navegadores comparten la base del servidor.

**Versión de recepción disponible para probar:** http://192.168.1.187:3051. Usa el mismo administrador y los siete postulantes conservados. Se inició en 3051 porque la revisión automática bloqueó el reinicio del proceso anterior en 3050. El puerto predeterminado del código sigue siendo 3050; `iniciar-recepcion.cmd` permite iniciar explícitamente en 3051. No ejecutar dos conexiones de WhatsApp RRHH a la vez.

## Iniciar en esta PC

1. Ejecutar `iniciar.cmd` o `npm start` en `C:\RRHH`.
2. Abrir http://localhost:3050 en el servidor.
3. En la primera instalación, consultar `data\clave-inicial.txt` y crear el administrador desde la pantalla inicial. La clave se elimina al completar el alta. Contraseña mínima: 12 caracteres.
4. Desde las otras PC, abrir `http://IP-DEL-SERVIDOR:3050`. El servidor escucha en todas sus interfaces. Configurar una reserva de IP en el router y permitir el puerto TCP 3050 solamente en la red interna si el firewall lo bloquea.

No se abrieron puertos del firewall ni se configuró el router. Para redes no confiables, usar HTTPS mediante un proxy y `COOKIE_SECURE=1`.

## Circuito actual: recepción de CV

La prioridad actual es **WhatsApp por QR → sincronizar → revisar postulantes y experiencia → descargar ZIP por fechas**. El administrador existente se conserva. Ver [guía de recepción, migración y pruebas](docs/recepcion-cv.md).

WhatsApp se inicia desde el panel por un administrador, con sesión exclusiva de RRHH. El escaneo y las pruebas en la cuenta real están pendientes del usuario. La navegación no incluye evaluaciones ni convocatorias.

## Funciones de la base anterior conservadas

- Administrador y operadores, contraseñas con scrypt, sesiones de 8 horas, límites de intentos y registro de acciones.
- Fichas persistentes: WhatsApp del chat separado del teléfono del CV, localidad, domicilio, licencia, vencimiento, mayoría de edad declarada, distancia, traslado, experiencia y notas.
- Control de modificaciones concurrentes: una ficha editada por otro usuario exige recargar antes de guardar.
- Filtros por texto, estado, licencia declarada y distancia verificada manualmente. Sin distancia conocida, la ficha sigue visible. No hay ranking ni descarte automático por edad.
- CV originales PDF/JPG/PNG hasta 15 MB. Extracción de texto PDF y OCR local de imágenes o PDF escaneados, máximo 20 páginas en OCR. Procesamiento OCR en serie. Texto disponible junto al original; completar los campos requiere revisión humana.
- Excel XLSX: detecta la hoja EVALUACION y encabezados en las primeras 30 filas; reconoce la planilla de referencia con encabezados en fila 8. Conserva observaciones y columnas adicionales en notas. Puntajes y resultados previos quedan como antecedentes, sin aplicar descartes. En la planilla de CV, los contactos se guardan como teléfono del CV y las licencias agrupadas quedan por confirmar. Vista previa y detección de duplicados por nombre y ambos teléfonos.
- Convocatorias con fecha, horario inicial y cupo; selección manual, textos de invitación editables para copiar y estados de confirmación/asistencia. No realiza envíos. Un único horario por convocatoria; usar convocatorias separadas para distintos turnos.
- Copia de seguridad manual de SQLite y CV desde Configuración. Usuarios y contraseñas cifradas mediante hash quedan incluidos en la base. Guardar las copias en un destino protegido externo al servidor.

## Dependencias e instalación en otra PC

Ejecutar `npm ci`, instalar Python con `pip install pymupdf` y Tesseract OCR. `ocr.py` utiliza PyMuPDF y el ejecutable Tesseract. En esta PC están instalados y se descargó el modelo español en `data\tessdata\spa.traineddata` desde el repositorio oficial https://github.com/tesseract-ocr/tessdata_fast. Sin modelo español local, usa inglés como alternativa.

Variables opcionales: `PORT` (3050), `HOST` (0.0.0.0), `DATA_DIR`, `PYTHON_BIN`, `TESSERACT_BIN`, `OCR_LANG`, `COOKIE_SECURE`. El certificado `data\windows-ca.pem` se generó a partir del almacén de confianza de Windows para instalar dependencias en este entorno; no contiene claves privadas.

Pruebas: `npm test`. Los datos de prueba usan una carpeta temporal aislada y se eliminan al finalizar.

## Datos y recuperación

La base está en `data\rrhh.sqlite` y los adjuntos en `data\cv`. No borrar los archivos WAL mientras el servidor está activo. Para restaurar, detener el programa, guardar una copia del estado actual y reemplazar la base y `cv` con los de la misma copia de seguridad; retirar archivos WAL/SHM antiguos únicamente con el servidor detenido. Conservar el modelo OCR local. Reiniciar el servidor.

El inicio automático y las copias programadas no están configurados. `iniciar.cmd` permite inicio manual; para operación continua puede registrarse en el Programador de tareas de Windows con el directorio de trabajo `C:\RRHH`.

## Pendiente de los archivos de referencia

Se recibió `transferencias-main.zip` y se revisó su conexión de WhatsApp: ver [notas de referencia](docs/transferencias-referencia.md). El ZIP original queda en `data/referencias`, excluido de GitHub y Repomix. También se recibió `Evaluacion_CVs_2026-09-09.xlsx`; su original y los datos importados se conservan solo en el servidor. Sigue pendiente `INICIAR_RRHH_IVESS_CODEX.md`. No se importaron candidatos ficticios como datos reales.

La conexión real por QR, la sincronización y la descarga por fechas están implementadas; falta validarlas con la cuenta real. No se envían mensajes, no se sincronizan confirmaciones y no se desarrolla selección laboral en esta etapa. No reutilizar ni modificar sesiones de los otros proyectos.

Documentación de dependencias: [ExcelJS](https://www.npmjs.com/package/exceljs), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [pdf-parse](https://www.npmjs.com/package/pdf-parse).


## GitHub y Repomix

Repositorio: https://github.com/marcosmartinezaesa/rrhh

Ejecutar `npm run repomix` para actualizar `repomix-output.xml`, el resumen del código para compartir contexto. Se versiona junto al proyecto; regenerarlo antes de subir cambios. `npm run repomix:stdout` permite obtenerlo por consola.

La configuración mantiene la [revisión de seguridad de Repomix](https://repomix.com/guide/security) y excluye CV, datos, copias, sesiones, secretos y dependencias instaladas. Los logos binarios se conservan en GitHub; Repomix resume archivos de texto.

Repomix está fijado en 1.14.1 (correcciones de seguridad). Declara Node.js 22 o superior; la generación local fue verificada también con Node 20.19.4, pero para usar la herramienta en otras PC corresponde Node 22+. El servidor actual sigue usando Node 20.

Importación local de administración: `node scripts/import-excel.js RUTA.xlsx` muestra el conteo. Agregar `--apply` carga las fichas en una transacción y crea previamente una copia de la base en `data/import-backups`. No adjunta los CV mencionados en el Excel: esos archivos deben cargarse por separado.

Prueba del circuito actual en navegador: `node scripts/browser-reception.js`. La comprobación antigua `browser-check.js` corresponde a la navegación anterior.
