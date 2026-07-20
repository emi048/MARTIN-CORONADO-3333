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

## Antes de poner esto en producción — 3 cosas pendientes

### 1. Conexión real a HikCentral (lib/hikcentral.js)
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

### 2. Seguridad de los endpoints admin (server.js)
`/admin/generar-ahora` y `/admin/registrar-numero` hoy están abiertos. Antes
de exponer el servidor a internet, agregales una clave simple (por ejemplo,
un header `x-admin-key` que compares contra una variable de entorno) — te lo
puedo armar en el próximo paso.

### 3. Alta de empleados en WhatsApp
Por ahora, dar de alta a alguien es un POST manual a `/admin/registrar-numero`
con `{ "numero": "+549...", "empleado": "Nombre Apellido" }`. Si querés, la
siguiente iteración puede ser un panel web chiquito (protegido con
contraseña, como el panel admin que ya tenías en el HTML) para hacer esto sin
tocar la terminal.

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
