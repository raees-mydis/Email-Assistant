const Anthropic = require('@anthropic-ai/sdk');
const config    = require('./config');
const fs        = require('fs');
const path      = require('path');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const IGNORE_FILE = path.join('/tmp', 'ignored.json');

const PRIORITY_HIGH = {
  emails: ['al@iwsuk.com'],
  domains: ['cplfoods.co.uk','cmagriculture.co.uk','annyallachicks.com','2agriculture.co.uk'],
  names: ['jan marciniak','kamran ahmed','faz ahmed','jane chen','nadeem iqbal','colin taylor',
          'tom pearson','justyna','emma aldridge','lucy brookes',
          'leigh gallant','jonathan martin','nick lynn','liv robinson'],
};

const PRIORITY_MEDIUM = {
  names: ['ketan rana','florin alb','julia dan mcarthur','gemma polanski','omar amin'],
  patterns: ['hr1@','hr2@','hr3@'],
};

const TEAM = [
  { name: 'Hamid',   email: 'hamid@mydis.com' },
  { name: 'Falak',   email: 'falak@mydis.com' },
  { name: 'Lilian',  email: 'lilian@mydis.com' },
  { name: 'Craig',   email: 'craig@mydis.com' },
  { name: 'Adegoke', email: 'adegoke@mydis.com', alias: 'ade' },
  { name: 'Basat',   email: 'basat@mydis.com',   alias: 'bas' },
  { name: 'Shams',   email: 'shams@mydis.com' },
];

function loadIgnored() { try { return JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')); } catch { return []; } }
function saveIgnored(list) { fs.writeFileSync(IGNORE_FILE, JSON.stringify(list), 'utf8'); }
function addIgnored(entry) { const list = loadIgnored(); const e = entry.toLowerCase().trim(); if (!list.includes(e)) { list.push(e); saveIgnored(list); } return list; }
function isIgnored(email) {
  const list = loadIgnored();
  const addr = (email.from || '').toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  return list.some(e => addr.includes(e) || (domain && domain.includes(e)));
}

function getPriorityLevel(email) {
  const addr = (email.from || '').toLowerCase();
  const name = (email.fromName || '').toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  if (PRIORITY_HIGH.emails.some(e => addr === e)) return 'high';
  if (PRIORITY_HIGH.domains.some(d => domain.includes(d))) return 'high';
  if (PRIORITY_HIGH.names.some(n => name.includes(n) || addr.includes(n.replace(' ','')))) return 'high';
  if (PRIORITY_MEDIUM.names.some(n => name.includes(n) || addr.includes(n.replace(' ','')))) return 'medium';
  if (PRIORITY_MEDIUM.patterns.some(p => addr.includes(p))) return 'medium';
  return 'normal';
}

function isSecuritySuspect(email) {
  const subject = (email.subject || '').toLowerCase();
  const preview = (email.preview || '').toLowerCase();
  const suspiciousTerms = ['verify your account','password reset','click here to confirm','unusual sign-in','suspicious activity','your account has been','credentials','banking details','wire transfer','urgent payment'];
  return suspiciousTerms.some(t => subject.includes(t) || preview.includes(t));
}

async function ask(system, content, maxTokens) {
  const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: parseInt(maxTokens || 800, 10), system, messages: [{ role: 'user', content }] });
  return msg.content[0].text.trim();
}

const MASTER_SYSTEM = `You are Aria, Raees's Executive PA via WhatsApp. Raees is a high-functioning director.

PERSONALITY: Friendly, warm, efficient. Use emojis naturally but sparingly. Conversational tone. Short sentences. Never blocky walls of text.

FORMATTING: Plain text only. Never use markdown — no #, ##, ###, no **bold**, no *italic*, no bullet dashes. Use emojis instead of markdown for structure. WhatsApp does not render markdown from the API.

ANDROID AUTO OPTIMISED: Responses must work as voice. Keep summaries scannable. Group info logically. Default to short summaries — always offer more detail after.

RAEES'S COMPANY: MYDIS (mydis.com)
TEAM: Hamid, Falak, Lilian, Craig, Adegoke (Ade), Basat (Bas), Shams — all @mydis.com

PRIORITY HIGH (always surface, top of digest):
- Al (al@iwsuk.com)
- Jan Marciniak, Kamran Ahmed, Faz Ahmed, Jane Chen, Nadeem Iqbal, Colin Taylor
- Any email from: cplfoods.co.uk, cmagriculture.co.uk, annyallachicks.com, 2agriculture.co.uk
- CMA Agriculture contacts: Tom Pearson, Justyna, Emma Aldridge, Lucy Brookes
- Annyalla Chicks contacts: Leigh Gallant, Jonathan Martin, Nick Lynn, Liv Robinson

PRIORITY MEDIUM:
- Ketan Rana, Florin Alb, Julia Dan McArthur, Gemma Polanski, Omar Amin
- Any HR email addresses (hr1@, hr2@, hr3@)

FILTER OUT SILENTLY (never mention):
- Recruitment, job applications, headhunters
- Sales/marketing emails, newsletters, promotions
- Automated notifications, FYI receipts
- Cold outreach from unknown companies
- Emails where Raees is CC'd only with no action needed

THREAD AWARENESS: If a MYDIS team member has replied in a thread, say who is handling it and whether Raees needs to step in.

SECURITY: Flag any email that looks like phishing, credential harvesting, or suspicious payment requests with 🚨

DECISION SUPPORT: End each email item with a recommended action (Reply / Delegate / Task / Ignore / Chase).

DRIVING MODE DEFAULT: Always give short summary first. End with "Want me to action any of these?" If user asks for more detail, expand only that item.`;

async function summariseEmails(emails, stakeholders, accountLabel, vips, rules) {
  // For IWS account — all contacts are work colleagues, treat differently to MYDIS
  const isIws = accountLabel === 'IWS';
  if (!emails.length) return 'All clear — nothing needs your attention right now! 🎉';

  const prioritised = emails
    .filter(e => !isIgnored(e))
    .sort((a, b) => {
      const pa = getPriorityLevel(a) === 'high' ? 0 : getPriorityLevel(a) === 'medium' ? 1 : 2;
      const pb = getPriorityLevel(b) === 'high' ? 0 : getPriorityLevel(b) === 'medium' ? 1 : 2;
      return pa - pb;
    });

  console.log('[summarise] ' + accountLabel + ': ' + emails.length + ' total, ' + prioritised.length + ' after filter');
  if (!prioritised.length) return 'All clear — nothing needs your attention right now! 🎉';

  const block = prioritised.map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const priority = getPriorityLevel(e);
    const priorityTag = priority === 'high' ? ' [HIGH PRIORITY]' : priority === 'medium' ? ' [MEDIUM PRIORITY]' : '';
    const attachTag = e.hasAttachments ? ' [HAS ATTACHMENT]' : '';
    const teamTag = e.teamReply ? ' [TEAM HANDLING: ' + e.teamReply.name + ']' : '';
    const securityTag = isSecuritySuspect(e) ? ' [SECURITY FLAG]' : '';
    const readTag = e.isRead ? ' [READ]' : ' [UNREAD]';
    const attachNote = e.attachmentSummary ? '\nATTACHMENT SUMMARY: ' + e.attachmentSummary : '';
    return '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + ' <' + e.from + '>' + priorityTag + attachTag + teamTag + securityTag + readTag +
           '\nSUBJECT: ' + e.subject +
           '\nRECEIVED: ' + date +
           '\nPREVIEW: ' + e.preview + attachNote;
  }).join('\n\n---\n\n');

  const stakeholderContext = stakeholders && Object.keys(stakeholders).length
    ? '\n\nSTAKEHOLDER ASSIGNMENTS:\n' + Object.entries(stakeholders).map(([k,v]) => k + ' -> ' + v).join('\n')
    : '';

  const iwsContext = isIws ? '\n\nIMPORTANT: This is the IWS account (raees@iwsuk.com). ALL emails from real people are work colleagues or business contacts and MUST be shown to Raees. Only filter automated system emails, newsletters, and cold sales outreach.' : '';

  const formatPrompt = `Process these emails for Raees${accountLabel ? ' (' + accountLabel + ' inbox)' : ''}.

RULES:
- Show HIGH PRIORITY emails first, always
- Show MEDIUM PRIORITY next
- Surface only emails requiring Raees's personal action for normal priority
- Silently filter irrelevant emails — NEVER mention them, NEVER say how many were filtered, NEVER explain what was excluded
- For TEAM HANDLING emails: note who is on it and if Raees needs to step in
- For SECURITY FLAG emails: show with 🚨 warning
- For UNREAD emails: prioritise over READ ones

Format each email like this (keep it tight):
[N] 👤 Name | Subject
📅 date and time
➡️ What needs doing — one sentence
📎 Attachment: key details if present
🔴 URGENT / 🟡 SOON / 🟢 LOW
💡 Reply / Delegate / Task / Ignore

End with: "Anything you'd like to action? 👆"

If nothing action-worthy after filtering: "All clear — nothing needs your attention! 🎉"
STRICT RULE: Never say "I filtered out X emails" or "X emails were spam" or any variation. Never acknowledge filtered emails exist.

EMAILS:
` + prioritised.map((e,i) => '[' + (i+1) + '] ' + (e.fromName || e.from) + ' | ' + e.subject).join('\n') + '\n\nFULL DETAILS:\n\n' + block;

  return ask(MASTER_SYSTEM + stakeholderContext + iwsContext, formatPrompt, 1500);
}

async function summariseWithContext(emails, minutes, actions, stakeholders) {
  if (!emails.length) return 'Nothing in that window 📭';
  const filtered = emails.filter(e => !isIgnored(e));
  if (!filtered.length) return 'Nothing relevant in that window 📭';

  const block = filtered.map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const action = actions[e.id];
    const actionNote = action ? ' [' + action.status.toUpperCase() + (action.note ? ': ' + action.note : '') + ']' : '';
    const readStatus = e.isRead ? '[READ]' : '[UNREAD]';
    return '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + actionNote + ' ' + readStatus +
           '\nSUBJECT: ' + e.subject + '\nRECEIVED: ' + date + '\nPREVIEW: ' + e.preview;
  }).join('\n\n---\n\n');

  return ask(
    MASTER_SYSTEM,
    'Period update for Raees. Include everything — actioned, awaiting reply, FYI, still needing action. Unread first.\n\nFormat:\n[N] 👤 Name | Subject\n📅 date\nStatus: ✅ Done / ⏳ Awaiting reply / ℹ️ FYI / ➡️ Needs action\n🔴 URGENT / 🟡 SOON / 🟢 LOW\n\nEnd with: "Anything you\'d like to action? 👆"\n\nEmails:\n\n' + block,
    1200
  );
}

async function generateMorningBrief(emails, tasks, stakeholders) {
  const emailBlock = emails.filter(e => !isIgnored(e)).slice(0, 15).map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
    return '[' + (i+1) + '] ' + (e.fromName || e.from) + ' | ' + e.subject + ' (' + date + ') ' + (e.isRead ? '' : '[UNREAD]');
  }).join('\n');

  const taskBlock = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content + (t.due ? ' — due ' + t.due.string : '')).join('\n') || 'No tasks due today';

  return ask(
    MASTER_SYSTEM,
    `Generate Raees's morning brief. Be warm and energising. Format:\n\n1. Good morning greeting with date\n2. 📬 Key emails needing action (max 5, priority first)\n3. ✅ Tasks due today\n4. ⚠️ Anything overdue or urgent\n5. Brief closing — offer to action anything\n\nKeep it short enough to listen to in the car.\n\nEMAILS:\n${emailBlock}\n\nTODIST TASKS:\n${taskBlock}`,
    1200
  );
}

async function analyseAttachment(attachment, question) {
  const isPdf = attachment.contentType.includes('pdf');
  const isDoc = attachment.contentType.includes('word') || attachment.contentType.includes('document');
  if (!attachment.contentBytes || (!isPdf && !isDoc)) return null;

  try {
    const q = question || 'Summarise this document: what is it for, who is it from, any totals or amounts, due dates, and a one sentence overview.';
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: attachment.contentBytes } },
          { type: 'text', text: q + '\n\nBe concise. Plain text only.' }
        ]
      }]
    });
    return msg.content[0].text.trim();
  } catch (err) {
    console.error('[claude] attachment error:', err.message);
    return null;
  }
}

async function reviewReply(email, dictated, useExact) {
  if (useExact) return dictated;
  return ask('Improve this dictated reply into a professional email. Keep same intent and tone. Plain text only. Return only the email body.', 'Original from ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview + '\n\nDictated:\n' + dictated, 500);
}

async function extractTask(email) {
  const raw = await ask('Extract a Todoist task. Return only valid JSON: title (max 80 chars), description (max 200 chars), due_string.', 'From ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview, 300);
  try { return JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return { title: email.subject, description: email.preview, due_string: 'in 3 days' }; }
}

async function draftDelegation(email, name) {
  return ask('Write a short delegation email in first person as Raees. Direct and professional. Return only the email body.', 'Delegate to ' + name + '.\nFrom: ' + (email.fromName || email.from) + '\nSubject: ' + email.subject + '\n' + email.preview, 400);
}

async function parseIntent(text, session, conversation) {
  const emailList = session ? session.emails.map((e, i) =>
    '[' + (i+1) + '] idx=' + i + ' | name="' + (e.fromName || '') + '" | email="' + e.from + '" | subject="' + e.subject + '"'
  ).join('\n') : 'No emails loaded.';

  const recentConvo = conversation.slice(-4).map(c => c.role + ': ' + c.text).join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 300,
    system: `Parse a WhatsApp command for an email assistant. Return ONLY valid JSON.

Current emails in session:
${emailList}

Recent conversation:
${recentConvo}

CRITICAL name matching rules:
- Match on first name only — if Raees says "Joanne", only match emails where sender name contains "Joanne" or "Jo" as a standalone word
- Do NOT match based on subject, company, or any other field
- Do NOT suggest alternative emails — if no sender name match, set emailIndex to null
- Never match "Joanne" to "Hamid" or any other unrelated name
- Raees knows exactly who he means

Intents: update | morning_brief | period_update | calendar_today | calendar_tomorrow | reply | send | edit | task | delegate | ignore | unsubscribe | what_sent | mark_read | repeat_item | more_detail | attachment_query | stakeholder_assign | help | unknown

calendar_today: asking about today's schedule/diary/calendar/appointments/meetings
calendar_tomorrow: asking about tomorrow's schedule/diary/agenda/meetings/what's on

Return JSON:
{ "intent": "...", "emailIndex": null or 0-based int, "personName": null or string, "delegateTo": null or string, "content": null or string, "minutes": null or int, "useExact": false, "itemReference": null or string, "taskIndex": null or 0-based int, "sectionHint": null or string }

useExact: true if user says "use my words" / "send as is" / "use mine"
itemReference: what they're referring to for repeat/detail/attachment queries (e.g. "the CPL one", "invoice")`,
    messages: [{ role: 'user', content: text }]
  });

  try { const m = msg.content[0].text.trim().match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : { intent: 'unknown' }; }
  catch { return { intent: 'unknown' }; }
}


async function parseMultiIntent(text, session, conversation) {
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const emailList = session ? session.emails.map((e, i) =>
    '[' + (i+1) + '] idx=' + i + ' | name="' + (e.fromName || '') + '" | email="' + e.from + '" | subject="' + e.subject + '"'
  ).join('\n') : 'No emails loaded.';

  const recentConvo = (conversation || []).slice(-4).map(c => c.role + ': ' + c.text).join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 400,
    system: 'Parse WhatsApp commands for an email assistant. The user may give MULTIPLE instructions. Return ONLY a valid JSON array of intent objects.\n\nCurrent emails:\n' + emailList + '\n\nRecent conversation:\n' + recentConvo + '\n\nCRITICAL: Only match emails where the name is clearly in sender details. Never guess.\n\nIntents: update | morning_brief | period_update | calendar_today | calendar_tomorrow | reply | send | edit | task | delegate | ignore | unsubscribe | what_sent | mark_read | repeat_item | more_detail | attachment_query | stakeholder_assign | tasks_today | postpone_task | postpone_all_tasks | day_summary_today | day_summary_tomorrow | calendar_add | add_vip | remember_rule | contact_pref | help | unknown\n\ncalendar_today: asking about today schedule/diary/calendar\ncalendar_tomorrow: asking about tomorrow schedule/diary/agenda/meetings\nperiod_update: last X hours/mins\ntask: adding an email as a Todoist task — e.g. \'task 1\', \'add task 2\', \'create task for email 3\'\ntasks_today: show outstanding tasks due today\nday_summary_today: asking what day looks like today, full day overview\nday_summary_tomorrow: asking what tomorrow looks like, full day overview\npostpone_task: postpone a specific task — add taskIndex (0-based int) and content=new date\npostpone_all_tasks: postpone all tasks — content=new date\n\nEach object: { "intent": "...", "emailIndex": null or 0-based int, "personName": null or string, "delegateTo": null or string, "content": null or string, "minutes": null or int, "useExact": false, "itemReference": null or string, "taskIndex": null or 0-based int, "sectionHint": null or string }\n\nReturn array even for one intent.',
    messages: [{ role: 'user', content: text }]
  });

  try {
    const raw = msg.content[0].text.trim();
    const m = raw.match(/\[[\s\S]*\]/);
    let parsed = null;
    if (m) {
      parsed = JSON.parse(m[0]);
      if (!Array.isArray(parsed)) parsed = [parsed];
    } else {
      const obj = raw.match(/\{[\s\S]*\}/);
      parsed = obj ? [JSON.parse(obj[0])] : [{ intent: 'unknown' }];
    }

    // Safety net: fix common misparses
    const anyPersonName = parsed.some(p => p.personName);

    // Merge multiple compose_email intents into one (e.g. one per person)
    const multiCompose = parsed.filter(p => p.intent === 'compose_email');
    if (multiCompose.length > 1) {
      const allNames = [...new Set(multiCompose.map(p => p.personName).filter(Boolean))].join(', ');
      const combinedContent = multiCompose.map(p => p.content).filter(Boolean)[0] || text;
      const nonCompose = parsed.filter(p => p.intent !== 'compose_email');
      return [{ intent: 'compose_email', personName: allNames, content: combinedContent, emailIndex: null }, ...nonCompose];
    }

    // If ALL intents are "send" or "reply" but have personNames and no emailIndex → compose_email
    const allSendOrReply = parsed.every(p => p.intent === 'send' || (p.intent === 'reply' && !p.emailIndex && p.emailIndex !== 0));
    if (allSendOrReply && anyPersonName) {
      const names = [...new Set(parsed.map(p => p.personName).filter(Boolean))].join(', ');
      const content = parsed.map(p => p.content).filter(Boolean)[0] || text;
      return [{ intent: 'compose_email', personName: names, content: content, emailIndex: null }];
    }

    // Fix: any "send" with personName → compose_email
    // Fix: any "reply" with personName but no emailIndex → compose_email
    parsed = parsed.map(p => {
      if (p.intent === 'send' && p.personName) return { ...p, intent: 'compose_email' };
      if (p.intent === 'reply' && p.personName && (p.emailIndex === null || p.emailIndex === undefined)) return { ...p, intent: 'compose_email' };
      return p;
    });

    // Fix: "calendar_add" that mentions an existing meeting keyword → update_calendar_event
    const meetingWords = ['mastermind','standup','meeting','call','invite','existing','propose'];
    parsed = parsed.map(p => {
      if (p.intent === 'calendar_add') {
        const ref = ((p.itemReference || '') + ' ' + (p.content || '')).toLowerCase();
        if (meetingWords.some(w => ref.includes(w))) {
          return { ...p, intent: 'update_calendar_event', itemReference: p.content };
        }
      }
      return p;
    });

    // Merge multiple compose_email intents into one (e.g. one per person → combined)
    const composeIntents = parsed.filter(p => p.intent === 'compose_email');
    if (composeIntents.length > 1) {
      const allNames = [...new Set(composeIntents.map(p => p.personName).filter(Boolean))].join(', ');
      const combinedContent = composeIntents.map(p => p.content).filter(Boolean)[0] || text;
      const merged = { intent: 'compose_email', personName: allNames, content: combinedContent, emailIndex: null };
      parsed = [merged, ...parsed.filter(p => p.intent !== 'compose_email')];
    }

    return parsed;
  } catch { return [{ intent: 'unknown' }]; }
}


async function generateDaySummary(emails, calEvents, tasks, dayLabel, dateStr) {
  // Build email block — only actionable ones
  const actionableEmails = emails.filter(e => !isIgnored(e));

  const emailBlock = actionableEmails.length
    ? actionableEmails.slice(0, 10).map((e, i) => {
        const priority = getPriorityLevel(e);
        const tag = priority === 'high' ? ' [HIGH PRIORITY]' : priority === 'medium' ? ' [MEDIUM]' : '';
        const unread = e.isRead ? '' : ' [UNREAD]';
        const acct = e.account === 'iws' ? ' [IWS]' : '';
        return '[' + (i+1) + '] ' + (e.fromName || e.from) + acct + tag + unread + '\n    ' + e.subject + '\n    ' + e.preview.slice(0, 100);
      }).join('\n\n')
    : 'No emails needing attention';

  // Build calendar block
  const calBlock = calEvents.length
    ? calEvents.map(e => {
        const time = e.isAllDay ? 'All day' : (e.startTime
          ? new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
            + ' - ' + new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
          : '');
        const loc = e.location ? ' @ ' + e.location : '';
        const acct = e.account === 'iws' ? ' [IWS]' : '';
        return time + ' - ' + e.subject + loc + acct;
      }).join('\n')
    : 'Calendar is clear';

  // Build tasks block
  const taskBlock = tasks.length
    ? tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content).join('\n')
    : 'No tasks due';

  const prompt = `Create a concise day summary for Raees for ${dayLabel}.

EMAILS:
${emailBlock}

CALENDAR:
${calBlock}

TASKS:
${taskBlock}

Format it exactly like this — keep each section short and scannable:

📅 [${dayLabel}]

📬 Emails
[List only emails needing action — one line each: Name | Subject | what to do]
[If none: All clear!]

🗓️ Schedule
[List each event: time - what it is - prep note if needed]
[If none: Nothing in the diary]

✅ Tasks
[List tasks numbered]
[If none: All clear!]

💬 [One sentence summary of the day ahead — warm and direct]

Anything you'd like to action? 👆`;

  return ask(MASTER_SYSTEM, prompt, 1200);
}


async function parseCalendarEvent(text, conversation) {
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
  const recentConvo = (conversation || []).slice(-4).map(c => c.role + ': ' + c.text).join('\n');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 300,
    messages: [{ role: 'user', content: 'Current date/time in UK (Europe/London): ' + now + '\n\nRecent conversation:\n' + recentConvo + '\n\nExtract calendar event details from this request: "' + text + '"\n\nReturn ONLY valid JSON:\n{ "title": "event title", "start": "ISO8601 datetime", "end": "ISO8601 datetime", "location": null or string, "notes": null or string, "attendees": [], "account": "mydis", "calendarName": null or string }\n\nCRITICAL TIMEZONE RULES:\n- start and end must be LOCAL UK time (Europe/London / BST), NOT UTC\n- Format: 2026-04-17T19:30:00 (no Z suffix, no UTC offset)\n- Never convert to UTC — always output the time exactly as stated by the user\n- If no end time given, assume 1 hour after start\n- If no date given, assume today\n- account: use "iws" only if IWS is mentioned, otherwise "mydis"\n- calendarName: set to "personal" if user mentions personal calendar, home calendar, or Outlook personal. Otherwise null.' }]
  });

  try {
    const raw = msg.content[0].text.trim();
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}


async function isVipContact(email, name, vips) {
  const addr = (email || '').toLowerCase();
  const n = (name || '').toLowerCase();
  return Object.keys(vips || {}).some(k =>
    addr.includes(k) || n.includes(k) || (addr.split('@')[0] || '').includes(k)
  );
}

module.exports = {
  summariseEmails, summariseWithContext, generateMorningBrief,
  analyseAttachment, reviewReply, extractTask, draftDelegation,
  parseIntent, parseMultiIntent, generateDaySummary, parseCalendarEvent, isVipContact, addIgnored, isIgnored, getPriorityLevel, MASTER_SYSTEM,
  PRIORITY_HIGH, TEAM,
};
