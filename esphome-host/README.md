# HAWhatsUp ESPHome Host Prototype

Prototipo para ejecutar un nodo ESPHome en x86/Linux usando la plataforma
`host`. Home Assistant lo ve como un dispositivo ESPHome por la API nativa en el
puerto `6053`.

El nodo no habla directamente con WhatsApp. Hace de "companion device" y se
comunica por HTTP con el add-on HAWhatsUp Baileys.

## Requisitos

- ESPHome instalado, o usar el contenedor oficial `esphome/esphome`.
- El add-on HAWhatsUp accesible por HTTP.

En la prueba local actual, el add-on esta en:

```text
http://127.0.0.1:3012
```

Si ejecutas ESPHome en Docker con `--network host`, `127.0.0.1` apunta al host
y sirve para hablar con el add-on local. Si usas otra red Docker, cambia
`addon_url` por la IP/nombre que alcance al add-on.

## Ejecutar localmente

Con ESPHome instalado:

```bash
esphome run hawhatsup_host.yaml
```

Con Docker, desde esta carpeta:

```bash
docker run --rm -it --network host \
  -v "$PWD":/config \
  esphome/esphome run /config/hawhatsup_host.yaml
```

## Anadir en Home Assistant

ESPHome `host` no se descubre automaticamente por mDNS. En Home Assistant,
anade la integracion ESPHome manualmente apuntando a la IP del equipo donde
corre este proceso y puerto `6053`.

En esta maquina de pruebas:

```text
192.168.1.136:6053
```

## Entidades

- `text.whatsapp_message`
- `select.whatsapp_contact`
- `button.send_whatsapp_message`
- `text_sensor.whatsapp_status`
- `text_sensor.whatsapp_last_message`
- `text_sensor.whatsapp_last_from`
- `text_sensor.whatsapp_last_direction`
- `sensor.whatsapp_message_count`
- `binary_sensor.whatsapp_connected`
- `button.refresh_whatsapp_status`

## Accion para enviar

Home Assistant creara una accion ESPHome similar a:

```yaml
action: esphome.hawhatsup_host_send_whatsapp_message
data:
  to: "34655068269"
  message: "hola desde ESPHome"
```

Tambien puedes enviar desde las entidades del dispositivo:

1. Escribe el texto en `text.whatsapp_message`.
2. Elige contacto en `select.whatsapp_contact`.
3. Pulsa `button.send_whatsapp_message`.

## Actualizar contactos

ESPHome necesita que las opciones de un `select` esten definidas en YAML. Para
rellenarlas desde los contactos que recoge Baileys:

```bash
node ../tools/update-esphome-contacts.mjs hawhatsup_host.yaml
```

Si el add-on no esta en `http://127.0.0.1:3012`, define `HAWHATSUP_URL`:

```bash
HAWHATSUP_URL=http://192.168.1.136:3012 \
  node ../tools/update-esphome-contacts.mjs hawhatsup_host.yaml
```

Despues vuelve a ejecutar ESPHome para que Home Assistant vea el desplegable
actualizado.
