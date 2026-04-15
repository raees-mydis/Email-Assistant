const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

async function send(text) {
  const MAX = 1500;
  const chunks = text.length <= MAX ? [text] : text.match(new RegExp('.{1,' + MAX + '}', 'gs')) || [text];
  for (const chunk of chunks) {
    await client.messages.create({
      from: config.twilio.fromNumber,
      to:   config.twilio.toNumber,
      body: chunk,
    });
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

function parseInbound(body) {
  return {
    from:   (body.From || '').replace('whatsapp:', '').trim(),
    text:   (body.Body || '').trim(),
    msgSid: body.MessageSid || '',
  };
}

function isAllowedSender(from) {
  const allowed = (config.twilio.allowedSender || '').replace(/\D/g, '');
  const cleaned = from.replace(/\D/g, '');
  return cleaned === allowed || cleaned.endsWith(allowed) || allowed.endsWith(cleaned);
}

module.exports = { send, parseInbound, isAllowedSender };
