# FicheroHik automático

Este proyecto reemplaza el flujo manual (exportar Excel de HikCentral → subirlo
a la página HTML → clic en "Generar") por un backend que corre solo en tu VPS.

## Qué hace

1. El día y hora que configures (por defecto, el 21 de cada mes a las 8am) se
   conecta a HikCentral, trae los eventos de acceso del período, aplica
   exactamente la misma lógica de cálculo de horas que ya usabas en el HTML,
   genera el Excel con el mismo formato, y te lo manda por mail.
2. Guarda un resumen por empleado y por mes en una base de datos local (SQLite).
3. Expone un webhook para un bot de WhatsApp (vía Twilio): cada empleado
   registrado puede escribirle al número del bot y recibir *solo sus propias*
   horas — el acceso se controla por número de teléfono, no hay forma de
   consultar los datos de otra persona.

## Instalación

```bash
cd fichero-automatico
npm install
cp .env.example .env
# completá .env con tus datos reales (ver abajo)
```

## Pendiente antes de producción

### Conexión real a HikCentral (lib/hikcentral.js)
El esquema de firma HMAC que dejé es el patrón típico de la API "Artemis" de
Hikvision, pero **necesita validarse contra tu instalación real**:

- Generá el AppKey/AppSecret en HikCentral: *Configuración del sistema →
  Cuenta OpenAPI*.
- Pedile a tu proveedor/integrador de Hikvision la colección de Postman de
  HikCentral OpenAPI (o descargala del portal de partners de Hikvision).
- Probá ahí el endpoint de eventos de acceso, confirmá el formato exacto de
  headers y de la respuesta JSON, y ajustá `firmarRequest` y
  `mapearEventoAEmpleado` en `lib/hikcentral.js` de acuerdo a eso.
- Mientras tanto, podés seguir generando el fichero subiendo el Excel manual
  con `lib/leerExcelHikvision.js` (dejé esa función intacta como respaldo).

## Preguntas resueltas sobre cambios de turno

### 1. Sincronizar el Google Calendar cuando se aprueba un cambio de turno
**Resuelto.** Al aprobar un pedido de cambio de turno (comando `aprobar
cambio N` por WhatsApp, o desde el panel via `POST /panel/api/cambio/:id/:accion`
-- ambos caminos llaman a la misma `resolverUnaSolicitudCambio` en
`lib/whatsapp.js`), ademas de guardar el intercambio como excepcion puntual
(tabla `excepciones_turno`), se busca y actualiza (o crea si todavia no
existia) el evento correspondiente a cada fecha afectada en el Google
Calendar de turnos de mantenimiento (`actualizarEventoDia`, en
`generarCalendarioMantenimiento.js`). Es best-effort: si el Calendar API
falla, el cambio queda igual aprobado en la base (eso es lo que manda), solo
se loguea el error.

### 2. Que pasa con la rotacion de francos si alguien trabaja de mas por un cambio
**Resuelto (decision de negocio confirmada): la formula de base nunca se
toca.** Ejemplo: si Alberto cubre el turno de Diego un finde (termina
laburando sabado y domingo seguidos, en vez de un solo turno), el finde
siguiente se calcula exactamente igual, como si nada hubiera pasado -- el
orden de rotacion sigue su curso normal. Esto ya es lo que hace el codigo:
`turnoDelDia` (la formula base en `lib/turnosMantenimiento.js`) se calcula
solo a partir de las fechas ancla, nunca lee `excepciones_turno`; unicamente
`turnoRealDelDia` (usado para mostrar/sincronizar el dia puntual del
cambio) chequea si hay una excepcion. Si en el futuro alguien quiere
"devolver el favor", se hace con otro pedido de cambio de turno como los
que ya existen -- no hay compensacion automatica.

## Diseñado, no implementado: gestion de licencias y vacaciones

Charlado pero no construido todavia. Asi quedo pensado:

- **Tabla nueva `licencias`**: empleado, fecha desde, fecha hasta, tipo
  (vacaciones, licencia medica, estudio, etc.), quien la cargo.
- **Carga por WhatsApp** (comando de admin, mismo patron que `alta` y
  `evento`): `licencia Nombre Apellido 10/07 al 20/07 vacaciones`. Reusa
  `parsearFechas` (ya soporta un dia, un rango, o fechas sueltas), no hay
  que escribir un parser nuevo.
- **Efecto en el calculo**: un dia que cae dentro de una licencia activa se
  marca con el tipo de licencia (ej. `🏖️ Vacaciones`) **sin** la alerta de
  "falta fichaje", y no se le ofrece al empleado la opcion de pedir una
  correccion ese dia (no tiene sentido corregir un dia que no trabajo).
- **Se ve reflejado** tanto en "mis horas" (WhatsApp) como en el Excel,
  etiquetado aparte de un dia trabajado o de un dia con alerta real.

**Decision pendiente (de negocio, no tecnica):** ¿un dia de licencia/vacaciones
cuenta como "dia trabajado" en el resumen mensual (a los fines de
presentismo/sueldo), o queda totalmente aparte del conteo de dias y horas?
Esto hay que definirlo antes de implementar el calculo de sueldo automatico
tambien pedido como mejora futura, porque la regla es la misma para los dos.

## Diseñado, no implementado: deteccion de ausencias por WhatsApp

Tambien charlado, tampoco construido. La idea:

1. Recordatorio de fichada 10 minutos antes del horario de entrada esperado
   de cada empleado (mismo mecanismo que ya existe para el recordatorio de
   salida olvidada).
2. Si pasan 3-4hs sin fichada, el bot pregunta con menu numerado (no texto
   libre): "1) Vine pero me olvide fichar / 2) No vine hoy". La opcion 1
   entra al flujo de correccion que ya existe. La opcion 2, o si no
   contesta nada, marca el dia como `AUSENTE` en rojo en el Excel y le
   avisa al admin para que confirme el motivo real (enganchando con lo de
   licencias de arriba: un "ausente sin justificar" es una licencia sin
   clasificar todavia).

**Requisito tecnico previo:** esto necesita saber, de antemano, que dias se
espera que cada persona trabaje (para no preguntarle a alguien en su dia
franco). Para el equipo de mantenimiento ya existe esa base
(`lib/turnosMantenimiento.js`, con la rotacion de turnos y francos). Para el
resto de los sectores (conserjeria, etc.) todavia no hay un calendario
esperado equivalente -- hay que definirlo antes de poder activar esto para
todos, no solo mantenimiento.

## Panel web de administracion

Disponible en `http://TU_SERVIDOR:3000/panel`. Se loguea con la misma
`ADMIN_API_KEY` del `.env` (no hay usuario/contraseña separados). Desde ahi
se puede, sin usar WhatsApp:

- Ver y aprobar/rechazar correcciones de fichaje pendientes.
- Ver y aprobar/rechazar pedidos de cambio de turno pendientes.
- Ver la lista de empleados (sector, numero de WhatsApp registrado).
- Ver el resumen de horas de cualquier periodo.

Aprobar/rechazar desde el panel dispara exactamente la misma logica que el
comando de WhatsApp (recalculo de horas, aviso al empleado, sync del
Google Calendar en cambios de turno) -- es el mismo codigo, solo cambia el
canal desde donde se dispara.

La sesion del panel vive en memoria del proceso (dura 12hs); si el server
reinicia, hay que volver a loguearse.

## Auto-monitoreo del servidor

Cron externo (`monitorProceso.js`, corre cada 5 minutos via `crontab`, no
depende de que el server este sano) que avisa por WhatsApp al admin si el
proceso deja de estar "online" en pm2, o si empieza a reiniciarse solo en
loop (`unstable_restarts` de pm2 sube).

## Dias de evento por WhatsApp

Comando de admin: `evento Nombre Apellido DD/MM` (tambien admite rango
"DD/MM al DD/MM" o fechas separadas por coma). Se guarda en la tabla
`eventos` y lo usa `motorCalculo.esDiaDeEvento` -- mientras no haya conexion
con Simple Solutions, esta es la forma de cargarlo sin tocar codigo.

## Estadisticas en el panel

Pestaña nueva en el panel web:

- **% de fichadas completas por empleado** (periodo actual) -- de datos que
  ya existian (`filas_diarias`).
- **Correcciones pedidas por empleado** -- de `solicitudes_correccion`, que
  ya existia.
- **Interacciones con el bot** (consultas de horas, correcciones, etc por
  empleado) y **ultima actividad** -- estos dos son nuevos: se registran en
  la tabla `mensajes_whatsapp` a partir de ahora. **No hay forma de
  reconstruir historial de antes de que se agregara esto** -- antes no se
  guardaba ningun registro de mensajes, solo el paso actual de la
  conversacion.

**Sobre las 72hs del Sandbox de Twilio:** se evaluo poder mostrar una cuenta
regresiva de cuando vence el `join` de cada numero, pero no es posible desde
nuestro lado -- Twilio intercepta el mensaje "join" antes de que llegue a
nuestro webhook, asi que el sistema no tiene forma de saber cuando se unio
cada numero. La unica solucion real sigue siendo salir del Sandbox (ver
"Preguntas abiertas").

## Auto-deploy

Cron (`deploy.sh`, cada 3 minutos) que revisa si hay commits nuevos en
GitHub (rama `main`) y, si los hay, hace `git pull` + `npm install` +
`pm2 restart` solo. Pensado para que cambios subidos desde otra sesion (ej.
Claude Code desde el celular, sin acceso SSH al servidor) se apliquen
solos.

## Probar el pipeline sin esperar al cron

```bash
npm run run-once
```

## Correr el servidor

```bash
npm start
```

## Configurar el webhook de Twilio

En la consola de Twilio, WhatsApp Sandbox (o tu número de WhatsApp Business
ya aprobado) → "When a message comes in" → apuntalo a:

```
https://tu-servidor.com/whatsapp/webhook
```
