const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const todoist  = require('./todoist');
const store    = require('./store');

function getCurrentHour() {
  return parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }), 10);
}

function getCurrentDay() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long' });
}

function isFriday() { return getCurrentDay() === 'Friday'; }
function isSunday() { return getCurrentDay() === 'Sunday'; }

// IWS domains/senders to always filter out
const IWS_FILTER_DOMAINS = [
  'creditsafe', 'payhawk', 'procontract', 'etendersni', 'delta-esourcing',
  'hse.gov.uk', 'hseni', 'find-tender', 'contracts finder', 'supplierregistration',
  'etenders', 'procurement', 'tendersni', 'sell2wales', 'publiccontractsscotland',
  'bigchange', 'jobwatch', 'raisinhr', 'breathehr', 'xero', 'sage',
];

const IWS_FILTER_SUBJECTS = [
  'purchase order', 'po approval', 'expense', 'vat reminder', 'direct debit',
  'statement of account', 'payment reminder', 'invoice due',
];

function filterIwsEmailExtended(email) {
  const from = (email.from || '').toLowerCase();
  const name = (email.fromName || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  return IWS_FILTER_DOMAINS.some(d => from.includes(d) || name.includes(d)) ||
    IWS_FILTER_SUBJECTS.some(s => subject.includes(s));
}

function filterIwsEmail(email) {
  const from = (email.from || '').toLowerCase();
  const name = (email.fromName || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  return IWS_FILTER_DOMAINS.some(d =>
    from.includes(d) || name.includes(d) || subject.includes(d)
  );
}

async function runDigest() {
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const hour = getCurrentHour();
  const day  = getCurrentDay();
  console.log('[digest] Running at', now, '(hour:', hour + ', day:', day + ')');

  try {
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();

    // Fetch both inboxes in parallel
    const [mydisEmails, iwsEmails] = await Promise.all([
      graph.getUnreadEmails(40),
      graph.getIwsUnreadEmails(40),
    ]);

    const mydisInbound = mydisEmails.filter(e => !e.from.toLowerCase().includes(userEmail));
    const iwsInbound   = iwsEmails
      .filter(e => !e.from.toLowerCase().includes('raees@iwsuk.com'))
      .filter(e => !filterIwsEmail(e)).filter(e => !filterIwsEmailExtended(e)); // filter noise before Claude sees it

    console.log('[digest] MYDIS:', mydisInbound.length, '| IWS:', iwsInbound.length);

    // Thread detection for MYDIS
    for (const email of mydisInbound) {
      if (email.conversationId) {
        try {
          const teamReply = await graph.getThreadTeamReplies(email.conversationId);
          if (teamReply) email.teamReply = teamReply;
        } catch {}
      }
    }

    // Attachment analysis
    for (const email of [...mydisInbound, ...iwsInbound]) {
      if (email.hasAttachments) {
        try {
          const attachments = await graph.getAttachments(email.id, email.account);
          const docAtts = attachments.filter(a =>
            a.contentBytes && (
              a.contentType.includes('pdf') || a.contentType.includes('word') ||
              (a.name || '').toLowerCase().match(/invoice|quote|proposal|contract/)
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

    // Save session
    store.saveSession([...mydisInbound, ...iwsInbound]);
    const stakeholders = store.getStakeholderAssignments();
    const vips = store.getVips();
    const rules = store.getRules();

    // Summarise inboxes
    const mydisSummary = await claude.summariseEmails(mydisInbound, stakeholders, 'MYDIS', vips, rules);
    const iwsSummary   = iwsInbound.length > 0
      ? await claude.summariseEmails(iwsInbound, stakeholders, 'IWS', vips, rules)
      : null;

    // Build message
    let message = '📬 ' + now + '\n\n';
    message += '🏢 MYDIS (raees@mydis.com)\n' + mydisSummary;
    if (iwsSummary) {
      message += '\n\n---\n\n🏭 IWS (raees@iwsuk.com)\n' + iwsSummary;
    }

    // ── 7am: today's calendar + today's tasks ──────────────────────────────
    if (hour === 7 || hour === 6) {
      try {
        const [events, tasks] = await Promise.all([
          graph.getCombinedCalendarEvents(0),
          todoist.getTodayTasks(),
        ]);

        if (events.length) {
          const lines = events.map(e => {
            const s = e.startTime ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
            const en = e.endTime ? new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
            const acct = e.account === 'iws' ? ' [IWS]' : (e.account === 'personal' ? ' [Personal]' : '');
            return '🕐 ' + s + (en ? ' - ' + en : '') + ' — ' + e.subject + acct;
          }).join('\n');
          message += '\n\n---\n\n📅 Today\n' + lines;
        } else {
          message += '\n\n📅 Today: Calendar is clear 🎉';
        }

        if (tasks.length) {
          const taskLines = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content).join('\n');
          message += '\n\n---\n\n📋 Tasks due today (' + tasks.length + ')\n' + taskLines;
        }
      } catch (err) { console.error('[digest] 7am error:', err.message); }

    // ── 5pm Friday: outstanding tasks + offer to move to Monday ────────────
    } else if ((hour === 17 || hour === 16) && isFriday()) {
      try {
        const [tomorrowEvents, mondayEvents, tasks] = await Promise.all([
          graph.getCombinedCalendarEvents(3), // Monday
          graph.getCombinedCalendarEvents(3),
          todoist.getTodayTasks(),
        ]);

        // Monday calendar
        const mondayLines = mondayEvents.length
          ? mondayEvents.map(e => {
              const s = e.startTime ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
              const en = e.endTime ? new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
              const acct = e.account === 'iws' ? ' [IWS]' : '';
              return '🕐 ' + s + (en ? ' - ' + en : '') + ' — ' + e.subject + acct;
            }).join('\n')
          : 'Nothing scheduled yet';

        message += '\n\n---\n\n📅 Monday\n' + mondayLines;

        if (tasks.length) {
          store.savePendingTasks(tasks);
          const taskLines = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content).join('\n');
          message += '\n\n---\n\n📋 Outstanding tasks (' + tasks.length + ')\n' + taskLines + '\n\nSay "move all to Monday" to reschedule these, or "postpone T2 to Monday" for specific ones.';
        } else {
          message += '\n\n📋 No outstanding tasks — clean slate for Monday! 🎉';
        }
      } catch (err) { console.error('[digest] friday error:', err.message); }

    // ── 5pm Sunday: weekly preview ─────────────────────────────────────────
    } else if ((hour === 17 || hour === 16) && isSunday()) {
      try {
        // Get the whole week ahead (Mon-Fri)
        const weekEvents = [];
        for (let i = 1; i <= 5; i++) {
          const events = await graph.getCombinedCalendarEvents(i);
          const dateStr = new Date(Date.now() + i * 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short' });
          if (events.length) {
            weekEvents.push(dateStr + ':');
            events.forEach(e => {
              const s = e.startTime ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
              weekEvents.push('  🕐 ' + s + ' — ' + e.subject);
            });
          }
        }

        if (weekEvents.length) {
          message += '\n\n---\n\n📅 Week ahead\n' + weekEvents.join('\n');
        } else {
          message += '\n\n📅 Week ahead: Nothing scheduled yet';
        }

        // Tasks due this week
        const tasks = await todoist.getTodayTasks();
        if (tasks.length) {
          store.savePendingTasks(tasks);
          const taskLines = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content + (t.dueBritish ? ' (' + t.dueBritish + ')' : '')).join('\n');
          message += '\n\n---\n\n📋 Tasks due this week (' + tasks.length + ')\n' + taskLines;
        }
      } catch (err) { console.error('[digest] sunday error:', err.message); }

    // ── Regular 5pm: tomorrow's calendar + outstanding tasks ───────────────
    } else if (hour === 17 || hour === 16) {
      try {
        const [events, tasks] = await Promise.all([
          graph.getCombinedCalendarEvents(1),
          todoist.getTodayTasks(),
        ]);

        const dayName = new Date(Date.now() + 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long' });
        if (events.length) {
          const lines = events.map(e => {
            const s = e.startTime ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
            const en = e.endTime ? new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
            const acct = e.account === 'iws' ? ' [IWS]' : '';
            return '🕐 ' + s + (en ? ' - ' + en : '') + ' — ' + e.subject + acct;
          }).join('\n');
          message += '\n\n---\n\n📅 Tomorrow — ' + dayName + '\n' + lines;
        } else {
          message += '\n\n📅 Tomorrow — ' + dayName + ': Clear 🎉';
        }

        if (tasks.length) {
          store.savePendingTasks(tasks);
          const taskLines = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content).join('\n');
          message += '\n\n---\n\n📋 Outstanding today (' + tasks.length + ')\n' + taskLines;
        }
      } catch (err) { console.error('[digest] 5pm error:', err.message); }
    }

    if (chaseAlerts.length) {
      message += '\n\n⏰ Still waiting on:\n' + chaseAlerts.map(c => '• ' + c).join('\n');
    }

    store.saveConversationTurn('penelope', message);
    await whatsapp.send(message);
    console.log('[digest] Sent');

  } catch (err) {
    console.error('[digest] Error:', err.message);
    try { await whatsapp.send('😕 Hit a snag: ' + err.message + '\nTry "update" again!'); } catch {}
  }
}

module.exports = { runDigest };
