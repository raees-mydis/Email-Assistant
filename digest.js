const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const store    = require('./store');

async function runDigest() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  console.log('[digest] Running at', now);
  try {
    const emails = await graph.getUnreadEmails(40);
    console.log('[digest] Fetched', emails.length, 'emails');

    // Filter out emails sent by Raees himself
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));

    // For emails with attachments, fetch and analyse them
    for (const email of inbound) {
      if (email.hasAttachments) {
        try {
          const attachments = await graph.getAttachments(email.id);
          const docAttachments = attachments.filter(a =>
            a.contentType.includes('pdf') ||
            a.contentType.includes('word') ||
            a.contentType.includes('document') ||
            a.name.toLowerCase().includes('invoice') ||
            a.name.toLowerCase().includes('quote') ||
            a.name.toLowerCase().includes('quotation')
          );
          if (docAttachments.length > 0) {
            const summaries = [];
            for (const att of docAttachments.slice(0, 2)) {
              const summary = await claude.analyseAttachment(att);
              if (summary) summaries.push('📎 ' + att.name + ': ' + summary);
            }
            if (summaries.length) email.attachmentSummary = summaries.join('\n');
          }
        } catch (err) {
          console.error('[digest] attachment error for', email.id, err.message);
        }
      }
    }

    store.saveSession(inbound);
    const summary = await claude.summariseEmails(inbound);
    await whatsapp.send('📬 Email digest — ' + now + '\n\n' + summary);
    console.log('[digest] Sent');
  } catch (err) {
    console.error('[digest] Error:', err.message);
    try { await whatsapp.send('😕 Digest hit a snag: ' + err.message + '\n\nTry "update" again in a moment!'); } catch {}
  }
}

module.exports = { runDigest };
