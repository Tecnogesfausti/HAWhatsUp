# HAWhatsUp Baileys

Bridge de WhatsApp Web para Home Assistant usando Baileys.

## Que hace

- Abre una sesion de WhatsApp Web con Baileys.
- Muestra el QR en la web del add-on y en los logs.
- Publica mensajes entrantes en MQTT.
- Crea sensores en Home Assistant usando MQTT discovery.
- Permite enviar mensajes por HTTP o publicando en MQTT.

## Sensores creados

- `sensor.whatsapp_status`: estado de la sesion (`starting`, `qr`, `connected`, `disconnected`, `logged_out`).
- `sensor.whatsapp_last_message`: ultimo texto recibido, con atributos `from`, `pushName`, `timestamp`, `messageType` y `body`.
- `sensor.whatsapp_message_count`: contador de mensajes recibidos desde el arranque.

## Topicos MQTT

- `hawhatsup/status/state`
- `hawhatsup/messages`
- `hawhatsup/last_message/state`
- `hawhatsup/last_message/attributes`
- `hawhatsup/message_count/state`
- `hawhatsup/send`

Para enviar un mensaje por MQTT:

```json
{"to":"34123456789","message":"Hola desde Home Assistant"}
```

## API HTTP

- `GET /`: pagina de estado y QR.
- `GET /status`: estado JSON.
- `GET /qr`: QR JSON con `dataUrl`.
- `POST /send`: envia mensaje.

Ejemplo:

```bash
curl -X POST http://homeassistant.local:3000/send \
  -H 'content-type: application/json' \
  -d '{"to":"34123456789","message":"Hola"}'
```

## Configuracion

Usa el broker MQTT de Home Assistant, normalmente el add-on Mosquitto con host
`core-mosquitto`.

Si Mosquitto requiere usuario y clave, ponlos en las opciones del add-on.

## Avisos

Baileys usa WhatsApp Web no oficial. Puede dejar de funcionar si WhatsApp cambia
su protocolo, y debes respetar la privacidad de los mensajes y las condiciones
del servicio aplicables.

