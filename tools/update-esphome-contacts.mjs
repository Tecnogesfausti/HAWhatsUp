import fs from 'node:fs';

const endpoint = process.env.HAWHATSUP_URL || 'http://127.0.0.1:3012';
const yamlPath = process.argv[2] || 'esphome-host/hawhatsup_host.yaml';
const start = '      # BEGIN generated WhatsApp contacts';
const end = '      # END generated WhatsApp contacts';

const response = await fetch(`${endpoint.replace(/\/$/, '')}/contacts`);
if (!response.ok) {
  throw new Error(`Could not fetch contacts: HTTP ${response.status}`);
}

const payload = await response.json();
const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
const options = contacts
  .filter((contact) => contact.name && contact.jid)
  .slice(0, Number(process.env.HAWHATSUP_CONTACT_LIMIT || 50))
  .map((contact) => `        - ${JSON.stringify(`${contact.name} | ${contact.jid}`)}`);

if (options.length === 0) {
  options.push('        - "No contacts yet | "');
}

const yaml = fs.readFileSync(yamlPath, 'utf8');
const beginIndex = yaml.indexOf(start);
const endIndex = yaml.indexOf(end);

if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
  throw new Error(`Could not find generated contacts markers in ${yamlPath}`);
}

const updated = [
  yaml.slice(0, beginIndex + start.length),
  '\n',
  ...options.map((line) => `${line}\n`),
  yaml.slice(endIndex)
].join('');

fs.writeFileSync(yamlPath, updated);
console.log(`Updated ${options.length} ESPHome contact option(s) in ${yamlPath}`);

