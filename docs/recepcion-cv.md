# Recepción de CV y experiencia laboral

## Recorrido

1. Iniciar con `iniciar.cmd` e ingresar con el usuario existente.
2. Abrir **WhatsApp y sincronización** como administrador. Verificar que la cuenta prevista no esté administrada por otra integración y pulsar **Iniciar conexión / mostrar QR**.
3. Escanear el QR real desde WhatsApp → Dispositivos vinculados. Se valida la cuenta configurada antes de admitir recepciones. No se envían mensajes.
4. Elegir fechas para sincronizar. La escucha de nuevos mensajes comienza al estar conectado. La sincronización histórica se solicita explícitamente.
5. Revisar **Adjuntos por revisar**, asociar a una ficha existente, crear una persona diferente o marcar el archivo como ajeno a una postulación.
6. En **Postulantes y CV**, abrir la ficha, verificar atributos, versiones y experiencia laboral.
7. En **Descargas por fecha**, elegir el rango y modo, revisar faltantes y generar el ZIP. Descargar cuando el trabajo esté listo.

## Almacenamiento y migración

SQLite permanece en `data/rrhh.sqlite` y los originales en `data/cv`. `DATA_DIR` permite otro destino. La migración aditiva versión 2 guarda primero una instantánea SQLite con `VACUUM INTO`, dentro de `data/migration-backups`. Además se creó un respaldo previo de base y CV en `backups/antes-recepcion-*` durante la implementación.

No se cambian usuarios ni hashes de contraseña. Se conserva el texto `candidates.experience`, las notas, las tablas de convocatorias y los documentos heredados. Los documentos antiguos sin fecha de recepción verificable quedan visibles con fecha por confirmar y fuera de las exportaciones por recepción hasta registrar una recepción real. No se toma la fecha de importación como fecha original.

Los servicios en `lib/` separan persistencia, identidad, archivos, extracción, experiencia, WhatsApp, sincronización, exportación y controladores. `server.js` mantiene el acceso existente. Las funciones anteriores de evaluación y convocatorias están fuera de la navegación; sus datos y rutas anteriores se conservan por compatibilidad.

## WhatsApp

- Dependencia real: `whatsapp-web.js`, con `LocalAuth` exclusiva en `data/whatsapp-auth/session-rrhh` y caché en `data/whatsapp-cache`. No se usa takeover.
- Navegador: `WHATSAPP_BROWSER`, ruta completa a Chrome o Edge. Se utiliza el navegador instalado; `.puppeteerrc.cjs` evita descargar otro durante `npm ci`.
- Cuenta esperada: `WHATSAPP_ACCOUNT` (por defecto `5491151475803`). Una cuenta diferente detiene la recepción.
- No es posible conocer desde RRHH todas las integraciones externas de una cuenta antes de vincular. Se exige la comprobación del administrador y se detiene el cliente si WhatsApp informa un conflicto. El bloqueo local evita dos clientes RRHH sobre la misma sesión.
- Después de reiniciar, volver a pulsar **Iniciar conexión**; LocalAuth reutiliza la sesión exclusiva sin pedir QR si sigue válida. Los trabajos interrumpidos quedan pausados para reanudar desde el panel.
- Historial: `WHATSAPP_HISTORY_LIMIT` (5000 mensajes por chat). Se informa cuántos chats y mensajes fueron recuperados, la fecha más antigua devuelta y si se alcanzó el límite. No se garantiza que WhatsApp entregue todo el historial ni todos los medios antiguos.
- Descargas y chats se procesan en serie, fuera de las peticiones del panel. La pausa se aplica entre operaciones; una operación de WhatsApp en curso tiene plazo limitado. Los medios pendientes y fallidos son reintentables, sin marcarse como completados antes de guardar los bytes.
- Se excluyen grupos, estados y canales. Los identificadores `@lid` se conservan; sólo se completa un teléfono si WhatsApp permite resolverlo.

## Versiones e identidad

`cv_files` tiene una clave única SHA-256; `cv_receipts` tiene unicidad por cuenta, chat y mensaje. `cv_versions` distingue versiones por postulante y hash. Cada recepción original se conserva. La versión vigente es la incorporada más recientemente según la fecha original, no según el orden de procesamiento. Un reenvío idéntico no actualiza su incorporación.

El nombre no fusiona personas globalmente. Dentro de un chat ya asociado, una actualización con el mismo nombre explícito puede vincularse si no contradice el DNI confirmado; si falta evidencia, se pide asociación manual. Un hash idéntico de otro chat no fusiona las fichas. Un tercero explícito o datos distintos quedan pendientes. La unión entre fichas es una acción explícita del administrador y conserva la ficha de origen como antecedente.

SHA-256 sólo reconoce bytes idénticos. Un archivo regenerado o recomprimido puede tener otro hash. Un archivo viejo nunca visto por RRHH, reenviado hoy, no revela por sus bytes la fecha de su primera circulación: esa antigüedad requiere revisar el origen. Cuando se recibe también el mensaje histórico, la fecha mínima corrige la incorporación de esa versión.

## Lectura y experiencia

`extract_cv.py` extrae texto por página y usa Tesseract para páginas escaneadas o con imágenes, incluidos PDF mixtos. Las imágenes pasan por OCR local. Máximo 40 páginas, 15 MB por archivo y 240 segundos por lectura. Fallos de lectura o experiencia conservan el original descargable. El panel permite reintentar.

La extracción local usa reglas conservadoras, no un servicio externo ni un modelo de IA. Reconoce atributos etiquetados y secciones de experiencia. Diseños complejos, puestos sin etiquetas y fechas no normalizadas requieren completar manualmente; conserva el fragmento y señala lo no informado. No convierte el nombre de una empresa en tareas ni en categorías. Tampoco usa edad o categorías para puntuar o descartar.

Cada `ExperienciaLaboral` admite varias categorías. `employment_sources` guarda una instantánea por CV o mensaje de respaldo; `employment_history` guarda las correcciones. La misma fuente no se inserta otra vez al reprocesar. Las fuentes diferentes de un mismo empleo se agrupan; las diferencias se presentan como contradicción y no sustituyen una corrección confirmada. Un empleo no identificable con certeza puede requerir revisión manual: no se promete conciliación semántica perfecta de CV arbitrarios.

La experiencia manual debe asociarse a una versión de CV para exportarse con ella. Si se cargó antes de tener un CV, puede abrirse después y elegir la versión. Los datos sin versión se conservan en la ficha y no se atribuyen retrospectivamente a cualquier CV.

Se separa duración declarada de calculada. Fechas exactas permiten días; mes/año permite meses; año solo queda sin cálculo. Los totales por categoría unen intervalos con fechas completas, sin sumar dos veces el solapamiento. Períodos incompletos quedan contados como pendientes, no como cero experiencia.

## ZIP

El rango incluye ambos días completos en `America/Argentina/Buenos_Aires`.

- **Postulantes nuevos**: primera incorporación verificable dentro del rango.
- **CV nuevos o actualizados**: alguna incorporación de versión dentro del rango.

Se elige una versión por postulante hasta el cierre del rango. Cada hash se empaqueta una vez; las asociaciones constan en `indice.csv`. Se incluye `experiencias.csv`, una fila por empleo de esa versión, con fuentes, fragmentos y estado de revisión. Las correcciones de una versión posterior no reemplazan las fuentes de una anterior.

Se neutralizan fórmulas en celdas CSV. El ZIP se genera mediante streams en un archivo temporal, fuera de la petición web; sólo se habilita su descarga tras completarse. Si faltan originales o hay recepciones sin resolver en el rango, la generación se bloquea para no presentar una entrega incompleta. El OCR pendiente no bloquea los originales: `LEEME.txt` y el índice informan el estado de lectura. Las exportaciones no consumen ni mueven los CV. Tras un reinicio se puede volver a generar el mismo rango.

## Pruebas

`npm test`: migración aditiva en bases aisladas; permisos; conflictos concurrentes; deduplicación; versiones fuera de orden; fuentes de experiencia y correcciones; solapamientos; CSV; ZIP; sincronización con cliente controlado, QR sintético, exclusión de grupos y LID sin teléfono inventado.

`node scripts/browser-reception.js`: alta de administrador en base temporal, ficha, carga de PDF de prueba real, experiencia manual, vista previa y descarga efectiva del ZIP, escritorio y móvil. No conecta WhatsApp real.

Pendiente de prueba en la cuenta real: escaneo QR, sesión autenticada, cobertura histórica, recepción en vivo y disponibilidad de medios antiguos. Ningún QR sintético de pruebas aparece en el servidor productivo. No se modificó Transferencias, C:\bot ni sus sesiones o procesos.

La auditoría npm detecta avisos heredados de `extract-zip`, dependencia del descargador de navegadores de Puppeteer. RRHH usa un navegador instalado y no acepta ZIP para extraer ni invoca ese descargador. No se realizó una actualización mayor incompatible para ocultar esos avisos; corresponde revisar la actualización de Puppeteer/Node antes de habilitar descargas de navegadores.

Documentación: [whatsapp-web.js](https://docs.wwebjs.dev/Client.html), [Archiver](https://www.archiverjs.com/docs/quickstart/).
