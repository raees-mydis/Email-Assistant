const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const store    = require('./store');

function getCurrentHour() {
  return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }), 10);
}

async function runDigest() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const hour = getCurrentHour();
  console.log('[digest] Running at', now, '(hour:', hour + ')');

  try {
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();

    // Fetch both inboxes in parallel
    const [mydisEmails, iwsEmails] = await Promise.all([
      graph.getUnreadEmails(40),
      graph.getIwsUnreadEmails(40),
    ]);

    const mydisInbound = mydisEmails.filter(e => !e.from.toLowerCase().includes(userEmail));
    const iwsInbound   = iwsEmails.filter(e => !e.from.toLowerCase().includes('raees@iwsuk.com'));

    // Thread detection for MYDIS emails
    for (const email of mydisInbound) {
      if (email.conversationId) {
        try {
          const teamReply = await graph.getThreadTeamReplies(email.conversationId);
          if (teamReply) email.teamReply = teamReply;
        } catch {}
      }
    }

    // Attachment analysis for both
    for (const email of [...mydisInbound, ...iwsInbound]) {
      if (email.hasAttachments) {
        try {
          const attachments = await graph.getAttachments(email.id, email.account);
          const docAtts = attachments.filter(a =>
            a.contentBytes && (
              a.contentType.includes('pdf') || a.contentType.includes('word') ||
              (a.name || '').toLowerCase().match(/invoice|quote|quotation|proposal|contract/)
            )
          );
          if (docAtts.length) {
            const summary = await claude.analyseAttachment(docAtts[0]);
            if (summary) email.attachmentSummary = summary;
          }
        } catch (err) { console.error('[digest] attachment error:', err.message); }
      }
    }

    // Chase alerts
    const chases = store.getChaseItems();
    const chaseAlerts = [];
    for (const [id, item] of Object.entries(chases)) {
      const hoursSince = (Date.now() - new Date(item.savedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSince > 48) chaseAlerts.push(item.subject + ' (' + item.from + ')');
    }

    // Save combined session (MYDIS first, then IWS)
    const allEmails = [...mydisInbound, ...iwsInbound];
    store.saveSession(allEmails);
    const allInbound = allEmails; // alias for day summary use

    const stakeholders = store.getStakeholderAssignments();

    // Summarise each inbox separately
    const mydisSummary = await claude.summariseEmails(mydisInbound, stakeholders, 'MYDIS');
    const iwsSummary   = iwsInbound.length > 0
      ? await claude.summariseEmails(iwsInbound, stakeholders, 'IWS')
      : null;

    // Build message
    let message = '📬 *' + now + '*\n\n';
    message += '🏢 *MYDIS (raees@mydis.com)*\n' + mydisSummary;
    if (iwsSummary) {
      message += '\n\n---\n\n🏭 *IWS (raees@iwsuk.com)*\n' + iwsSummary;
    }

    // Calendar section
    if (hour === 7 || hour === 6) {
      try {
        const events = await graph.getCombinedCalendarEvents(0);
        if (events.length) {
          const lines = events.map(e => {
            const time = e.isAllDay ? 'All day' : (e.startTime ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ' - ' + new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '');
            const acct = e.account === 'iws' ? ' [IWS]' : '';
            return '🕐 ' + time + ' - ' + e.subject + acct;
          }).join('\n');
          message += '\n\n---\n\n📅 *Today*\n' + lines;
        } else {
          message += '\n\n📅 *Today:* Calendar is clear 🎉';
        }
      } catch (err) { console.error('[digest] calendar error:', err.message); }

    } else if (hour === 17 || hour === 16) {
      try {
        const events = await graph.getCombinedCalendarEvents(1);
        const dayName = new Date(Date.now() + 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long' });
        if (events.length) {
          const lines = events.map(e => {
            const time = e.isAllDay ? 'All day' : (e.startTime ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ' - ' + new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '');
            const acct = e.account === 'iws' ? ' [IWS]' : '';
            return '🕐 ' + time + ' - ' + e.subject + acct;
          }).join('\n');
          message += '\n\n---\n\n📅 *Tomorrow - ' + dayName + '*\n' + lines;
        } else {
          message += '\n\n📅 *Tomorrow:* Calendar is clear 🎉';
        }
      } catch (err) { console.error('[digest] calendar error:', err.message); }
    }

    if (chaseAlerts.length) {
      message += '\n\n⏰ *Still waiting on replies:*\n' + chaseAlerts.map(c => '• ' + c).join('\n');
    }

    store.saveConversationTurn('penelope', message);
    await whatsapp.send(message);
    console.log('[digest] Sent');

  } catch (err) {
    console.error('[digest] Error:', err.message);
    try { await whatsapp.send('😕 Hit a snag: ' + err.message + '\n\nTry "update" again!'); } catch {}
  }
}

module.exports = { runDigest };
