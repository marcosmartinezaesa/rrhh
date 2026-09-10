# RRHH IVESS

Aplicación web interna para centralizar postulantes y organizar entrevistas. Node.js 20, Express y SQLite; los navegadores comparten la base del servidor.

## Iniciar en esta PC

1. Ejecutar `iniciar.cmd` o `npm start` en `C:\RRHH`.
2. Abrir http://localhost:3050 en el servidor.
3. En la primera instalación, consultar `data\clave-inicial.txt` y crear el administrador desde la pantalla inicial. La clave se elimina al completar el alta. Contraseña mínima: 12 caracteres.
4. Desde las otras PC, abrir `http://IP-DEL-SERVIDOR:3050`. El servidor escucha en todas sus interfaces. Configurar una reserva de IP en el router y permitir el puerto TCP 3050 solamente en la red interna si el firewall lo bloquea.

No se abrieron puertos del firewall ni se configuró el router. Para redes no confiables, usar HTTPS mediante un proxy y `COOKIE_SECURE=1`.

## Funciones implementadas

- Administrador y operadores, contraseñas con scrypt, sesiones de 8 horas, límites de intentos y registro de acciones.
- Fichas persistentes: WhatsApp del chat separado del teléfono del CV, localidad, domicilio, licencia, vencimiento, mayoría de edad declarada, distancia, traslado, experiencia y notas.
- Control de modificaciones concurrentes: una ficha editada por otro usuario exige recargar antes de guardar.
- Filtros por texto, estado, licencia declarada y distancia verificada manualmente. Sin distancia conocida, la ficha sigue visible. No hay ranking ni descarte automático por edad.
- CV originales PDF/JPG/PNG hasta 15 MB. Extracción de texto PDF y OCR local de imágenes o PDF escaneados, máximo 20 páginas en OCR. Procesamiento OCR en serie. Texto disponible junto al original; completar los campos requiere revisión humana.
- Excel XLSX: primera hoja, encabezados en fila 1, vista previa y confirmación de importación. Reconoce Nombre / Nombre y apellido / Postulante / Candidato, WhatsApp / Teléfono, Localidad, Domicilio / Dirección, Licencia / Registro, Experiencia, Observaciones. Hasta 2000 filas. Omite duplicados exactos de nombre y teléfono. Muestra columnas no reconocidas antes de importar; no adapta todavía el Excel original que no fue adjuntado.
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

No se recibieron `Evaluacion_CVs_2026-09-09.xlsx`, `transferencias-main.zip` ni `INICIAR_RRHH_IVESS_CODEX.md`: el único adjunto fue la conversación. No se importaron candidatos ficticios como datos reales.

WhatsApp queda pendiente: QR, sesión independiente, importación de chats/adjuntos, conciliación del teléfono de origen y sincronización de respuestas. También quedan para ampliación la extracción estructurada avanzada de CV, geocodificación/distancias verificadas y turnos individuales. No reutilizar ni modificar sesiones de los otros proyectos.

Documentación de dependencias: [ExcelJS](https://www.npmjs.com/package/exceljs), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [pdf-parse](https://www.npmjs.com/package/pdf-parse).
