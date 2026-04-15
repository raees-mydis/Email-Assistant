const config    = require('./config');
const express   = require('express');
const cron      = require('node-cron');
const whatsapp  = require('./whatsapp');
const router    = require('./router');
const { runDigest } = require('./digest');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-email-assistant', time: new Date().toISOString() });
});

// ─── Twilio inbound webhook ───────────────────────────────────────────────────
// Twilio POSTs here whenever you send a WhatsApp message to your Twilio number.

app.post('/webhook/whatsapp', async (req, res) => {
  // Always respond 200 immediately — Twilio will retry if we don't
  res.sendStatus(200);

  const { from, text } = whatsapp.parseInbound(req.body);

  // Security: only process messages from your own number
  if (!whatsapp.isAllowedSender(from)) {
    console.warn(`[webhook] Ignored message from unknown sender: ${from}`);
    return;
  }

  if (!text) return;

  try {
    await router.handleInbound(text);
  } catch (err) {
    console.error('[webhook] Handler error:', err.message);
    try {
      await whatsapp.send(`Error: ${err.message}`);
    } catch {}
  }
});

// ─── Manual digest trigger (useful for testing) ───────────────────────────────

app.post('/trigger/digest', async (req, res) => {
  res.json({ status: 'triggered' });
  try {
    await runDigest();
  } catch (err) {
    console.error('[trigger] Digest error:', err.message);
  }
});

// ─── Cron scheduler ───────────────────────────────────────────────────────────

function startScheduler() {
  const times = config.app.digestTimes;

  times.forEach(expression => {
    const trimmed = expression.trim();
    if (!cron.validate(trimmed)) {
      console.warn(`[cron] Invalid expression: "${trimmed}" — skipping`);
      return;
    }
    cron.schedule(trimmed, runDigest, { timezone: 'Europe/London' });
    console.log(`[cron] Digest scheduled: ${trimmed}`);
  });

  console.log(`[cron] ${times.length} digest(s) scheduled daily`);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = config.app.port;
app.listen(PORT, () => {
  console.log('\n✅  WhatsApp Email Assistant started');
  console.log(`    Webhook:  http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`    Trigger:  POST http://localhost:${PORT}/trigger/digest`);
  console.log(`    User:     ${config.azure.userEmail}`);
  console.log(`    WhatsApp: ${config.twilio.toNumber}\n`);
  startScheduler();
});

module.exports = app;
