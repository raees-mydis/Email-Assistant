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

// Restore travelling state from saved rules
(function() {
  const rules = store.getRules();
  const lastTravel = rules.filter(r => r.rule === '__travelling__' || r.rule === '__not_travelling__').pop();
  if (lastTravel && lastTravel.rule === '__travelling__') global.PENELOPE_TRAVELLING = true;
})();


// Known people for name extraction
const KNOWN_PEOPLE = [
  'hamid','falak','lilian','craig','adegoke','ade','basat','bas','shams',
  'al','jan','kamran','faz','jane','nadeem','colin','ketan','florin',
  'gemma','omar','justyna','tom','leigh','jonathan','nick','liv',
  'emma','lucy','irfan','chris'
];

function extractPeopleFromText(t) {
  const found = [];
  for (const n of KNOWN_PEOPLE) {
    const re = new RegExp('\\b' + n + '\\b', 'i');
    if (re.test(t) && !found.includes(n)) found.push(n);
  }
  return found.join(', ') || null;
}

// Pre-filter: catch obvious intents reliably before sending to Claude
function preFilterIntent(text) {
  const t = text.toLowerCase().trim();

  // Compose email — catch all "email/message/ask/tell X" patterns
  const isCompose =
    /^(can we|could you|please|can you)\s+(email|message|send|write|ask|tell|let|contact)/i.test(text) ||
    /^(email|message|write to|send (an )?email to|ask|tell|contact)\s+/i.test(text) ||
    /(email|message)\s+(lilian|craig|hamid|falak|shams|basat|adegoke|al\b|jan|kamran|faz|jane|nadeem|colin|ketan|florin|gemma|omar)/i.test(text);

  if (isCompose) {
    const names = extractPeopleFromText(t);
    return { intent: 'compose_email', personName: names, content: text };
  }

  // Update existing calendar event
  const isUpdateCal =
    /(change|move|update|reschedule|shift|push).+(meeting|call|calendar|invite|mastermind|standup|event)/i.test(text) ||
    /(meeting|call|mastermind|standup).+(change|move|update|reschedule|to \d+pm|to \d+am)/i.test(text);

  if (isUpdateCal) {
    return { intent: 'update_calendar_event', itemReference: text, content: text };
  }

  // "send" ONLY as standalone command
  if (/^send(\s*$|\s+(it|that|this|draft|the draft))/i.test(t)) {
    return { intent: 'send' };
  }

  return null;
}

async function handleInbound(text) {
  console.log('[router] received:', text);
  store.saveConversationTurn('user', text);

  const draft = store.getPendingDraft();

  // Handle organiser decision
  if (draft && draft.awaitingOrganiserDecision) {
    const lower = text.toLowerCase().trim();
    const doEmail = lower.includes('email') || lower.includes('both') || lower.includes('1');
    const doPropose = lower.includes('propose') || lower.includes('both') || lower.includes('2') || lower.includes('3');

    if (!doEmail && !doPropose) {
      // They might be sending the email draft — let it fall through but keep organiser context
      // Don't clear the organiser decision yet
    } else {
      store.clearPendingDraft();
      const msgs = [];
      if (doEmail && draft.organiserEmail) {
        await graph.sendEmail({
          to: draft.organiserEmail,
          subject: 'Request to reschedule: ' + draft.found.subject,
          body: 'Hi ' + draft.organiserName + ',\n\nCould we please reschedule the ' + draft.found.subject + '? A different time would work better.\n\nKind Regards\nRaees Sayed'
        });
        msgs.push('Email sent to ' + draft.organiserName);
      }
      if (doPropose && draft.found && draft.updates) {
        try {
          await graph.updateCalendarEvent(draft.found.id, draft.updates, draft.account);
          msgs.push('New time proposed on the calendar');
        } catch {
          msgs.push('Note: ' + draft.organiserName + ' is the organiser so they\'ll need to accept the calendar change');
        }
      }
      const doneMsg = 'Done! ✅ ' + msgs.join(' & ') + '.';
      store.saveConversationTurn('penelope', doneMsg);
      return waSend(doneMsg);
    }
  }

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

  // Handle task vs calendar ambiguity
  if (draft && draft.awaitingClarify && draft.type === 'ambiguous') {
    const lower = text.toLowerCase().trim();
    if (lower.includes('task') || lower.includes('todoist') || lower.includes('postpone') || lower.includes('move')) {
      store.clearPendingDraft();
      const dateMatch = draft.originalText.match(/to (tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next \w+)/i);
      const newDate = dateMatch ? dateMatch[1] : 'tomorrow';
      await todoist.updateTaskDue(draft.taskId, newDate);
      const msg = 'Done! ✅ "' + draft.taskContent + '" moved to ' + newDate;
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    } else if (lower.includes('calendar') || lower.includes('event') || lower.includes('schedule')) {
      store.clearPendingDraft();
      return handleCalendarAdd(draft.originalText);
    }
  }

  if (draft && draft.awaitingConfirm && draft.type === 'calendar_event') {
    const lower = text.toLowerCase().trim();
    if (lower === 'yes' || lower === 'confirm' || lower === 'add it' || lower === 'go ahead') {
      store.clearPendingDraft();
      try {
        if (draft.type === 'calendar_update') {
          await graph.updateCalendarEvent(draft.eventId, draft.updates, draft.account);
          const msg = 'Done! ✅ "' + draft.eventTitle + '" has been updated.';
          store.saveConversationTurn('penelope', msg);
          return waSend(msg);
        } else {
          const result = await graph.createCalendarEvent(draft.eventData, draft.eventData.account);
          const msg = 'Done! ✅ "' + result.subject + '" added to your calendar.';
          store.saveConversationTurn('penelope', msg);
          return waSend(msg);
        }
      } catch (err) {
        return waSend('Had trouble with that 😕 - ' + err.message);
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

async function processIntent(parsed, intentCount, text) {
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

    case 'compose_email':
      return handleComposeEmail(parsed.personName, parsed.content, text, intentCount > 1);

    case 'update_calendar_event':
      return handleUpdateCalendarEvent(parsed.itemReference || parsed.content, parsed.content, text, intentCount > 1);

    case 'travelling_on':
      global.PENELOPE_TRAVELLING = true;
      store.saveRule('__travelling__');
      return waSend('Got it! ✈️ I will add your travelling disclaimer to all emails until you tell me you\'re back.');

    case 'travelling_off':
      global.PENELOPE_TRAVELLING = false;
      store.saveRule('__not_travelling__');
      return waSend('Welcome back! 🏠 Travelling disclaimer removed from emails.');

    case 'add_vip':
      return handleAddVip(parsed.personName, parsed.content);

    case 'remember_rule':
      return handleRememberRule(parsed.content);

    case 'contact_pref':
      return handleContactPref(parsed.personName, parsed.content);

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

    case 'propose':
    case 'unknown':
      // Check if user is following up on an organiser decision
      if (text.toLowerCase().includes('propose') || text.toLowerCase().includes('suggest')) {
        const recentConvo = store.getConversation();
        const lastPenelopeMsg = recentConvo.filter(c => c.role === 'penelope').pop();
        if (lastPenelopeMsg && lastPenelopeMsg.text && lastPenelopeMsg.text.includes('not the organiser')) {
          return waSend('I\'ve lost the meeting context — please say "update the mastermind calendar" again and I\'ll handle it from there. 📅');
        }
      }
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
  const contactPref = store.getContactPref(draftInfo.toAddress);
  const toneExamples = store.getToneExamples();
  const polished = email ? await claude.reviewReply(email, content, useExact, contactPref, toneExamples) : content;
  store.savePendingDraft({ ...draftInfo, draft: polished, awaitingReply: false, originalDictated: content });
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
  const sentAt = Date.now();

  // Handle new outbound email (not a reply)
  if (draft.type === 'new_email') {
    await graph.sendEmail({ to: draft.recipients, subject: draft.subject, body: draft.draft });
    store.clearPendingDraft();
    const toNames = draft.recipients.map(r => r.name).join(' and ');
    const msg = 'Done! ✅ Email sent to ' + toNames;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }

  await graph.replyToEmail(draft.messageId, draft.draft, draft.account, draft.replyAll !== false);
  store.setEmailAction(draft.messageId, 'replied', 'to ' + draft.toName);
  store.removeChaseItem(draft.messageId);
  // Track reply speed for this contact
  const session = store.getSession();
  const origEmail = session ? session.emails.find(e => e.id === draft.messageId) : null;
  if (origEmail && origEmail.receivedAt) {
    const msToReply = sentAt - new Date(origEmail.receivedAt).getTime();
    store.trackReply(draft.toAddress, msToReply);
  }
  store.clearPendingDraft();
  const msg = 'Done! ✅ Reply sent to ' + draft.toName;
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();
  if (!draft) return waSend('No draft to edit - start with "reply to [name]" first 📝');

  // Detect if this is a style/tone instruction rather than replacement text
  const stylePatterns = [
    /^(make it|change it to|rewrite|can you make|more|less|sound|tone|be more|be less|friendlier|softer|shorter|longer|formal|informal|casual|professional|polite|direct|asking|question|ask them|as a question)/i,
    /^(don.t tell|don.t say|instead of telling|phrase it as|word it as)/i,
  ];
  const isStyleInstruction = stylePatterns.some(p => p.test(newText.trim()));

  if (isStyleInstruction && draft.draft) {
    // Rewrite the existing draft using the instruction
    await waSend('Rewriting... ✍️');
    const Anthropic = require('@anthropic-ai/sdk');
    const config = require('./config');
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const travelling = global.PENELOPE_TRAVELLING || false;
    const signature = travelling
      ? 'Kind Regards\nRaees Sayed\n(I\'m currently travelling so replies may be slower)'
      : 'Kind Regards\nRaees Sayed';
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      messages: [{ role: 'user', content: 'Rewrite this email following this instruction: "' + newText + '"\n\nKeep the same general topic and recipients. Keep the signature exactly as is.\n\nCurrent draft:\n' + draft.draft + '\n\nSignature to keep: ' + signature + '\n\nReturn only the rewritten email body.' }]
    });
    const rewritten = msg.content[0].text.trim();
    if (draft.draft && draft.toAddress) {
      store.saveToneExample(draft.toAddress, draft.toName, draft.draft, rewritten, draft.subject);
    }
    store.savePendingDraft({ ...draft, draft: rewritten, awaitingReply: false });
    const confirmMsg = 'Rewritten! ✏️\n\n' + rewritten + '\n\n"send" when you are happy 👍';
    store.saveConversationTurn('penelope', confirmMsg);
    return waSend(confirmMsg);
  }

  // Otherwise treat as literal replacement
  if (draft.draft && draft.toAddress) {
    store.saveToneExample(draft.toAddress, draft.toName, draft.draft, newText, draft.subject);
  }
  store.savePendingDraft({ ...draft, draft: newText, awaitingReply: false });
  const confirmMsg = 'Updated! ✏️\n\n' + newText + '\n\n"send" when you are happy 👍';
  store.saveConversationTurn('penelope', confirmMsg);
  return waSend(confirmMsg);
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
      '[T' + (i+1) + '] ' + t.content + (t.dueBritish ? ' — ' + t.dueBritish : (t.due ? ' — ' + t.due.date : ''))
    ).join('\n');
    const msg = '📋 Outstanding tasks (' + tasks.length + '):\n\n' + lines + '\n\nSay "postpone T2 to Friday", "postpone the [name] task to [date]", or "postpone all to tomorrow"';
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

  // Try keyword match — strip special chars for comparison
  if (!task && itemReference) {
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const kw = normalize(itemReference);
    const kwWords = kw.split(' ').filter(w => w.length > 2);
    // Score each task by how many keywords match
    let bestScore = 0, bestTask = null;
    for (const t of tasks) {
      const taskNorm = normalize(t.content);
      const matchCount = kwWords.filter(w => taskNorm.includes(w)).length;
      if (matchCount > bestScore) { bestScore = matchCount; bestTask = t; }
    }
    if (bestScore > 0) task = bestTask;
  }

  // Still no match — ask Claude
  if (!task && itemReference) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const config = require('./config');
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const taskList = tasks.map((t, i) => '[' + i + '] ' + t.content).join('\n');
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 50,
        messages: [{ role: 'user', content: 'Tasks:\n' + taskList + '\n\nUser said: "' + itemReference + '"\nReturn ONLY the 0-based index of the closest matching task, or -1 if no match.' }]
      });
      const idx = parseInt(msg.content[0].text.trim(), 10);
      if (idx >= 0 && tasks[idx]) task = tasks[idx];
    } catch {}
  }

  if (!task) {
    const list = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content).join('\n');
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

    // Check if this might be a task postpone first
    const tasks = await todoist.getTodayTasks();
    if (tasks.length > 0) {
      const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const textNorm = normalize(text);
      const textWords = textNorm.split(' ').filter(w => w.length > 2 && !['add','move','put','set','the','for','please','can','you','to','my'].includes(w));
      let bestScore = 0, bestTask = null;
      for (const t of tasks) {
        const taskNorm = normalize(t.content);
        const matchCount = textWords.filter(w => taskNorm.includes(w)).length;
        if (matchCount > bestScore) { bestScore = matchCount; bestTask = t; }
      }
      if (bestScore >= 2 || (bestScore === 1 && textWords.length <= 3)) {
        // Looks like a task reference — ask for clarification
        const dateMatch = text.match(/to (tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next \w+|\d+ \w+)/i);
        const newDate = dateMatch ? dateMatch[1] : null;
        if (newDate) {
          // High confidence — just do it as task postpone
          await todoist.updateTaskDue(bestTask.id, newDate);
          const msg = 'Done! ✅ "' + bestTask.content + '" moved to ' + newDate;
          store.saveConversationTurn('penelope', msg);
          return waSend(msg);
        }
        // Ask to clarify
        const clarifyMsg = 'Did you mean:\n\n📋 Postpone the task "' + bestTask.content + '" in Todoist\nor\n📅 Add "' + bestTask.content + '" as a new calendar event?\n\nSay "task" or "calendar"';
        store.savePendingDraft({ type: 'ambiguous', taskId: bestTask.id, taskContent: bestTask.content, originalText: text, awaitingClarify: true });
        store.saveConversationTurn('penelope', clarifyMsg);
        return waSend(clarifyMsg);
      }
    }

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

async function handleAddVip(personName, emailAddr) {
  if (!personName && !emailAddr) return waSend('Who do you want to add as a VIP? Give me a name or email 👤');
  // Try to find them in current session emails
  const session = store.getSession();
  let resolvedEmail = emailAddr, resolvedName = personName;
  if (session && personName) {
    const found = session.emails.find(e => {
      const senderName = (e.fromName || '').toLowerCase();
      const senderEmail = e.from.toLowerCase();
      return senderName.includes(personName.toLowerCase()) || senderEmail.includes(personName.toLowerCase());
    });
    if (found) { resolvedEmail = found.from; resolvedName = found.fromName || found.from; }
  }
  store.addVip(resolvedEmail, resolvedName, 'Added by Raees');
  const msg = 'Done! ⭐ ' + (resolvedName || resolvedEmail) + ' is now a VIP — they will always be surfaced at the top of your digest.';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleRememberRule(ruleText) {
  if (!ruleText) return waSend('What should I remember? 🧠');
  store.saveRule(ruleText);
  const msg = 'Got it! 🧠 I will remember: "' + ruleText + '"';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleContactPref(personName, prefText) {
  if (!personName || !prefText) return waSend('Who is this about and what should I know? e.g. "always informal with Craig" 👤');
  const session = store.getSession();
  let emailKey = personName.toLowerCase();
  if (session) {
    const found = session.emails.find(e => (e.fromName || '').toLowerCase().includes(personName.toLowerCase()));
    if (found) emailKey = found.from.toLowerCase();
  }
  const lower = prefText.toLowerCase();
  const formality = lower.includes('informal') || lower.includes('casual') || lower.includes('friendly') ? 'informal'
    : lower.includes('formal') || lower.includes('professional') ? 'formal' : null;
  store.saveContactPref(emailKey, { formality: formality || undefined, notes: prefText });
  const msg = 'Noted! 🧠 I will remember that when writing to ' + personName + ': ' + prefText;
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleComposeEmail(recipientNames, topic, originalText, autoSend) {
  if (!recipientNames) return waSend('Who do you want to send this to? Give me a name 👤');

  // Resolve recipient names to email addresses from team + session
  const session = store.getSession();
  const TEAM_MAP = {
    'hamid': 'hamid@mydis.com', 'falak': 'falak@mydis.com',
    'lilian': 'lilian@mydis.com', 'craig': 'craig@mydis.com',
    'adegoke': 'adegoke@mydis.com', 'ade': 'adegoke@mydis.com',
    'basat': 'basat@mydis.com', 'bas': 'basat@mydis.com',
    'shams': 'shams@mydis.com', 'al': 'al@iwsuk.com',
  };

  const names = recipientNames.split(/,|and/).map(n => n.trim().toLowerCase()).filter(Boolean);
  const resolved = [];
  const unresolved = [];

  for (const name of names) {
    // Check team map first
    const teamEmail = TEAM_MAP[name];
    if (teamEmail) { resolved.push({ name, email: teamEmail }); continue; }

    // Check recent emails
    if (session) {
      const found = session.emails.find(e =>
        (e.fromName || '').toLowerCase().includes(name) || e.from.toLowerCase().includes(name)
      );
      if (found) { resolved.push({ name: found.fromName || found.from, email: found.from }); continue; }
    }

    unresolved.push(name);
  }

  if (unresolved.length > 0) {
    return waSend('I could not find email addresses for: ' + unresolved.join(', ') + '\n\nTry saying their full name or email address, or "add [name] as VIP" after emailing them so I remember.');
  }

  // Draft the email using Claude
  await waSend('Sure Raees, drafting that now... ✍️');
  await new Promise(r => setTimeout(r, 800));

  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const travelling = global.PENELOPE_TRAVELLING || false;
  const signature = travelling
    ? 'Kind Regards\nRaees Sayed\n(I\'m currently travelling so replies may be slower)'
    : 'Kind Regards\nRaees Sayed';

  const recipientStr = resolved.map(r => r.name).join(' and ');

  // Capitalise first letter of each name for greeting
  const greetingNames = resolved.length === 1
    ? resolved[0].name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : resolved.map(r => r.name.split(' ')[0].charAt(0).toUpperCase() + r.name.split(' ')[0].slice(1)).join(' and ');

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 500,
    messages: [{ role: 'user', content: 'Draft a professional email from Raees to ' + recipientStr + ' about: ' + (topic || originalText) + '\n\nFormatting rules:\n- Start with "Hi ' + greetingNames + ',"\n- Blank line after greeting\n- Short clear body\n- Blank line then signature: ' + signature + '\n\nReturn ONLY the email body including signature. No subject line.' }]
  });

  const draft = msg.content[0].text.trim();

  // Generate subject
  const subjectMsg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 30,
    messages: [{ role: 'user', content: 'Write a short email subject line (max 8 words) for this topic: ' + (topic || originalText) + '. Return only the subject line.' }]
  });
  const subject = subjectMsg.content[0].text.trim().replace(/^subject:\s*/i, '');

  const toLine = resolved.map(r => r.name + ' (' + r.email + ')').join(', ');

  // In multi-intent mode, auto-send without waiting for confirmation
  if (autoSend) {
    await graph.sendEmail({ to: resolved, subject, body: draft });
    const msg = 'Done! ✅ Email sent to ' + toLine + '\nSubject: ' + subject;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }

  store.savePendingDraft({
    type: 'new_email',
    recipients: resolved,
    subject,
    draft,
    awaitingReply: false,
    awaitingConfirm: true,
  });

  const confirmMsg = 'Here is your draft:\n\nTo: ' + toLine + '\nSubject: ' + subject + '\n\n' + draft + '\n\n"send" to fire it off\n"edit [changes]" to tweak';
  store.saveConversationTurn('penelope', confirmMsg);
  return waSend(confirmMsg);
}

async function handleUpdateCalendarEvent(eventKeyword, changeDescription, originalText, autoConfirm) {
  if (!eventKeyword) return waSend('Which meeting do you want to update? Give me the name or a keyword 📅');

  await waSend('Sure Raees, finding that meeting... 📅');
  await new Promise(r => setTimeout(r, 600));

  try {
    // Search both calendars
    const [mydisEvent, iwsEvent] = await Promise.all([
      graph.findCalendarEvent(eventKeyword, 'mydis'),
      graph.findCalendarEvent(eventKeyword, 'iws'),
    ]);
    const found = mydisEvent || iwsEvent;
    const account = mydisEvent ? 'mydis' : 'iws';

    if (!found) {
      return waSend('Could not find a meeting matching "' + eventKeyword + '" in your calendar 🔍\n\nTry giving me more of the event title.');
    }

    // Check if Raees is the organiser — if not, we can only propose a new time
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const iwsEmail = 'raees@iwsuk.com';
    const organiserEmail = (found.organizer && found.organizer.emailAddress ? found.organizer.emailAddress.address : '').toLowerCase();
    const isOrganiser = organiserEmail.includes(userEmail.split('@')[0]) || organiserEmail === userEmail || organiserEmail === iwsEmail;

    if (!isOrganiser && organiserEmail) {
      const organiserName = (found.organizer && found.organizer.emailAddress ? found.organizer.emailAddress.name : null) || organiserEmail;

      if (autoConfirm) {
        // In multi-intent mode — just propose the new time automatically
        try {
          if (updates.start) {
            // Send a tentative proposal by updating with tentative status
            await graph.updateCalendarEvent(found.id, { ...updates, showAs: 'tentative' }, account);
            const msg = 'Done! 📅 Proposed new time on "' + found.subject + '" — shown as tentative since ' + organiserName + ' organised it.';
            store.saveConversationTurn('penelope', msg);
            return waSend(msg);
          }
        } catch (err) {
          console.error('[updateCal] propose error:', err.message);
        }
        return waSend('Note: ' + organiserName + ' organised the event so the invite can only be fully changed by them. Your email has been sent asking to move it. 📧');
      }

      return waSend('You are not the organiser of "' + found.subject + '" — ' + organiserName + ' set it up.\n\nShall I:\n1. Email ' + organiserName + ' to request the time change\n2. Send a tentative proposal through the calendar\n\nSay "email them" or "propose" to proceed.');
    }

    // Parse the change using Claude
    const Anthropic = require('@anthropic-ai/sdk');
    const config = require('./config');
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });

    const currentStart = found.start ? found.start.dateTime : '';
    const currentEnd   = found.end   ? found.end.dateTime   : '';
    const currentDate  = currentStart ? new Date(currentStart).toISOString().split('T')[0] : '';
    const now = new Date().toISOString();

    const parseMsg = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 200,
      messages: [{ role: 'user', content: 'Current event: "' + found.subject + '" starts ' + currentStart + ' ends ' + currentEnd + '\nCurrent date/time: ' + now + '\nChange requested: "' + (changeDescription || originalText) + '"\n\nReturn ONLY valid JSON with the new values:\n{ "start": "ISO8601 or null if unchanged", "end": "ISO8601 or null if unchanged", "title": null, "location": null }\n\nIf only time changes, keep the same date. If moving to tomorrow keep same time unless specified.' }]
    });

    const raw = parseMsg.content[0].text.trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const updates = m ? JSON.parse(m[0]) : {};

    if (!updates.start && !updates.end && !updates.title && !updates.location) {
      return waSend('Not sure what change you want — can you be more specific? e.g. "move it to 2pm" or "change it to tomorrow"');
    }

    // Show confirmation
    const newStartStr = updates.start
      ? new Date(updates.start).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : new Date(currentStart).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const newEndStr = (updates.end || currentEnd)
      ? new Date(updates.end || currentEnd).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
      : '';

    // In multi-intent mode, auto-confirm the update
    if (autoConfirm) {
      await graph.updateCalendarEvent(found.id, updates, account);
      const msg = 'Done! ✅ "' + found.subject + '" updated to ' + newStartStr + (newEndStr ? ' - ' + newEndStr : '');
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }

    store.savePendingDraft({ type: 'calendar_update', eventId: found.id, account, updates, eventTitle: found.subject, awaitingConfirm: true });

    const confirmMsg = 'Updating "' + found.subject + '":\n\n📅 New time: ' + newStartStr + (newEndStr ? ' - ' + newEndStr : '') + '\n\nSay "yes" to confirm or "cancel" to stop.';
    store.saveConversationTurn('penelope', confirmMsg);
    return waSend(confirmMsg);
  } catch (err) {
    console.error('[updateCal] error:', err.message);
    return waSend('Had trouble updating that 😕 - ' + err.message);
  }
}

module.exports = { handleInbound };
