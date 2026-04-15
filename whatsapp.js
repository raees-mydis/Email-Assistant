const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

// ─── Send a WhatsApp message to yourself ─────────────────────────────────────

async function send(text) {
  // WhatsApp messages have a 4096 char limit — split if needed
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    await client.messages.create({
      from: config.twilio.fromNumber,
      to:   config.twilio.toNumber,
      body: chunk,
    });
    // Small delay between chunks to preserve order
    if (chunks.length > 1) await sleep(500);
  }
}

// ─── Parse an inbound Twilio webhook POST body ────────────────────────────────
// Twilio sends form-encoded data. Express with urlencoded middleware handles this.

function parseInbound(body) {
  const from   = (body.From || '').replace('whatsapp:', '').trim();
  const text   = (body.Body || '').trim();
  const msgSid = body.MessageSid || '';
  return { from, text, msgSid };
}

// ─── Validate the message came from your number ──────────────────────────────

function isAllowedSender(from) {
  const allowed = config.twilio.allowedSender.replace(/\s/g, '');
  const cleaned = from.replace(/\s/g, '');
  return cleaned === allowed || `+${cleaned}` === allowed;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    let end = pos + maxLen;
    if (end < text.length) {
      // Try to break at a newline or space
      const nl = text.lastIndexOf('\n', end);
      const sp = text.lastIndexOf(' ', end);
      end = nl > pos + maxLen / 2 ? nl : sp > pos + maxLen / 2 ? sp : end;
    }
    chunks.push(text.slice(pos, end).trim());
    pos = end + 1;
  }
  return chunks.filter(Boolean);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { send, parseInbound, isAllowedSender };
