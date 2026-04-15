const express = require('express');
const cron    = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-email-assistant' });
});

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const whatsapp = require('./whatsapp');
    const router   = require('./router');
    const { from, text } = whatsapp.parseInbound(req.body);
    console.log('[webhook] from:', from, 'text:', text);
    if (!whatsapp.isAllowedSender(from)) {
      console.log('[webhook] ignored unknown sender:', from);
      return;
    }
    if (text) await router.handleInbound(text);
  } catch (err) {
    console.error('[webhook] error:', err.message);
  }
});

app.post('/trigger/digest', async (req, res) => {
  res.json({ status: 'triggered' });
  try {
    const { runDigest } = require('./digest');
    await runDigest();
  } catch (err) {
    console.error('[trigger] error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('WhatsApp Email Assistant running on port', PORT);
  console.log('User:', process.env.USER_EMAIL);
  console.log('WhatsApp:', process.env.YOUR_WHATSAPP_NUMBER);

  const times = (process.env.DIGEST_TIMES || '0 8 * * *,0 12 * * *,0 15 * * *').split(',');
  times.forEach(t => {
    const trimmed = t.trim();
    if (cron.validate(trimmed)) {
      cron.schedule(trimmed, async () => {
        try {
          const { runDigest } = require('./digest');
          await runDigest();
        } catch (err) {
          console.error('[cron] error:', err.message);
        }
      }, { timezone: 'Europe/London' });
      console.log('[cron] scheduled:', trimmed);
    }
  });
});
