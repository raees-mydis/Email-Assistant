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
    // ── Fetch emails ──────────────────────────────────────────────────────
    const emails = await graph.getUnreadEmails(40);
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));

    // Thread detection
    for (const email of inbound) {
      if (email.conversationId) {
        try {
          const teamReply = await graph.getThreadTeamReplies(email.conversationId);
          if (teamReply) email.teamReply = teamReply;
        } catch {}
      }
    }

    // Attachment analysis
    for (const email of inbound) {
      if (email.hasAttachments) {
        try {
          const attachments = await graph.getAttachments(email.id);
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

    store.saveSession(inbound);
    const stakeholders = store.getStakeholderAssignments();
    const emailSummary = await claude.summariseEmails(inbound, stakeholders);

    // ── Calendar ──────────────────────────────────────────────────────────
    let calendarSection = '';

    if (hour === 7 || hour === 6) {
      // 7am: show TODAY's calendar
      try {
        const todayEvents = await graph.getCalendarEvents(0);
        const calSummary = await claude.summariseCalendarDay(todayEvents, 'Today');
        calendarSection = '\n\n' + calSummary;
      } catch (err) { console.error('[digest] calendar error:', err.message); }

    } else if (hour === 17 || hour === 16) {
      // 5pm: show TOMORROW's calendar
      try {
        const tomorrowEvents = await graph.getCalendarEvents(1);
        const tomorrowDate = new Date();
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const dayName = tomorrowDate.toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long' });
        const calSummary = await claude.summariseCalendarDay(tomorrowEvents, 'Tomorrow — ' + dayName);
        calendarSection = '\n\n' + calSummary;
      } catch (err) { console.error('[digest] calendar error:', err.message); }
    }

    // ── Assemble message ──────────────────────────────────────────────────
    let message = '📬 *' + now + '*\n\n' + emailSummary + calendarSection;

    if (chaseAlerts.length) {
      message += '\n\n⏰ *Still waiting on replies:*\n' + chaseAlerts.map(c => '• ' + c).join('\n');
    }

    store.saveConversationTurn('aria', message);
    await whatsapp.send(message);
    console.log('[digest] Sent');

  } catch (err) {
    console.error('[digest] Error:', err.message);
    try { await whatsapp.send('😕 Hit a snag: ' + err.message + '\n\nTry "update" again in a moment!'); } catch {}
  }
}

module.exports = { runDigest };
