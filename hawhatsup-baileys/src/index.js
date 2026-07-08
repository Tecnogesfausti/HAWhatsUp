import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import express from 'express';
import mqtt from 'mqtt';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';

const DATA_DIR = process.env.DATA_DIR || '/data';
const OPTIONS_PATH = path.join(DATA_DIR, 'options.json');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const defaults = {
  mqtt_host: process.env.MQTT_HOST || 'localhost',
  mqtt_port: Number(process.env.MQTT_PORT || 1883),
  mqtt_username: process.env.MQTT_USERNAME || '',
  mqtt_password: process.env.MQTT_PASSWORD || '',
  mqtt_client_id: process.env.MQTT_CLIENT_ID || 'hawhatsup-baileys',
  mqtt_base_topic: process.env.MQTT_BASE_TOPIC || 'hawhatsup',
  discovery_prefix: process.env.DISCOVERY_PREFIX || 'homeassistant',
  web_port: Number(process.env.WEB_PORT || 3000),
  device_name: process.env.DEVICE_NAME || 'HAWhatsUp',
  include_own_messages: true,
  mark_online_on_connect: true,
  reject_call: true
};

function readOptions() {
  try {
    if (fs.existsSync(OPTIONS_PATH)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8')) };
    }
  } catch (error) {
    logger.warn({ error }, 'Could not read add-on options, using defaults');
  }

  return defaults;
}

const options = readOptions();
const baseTopic = cleanTopic(options.mqtt_base_topic);
const discoveryPrefix = cleanTopic(options.discovery_prefix);

let socket;
let qrText = null;
let qrDataUrl = null;
let connectionState = 'starting';
let lastMessage = null;
let messageCount = 0;
let reconnectTimer = null;
const contacts = new Map();

fs.mkdirSync(AUTH_DIR, { recursive: true });
loadContacts();

const mqttClient = mqtt.connect({
  host: options.mqtt_host,
  port: Number(options.mqtt_port),
  username: options.mqtt_username || undefined,
  password: options.mqtt_password || undefined,
  clientId: options.mqtt_client_id,
  reconnectPeriod: 5000,
  will: {
    topic: `${baseTopic}/availability`,
    payload: 'offline',
    qos: 1,
    retain: true
  }
});

mqttClient.on('connect', () => {
  logger.info('Connected to MQTT broker');
  publishAvailability('online');
  publishDiscovery();
  publishStatus();
  mqttClient.subscribe(`${baseTopic}/send`, { qos: 1 });
});

mqttClient.on('message', async (topic, payload) => {
  if (topic !== `${baseTopic}/send`) return;

  try {
    const command = JSON.parse(payload.toString());
    await sendWhatsAppMessage(command.to, command.message);
  } catch (error) {
    logger.warn({ error }, 'Invalid MQTT send command');
  }
});

mqttClient.on('error', (error) => {
  logger.warn({ error }, 'MQTT error');
});

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => {
  res.type('html').send(renderStatusPage());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, connectionState, hasQr: Boolean(qrText) });
});

app.get('/status', (_req, res) => {
  res.json({ connectionState, hasQr: Boolean(qrText), lastMessage, messageCount });
});

app.get('/contacts', (_req, res) => {
  res.json({ contacts: getContactList() });
});

app.get('/qr', (_req, res) => {
  if (!qrDataUrl) {
    res.status(404).json({ error: 'QR is not available. Restart pairing if needed.' });
    return;
  }

  res.json({ qr: qrText, dataUrl: qrDataUrl });
});

app.post('/send', async (req, res) => {
  try {
    await sendWhatsAppMessage(req.body?.to, req.body?.message);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.listen(Number(options.web_port), () => {
  logger.info({ port: options.web_port }, 'Status API listening');
});

startWhatsApp();

async function startWhatsApp() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('HAWhatsUp'),
    markOnlineOnConnect: Boolean(options.mark_online_on_connect),
    logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' })
  });

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', handleConnectionUpdate);
  socket.ev.on('messages.upsert', handleMessagesUpsert);
  socket.ev.on('messaging-history.set', handleMessagingHistorySet);
  socket.ev.on('contacts.upsert', handleContactsUpsert);
  socket.ev.on('contacts.update', handleContactsUpdate);

  if (options.reject_call) {
    socket.ev.on('call', async (calls) => {
      for (const call of calls) {
        if (call.status === 'offer') {
          await socket.rejectCall(call.id, call.from);
        }
      }
    });
  }
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    qrText = qr;
    qrDataUrl = await QRCode.toDataURL(qr);
    connectionState = 'qr';
    logger.info('Pairing QR generated. Open the add-on web UI to scan it.');
    publishStatus();
  }

  if (connection === 'open') {
    qrText = null;
    qrDataUrl = null;
    connectionState = 'connected';
    logger.info('WhatsApp session connected');
    publishStatus();
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    connectionState = loggedOut ? 'logged_out' : 'disconnected';
    logger.warn({ statusCode }, 'WhatsApp session closed');
    publishStatus();

    if (!loggedOut) {
      reconnectTimer = setTimeout(startWhatsApp, 5000);
    }
  }
}

function handleMessagesUpsert({ messages, type }) {
  logger.info({ type, count: messages.length }, 'WhatsApp messages upsert');
  publishMessages(messages, type);
}

function handleMessagingHistorySet({ messages = [], syncType }) {
  logger.info({ syncType, count: messages.length }, 'WhatsApp messaging history set');
  publishMessages(messages, `history:${syncType || 'unknown'}`);
}

function publishMessages(messages, source) {
  for (const message of messages) {
    if (!message.message) continue;
    if (message.key.fromMe && !options.include_own_messages) continue;

    const normalized = normalizeMessage(message);
    normalized.source = source;
    lastMessage = normalized;
    messageCount += 1;

    upsertContact({
      id: normalized.from,
      name: normalized.pushName,
      notify: normalized.pushName
    });

    publishJson(`${baseTopic}/messages`, normalized, false);
    publishJson(`${baseTopic}/last_message/attributes`, normalized, true);
    publishState(`${baseTopic}/last_message/state`, normalized.body || normalized.messageType || 'message', true);
    publishState(`${baseTopic}/message_count/state`, String(messageCount), true);

    logger.info({ from: normalized.from, messageType: normalized.messageType }, 'WhatsApp message received');
  }
}

function handleContactsUpsert(items) {
  for (const contact of items) {
    upsertContact(contact);
  }

  logger.info({ count: contacts.size }, 'WhatsApp contacts upserted');
}

function handleContactsUpdate(items) {
  for (const contact of items) {
    upsertContact(contact);
  }

  logger.info({ count: contacts.size }, 'WhatsApp contacts updated');
}

function normalizeMessage(message) {
  const content = unwrapMessage(message.message);
  const messageType = getContentType(content) || 'unknown';
  const body = extractText(content, messageType);

  return {
    id: message.key.id,
    from: message.key.remoteJid,
    fromMe: Boolean(message.key.fromMe),
    direction: message.key.fromMe ? 'outgoing' : 'incoming',
    pushName: message.pushName || '',
    timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
    messageType,
    body
  };
}

function upsertContact(contact) {
  if (!contact?.id || !isSendableJid(contact.id)) return;

  const previous = contacts.get(contact.id) || {};
  contacts.set(contact.id, normalizeContact({ ...previous, ...contact }));
  saveContacts();
}

function normalizeContact(contact) {
  const displayName = contact.name || contact.notify || contact.verifiedName || contact.id;
  return {
    id: contact.id,
    name: displayName,
    notify: contact.notify || '',
    verifiedName: contact.verifiedName || '',
    jid: contact.id,
    phone: jidToPhone(contact.id),
    label: `${displayName} | ${contact.id}`
  };
}

function getContactList() {
  return Array.from(contacts.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

function loadContacts() {
  try {
    if (!fs.existsSync(CONTACTS_PATH)) return;

    const stored = JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8'));
    const items = Array.isArray(stored.contacts) ? stored.contacts : [];
    for (const contact of items) {
      if (contact?.id) {
        contacts.set(contact.id, normalizeContact(contact));
      }
    }

    logger.info({ count: contacts.size }, 'Loaded persisted WhatsApp contacts');
  } catch (error) {
    logger.warn({ error }, 'Could not load persisted WhatsApp contacts');
  }
}

function saveContacts() {
  try {
    fs.writeFileSync(CONTACTS_PATH, JSON.stringify({ contacts: getContactList() }, null, 2));
  } catch (error) {
    logger.warn({ error }, 'Could not persist WhatsApp contacts');
  }
}

function isSendableJid(jid) {
  return String(jid).endsWith('@s.whatsapp.net') || String(jid).endsWith('@lid');
}

function jidToPhone(jid) {
  const user = String(jid).split('@')[0] || '';
  return /^\d+$/.test(user) ? user : '';
}

function unwrapMessage(message) {
  if (message?.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message?.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message?.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  return message || {};
}

function extractText(content, messageType) {
  const payload = content?.[messageType];
  if (messageType === 'conversation') return content.conversation || '';
  if (!payload || typeof payload !== 'object') return '';
  return payload.text || payload.caption || payload.extendedTextMessage?.text || '';
}

async function sendWhatsAppMessage(to, message) {
  if (!socket || connectionState !== 'connected') {
    throw new Error('WhatsApp session is not connected');
  }

  if (!to || !message) {
    throw new Error('Both "to" and "message" are required');
  }

  const jid = normalizeJid(to);
  await socket.sendMessage(jid, { text: String(message) });
  upsertContact({ id: jid, name: jidToPhone(jid) || jid });
  publishJson(`${baseTopic}/sent`, { to: jid, message: String(message), timestamp: Date.now() }, false);
}

function normalizeJid(value) {
  const trimmed = String(value).trim();
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) throw new Error('Invalid WhatsApp recipient');
  return `${digits}@s.whatsapp.net`;
}

function publishDiscovery() {
  const device = {
    identifiers: ['hawhatsup_baileys'],
    name: options.device_name,
    manufacturer: 'HAWhatsUp',
    model: 'Baileys WhatsApp Web bridge'
  };

  publishJson(`${discoveryPrefix}/sensor/hawhatsup_status/config`, {
    name: 'WhatsApp Status',
    unique_id: 'hawhatsup_status',
    state_topic: `${baseTopic}/status/state`,
    availability_topic: `${baseTopic}/availability`,
    icon: 'mdi:whatsapp',
    device
  }, true);

  publishJson(`${discoveryPrefix}/sensor/hawhatsup_last_message/config`, {
    name: 'WhatsApp Last Message',
    unique_id: 'hawhatsup_last_message',
    state_topic: `${baseTopic}/last_message/state`,
    json_attributes_topic: `${baseTopic}/last_message/attributes`,
    availability_topic: `${baseTopic}/availability`,
    icon: 'mdi:message-text',
    device
  }, true);

  publishJson(`${discoveryPrefix}/sensor/hawhatsup_message_count/config`, {
    name: 'WhatsApp Message Count',
    unique_id: 'hawhatsup_message_count',
    state_topic: `${baseTopic}/message_count/state`,
    availability_topic: `${baseTopic}/availability`,
    icon: 'mdi:counter',
    state_class: 'total_increasing',
    device
  }, true);
}

function publishStatus() {
  publishState(`${baseTopic}/status/state`, connectionState, true);
  publishState(`${baseTopic}/message_count/state`, String(messageCount), true);
}

function publishAvailability(value) {
  publishState(`${baseTopic}/availability`, value, true);
}

function publishState(topic, value, retain = false) {
  if (!mqttClient.connected) return;
  mqttClient.publish(topic, value, { qos: 1, retain });
}

function publishJson(topic, value, retain = false) {
  if (!mqttClient.connected) return;
  mqttClient.publish(topic, JSON.stringify(value), { qos: 1, retain });
}

function cleanTopic(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '') || 'hawhatsup';
}

function renderStatusPage() {
  const qrBlock = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="WhatsApp pairing QR"><p>Escanea este QR desde WhatsApp > Dispositivos vinculados.</p>`
    : '<p>No hay QR activo ahora mismo.</p>';

  const last = lastMessage
    ? `<pre>${escapeHtml(JSON.stringify(lastMessage, null, 2))}</pre>`
    : '<p>Aun no se ha recibido ningun mensaje.</p>';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HAWhatsUp</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; color: #17202a; background: #f5f7f8; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px; }
    section { background: white; border: 1px solid #d9e1e5; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    img { width: 260px; max-width: 100%; image-rendering: pixelated; }
    pre { overflow: auto; background: #101820; color: #e8f0f2; padding: 14px; border-radius: 6px; }
    .state { font-size: 1.4rem; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>HAWhatsUp</h1>
      <p class="state">${escapeHtml(connectionState)}</p>
    </section>
    <section>
      <h2>QR</h2>
      ${qrBlock}
    </section>
    <section>
      <h2>Ultimo mensaje</h2>
      ${last}
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  logger.info('Shutting down');
  publishAvailability('offline');
  mqttClient.end(true, () => process.exit(0));
}
