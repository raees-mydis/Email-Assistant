const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const store    = require('./store');

async function runDigest() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  console.log('[digest] Running at', now);
  try {
    const emails = await graph.getUnreadEmails(30);
    console.log('[digest] Fetched', emails.length, 'emails');
    store.saveSession(emails);
    const summary = await claude.summariseEmails(emails);
    await whatsapp.send('Email digest - ' + now + '\n\n' + summary);
    console.log('[digest] Sent');
  } catch (err) {
    console.error('[digest] Error:', err.message);
    try { await whatsapp.send('Digest failed: ' + err.message); } catch {}
  }
}

module.exports = { runDigest };
