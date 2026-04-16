const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const todoist  = require('./todoist');
const store    = require('./store');

function cleanMd(t) {
  if (!t) return t;
  return t
    .replace(/### /g, '').replace(/## /g, '').replace(/# /g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function waSend(text) { return whatsapp.send(cleanMd(text)); }

const DELEGATES = {
  'hamid':   'hamid@mydis.com',
  'falak':   'falak@mydis.com',
  'lilian':  'lilian@mydis.com',
  'craig':   'craig@mydis.com',
  'adegoke': 'adegoke@mydis.com',
  'ade':     'adegoke@mydis.com',
  'basat':   'basat@mydis.com',
  'bas':     'basat@mydis.com',
  'shams':   'shams@mydis.com',
};

async function handleInbound(text) {
  console.log('[router] received:', text);
  store.saveConversationTurn('user', text);

  const draft = store.getPendingDraft();

  // Handle CC decision
  if (draft && draft.awaitingCcDecision) {
    const lower = text.toLowerCase().trim();
    const keepCc = lower.includes('keep') || lower.includes('all') || lower.includes('yes');
    const onlyTo = lower.includes('only') || lower.includes('just') || lower.includes('no');
    if (keepCc || onlyTo) {
      store.savePendingDraft({ ...draft, replyAll: keepCc, awaitingCcDecision: false, awaitingReply: true });
      const msg = keepCc
        ? 'Got it — replying to all 👥\n\nWhat would you like to say?'
        : 'Got it — replying to ' + draft.toName + ' only 👤\n\nWhat would you like to say?';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
    // They typed their reply directly without deciding — default to reply-all
    store.savePendingDraft({ ...draft, replyAll: true, awaitingCcDecision: false, awaitingReply: false });
    return handleReplyContent(text, { ...draft, replyAll: true });
  }

  if (draft && draft.awaitingConfirm && draft.type === 'calendar_event') {
    const lower = text.toLowerCase().trim();
    if (lower === 'yes' || lower === 'confirm' || lower === 'add it' || lower === 'go ahead') {
      store.clearPendingDraft();
      try {
        const result = await graph.createCalendarEvent(draft.eventData, draft.eventData.account);
        const msg = 'Done! ✅ "' + result.subject + '" added to your calendar.';
        store.saveConversationTurn('penelope', msg);
        return waSend(msg);
      } catch (err) {
        return waSend('Had trouble adding that 😕 - ' + err.message);
      }
    } else if (lower === 'cancel' || lower === 'no') {
      store.clearPendingDraft();
      return waSend('No problem, cancelled 👍');
    }
  }
  if (draft && draft.awaitingReply) {
    const lower = text.toLowerCase().trim();
    if (!['cancel','update','morning brief'].includes(lower)) {
      return handleReplyContent(text, draft);
    }
  }

  const session  = store.getSession();
  const convo    = store.getConversation();
  const intents  = await claude.parseMultiIntent(text, session, convo);
  console.log('[router] intents:', JSON.stringify(intents));

  for (const parsed of intents) {
    await processIntent(parsed);
  }
}

async function processIntent(parsed) {
  switch (parsed.intent) {
    case 'update':
      await waSend('Sure Raees, give me a sec... 📬');
  await new Promise(r => setTimeout(r, 800));
      store.saveConversationTurn('penelope', 'Fetching emails...');
      return require('./digest').runDigest();

    case 'morning_brief':
      return handleMorningBrief();

    case 'period_update':
      return handlePeriodUpdate(parsed.minutes || 60);

    case 'calendar_today':
      return handleCalendar(0);

    case 'calendar_tomorrow':
      return handleCalendar(1);

    case 'reply':
      return handleReply(parsed.emailIndex, parsed.content, parsed.personName, parsed.useExact);

    case 'send':
      return handleSend();

    case 'edit':
      return handleEdit(parsed.content || '');

    case 'task':
      return handleTask(parsed.emailIndex, parsed.personName, parsed.sectionHint);

    case 'delegate':
      return handleDelegate(parsed.emailIndex, parsed.delegateTo, parsed.personName);

    case 'ignore':
      return handleIgnore(parsed.emailIndex, parsed.personName);

    case 'unsubscribe':
      return handleUnsubscribe(parsed.emailIndex, parsed.personName);

    case 'what_sent':
      return handleWhatSent(parsed.personName || parsed.content);

    case 'mark_read':
      return handleMarkRead(parsed.emailIndex, parsed.personName);

    case 'repeat_item':
      return handleRepeat(parsed.itemReference);

    case 'more_detail':
      return handleMoreDetail(parsed.emailIndex, parsed.personName, parsed.itemReference);

    case 'attachment_query':
      return handleAttachmentQuery(parsed.emailIndex, parsed.personName, parsed.content, parsed.itemReference);

    case 'stakeholder_assign':
      return handleStakeholderAssign(parsed.content);

    case 'calendar_add':
      return handleCalendarAdd(parsed.content || '');

    case 'day_summary_today':
      return handleDaySummary(0);

    case 'day_summary_tomorrow':
      return handleDaySummary(1);

    case 'tasks_today':
      return handleTasksToday();

    case 'postpone_task':
      return handlePostponeTask(parsed.taskId, parsed.content);

    case 'postpone_all_tasks':
      return handlePostponeAllTasks(parsed.content);

    case 'help':
      const helpMsg = 'Here is what you can ask me 👇\n\n' +
        '"update" - get digest now\n' +
        '"morning brief" - full morning summary\n' +
        '"what have I got today/tomorrow" - calendar\n' +
        '"last hour / 30 mins" - period update\n' +
        '"reply to Jo" - I will ask what to say\n' +
        '"use my exact words" - sends as-is\n' +
        '"task 3" - add to Todoist (P2, Operations)\n' +
        '"delegate 2 to Craig"\n' +
        '"ignore emails from X"\n' +
        '"mark the rest as read"\n' +
        '"repeat the CPL one"\n' +
        '"more detail on the invoice"\n' +
        '"what did I send to Jo?"\n' +
        '"Craig handles site issues" - remember this';
      store.saveConversationTurn('penelope', helpMsg);
      return waSend(helpMsg);

    default:
      const reply = 'Hmm, not quite sure what you mean 🤔 Say "help" for the full list!';
      store.saveConversationTurn('penelope', reply);
      return waSend(reply);
  }
}

async function handleCalendar(offsetDays) {
  const label = offsetDays === 0 ? 'today' : 'tomorrow';
  try {
    const events = await graph.getCalendarEvents(offsetDays);
    if (!events || !events.length) {
      const msg = 'Your calendar is clear for ' + label + '! 🎉';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
    const dayName = offsetDays === 0 ? 'Today' :
      'Tomorrow - ' + new Date(Date.now() + 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long' });

    const lines = events.map(function(e) {
      let time = e.isAllDay ? 'All day' : '';
      if (!e.isAllDay && e.startTime) {
        const s = new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        const en = new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        time = s + ' - ' + en;
      }
      const loc = e.location ? ' @ ' + e.location : '';
      return '🕐 ' + time + ' - ' + e.subject + loc;
    }).join('\n\n');

    const msg = '📅 ' + dayName + ' (' + events.length + ' event' + (events.length !== 1 ? 's' : '') + ')\n\n' + lines;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    console.error('[calendar] error:', err.message);
    return waSend('Had trouble fetching your calendar 😕 - ' + err.message);
  }
}

async function handleMorningBrief() {
  await waSend('Good morning Raees! Give me a sec... ☀️');
  await new Promise(r => setTimeout(r, 800));
  try {
    const [emails, tasks] = await Promise.all([
      graph.getUnreadEmails(30),
      todoist.getTodayTasks(),
    ]);
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));
    const stakeholders = store.getStakeholderAssignments();
    const brief = await claude.generateMorningBrief(inbound, tasks, stakeholders);
    store.saveConversationTurn('penelope', brief);
    await waSend(brief);
  } catch (err) {
    const msg = 'Could not pull the brief right now 😕 - ' + err.message;
    store.saveConversationTurn('penelope', msg);
    await waSend(msg);
  }
}

async function handlePeriodUpdate(minutes) {
  const label = minutes >= 1440 ? 'today' : minutes >= 60 ? 'the last ' + Math.round(minutes/60) + ' hour' + (minutes > 60 ? 's' : '') : 'the last ' + minutes + ' mins';
  await waSend('Sure Raees, pulling that for you... 🔍');
  await new Promise(r => setTimeout(r, 800));
  try {
    const emails = await graph.getRecentEmails(minutes);
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));
    store.saveSession(inbound);
    const actions = store.getEmailActions();
    const stakeholders = store.getStakeholderAssignments();
    const summary = await claude.summariseWithContext(inbound, minutes, actions, stakeholders);
    store.saveConversationTurn('penelope', summary);
    await waSend(summary);
  } catch (err) {
    await waSend('Had a problem fetching that 😕 - ' + err.message);
  }
}

async function handleReply(emailIndex, content, personName, useExact) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded - say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) {
    if (personName) return waSend('I could not find an email from "' + personName + '" in the current digest 🔍\n\nTry "update" to refresh.');
    return waSend('Which email did you want to reply to? Give me a name or number 📬');
  }

  const cc = email.ccRecipients || [];
  const draftBase = {
    messageId: email.id,
    toAddress: email.from,
    toName: email.fromName || email.from,
    subject: email.subject,
    account: email.account || 'mydis',
    draft: '',
    awaitingReply: true,
    useExact: useExact || false,
    replyAll: cc.length > 0, // default to reply-all if there are CC recipients
    ccRecipients: cc,
  };

  // If there are CC recipients, ask first
  if (cc.length > 0 && !content) {
    const ccNames = cc.map(r => r.name || r.email).join(', ');
    store.savePendingDraft({ ...draftBase, awaitingReply: false, awaitingCcDecision: true });
    const msg = 'Replying to ' + (email.fromName || email.from) + ' re: ' + email.subject + '\n\n👥 CC: ' + ccNames + '\n\nKeep them in CC or reply to ' + (email.fromName || email.from.split('@')[0]) + ' only?\n\n"keep" — reply all\n"only" — reply to sender only\n\nThen tell me what to say.';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }

  store.savePendingDraft(draftBase);
  if (!content) {
    const msg = 'Sure! ✉️ Replying to ' + (email.fromName || email.from) + '\nRe: ' + email.subject + '\n\nWhat would you like to say?';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }
  return handleReplyContent(content, draftBase);
}

async function handleReplyContent(content, draftInfo) {
  const useExact = draftInfo.useExact || content.toLowerCase().includes('use my words') || content.toLowerCase().includes('use mine') || content.toLowerCase().includes('send as is');
  await waSend(useExact ? 'Using your exact words ✍️' : 'Polishing that up... ✍️');
  const session = store.getSession();
  const email = session ? session.emails.find(e => e.id === draftInfo.messageId) : null;
  const polished = email ? await claude.reviewReply(email, content, useExact) : content;
  store.savePendingDraft({ ...draftInfo, draft: polished, awaitingReply: false });
  const ccNote = draftInfo.replyAll && draftInfo.ccRecipients && draftInfo.ccRecipients.length
    ? '\n👥 CC: ' + draftInfo.ccRecipients.map(r => r.name || r.email).join(', ')
    : '';
  const msg = 'Here is your draft to ' + draftInfo.toName + ccNote + ':\n\n' + polished + '\n\n"send" to fire it off\n"edit [changes]" to tweak\n"only" to remove CC recipients';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleSend() {
  const draft = store.getPendingDraft();
  if (!draft) return waSend('Nothing waiting to be sent! Start with "reply to [name]" 📝');
  if (!draft.draft) return waSend('The draft is empty - say "edit [your reply]" first 📝');
  await graph.replyToEmail(draft.messageId, draft.draft, draft.account, draft.replyAll !== false);
  store.setEmailAction(draft.messageId, 'replied', 'to ' + draft.toName);
  store.removeChaseItem(draft.messageId);
  store.clearPendingDraft();
  const msg = 'Done! ✅ Reply sent to ' + draft.toName;
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();
  if (!draft) return waSend('No draft to edit - start with "reply to [name]" first 📝');
  store.savePendingDraft({ ...draft, draft: newText, awaitingReply: false });
  const msg = 'Updated! ✏️\n\n' + newText + '\n\n"send" when you are happy 👍';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleTask(emailIndex, personName, sectionHint) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded - say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return waSend('Could not find that email 🔍 Try the number from the digest.');
  try {
    const taskData = await claude.extractTask(email);
    taskData.section = sectionHint || 'operations';
    const task = await todoist.createTask(taskData);
    store.setEmailAction(email.id, 'tasked', task.content);
    const sectionName = sectionHint ? sectionHint.charAt(0).toUpperCase() + sectionHint.slice(1) : 'Operations';
    const msg = 'Done! ✅ Added to ' + sectionName + ' (P2):\n"' + task.content + '"\nDue: ' + (task.due ? task.due.string : taskData.due_string);
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    console.error('[task] todoist error:', err.response ? JSON.stringify(err.response.data) : err.message);
    return waSend('Hmm, had trouble adding that to Todoist 😕\n' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
}

async function handleDelegate(emailIndex, delegateTo, personName) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded - say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return waSend('Could not find that email 🔍');
  if (!delegateTo) return waSend('Who should I delegate this to? 👤');
  const delegateEmail = DELEGATES[delegateTo.toLowerCase()];
  if (!delegateEmail) return waSend('I do not have ' + delegateTo + '\'s email - let me know their address and I will add it! 👤');
  const brief = await claude.draftDelegation(email, delegateTo);
  await graph.sendEmail({ to: delegateEmail, subject: 'For your action: ' + email.subject, body: brief });
  store.setEmailAction(email.id, 'delegated', 'to ' + delegateTo);
  const msg = 'Done! ✅ Brief sent to ' + delegateTo + ' (' + delegateEmail + ')';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleIgnore(emailIndex, personName) {
  const session = store.getSession();
  let domainToIgnore = null, nameToIgnore = personName;
  if (session && (emailIndex !== null || personName)) {
    const email = findEmail(session, emailIndex, personName);
    if (email) { domainToIgnore = email.from.includes('@') ? email.from.split('@')[1] : email.from; nameToIgnore = email.fromName || email.from; }
  }
  if (!domainToIgnore && personName) domainToIgnore = personName.toLowerCase().includes('@') ? personName.split('@')[1] : personName;
  if (!domainToIgnore) return waSend('Who should I ignore? Say "ignore emails from [name]" 👍');
  claude.addIgnored(domainToIgnore);
  const msg = 'Got it! 🙅 Filtering out ' + (nameToIgnore || domainToIgnore) + ' from now on.';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleUnsubscribe(emailIndex, personName) {
  const session = store.getSession();
  if (session && (emailIndex !== null || personName)) {
    const email = findEmail(session, emailIndex, personName);
    if (email) {
      const domain = email.from.includes('@') ? email.from.split('@')[1] : email.from;
      claude.addIgnored(domain);
      const msg = 'Done! 🙅 I will stop showing emails from ' + (email.fromName || domain) + '.';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
  }
  return waSend('Which sender? Give me the email number or their name 👍');
}

async function handleWhatSent(personOrTopic) {
  if (!personOrTopic) return waSend('Who did you send something to? 🔍');
  try {
    const emails = await graph.getSentEmails(personOrTopic);
    if (!emails.length) return waSend('No recent emails to ' + personOrTopic + ' found 🔍');
    const list = emails.slice(0, 3).map((e, i) =>
      (i+1) + '. To: ' + e.to + '\nSubject: ' + e.subject + '\n' +
      new Date(e.sentAt).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
      '\n' + e.preview
    ).join('\n\n');
    const msg = 'Here is what you sent 📤\n\n' + list;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) { return waSend('Had trouble looking that up 😕 - ' + err.message); }
}

async function handleMarkRead(emailIndex, personName) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded 📬');
  if (emailIndex !== null || personName) {
    const email = findEmail(session, emailIndex, personName);
    if (email) {
      await graph.markAsRead(email.id);
      store.setEmailAction(email.id, 'read', 'marked as read');
      return waSend('Done! ✅ Marked as read.');
    }
  }
  const actions = store.getEmailActions();
  const toMark = session.emails.filter(e => !actions[e.id]).map(e => e.id);
  if (!toMark.length) return waSend('Nothing left to mark as read 👍');
  await waSend('Marking ' + toMark.length + ' emails as read... 📖');
  const count = await graph.markMultipleAsRead(toMark);
  toMark.forEach(id => store.setEmailAction(id, 'read', 'marked as read'));
  const msg = 'Done! ✅ Marked ' + count + ' emails as read.';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleRepeat(itemReference) {
  const session = store.getSession();
  if (!session) return waSend('Nothing to repeat - say "update" to get a fresh digest 📬');
  if (itemReference && session) {
    const email = findEmailByKeyword(session, itemReference);
    if (email) {
      const date = new Date(email.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const msg = 'Here is that one again:\n\n' + (email.fromName || email.from) + '\n' + email.subject + '\n' + date + '\n\n' + email.preview;
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
  }
  return waSend('Which one do you want me to repeat? Give me a name or keyword 🔍');
}

async function handleMoreDetail(emailIndex, personName, itemReference) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded - say "update" first 📬');
  const email = emailIndex !== null || personName
    ? findEmail(session, emailIndex, personName)
    : itemReference ? findEmailByKeyword(session, itemReference) : null;
  if (!email) return waSend('Which email do you want more detail on? 🔍');
  try {
    const date = new Date(email.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    let detail = email.subject + '\nFrom: ' + (email.fromName || email.from) + ' <' + email.from + '>\n' + date + '\n\n' + email.preview;
    if (email.hasAttachments) {
      const attachments = await graph.getAttachments(email.id);
      for (const att of attachments.slice(0, 2)) {
        const summary = await claude.analyseAttachment(att);
        if (summary) detail += '\n\nAttachment - ' + att.name + ':\n' + summary;
      }
    }
    store.saveConversationTurn('penelope', detail);
    return waSend(detail);
  } catch (err) { return waSend('Had trouble getting that 😕 - ' + err.message); }
}

async function handleAttachmentQuery(emailIndex, personName, question, itemReference) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded - say "update" first 📬');
  const email = findEmail(session, emailIndex, personName) || (itemReference ? findEmailByKeyword(session, itemReference) : null);
  if (!email) return waSend('Which email\'s attachment are you asking about? 🔍');
  if (!email.hasAttachments) return waSend('That email does not have any attachments 📎');
  try {
    const attachments = await graph.getAttachments(email.id);
    const docAtts = attachments.filter(a => a.contentBytes && (a.contentType.includes('pdf') || a.contentType.includes('word') || a.contentType.includes('document')));
    if (!docAtts.length) return waSend('I could not read that attachment type 😕 - I can only read PDFs and Word docs.');
    const result = await claude.analyseAttachment(docAtts[0], question);
    const msg = result || 'Could not extract that info from the attachment 😕';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) { return waSend('Had trouble reading that 😕 - ' + err.message); }
}

async function handleStakeholderAssign(content) {
  if (!content) return waSend('What should I remember? E.g. "Craig handles site issues" 👍');
  const match = content.match(/^(\w+)\s+handles?\s+(.+)$/i);
  if (match) {
    store.saveStakeholderAssignment(match[2], match[1]);
    const msg = 'Got it! 🧠 I will remember that ' + match[1] + ' handles ' + match[2] + '.';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }
  return waSend('Got it, noted 🧠');
}

function findEmail(session, emailIndex, personName) {
  if (!session || !session.emails) return null;
  if (emailIndex !== null && emailIndex !== undefined && !isNaN(emailIndex)) return session.emails[emailIndex] || null;
  if (personName) {
    const parts = personName.toLowerCase().trim().split(/\s+/);
    return session.emails.find(e => {
      const senderName = (e.fromName || '').toLowerCase();
      const senderEmail = e.from.toLowerCase();
      return parts.every(p => senderName.includes(p) || senderEmail.includes(p));
    }) || null;
  }
  return null;
}

function findEmailByKeyword(session, keyword) {
  if (!session || !session.emails || !keyword) return null;
  const kw = keyword.toLowerCase();
  return session.emails.find(e =>
    (e.fromName || '').toLowerCase().includes(kw) ||
    e.from.toLowerCase().includes(kw) ||
    e.subject.toLowerCase().includes(kw) ||
    e.preview.toLowerCase().includes(kw)
  ) || null;
}


async function handleTasksToday() {
  try {
    const tasks = await todoist.getTodayTasks();
    if (!tasks.length) {
      return waSend('No outstanding tasks due today! 🎉');
    }
    store.savePendingTasks(tasks);
    const lines = tasks.map((t, i) =>
      '[T' + (i+1) + '] ' + t.content + (t.due ? ' - due ' + t.due.date : '')
    ).join('\n');
    const msg = '📋 Outstanding tasks (' + tasks.length + '):\n\n' + lines + '\n\nSay "postpone task T2 to Friday", "postpone all to tomorrow", or "postpone all to [date]"';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    return waSend('Had trouble fetching tasks 😕 - ' + err.message);
  }
}

async function handlePostponeTask(taskIndex, dueString, itemReference) {
  // Always fetch fresh tasks — never rely solely on cache
  let tasks = store.getPendingTasks();
  if (!tasks || !tasks.length) {
    tasks = await todoist.getTodayTasks();
    if (tasks.length) store.savePendingTasks(tasks);
  }
  if (!tasks || !tasks.length) {
    return waSend('You have no outstanding tasks due today 🎉');
  }

  let task = null;

  // Try index match first
  if (taskIndex !== null && taskIndex !== undefined && !isNaN(taskIndex)) {
    task = tasks[taskIndex] || null;
  }

  // Try keyword match if no index or index failed
  if (!task && itemReference) {
    const kw = itemReference.toLowerCase();
    task = tasks.find(t => t.content.toLowerCase().includes(kw)) || null;
  }

  // If still no match, ask Claude to figure out which task from context
  if (!task && itemReference) {
    const Anthropic = require('@anthropic-ai/sdk');
    const config = require('./config');
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const taskList = tasks.map((t, i) => '[' + i + '] ' + t.content).join('\n');
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 50,
      messages: [{ role: 'user', content: 'Tasks:\n' + taskList + '\n\nUser said: "' + itemReference + '"\nReturn ONLY the 0-based index of the matching task, or -1 if no match.' }]
    });
    const idx = parseInt(msg.content[0].text.trim(), 10);
    if (idx >= 0 && tasks[idx]) task = tasks[idx];
  }

  if (!task) {
    const list = tasks.slice(0, 5).map((t, i) => '[T' + (i+1) + '] ' + t.content).join('\n');
    return waSend('Not sure which task you mean 🔍 Here are your outstanding ones:\n\n' + list + '\n\nSay "postpone T2 to Friday" or "postpone the [keyword] task to [date]"');
  }

  const newDate = dueString || 'tomorrow';
  await todoist.updateTaskDue(task.id, newDate);
  const msg = 'Done! ✅ "' + task.content + '" moved to ' + newDate;
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handlePostponeAllTasks(dueString) {
  await waSend('Sure Raees, give me a sec... 📋');
  await new Promise(r => setTimeout(r, 800));
  const tasks = await todoist.getTodayTasks();
  if (!tasks.length) return waSend('No outstanding tasks to postpone 🎉');
  const newDate = dueString || 'tomorrow';
  await waSend('Sure Raees, postponing ' + tasks.length + ' task' + (tasks.length > 1 ? 's' : '') + ' to ' + newDate + '...');
  const results = await todoist.postponeAllTasks(tasks, newDate);
  const msg = 'Done! ✅ ' + results.length + ' task' + (results.length > 1 ? 's' : '') + ' moved to ' + newDate + ':\n\n' +
    results.map(r => '• ' + r.content).join('\n');
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleDaySummary(offsetDays) {
  const label = offsetDays === 0 ? 'Today' :
    'Tomorrow - ' + new Date(Date.now() + 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' });

  await waSend('Sure Raees, pulling together your ' + (offsetDays === 0 ? 'day' : 'tomorrow') + '... ⏳');
  await new Promise(r => setTimeout(r, 800));

  try {
    const dateStr = new Date(Date.now() + offsetDays * 86400000).toISOString().split('T')[0];

    const [emails, calEvents, tasks] = await Promise.all([
      graph.getUnreadEmails(30),
      graph.getCombinedCalendarEvents(offsetDays),
      offsetDays === 0 ? todoist.getTodayTasks() : todoist.getTasksForDate(dateStr),
    ]);

    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));

    const summary = await claude.generateDaySummary(inbound, calEvents, tasks, label, dateStr);
    store.saveConversationTurn('penelope', summary);
    return waSend(summary);
  } catch (err) {
    console.error('[daySummary] error:', err.message);
    return waSend('Had trouble pulling that together 😕 - ' + err.message);
  }
}

async function handleCalendarAdd(text) {
  try {
    const conversation = store.getConversation();
    const eventData = await claude.parseCalendarEvent(text, conversation);

    if (!eventData || !eventData.title || !eventData.start) {
      return waSend('I need a bit more detail to add that 📅\n\nTry something like:\n"Add a meeting with Jan tomorrow at 2pm"\n"Schedule a call with CPL Foods Friday 10am-11am"');
    }

    // Confirm before adding
    const startStr = new Date(eventData.start).toLocaleString('en-GB', {
      timeZone: 'Europe/London', weekday: 'short', day: 'numeric',
      month: 'short', hour: '2-digit', minute: '2-digit'
    });
    const endStr = new Date(eventData.end).toLocaleString('en-GB', {
      timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit'
    });
    const loc = eventData.location ? '\n📍 ' + eventData.location : '';
    const acct = eventData.account === 'iws' ? ' [IWS calendar]' : ' [MYDIS calendar]';

    const confirmMsg = 'Adding to your calendar' + acct + ':\n\n📅 ' + eventData.title + '\n🕐 ' + startStr + ' - ' + endStr + loc + '\n\nSay "yes" to confirm or "cancel" to stop.';
    store.savePendingDraft({ type: 'calendar_event', eventData, awaitingConfirm: true });
    store.saveConversationTurn('penelope', confirmMsg);
    return waSend(confirmMsg);
  } catch (err) {
    console.error('[calendarAdd] error:', err.message);
    return waSend('Had trouble parsing that event 😕 - ' + err.message);
  }
}

module.exports = { handleInbound };
