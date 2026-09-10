# Referencia recibida: Transferencias

Se recibió y revisó `transferencias-main.zip`. El original se conserva localmente en `data/referencias/`, fuera de Git y Repomix.

Componentes identificados en el código de referencia:

- `whatsapp-web.js` con `Client` y `LocalAuth` en `app/index.js`.
- Sesión persistente en `sesion_whatsapp`, navegador configurable y ejecución sin ventana.
- Evento `qr` para vincular y evento `message` para recibir mensajes.
- Descarga de adjuntos con reintentos y recuperación por identificador de mensaje.
- Lectura de documentos mediante scripts Python específicos de comprobantes.

La adaptación a RRHH debe crear una sesión independiente y vincular cada CV con el chat de origen. El reconocimiento de importes, bancos y comprobantes de Transferencias no corresponde a la evaluación de currículums.

Esta revisión no activa la conexión de WhatsApp de RRHH ni modifica la sesión de Transferencias. La integración sigue pendiente.
