const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const store    = require('./store');

async function runDigest() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  console.log('[digest] Running at', now);
  try {
    const emails = await graph.getUnreadEmails(40);
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));

    // Check for team replies in threads
    for (const email of inbound) {
      if (email.conversationId) {
        try {
          const teamReply = await graph.getThreadTeamReplies(email.conversationId);
          if (teamReply) email.teamReply = teamReply;
        } catch {}
      }
    }

    // Analyse attachments for invoices/quotes
    for (const email of inbound) {
      if (email.hasAttachments) {
        try {
          const attachments = await graph.getAttachments(email.id);
          const docAtts = attachments.filter(a =>
            a.contentBytes && (
              a.contentType.includes('pdf') || a.contentType.includes('word') ||
              a.name.toLowerCase().match(/invoice|quote|quotation|proposal|contract/)
            )
          );
          if (docAtts.length) {
            const summary = await claude.analyseAttachment(docAtts[0]);
            if (summary) email.attachmentSummary = summary;
          }
        } catch (err) { console.error('[digest] attachment error:', err.message); }
      }
    }

    // Check for items to chase (sent > 48hrs ago with no reply)
    const chases = store.getChaseItems();
    const chaseAlerts = [];
    for (const [id, item] of Object.entries(chases)) {
      const hoursSince = (Date.now() - new Date(item.savedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSince > 48) chaseAlerts.push(item.subject + ' (' + item.from + ')');
    }

    store.saveSession(inbound);
    const stakeholders = store.getStakeholderAssignments();
    const summary = await claude.summariseEmails(inbound, stakeholders);

    let message = '📬 *' + now + '*\n\n' + summary;
    if (chaseAlerts.length) {
      message += '\n\n⏰ *Pending chases (48hrs+):*\n' + chaseAlerts.map(c => '• ' + c).join('\n');
    }

    store.saveConversationTurn('aria', message);
    await whatsapp.send(message);
    console.log('[digest] Sent');
  } catch (err) {
    console.error('[digest] Error:', err.message);
    try { await whatsapp.send('😕 Hit a snag with the digest: ' + err.message + '\n\nTry "update" again in a moment!'); } catch {}
  }
}

module.exports = { runDigest };
