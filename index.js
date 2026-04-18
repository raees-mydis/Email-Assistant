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

// Personal account OAuth routes
app.get('/auth/personal', (req, res) => {
  const personalAuth = require('./personal-auth');
  res.redirect(personalAuth.getAuthUrl());
});

app.get('/auth/personal/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send('Auth error: ' + error);
  if (!code) return res.send('No code received');
  try {
    const personalAuth = require('./personal-auth');
    const tokens = await personalAuth.exchangeCode(code);
    const encoded = Buffer.from(JSON.stringify(tokens)).toString('base64');
    process.env.PERSONAL_TOKEN = encoded;
    const whatsapp = require('./whatsapp');
    await whatsapp.send('✅ Personal calendar connected!');
    res.send(`
      <h2>✅ Personal calendar connected!</h2>
      <p>Copy the value below and add it as a Railway environment variable named <strong>PERSONAL_TOKEN</strong>:</p>
      <textarea rows="4" style="width:100%;font-size:11px;word-break:break-all" onclick="this.select()">${encoded}</textarea>
      <p>Once added to Railway variables, your personal calendar will work permanently.</p>
    `);
  } catch (err) {
    console.error('[auth/personal] error:', err.message);
    res.send('Error: ' + err.message);
  }
});

app.get('/auth/personal/status', (req, res) => {
  const personalAuth = require('./personal-auth');
  res.json({ connected: personalAuth.isAuthenticated() });
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

  // Auto-rejoin Twilio sandbox every 60 hours to prevent expiry
  // Sandbox lasts 72h — we rejoin at 60h to stay safe
  const SANDBOX_NAME = process.env.TWILIO_SANDBOX_NAME;
  if (SANDBOX_NAME) {
    cron.schedule('0 */60 * * *', async () => {
      try {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await client.messages.create({
          from: 'whatsapp:' + process.env.YOUR_WHATSAPP_NUMBER,
          to: 'whatsapp:+14155238886',
          body: 'join ' + SANDBOX_NAME,
        });
        console.log('[sandbox] Auto-rejoined sandbox:', SANDBOX_NAME);
      } catch (err) {
        console.error('[sandbox] Auto-rejoin failed:', err.message);
      }
    });
    console.log('    [sandbox] Auto-rejoin enabled for:', SANDBOX_NAME);
  }
});
