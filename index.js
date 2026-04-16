const express  = require('express');
const cron     = require('node-cron');
const path     = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'penelope', time: new Date().toISOString() });
});

// Twilio WhatsApp webhook — must return empty TwiML, NOT "OK" text
app.post('/webhook/whatsapp', async (req, res) => {
  // Return empty TwiML immediately — stops Twilio forwarding "OK" as a WhatsApp message
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  try {
    const whatsapp = require('./whatsapp');
    const router   = require('./router');
    const { from, text } = whatsapp.parseInbound(req.body);
    console.log('[webhook] from:', from, 'text:', text);
    if (!whatsapp.isAllowedSender(from)) return;
    if (text) await router.handleInbound(text);
  } catch (err) {
    console.error('[webhook] error:', err.message);
  }
});

app.post('/api/command', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  const whatsapp = require('./whatsapp');
  const router   = require('./router');
  const responses = [];
  const originalSend = whatsapp.send.bind(whatsapp);
  whatsapp.send = async (msg) => { responses.push(msg); };
  try {
    await router.handleInbound(text);
    res.json({ response: responses.join('\n\n') || 'Done! ✅' });
  } catch (err) {
    console.error('[api/command] error:', err.message);
    res.json({ response: 'Something went wrong: ' + err.message });
  } finally {
    whatsapp.send = originalSend;
  }
});

app.post('/trigger/digest', async (req, res) => {
  res.json({ status: 'triggered' });
  try { const { runDigest } = require('./digest'); await runDigest(); }
  catch (err) { console.error('[trigger] error:', err.message); }
});

app.post('/api/digest', async (req, res) => {
  const whatsapp = require('./whatsapp');
  const responses = [];
  const originalSend = whatsapp.send.bind(whatsapp);
  whatsapp.send = async (msg) => { responses.push(msg); };
  try {
    const { runDigest } = require('./digest');
    await runDigest();
    res.json({ response: responses.join('\n\n') || 'Digest complete' });
  } catch (err) {
    res.json({ response: 'Digest error: ' + err.message });
  } finally {
    whatsapp.send = originalSend;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('✅  Penelope running on port', PORT);
  console.log('    User:', process.env.USER_EMAIL);
  const times = (process.env.DIGEST_TIMES || '0 7 * * *,0 12 * * *,0 17 * * *').split(',');
  times.forEach(t => {
    const trimmed = t.trim();
    if (cron.validate(trimmed)) {
      cron.schedule(trimmed, async () => {
        try { const { runDigest } = require('./digest'); await runDigest(); }
        catch (err) { console.error('[cron]', err.message); }
      }, { timezone: 'Europe/London' });
      console.log('    [cron]', trimmed);
    }
  });
});
