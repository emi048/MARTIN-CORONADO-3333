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

## Estructura del proyecto

```
server.js        -> arranque de la app
routes/           -> registro de endpoints (panel.js, whatsapp.js)
controllers/      -> logica de cada endpoint (panelController.js, whatsappController.js)
services/         -> logica de negocio, calculo e integraciones
  db.js               - acceso a la base SQLite
  motorCalculo.js      - calculo de horas (50%/100%, feriados, eventos)
  pipeline.js          - pipeline mensual (trae eventos, calcula, genera excel, manda mail)
  hikcentral.js        - llamada a la API OpenAPI de HikCentral (Artemis)
  leerExcelHikvision.js - lector del excel exportado a mano (respaldo/via principal actual)
  monitorFichadas.js   - poller de fichadas en tiempo real (bloqueado, ver abajo)
  generarExcel.js, mailer.js, gmailClient.js, twilioClient.js,
  turnosMantenimiento.js, turnosConserjeria.js, asistente.js
cron/             -> tareas programadas (pipeline mensual, poll de fichadas, recordatorios)
```

Reorganizado a esta convención (antes todo vivía junto en `lib/`) para que
sea más fácil de entender para alguien de afuera del proyecto.

## Instalación

```bash
cd fichero-automatico
npm install
cp .env.example .env
# completá .env con tus datos reales (ver abajo)
```

## Estado real de la conexión con HikCentral (services/hikcentral.js)

**Bloqueado, no en curso.** El plan original era conectarse a la API OpenAPI
("Artemis") de HikCentral con un AppKey/AppSecret generado por el
administrador del sistema (el integrador de Hikvision del edificio) --
pero **no pudimos obtener las credenciales necesarias**. `HIKCENTRAL_HOST` /
`HIKCENTRAL_APP_KEY` / `HIKCENTRAL_APP_SECRET` en `.env` siguen vacíos, y
`obtenerEventosAcceso` tira `ERR_INVALID_URL` cada vez que corre (se ve en
los logs de pm2 cada 2 minutos, por el poller de `monitorFichadas.js`).

**Mientras tanto, la vía real que se usa** es la manual: exportar
"Búsqueda de acceso de persona" desde el software de Hikvision (HikCentral
o iVMS-4200) y subir ese Excel -- lo procesa
`services/leerExcelHikvision.js` (matchea nombres contra el roster,
normaliza fechas/horas). Esto ya no es solo un "respaldo", es como se carga
la data hoy.

**Plan en evaluación:** sacar el lector facial (Hikvision DS-K1T671M) de la
red de HikCentral del edificio y ponerlo standalone, conectado a la red de
invitados del edificio junto con una PC/mini PC que corra un script puente
-- ese script consultaría al facial por su API local (ISAPI, con
usuario/contraseña propios del aparato, sin depender de credenciales de
terceros) y empujaría las marcaciones nuevas a este servidor por HTTPS
saliente. Esto
destrabaría también el monitoreo en tiempo real (ver más abajo). Sin
construir todavía -- depende de tener el hardware/red del lado del edificio
resuelto primero.

### Salir del Sandbox de Twilio + menú con botones

**En curso, con un bloqueo activo.** El bot corre sobre el Sandbox de
WhatsApp de Twilio, que tiene dos límites: los empleados tienen que
re-mandar el código "join" cada 72hs de inactividad, y no se pueden usar
Content Templates propias (botones, listas).

- **Paso 1 (hecho, con problema pendiente):** ya se registró un número de
  producción propio (+54 9 11 2567-3711, "Martín Coronado") como WhatsApp
  Sender via Twilio BYON. El Sender figura "Online" en Twilio, pero la
  cuenta está **"Restricted" del lado de Meta** -- la Business Verification
  sigue "En revisión" desde hace más de dos semanas, sin ninguna acción
  pendiente visible del lado nuestro (se revisó el Centro de Seguridad de
  Meta Business Manager, no hay nada para completar). Se abrió un ticket de
  soporte a Twilio pidiendo que revisen el estado. Hasta que esto se
  resuelva, **el número de producción no puede mandar ni un mensaje**
  (error 63051) -- `TWILIO_WHATSAPP_FROM` en `.env` sigue apuntando al
  Sandbox a propósito, no cambiarlo hasta que la cuenta deje de estar
  restringida.
- **Paso 2 (ya hecho):** ya están creadas 6 Content Templates en la cuenta
  de Twilio (menú principal con y sin la opción de cambio de turno, cuántos
  días corregir, qué corregir, qué día del finde cambiar, con quién) -- sus
  SIDs están en `.env` (`CONTENT_SID_*`). No las usa ningún código todavía.
  `services/twilioClient.js` ya tiene `enviarWhatsappInteractivo(numero,
  contentSid, variables)` lista para mandarlas.
- **Paso 3 (falta, bloqueado por el Paso 1):** el `<Message>` de TwiML **no
  soporta `ContentSid`** -- solo se puede mandar una Content Template por la
  API REST de forma asíncrona, no como respuesta directa al webhook. No se
  puede probar en Sandbox (no renderiza Content Templates custom), así que
  no conviene tocar esto hasta que el número de producción esté activo de
  verdad.

## Preguntas resueltas sobre cambios de turno

### 1. Sincronizar el Google Calendar cuando se aprueba un cambio de turno
**Resuelto.** Al aprobar un pedido de cambio de turno (comando `aprobar
cambio N` por WhatsApp, o desde el panel via `POST /panel/api/cambio/:id/:accion`
-- ambos caminos llaman a la misma `resolverUnaSolicitudCambio` en
`controllers/whatsappController.js`), ademas de guardar el intercambio como
excepcion puntual (tabla `excepciones_turno`), se busca y actualiza (o crea
si todavia no existia) el evento correspondiente a cada fecha afectada en el
Google Calendar de turnos de mantenimiento (`actualizarEventoDia`, en
`generarCalendarioMantenimiento.js`). Es best-effort: si el Calendar API
falla, el cambio queda igual aprobado en la base (eso es lo que manda), solo
se loguea el error.

### 2. Que pasa con la rotacion de francos si alguien trabaja de mas por un cambio
**Resuelto (decision de negocio confirmada): la formula de base nunca se
toca.** Ejemplo: si Alberto cubre el turno de Diego un finde (termina
laburando sabado y domingo seguidos, en vez de un solo turno), el finde
siguiente se calcula exactamente igual, como si nada hubiera pasado -- el
orden de rotacion sigue su curso normal. Esto ya es lo que hace el codigo:
`turnoDelDia` (la formula base en `services/turnosMantenimiento.js`) se
calcula solo a partir de las fechas ancla, nunca lee `excepciones_turno`;
unicamente `turnoRealDelDia` (usado para mostrar/sincronizar el dia puntual
del cambio) chequea si hay una excepcion. Si en el futuro alguien quiere
"devolver el favor", se hace con otro pedido de cambio de turno como los
que ya existen -- no hay compensacion automatica.

## Gestion de licencias y vacaciones

**Implementado**, desde el panel de admin (`/panel` → seccion "Licencias",
en el menu lateral). No hay carga por WhatsApp todavia, solo panel.

- **Tabla `licencias`**: empleado, fecha desde, fecha hasta, tipo
  (Vacaciones / Licencia medica / Estudio / Otro), quien la cargo.
- **Al registrar una licencia** se materializan filas "placeholder" en
  `filas_diarias` (columna `licencia_tipo`) para cada dia del rango que
  todavia no tenga datos reales -- si un dia ya tenia una fila (alguien
  fichó antes de cargar la licencia), se deja intacta y se avisa en la
  respuesta ("N dias ya tenian datos y no se tocaron").
- **Si despues llega un fichaje real** para un dia marcado como licencia
  (`guardarFilasDiarias`, usado por el pipeline y por las correcciones), se
  limpia `licencia_tipo` automaticamente -- deja de contar como licencia y
  pasa a ser un dia trabajado normal.
- **Efecto en el calculo**: los dias de licencia **no** cuentan como "dia
  trabajado" en el resumen mensual (se excluyen del `COUNT(*)` de
  `recalcularResumenEmpleado` y del % de fichadas completas del panel), y
  no muestran la alerta de "sin dato".
- **Se ve reflejado** en "mis horas" (WhatsApp, `° 15/7 🏖️ Vacaciones`) y en
  el Excel (columna Turno = "Licencia", Observación con el tipo).
- **Borrar una licencia** solo borra los placeholders puros que genero (los
  que nunca recibieron un dato real) -- si algun dia de ese rango ya tiene
  fichaje real cargado, no se toca.

**Decision de negocio ya definida:** por ahora no se esta calculando sueldo
automatico, asi que no importa si un dia de licencia "cuenta como
presentismo" o no -- quedo afuera del conteo de dias/horas del resumen. Si
mas adelante se retoma el calculo de sueldo, hay que revisar esta regla.

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
(`services/turnosMantenimiento.js`, con la rotacion de turnos y francos).
Para conserjeria existe para 5 de los 7 -- Martin Torres, Veronica
Montenegro, Maria Benitez Morinigo, Yesica Alcaraz y Sebastian Galeano
tienen su dia franco fijo cargado en `services/turnosConserjeria.js`; Lisa
Rios y Aaron Garcen quedan afuera a proposito (sin patron de franco
conocido todavia).

## Deteccion manual de dias sin fichar (ya usada, no automatica)

No es lo mismo que el punto anterior (eso es deteccion automatica por
WhatsApp, sin construir). Lo que sí existe hoy es un chequeo manual: cruzar
`turnoRealDelDia`/`turnoConserjeriaDelDia` (el turno que le tocaba a cada
uno) contra `filaDelDiaPorFecha` (si hay o no un registro ese dia) para
armar una lista de dias sin ninguna marcacion, excluyendo feriados y el dia
de hoy. Se corrio a mano para mantenimiento y conserjeria completo. Sirve
de base para armar un endpoint o comando fijo mas adelante si hace falta
repetirlo seguido.

## Panel web de administracion

Disponible en `http://TU_SERVIDOR:3000/panel`. Se loguea con
`ADMIN_PANEL_PASSWORD` del `.env` (contraseña propia del panel, separada de
`ADMIN_API_KEY` que usan los endpoints `/admin/*`). La navegacion es un
menu lateral (boton ☰ arriba a la izquierda) con todas las secciones.
Desde ahi se puede, sin usar WhatsApp:

- Ver Resumen general (dashboard) con metricas del periodo actual.
- Ver y aprobar/rechazar correcciones de fichaje pendientes (con el dato
  actual de esa fecha visible antes de decidir).
- Ver y aprobar/rechazar pedidos de cambio de turno pendientes.
- Buscar las fichadas de un empleado por periodo ("Fichadas por empleado").
- Ver la lista de empleados (sector, numero de WhatsApp registrado).
- Ver el resumen de horas de cualquier periodo.
- Registrar y borrar licencias/vacaciones (seccion "Licencias").
- Ver estadisticas de uso del bot, tendencia de horas y ranking de fichaje
  perfecto (seccion "Estadisticas").
- Ver la grilla de turnos de mantenimiento y las fichas de conserjeria
  (seccion "Turnos"), con selector de mes y feriados marcados.

Aprobar/rechazar desde el panel dispara exactamente la misma logica que el
comando de WhatsApp (recalculo de horas, aviso al empleado, sync del
Google Calendar en cambios de turno) -- es el mismo codigo, solo cambia el
canal desde donde se dispara.

La sesion del panel queda guardada en el navegador (localStorage) y
persiste la pestaña activa entre recargas.

## Auto-monitoreo del servidor

Cron externo (`monitorProceso.js`, corre cada 5 minutos via `crontab`, no
depende de que el server este sano) que avisa por WhatsApp al admin si el
proceso deja de estar "online" en pm2, o si empieza a reiniciarse solo en
loop (`unstable_restarts` de pm2 sube).

## Monitoreo en tiempo real de fichadas (construido, bloqueado)

`services/monitorFichadas.js` + dos cron jobs (`CRON_POLL_FICHADAS`,
`CRON_RECORDATORIOS`) ya estan armados para avisar por WhatsApp ~2 minutos
despues de fichar, y mandar recordatorios si alguien se olvida de fichar la
salida. **No funciona hoy** porque depende de `obtenerEventosAcceso`
(`services/hikcentral.js`), que esta bloqueado por lo mismo que el pipeline
mensual (ver seccion de HikCentral arriba) -- tira `ERR_INVALID_URL` cada 2
minutos en los logs, es un error conocido, no hace falta alertarse por eso.
Se destraba solo si se resuelve el acceso a HikCentral o se arma el puente
con el facial standalone.

## Dias de evento por WhatsApp

Comando de admin: `evento Nombre Apellido DD/MM` (tambien admite rango
"DD/MM al DD/MM" o fechas separadas por coma). Se guarda en la tabla
`eventos` y lo usa `motorCalculo.esDiaDeEvento` -- estar marcado como
"evento" hace que las horas que superan el contrato normal de ese dia vayan
a extra 100% con un piso de 8hs (en vez del 50% normal). **Ojo:** esto es
distinto de "cubrir un evento externo tipo poker" -- ese caso se paga como
hora extra normal (50%), no lleva la marca de "evento" del sistema. La
distincion la define el admin caso por caso, no hay regla automatica que
adivine cual es cual.

## Estadisticas en el panel

Pestaña en el panel web:

- **Tendencia de horas** por sector, ultimos periodos.
- **Ranking de pedidos** (correcciones + cambios + cancelaciones) por
  empleado.
- **% de fichadas completas por empleado** (periodo actual), con badge de
  "Perfecto" o "Con faltantes".
- **Correcciones pedidas por empleado** -- de `solicitudes_correccion`.
- **Interacciones con el bot** (consultas de horas, correcciones, etc por
  empleado) y **ultima actividad** -- se registran en la tabla
  `mensajes_whatsapp`. No hay forma de reconstruir historial de antes de
  que se agregara esto.

**Sobre las 72hs del Sandbox de Twilio:** no es posible mostrar cuenta
regresiva de cuando vence el `join` de cada numero -- Twilio intercepta ese
mensaje antes de que llegue al webhook. La unica solucion real sigue siendo
salir del Sandbox (ver arriba).

## Mejoras de infraestructura pendientes

- **HTTPS / proxy:** hoy el panel corre en HTTP plano, directo en el
  puerto 3000, sin nginx ni ningun proxy adelante -- la contraseña del
  panel y la sesion viajan sin cifrar. Pendiente sumar un proxy (nginx) con
  certificado (Let's Encrypt) para tener HTTPS. No es urgente para el
  tamaño actual del proyecto, pero es la mejora de seguridad mas importante
  de las pendientes.
- **Base de datos separada:** hoy es SQLite, un solo archivo local en el
  mismo servidor (`data/fichero.sqlite`), sin un servidor de base de datos
  aparte. Funciona bien para el volumen actual, pero a futuro (mas
  empleados, mas historial, necesidad de backups/replicacion mas robustos
  que un archivo copiado a mano) tendria sentido migrar a un motor de base
  de datos dedicado (Postgres/MySQL) corriendo aparte -- mejora
  escalabilidad y facilita backups automaticos, no es un problema de
  seguridad puntual hoy.

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
