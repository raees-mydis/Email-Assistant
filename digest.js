const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const store    = require('./store');

async function runDigest() {
  const now = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit',
  });

  console.log(`[${new Date().toISOString()}] Running digest...`);

  try {
    // 1. Fetch unread emails from Office 365
    const emails = await graph.getUnreadEmails(30);
    console.log(`  Fetched ${emails.length} unread emails`);

    // 2. Save to session store so reply commands can reference by number
    store.saveSession(emails);

    // 3. Ask Claude to summarise
    const summary = await claude.summariseEmails(emails);
    console.log('  Claude summary ready');

    // 4. Build the WhatsApp message
    const message = `Email digest — ${now}\n\n${summary}`;

    // 5. Send via Twilio → WhatsApp → Android Auto reads it aloud
    await whatsapp.send(message);
    console.log('  Digest sent to WhatsApp');

  } catch (err) {
    console.error('  Digest failed:', err.message);

    // Notify yourself of the failure
    try {
      await whatsapp.send(`Digest failed at ${now}: ${err.message}`);
    } catch {}
  }
}

module.exports = { runDigest };
