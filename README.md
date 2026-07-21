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

## Preguntas abiertas (a resolver)

### 1. Sincronizar el Google Calendar cuando se aprueba un cambio de turno
Hoy, al aprobar un pedido de cambio de turno entre companeros de
mantenimiento (comando `aprobar cambio N` por WhatsApp), el intercambio
queda guardado como excepcion puntual en la base (tabla `excepciones_turno`,
usada por `turnosMantenimiento.turnoRealDelDia`), pero **el evento ya creado
en el Google Calendar de turnos de mantenimiento no se corrige solo** --
sigue mostrando la asignacion original de la formula. Falta sumar la logica
que busque y actualice (o cree) el evento correspondiente a cada fecha
afectada cuando se aprueba un cambio.

### 2. Que pasa con la rotacion de francos si alguien trabaja de mas por un cambio
Ejemplo: si Alberto cubre el turno de Diego un finde (termina laburando
sabado y domingo seguidos, en vez de un solo turno), la formula de rotacion
de mantenimiento (`lib/turnosMantenimiento.js`) **no se entera ni se
acomoda** -- el finde siguiente se calcula exactamente igual, como si nada
hubiera pasado. Falta decidir:

- **Opcion A (simple):** dejarlo asi. Cada intercambio es independiente; si
  alguien quiere "devolver el favor" mas adelante, se hace con otro pedido
  de cambio de turno como los que ya existen. No requiere trabajo extra,
  pero depende de que el equipo se acuerde y lo resuelva por su cuenta.
- **Opcion B (con memoria):** que el sistema lleve una cuenta de "dias de
  mas / de menos" por persona, para saber quien tiene un dia pendiente a
  favor. Requiere definir las reglas de negocio primero (¿un dia extra da
  un franco extra? ¿cuando se "cobra"? ¿se puede acumular mas de uno?) antes
  de poder implementarlo.

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
