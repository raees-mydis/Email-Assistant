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
  try {
    const rules = store.getRules();
    const lastTravel = rules.filter(r => r.rule === '__travelling__' || r.rule === '__not_travelling__').pop();
    if (lastTravel && lastTravel.rule === '__travelling__') global.PENELOPE_TRAVELLING = true;
  } catch {}
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

// Pre-filter: catch obvious intents before Claude — returns array
function preFilterIntent(text) {
  const t = text.toLowerCase().trim();
  const results = [];

  // Compose email patterns
  const isCompose =
    /^(can we|could you|please|can you)\s+(email|message|send|write|ask|tell|let|contact)/i.test(text) ||
    /^(email|message|write to|send (an )?email to|ask|tell|contact)\s+/i.test(text) ||
    /(email|message)\s+(lilian|craig|hamid|falak|shams|basat|adegoke|al\b|jan|kamran|faz|jane|nadeem|colin|ketan|florin|gemma|omar)/i.test(text);

  if (isCompose) {
    const names = extractPeopleFromText(t);
    results.push({ intent: 'compose_email', personName: names, content: text });
  }

  // Detect personal calendar request early
  const isPersonalCal = /personal calendar|my personal|outlook calendar/i.test(text);

  // Update existing calendar event — must have explicit change/move/reschedule language
  // "book/schedule/set up/arrange a meeting" are NEW events, not updates
  const isNewMeeting = /^(can we |can you |could you |please |let's )?(book|schedule|set up|arrange|create|add|organise|organize) (a |an )?(meeting|call|catch.?up|session)/i.test(text) ||
    /^(i need (to |a )|can we |can you |could you ).*(meeting|call|catch.?up|session).*(with|for|on|at)/i.test(text);

  const isUpdateCal = !isNewMeeting && (
    /(change|move|update|reschedule|shift|push|propose).+(meeting|call|calendar|invite|mastermind|standup|event)/i.test(text) ||
    /(meeting|call|mastermind|standup).+(change|move|update|reschedule|propose|to \d+pm|to \d+am)/i.test(text) ||
    /(propose|suggest).+(time|new time|calendar|event|invite)/i.test(text)
  );

  if (isUpdateCal) {
    results.push({ intent: 'update_calendar_event', itemReference: text, content: text });
  }

  // New meeting/event booking
  if (isNewMeeting && !isCompose) {
    results.push({ intent: 'calendar_add', content: text, calendarName: isPersonalCal ? 'personal' : null, skipTaskCheck: true });
  }

  // Calendar add with personal flag
  const isCalAdd = /(add|put|schedule|create|book).+(calendar|appointment|event|meeting)/i.test(text) && !isUpdateCal && !isCompose;
  if (isCalAdd || isPersonalCal) {
    if (!results.some(r => r.intent === 'calendar_add' || r.intent === 'update_calendar_event')) {
      results.push({ intent: 'calendar_add', content: text, calendarName: isPersonalCal ? 'personal' : null, skipTaskCheck: true });
    }
  }

  // Calendar search — "when is X", "what day is X", "find X meeting", "is X on my calendar"
  const isCalSearch =
    /^(when is|what day is|what time is|find|is there|do i have|where is).+(meeting|call|appointment|event|session|poultry|mastermind|standup)/i.test(text) ||
    /^can you (tell me|check|find|look up).+(meeting|call|appointment|event|calendar|when|schedule)/i.test(text) ||
    /(meeting|call|appointment|event).+(when|what day|what time|scheduled|on my calendar)/i.test(text);

  if (isCalSearch && !isCompose) {
    results.push({ intent: 'calendar_search', itemReference: text, content: text });
  }

  // Standalone task creation — "add a task", "create a task", "remind me to"
  const isCreateTask = /^(add|create|make|put|set up|remind me to|can you add) (a |an )?(task|reminder|todo|to-do)/i.test(text) ||
    /^(add|create).+(task|todoist|to-do|under (sales|operations|finance|admin|marketing|hr))/i.test(text) ||
    /under (sales|operations|finance|admin|marketing|hr).*(task|remind|add|create)/i.test(text);

  if (isCreateTask && results.length === 0) {
    // Extract section hint from text
    const sectionMatch = text.match(/under (\w+)/i);
    const sectionHint = sectionMatch ? sectionMatch[1].toLowerCase() : null;
    results.push({ intent: 'create_task', content: text, sectionHint });
  }

  // "send" ONLY as standalone command (only if nothing else matched)
  if (results.length === 0 && /^send(\s*$|\s+(it|that|this|draft|the draft))/i.test(t)) {
    results.push({ intent: 'send' });
  }

  return results.length > 0 ? results : null;
}

async function handleInbound(text) {
  console.log('[router] received:', text);
  store.saveConversationTurn('user', text);

  // Detect forwarded/shared message — WhatsApp forwards start with sender info or quoted text
  const looksForwarded = (
    /^(Forwarded message|---------- Forwarded)/i.test(text) ||
    (text.includes('\n') && text.length > 200)
  ) && !store.getPendingDraft();

  if (looksForwarded && !store.getPendingDraft()) {
    // Check if it looks like a forwarded chat (multiple lines, no clear command)
    const hasCommand = /^(update|reply|send|task|delegate|book|schedule|email|add|create|when|what|can you|can we|could)/i.test(text.trim());
    if (!hasCommand) {
      store.savePendingDraft({ type: 'forwarded_context', context: text, awaitingInstruction: true });
      const msg = 'Got it — I can see the forwarded message. What would you like me to do with this? 📋\n\nFor example: "reply", "add as task", "summarise", "email Hamid about this"';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
  }

  // "cancel" always clears pending draft first
  const lowerText = text.toLowerCase().trim();
  if (lowerText === 'cancel' || lowerText === 'cancel that' || lowerText === 'never mind' || lowerText === 'nevermind') {
    const existingDraft = store.getPendingDraft();
    if (existingDraft) {
      store.clearPendingDraft();
      return waSend('Cancelled! 👍 What else can I help with?');
    }
  }

  const draft = store.getPendingDraft();

  // Handle combined email+calendar action
  if (draft && draft.awaitingCombinedAction && draft.pendingCalendar) {
    const lower = text.toLowerCase().trim();
    const doSend = lower === 'send' || lower.includes('send only') || lower.includes('email only');
    const doPropose = lower === 'propose' || lower.includes('propose only') || lower.includes('calendar only');
    const doBoth = lower === 'both' || lower.includes('do both') || lower.includes('send and propose');

    if (doSend || doPropose || doBoth) {
      const cal = draft.pendingCalendar;
      const toNames = draft.recipients.map(r => r.name.charAt(0).toUpperCase() + r.name.slice(1)).join(' and ');
      const msgs = [];
      if (doSend || doBoth) {
        await graph.sendEmail({ to: draft.recipients, subject: draft.subject, body: draft.draft });
        msgs.push('Email sent to ' + toNames);
      }
      if (doPropose || doBoth) {
        try {
          await graph.updateCalendarEvent(cal.found.id, cal.updates, cal.account);
          msgs.push('New time proposed on the calendar');
        } catch {
          msgs.push('Note: ' + cal.organiserName + ' is the organiser — they need to accept the calendar change');
        }
      }
      store.clearPendingDraft();
      const doneMsg = 'Done! ✅ ' + msgs.join(' & ') + '.';
      store.saveConversationTurn('penelope', doneMsg);
      return waSend(doneMsg);
    }
    // "edit" falls through to handleEdit
  }

  // Handle forwarded message instruction
  if (draft && draft.awaitingInstruction && draft.type === 'forwarded_context') {
    store.clearPendingDraft();
    // Re-process with the forwarded content as context
    const combinedText = text + '\n\n[Context from forwarded message]:\n' + draft.context;
    return handleInbound(combinedText);
  }

  // Handle organiser decision
  if (draft && draft.awaitingOrganiserDecision) {
    const lower = text.toLowerCase().trim();
    const doEmail = lower.includes('email') || lower.includes('both') || lower.includes('1');
    const doPropose = lower.includes('propose') || lower.includes('both') || lower.includes('2') || lower.includes('3');

    if (doEmail || doPropose) {
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
    // else fall through (e.g. they typed "send" to send the email draft)
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
      const hint = draft.calendarNameHint || null;
      store.clearPendingDraft();
      return handleCalendarAdd(draft.originalText, hint, true); // true = skip task check
    }
  }

  // Handle calendar confirm/cancel
  if (draft && draft.awaitingConfirm && (draft.type === 'calendar_event' || draft.type === 'calendar_update')) {
    const lower = text.toLowerCase().trim();

    // Handle Teams link question
    if (draft.awaitingTeamsCheck) {
      const wantsTeams = lower === 'yes' || lower.includes('yes') || lower.includes('teams');
      const declines = lower === 'no' || lower.includes('no teams') || lower.includes('no link');
      if (wantsTeams || declines) {
        const updatedEventData = { ...draft.eventData, onlineMeeting: wantsTeams };
        store.savePendingDraft({ ...draft, eventData: updatedEventData, awaitingTeamsCheck: false });
        const teamsNote = wantsTeams ? '\n📹 Teams link will be added' : '';
        const msg = 'Got it! Say "yes" to confirm or "cancel" to stop.' + teamsNote;
        store.saveConversationTurn('penelope', msg);
        return waSend(msg);
      }
    }

    // Allow switching to personal calendar before confirming
    if (lower.includes('personal') || lower.includes('personal calendar') || lower.includes('outlook')) {
      const updatedData = { ...draft.eventData, calendarName: 'personal' };
      store.savePendingDraft({ ...draft, eventData: updatedData });
      return waSend('Got it — will add to your personal calendar instead 👤\n\nSay "yes" to confirm or "cancel" to stop.');
    }

    // Handle corrections to the pending event — "actually make it 10:30", "change to Monday", "I said Monday"
    const isCorrection = /^(actually|wait|no|i said|make it|change (it )?to|change the time|reschedule to|move it to|at \d)/i.test(text) ||
      /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|\d+:\d+|\d+(am|pm))/i.test(text) && text.length < 60;
    if (isCorrection && draft.eventData) {
      await waSend('Updating that... ✍️');
      const Anthropic = require('@anthropic-ai/sdk');
      const config = require('./config');
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
      const result = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 300,
        messages: [{ role: 'user', content: 'Current event being scheduled:\n' + JSON.stringify(draft.eventData) + '\n\nCorrection: "' + text + '"\n\nNow: ' + now + '\n\nReturn updated JSON with same structure, applying the correction. Keep all other fields the same. Return ONLY valid JSON.' }]
      });
      const raw = result.content[0].text.trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const updated = JSON.parse(m[0]);
        // Handle explicit calendar override
        if (/mydis/i.test(text)) updated.account = 'mydis';
        else if (/iws/i.test(text)) updated.account = 'iws';
        else if (/personal/i.test(text)) { updated.calendarName = 'personal'; }
        else { updated.account = draft.eventData.account; } // preserve existing account

        // Preserve already-resolved attendees unless correction adds new ones
        const existingAttendees = draft.eventData.attendees || [];
        const hasResolvedEmails = existingAttendees.some(a => a.includes('@') && !a.includes('email not found'));
        if (hasResolvedEmails && updated.attendees) {
          // Keep existing resolved emails, only re-resolve new names
          const newNames = (updated.attendees || []).filter(a => !a.includes('@'));
          if (newNames.length > 0) {
            try {
              const session = store.getSession();
              const newResolved = await graph.resolveAttendees(newNames, session);
              updated.attendees = [...existingAttendees.filter(a => a.includes('@') && !a.includes('email not found')), ...newResolved];
            } catch {}
          } else {
            updated.attendees = existingAttendees;
          }
        } else if (updated.attendees && updated.attendees.length) {
          try {
            const session = store.getSession();
            updated.attendees = await graph.resolveAttendees(updated.attendees, session);
          } catch {}
        }

        const startStr = new Date(updated.start).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const endStr = new Date(updated.end).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        const attendeeNote = updated.attendees && updated.attendees.length ? '\n👥 Inviting: ' + updated.attendees.join(', ') : '';
        const acct = updated.calendarName === 'personal' ? ' [Personal]' : updated.account === 'iws' ? ' [IWS]' : ' [MYDIS]';
        // Save AFTER all fixes applied
        store.savePendingDraft({ ...draft, eventData: updated });
        const msg = 'Updated!' + acct + '\n\n📅 ' + updated.title + '\n🕐 ' + startStr + ' — ' + endStr + attendeeNote + '\n\nSay "yes" to confirm or "cancel" to stop.';
        store.saveConversationTurn('penelope', msg);
        return waSend(msg);
      }
    }

    if (lower === 'yes' || lower === 'confirm' || lower === 'add it' || lower === 'go ahead') {
      store.clearPendingDraft();
      try {
        if (draft.type === 'calendar_update') {
          await graph.updateCalendarEvent(draft.eventId, draft.updates, draft.account);
          const msg = 'Done! ✅ "' + draft.eventTitle + '" has been updated.';
          store.saveConversationTurn('penelope', msg);
          return waSend(msg);
        } else {
          const calLabel = draft.eventData.calendarName === 'personal' ? 'personal calendar' : 'MYDIS calendar';
          const result = await graph.createCalendarEvent(draft.eventData, draft.eventData.account || 'mydis');
          const msg = 'Done! ✅ "' + result.subject + '" added to your ' + calLabel + '.';
          store.saveConversationTurn('penelope', msg);
          return waSend(msg);
        }
      } catch (err) {
        console.error('[handleSend] calendar error:', err.response ? JSON.stringify(err.response.data) : err.message);
        return waSend('Had trouble adding that 😕\n' + (err.response ? JSON.stringify(err.response.data) : err.message));
      }
    } else if (lower === 'cancel' || lower === 'no') {
      store.clearPendingDraft();
      return waSend('No problem, cancelled 👍');
    }
  }

  // Handle awaiting reply content
  if (draft && draft.awaitingReply) {
    const lower = text.toLowerCase().trim();
    if (!['cancel','update','morning brief'].includes(lower)) {
      return handleReplyContent(text, draft);
    }
  }

  // Quick acknowledgment for slow operations
  const slowOps = ['update','morning brief','what does my day','what have i got','tasks today','last hour','last 30','last 2 hour','brief'];
  if (slowOps.some(q => lowerText.includes(q))) {
    await waSend('Got it Raees, give me a sec... ⏳');
  }

  // Pre-filter: catch obvious intents before Claude
  const preFiltered = preFilterIntent(text);
  if (preFiltered) {
    console.log('[router] pre-filtered intents:', JSON.stringify(preFiltered));
    const pfCount = preFiltered.length;
    for (const pf of preFiltered) {
      await processIntent({ emailIndex: null, ...pf }, pfCount, text);
    }
    return;
  }

  // Parse with Claude
  const session = store.getSession();
  const convo   = store.getConversation();
  const intents = await claude.parseMultiIntent(text, session, convo);
  console.log('[router] intents:', JSON.stringify(intents));

  const intentCount = intents.length;
  for (const parsed of intents) {
    await processIntent(parsed, intentCount, text);
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

    case 'calendar_search':
      return handleCalendarSearch(parsed.itemReference || parsed.content || text);

    case 'calendar_free':
      return handleCalendarFree(parsed.itemReference || parsed.content || text);

    case 'reply':
      return handleReply(parsed.emailIndex, parsed.content, parsed.personName, parsed.useExact);

    case 'send':
      return handleSend();

    case 'edit':
      return handleEdit(parsed.content || text || '');

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

    case 'calendar_add':
      return handleCalendarAdd(parsed.content || text || '', parsed.calendarName, parsed.skipTaskCheck);

    case 'day_summary_today':
      return handleDaySummary(0);

    case 'day_summary_tomorrow':
      return handleDaySummary(1);

    case 'tasks_today':
      return handleTasksToday();

    case 'postpone_task':
      return handlePostponeTask(parsed.taskIndex, parsed.content, parsed.itemReference);

    case 'postpone_all_tasks':
      return handlePostponeAllTasks(parsed.content);

    case 'add_vip':
      return handleAddVip(parsed.personName, parsed.content);

    case 'create_task':
      return handleCreateTask(parsed.content, parsed.sectionHint, text);

    case 'remember_rule':
      return handleRememberRule(parsed.content);

    case 'contact_pref':
      return handleContactPref(parsed.personName, parsed.content);

    case 'travelling_on':
      global.PENELOPE_TRAVELLING = true;
      store.saveRule('__travelling__');
      return waSend('Got it! ✈️ Travelling disclaimer added to all emails until you say you\'re back.');

    case 'travelling_off':
      global.PENELOPE_TRAVELLING = false;
      store.saveRule('__not_travelling__');
      return waSend('Welcome back! 🏠 Travelling disclaimer removed.');

    case 'help':
      const helpMsg = 'Here is what you can ask me 👇\n\n' +
        '"update" — get digest now\n' +
        '"morning brief" — full morning summary\n' +
        '"what does my day look like" — emails, calendar + tasks\n' +
        '"what have I got today/tomorrow" — calendar\n' +
        '"last hour / 30 mins" — period update\n' +
        '"tasks today" — outstanding Todoist tasks\n' +
        '"reply to Jo" — reply to an email\n' +
        '"email Lilian and Craig about X" — send new email\n' +
        '"task 3 operations" — add to Todoist section\n' +
        '"delegate 2 to Craig"\n' +
        '"postpone the M&S task to Friday"\n' +
        '"postpone all to tomorrow"\n' +
        '"move the mastermind to 2pm" — update calendar\n' +
        '"ignore emails from X"\n' +
        '"mark the rest as read"\n' +
        '"add Jan as VIP"\n' +
        '"I\'m travelling" / "I\'m back"\n' +
        '"Craig handles site issues" — remember this';
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
    const events = await graph.getCombinedCalendarEvents(offsetDays);
    if (!events || !events.length) {
      const msg = 'Your calendar is clear for ' + label + '! 🎉';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
    const dayName = offsetDays === 0 ? 'Today' :
      'Tomorrow — ' + new Date(Date.now() + 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long' });
    const lines = events.map(e => {
      let time = e.isAllDay ? 'All day' : '';
      if (!e.isAllDay && e.startTime) {
        const s = new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        const en = new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
        time = s + ' — ' + en;
      }
      const loc = e.location ? ' @ ' + e.location : '';
      const acct = e.account === 'iws' ? ' [IWS]' : '';
      return '🕐 ' + time + ' — ' + e.subject + loc + acct;
    }).join('\n\n');
    const msg = '📅 ' + dayName + ' (' + events.length + ' event' + (events.length !== 1 ? 's' : '') + ')\n\n' + lines;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    return waSend('Had trouble fetching your calendar 😕 — ' + err.message);
  }
}

async function handleMorningBrief() {
  await waSend('Good morning Raees! Give me a sec... ☀️');
  await new Promise(r => setTimeout(r, 800));
  try {
    const [emails, tasks] = await Promise.all([graph.getUnreadEmails(30), todoist.getTodayTasks()]);
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const inbound = emails.filter(e => !e.from.toLowerCase().includes(userEmail));
    const stakeholders = store.getStakeholderAssignments();
    const brief = await claude.generateMorningBrief(inbound, tasks, stakeholders);
    store.saveConversationTurn('penelope', brief);
    await waSend(brief);
  } catch (err) {
    await waSend('Could not pull the brief right now 😕 — ' + err.message);
  }
}

async function handlePeriodUpdate(minutes) {
  const label = minutes >= 1440 ? 'today' : minutes >= 60 ? 'the last ' + Math.round(minutes/60) + ' hour' + (minutes > 60 ? 's' : '') : 'the last ' + minutes + ' mins';
  await waSend('Sure Raees, pulling that for you... 🔍');
  await new Promise(r => setTimeout(r, 800));
  try {
    const [mydisEmails, iwsEmails] = await Promise.all([
      graph.getRecentEmails(minutes),
      graph.getIwsRecentEmails(minutes),
    ]);
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const mydisinbound = mydisEmails.filter(e => !e.from.toLowerCase().includes(userEmail));
    const iwsInbound = iwsEmails.filter(e => !e.from.toLowerCase().includes('raees@iwsuk.com'));
    const inbound = [...mydisinbound, ...iwsInbound];
    console.log('[period] MYDIS:', mydisinbound.length, '| IWS:', iwsInbound.length);
    store.saveSession(inbound);
    const actions = store.getEmailActions();
    const stakeholders = store.getStakeholderAssignments();
    const summary = await claude.summariseWithContext(inbound, minutes, actions, stakeholders);
    store.saveConversationTurn('penelope', summary);
    await waSend(summary);
  } catch (err) {
    await waSend('Had a problem fetching that 😕 — ' + err.message);
  }
}

async function handleReply(emailIndex, content, personName, useExact) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) {
    if (personName) return waSend('I could not find an email from "' + personName + '" 🔍\n\nTry "update" to refresh.');
    return waSend('Which email did you want to reply to? Give me a name or number 📬');
  }
  const cc = email.ccRecipients || [];
  const draftBase = {
    messageId: email.id, toAddress: email.from, toName: email.fromName || email.from,
    subject: email.subject, account: email.account || 'mydis',
    draft: '', awaitingReply: true, useExact: useExact || false,
    replyAll: cc.length > 0, ccRecipients: cc,
  };
  if (cc.length > 0 && !content) {
    const ccNames = cc.map(r => r.name || r.email).join(', ');
    store.savePendingDraft({ ...draftBase, awaitingReply: false, awaitingCcDecision: true });
    const msg = 'Replying to ' + (email.fromName || email.from) + ' re: ' + email.subject + '\n\n👥 CC: ' + ccNames + '\n\nKeep them in CC or reply to sender only?\n\n"keep" — reply all\n"only" — sender only\n\nThen tell me what to say.';
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
  store.savePendingDraft({ ...draftInfo, draft: polished, awaitingReply: false });
  const ccNote = draftInfo.replyAll && draftInfo.ccRecipients && draftInfo.ccRecipients.length
    ? '\n👥 CC: ' + draftInfo.ccRecipients.map(r => r.name || r.email).join(', ')
    : '';
  const msg = 'Here is your draft to ' + draftInfo.toName + ccNote + ':\n\n' + polished + '\n\n"send" to fire it off\n"edit [changes]" to tweak';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleSend() {
  const draft = store.getPendingDraft();
  if (!draft) return waSend('Nothing waiting to be sent! Start with "reply to [name]" 📝');
  if (!draft.draft) return waSend('The draft is empty — say "edit [your reply]" first 📝');
  const sentAt = Date.now();
  if (draft.type === 'new_email') {
    const toNames = draft.recipients.map(r => r.name.charAt(0).toUpperCase() + r.name.slice(1)).join(' and ');
    // Handle combined action (email + calendar)
    if (draft.awaitingCombinedAction && draft.pendingCalendar) {
      await graph.sendEmail({ to: draft.recipients, subject: draft.subject, body: draft.draft });
      store.clearPendingDraft();
      const msg = 'Done! ✅ Email sent to ' + toNames + '.';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
    await graph.sendEmail({ to: draft.recipients, subject: draft.subject, body: draft.draft });
    store.clearPendingDraft();
    const msg = 'Done! ✅ Email sent to ' + toNames;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }
  await graph.replyToEmail(draft.messageId, draft.draft, draft.account, draft.replyAll !== false);
  store.setEmailAction(draft.messageId, 'replied', 'to ' + draft.toName);
  store.removeChaseItem(draft.messageId);
  const session = store.getSession();
  const origEmail = session ? session.emails.find(e => e.id === draft.messageId) : null;
  if (origEmail && origEmail.receivedAt) store.trackReply(draft.toAddress, sentAt - new Date(origEmail.receivedAt).getTime());
  store.clearPendingDraft();
  const msg = 'Done! ✅ Reply sent to ' + draft.toName;
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();
  if (!draft) return waSend('No draft to edit — start with "reply to [name]" first 📝');
  const stylePatterns = [
    /^(make it|change it|rewrite|can you make|more|less|sound|tone|be more|be less|friendlier|softer|shorter|longer|formal|informal|casual|professional|polite|direct|asking|question|ask them|as a question)/i,
    /^(don.t tell|don.t say|instead of telling|phrase it as|word it as)/i,
  ];
  const isStyleInstruction = stylePatterns.some(p => p.test(newText.trim()));
  if (isStyleInstruction && draft.draft) {
    await waSend('Rewriting... ✍️');
    const Anthropic = require('@anthropic-ai/sdk');
    const config = require('./config');
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const travelling = global.PENELOPE_TRAVELLING || false;
    const signature = travelling ? 'Kind Regards\nRaees Sayed\n(I\'m currently travelling so replies may be slower)' : 'Kind Regards\nRaees Sayed';
    const result = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      messages: [{ role: 'user', content: 'Rewrite this email following this instruction: "' + newText + '"\n\nKeep the same facts and recipients. End with: ' + signature + '\n\nCurrent draft:\n' + draft.draft + '\n\nReturn only the rewritten email body.' }]
    });
    const rewritten = result.content[0].text.trim();
    if (draft.toAddress) store.saveToneExample(draft.toAddress, draft.toName, draft.draft, rewritten, draft.subject);
    store.savePendingDraft({ ...draft, draft: rewritten, awaitingReply: false });
    const confirmMsg = 'Rewritten! ✏️\n\n' + rewritten + '\n\n"send" when you are happy 👍';
    store.saveConversationTurn('penelope', confirmMsg);
    return waSend(confirmMsg);
  }
  if (draft.toAddress) store.saveToneExample(draft.toAddress, draft.toName, draft.draft, newText, draft.subject);
  store.savePendingDraft({ ...draft, draft: newText, awaitingReply: false });
  const confirmMsg = 'Updated! ✏️\n\n' + newText + '\n\n"send" when you are happy 👍';
  store.saveConversationTurn('penelope', confirmMsg);
  return waSend(confirmMsg);
}

async function handleTask(emailIndex, personName, sectionHint) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded — say "update" first 📬');
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
    return waSend('Had trouble adding that to Todoist 😕\n' + (err.response ? JSON.stringify(err.response.data) : err.message));
  }
}

async function handleDelegate(emailIndex, delegateTo, personName) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return waSend('Could not find that email 🔍');
  if (!delegateTo) return waSend('Who should I delegate this to? 👤');
  const delegateEmail = DELEGATES[delegateTo.toLowerCase()];
  if (!delegateEmail) return waSend('I do not have ' + delegateTo + '\'s email 👤');
  const brief = await claude.draftDelegation(email, delegateTo);
  await graph.sendEmail({ to: delegateEmail, subject: 'For your action: ' + email.subject, body: brief });
  store.setEmailAction(email.id, 'delegated', 'to ' + delegateTo);
  const msg = 'Done! ✅ Brief sent to ' + delegateTo;
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
      claude.addIgnored(email.from.includes('@') ? email.from.split('@')[1] : email.from);
      const msg = 'Done! 🙅 I will stop showing emails from ' + (email.fromName || email.from) + '.';
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
      (i+1) + '. To: ' + e.to + '\n' + e.subject + '\n' +
      new Date(e.sentAt).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
      '\n' + e.preview
    ).join('\n\n');
    const msg = 'Here is what you sent 📤\n\n' + list;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) { return waSend('Had trouble looking that up 😕 — ' + err.message); }
}

async function handleMarkRead(emailIndex, personName) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded 📬');
  if (emailIndex !== null || personName) {
    const email = findEmail(session, emailIndex, personName);
    if (email) { await graph.markAsRead(email.id); store.setEmailAction(email.id, 'read', 'marked as read'); return waSend('Done! ✅ Marked as read.'); }
  }
  const actions = store.getEmailActions();
  const toMark = session.emails.filter(e => !actions[e.id]).map(e => e.id);
  if (!toMark.length) return waSend('Nothing left to mark as read 👍');
  const count = await graph.markMultipleAsRead(toMark);
  toMark.forEach(id => store.setEmailAction(id, 'read', 'marked as read'));
  const msg = 'Done! ✅ Marked ' + count + ' emails as read.';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleRepeat(itemReference) {
  const session = store.getSession();
  if (!session) return waSend('Nothing to repeat — say "update" to get a fresh digest 📬');
  if (itemReference) {
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
  if (!session) return waSend('No emails loaded — say "update" first 📬');
  const email = (emailIndex !== null || personName) ? findEmail(session, emailIndex, personName) : itemReference ? findEmailByKeyword(session, itemReference) : null;
  if (!email) return waSend('Which email do you want more detail on? 🔍');
  try {
    const date = new Date(email.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    let detail = email.subject + '\nFrom: ' + (email.fromName || email.from) + '\n' + date + '\n\n' + email.preview;
    if (email.hasAttachments) {
      const attachments = await graph.getAttachments(email.id, email.account);
      for (const att of attachments.slice(0, 2)) {
        const summary = await claude.analyseAttachment(att);
        if (summary) detail += '\n\nAttachment — ' + att.name + ':\n' + summary;
      }
    }
    store.saveConversationTurn('penelope', detail);
    return waSend(detail);
  } catch (err) { return waSend('Had trouble getting that 😕 — ' + err.message); }
}

async function handleAttachmentQuery(emailIndex, personName, question, itemReference) {
  const session = store.getSession();
  if (!session) return waSend('No emails loaded — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName) || (itemReference ? findEmailByKeyword(session, itemReference) : null);
  if (!email) return waSend('Which email\'s attachment are you asking about? 🔍');
  if (!email.hasAttachments) return waSend('That email does not have any attachments 📎');
  try {
    const attachments = await graph.getAttachments(email.id, email.account);
    const docAtts = attachments.filter(a => a.contentBytes && (a.contentType.includes('pdf') || a.contentType.includes('word') || a.contentType.includes('document')));
    if (!docAtts.length) return waSend('I can only read PDFs and Word docs 😕');
    const result = await claude.analyseAttachment(docAtts[0], question);
    const msg = result || 'Could not extract that info 😕';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) { return waSend('Had trouble reading that 😕 — ' + err.message); }
}

async function handleStakeholderAssign(content) {
  if (!content) return waSend('What should I remember? E.g. "Craig handles site issues" 👍');
  const match = content.match(/^(\w+)\s+handles?\s+(.+)$/i);
  if (match) {
    store.saveStakeholderAssignment(match[2], match[1]);
    const msg = 'Got it! 🧠 ' + match[1] + ' handles ' + match[2] + '.';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  }
  return waSend('Got it, noted 🧠');
}

async function handleTasksToday() {
  try {
    const tasks = await todoist.getTodayTasks();
    if (!tasks.length) return waSend('No outstanding tasks due today! 🎉');
    store.savePendingTasks(tasks);
    const lines = tasks.map((t, i) => '[T' + (i+1) + '] ' + t.content + (t.dueBritish ? ' — ' + t.dueBritish : (t.due ? ' — ' + t.due.date : ''))).join('\n');
    const msg = '📋 Outstanding tasks (' + tasks.length + '):\n\n' + lines + '\n\nSay "postpone T2 to Friday", "postpone the [task name] to [date]", or "postpone all to tomorrow"';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) { return waSend('Had trouble fetching tasks 😕 — ' + err.message); }
}

async function handlePostponeTask(taskIndex, dueString, itemReference) {
  let tasks = store.getPendingTasks();
  if (!tasks || !tasks.length) { tasks = await todoist.getTodayTasks(); if (tasks.length) store.savePendingTasks(tasks); }
  if (!tasks || !tasks.length) return waSend('You have no outstanding tasks due today 🎉');
  let task = null;
  if (taskIndex !== null && taskIndex !== undefined && !isNaN(taskIndex)) task = tasks[taskIndex] || null;
  if (!task && itemReference) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const kw = norm(itemReference);
    const kwWords = kw.split(' ').filter(w => w.length > 2);
    let bestScore = 0, bestTask = null;
    for (const t of tasks) {
      const score = kwWords.filter(w => norm(t.content).includes(w)).length;
      if (score > bestScore) { bestScore = score; bestTask = t; }
    }
    if (bestScore > 0) task = bestTask;
  }
  if (!task && itemReference) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const config = require('./config');
      const client = new Anthropic({ apiKey: config.anthropic.apiKey });
      const result = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 50,
        messages: [{ role: 'user', content: 'Tasks:\n' + tasks.map((t,i) => '['+i+'] '+t.content).join('\n') + '\n\nUser said: "' + itemReference + '"\nReturn ONLY the 0-based index of the closest match, or -1.' }]
      });
      const idx = parseInt(result.content[0].text.trim(), 10);
      if (idx >= 0 && tasks[idx]) task = tasks[idx];
    } catch {}
  }
  if (!task) {
    return waSend('Not sure which task you mean 🔍 Here are your outstanding ones:\n\n' + tasks.map((t,i) => '[T'+(i+1)+'] '+t.content).join('\n') + '\n\nSay "postpone T2 to Friday" or "postpone the [task name] to [date]"');
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
  const results = await todoist.postponeAllTasks(tasks, newDate);
  const msg = 'Done! ✅ ' + results.length + ' task' + (results.length > 1 ? 's' : '') + ' moved to ' + newDate + ':\n\n' + results.map(r => '• ' + r.content).join('\n');
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleDaySummary(offsetDays) {
  const label = offsetDays === 0 ? 'Today' : 'Tomorrow — ' + new Date(Date.now() + 86400000).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' });
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
    return waSend('Had trouble pulling that together 😕 — ' + err.message);
  }
}

async function handleCalendarAdd(text, calendarNameHint, skipTaskCheck) {
  try {
    const conversation = store.getConversation();
    // Skip task disambiguation if user explicitly wants calendar or personal calendar
    const tasks = (!skipTaskCheck && !calendarNameHint) ? await todoist.getTodayTasks() : [];
    if (tasks.length > 0) {
      const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      const textWords = norm(text).split(' ').filter(w => w.length > 2 && !['add','move','put','set','the','for','please','can','you','to','my'].includes(w));
      let bestScore = 0, bestTask = null;
      for (const t of tasks) {
        const score = textWords.filter(w => norm(t.content).includes(w)).length;
        if (score > bestScore) { bestScore = score; bestTask = t; }
      }
      if (bestScore >= 2 || (bestScore === 1 && textWords.length <= 3)) {
        const dateMatch = text.match(/to (tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next \w+|\d+ \w+)/i);
        if (dateMatch) {
          await todoist.updateTaskDue(bestTask.id, dateMatch[1]);
          const msg = 'Done! ✅ "' + bestTask.content + '" moved to ' + dateMatch[1];
          store.saveConversationTurn('penelope', msg);
          return waSend(msg);
        }
        const clarifyMsg = 'Did you mean:\n\n📋 Postpone the task "' + bestTask.content + '" in Todoist\nor\n📅 Add it as a new calendar event?\n\nSay "task" or "calendar"';
        store.savePendingDraft({ type: 'ambiguous', taskId: bestTask.id, taskContent: bestTask.content, originalText: text, calendarNameHint: calendarNameHint || null, awaitingClarify: true });
        return waSend(clarifyMsg);
      }
    }
    const eventData = await claude.parseCalendarEvent(text, conversation);
    if (!eventData || !eventData.title || !eventData.start) {
      return waSend('I need a bit more detail 📅\n\nTry: "Add a meeting with Jan tomorrow at 2pm"');
    }
    // Apply calendarName hint from initial request
    if (calendarNameHint) eventData.calendarName = calendarNameHint;

    // Step 1: Resolve attendees first
    if (eventData.attendees && eventData.attendees.length) {
      try {
        const session = store.getSession();
        const resolved = await graph.resolveAttendees(eventData.attendees, session);
        eventData.attendees = resolved;
        console.log('[calendar] resolved attendees:', resolved);
        // If all attendees are internal MYDIS, force MYDIS calendar
        const allMydis = resolved.filter(e => !e.includes('email not found')).every(e => e.includes('@mydis.com') || e.includes('@iwsuk.com'));
        const anyExternal = resolved.some(e => e.includes('@') && !e.includes('@mydis.com') && !e.includes('@iwsuk.com') && !e.includes('email not found'));

        // Auto-detect IWS account — only if there are external contacts
        if (!calendarNameHint && eventData.account !== 'iws' && anyExternal) {
          // Check session emails first
          const iwsSessionEmails = (session && session.emails || []).filter(e => e.account === 'iws');
          const foundInIwsSession = resolved.some(email =>
            iwsSessionEmails.some(e => e.from.toLowerCase() === (email || '').toLowerCase())
          );
          if (foundInIwsSession) {
            eventData.account = 'iws';
            console.log('[calendar] routing to IWS based on session');
          } else {
            // Check IWS sent emails for any of the attendee domains
            try {
              for (const email of resolved) {
                if (!email.includes('@') || email.includes('email not found')) continue;
                const domain = email.split('@')[1];
                const inIwsSent = await graph.searchEmailsInFolder('raees@iwsuk.com', domain, 'sentitems');
                const inIwsInbox = await graph.searchEmailsInFolder('raees@iwsuk.com', domain, 'inbox');
                if (inIwsSent || inIwsInbox) {
                  eventData.account = 'iws';
                  console.log('[calendar] routing to IWS based on email history with', domain);
                  break;
                }
              }
            } catch (err) {
              console.error('[calendar] IWS domain check error:', err.message);
            }
          }
        }
      } catch (err) {
        console.error('[calendar] attendee resolution error:', err.message);
      }
    }

    // Step 2: Check for clashes and nearby meetings
    let clashNote = '';
    try {
      const eventStart = new Date(eventData.start);
      const eventEnd = new Date(eventData.end);
      const offsetDays = Math.round((eventStart - new Date().setHours(0,0,0,0)) / 86400000);
      const dayEvents = await graph.getCombinedCalendarEvents(offsetDays);

      const clashes = [], nearby = [];
      const newTitle = (eventData.title || '').toLowerCase();
      for (const e of dayEvents) {
        if (!e.startTime) continue;
        // Skip if it looks like the same event we're creating or a duplicate
        const existingTitle = (e.subject || '').toLowerCase()
          .replace(/^\[external:\]\s*/i, '')  // strip [EXTERNAL:] prefix
          .replace(/invitation:\s*/i, '')        // strip "Invitation:" prefix
          .replace(/@.*$/i, '')                  // strip @date suffix
          .trim();
        const isSameEvent = existingTitle.includes(newTitle) || newTitle.includes(existingTitle.split(' ')[0]);
        if (isSameEvent) continue;

        const eStart = new Date(e.startTime);
        const eEnd = new Date(e.endTime);
        const cleanSubject = e.subject.replace(/^\[EXTERNAL:\]\s*/i, '').replace(/Invitation:\s*/i, '').split('@')[0].trim();

        // Check overlap — includes back-to-back meetings (gap of 0 mins = clash)
        const overlapMins = (Math.min(eEnd, eventEnd) - Math.max(eStart, eventStart)) / 60000;
        if (overlapMins > 0) {
          // True overlap
          clashes.push(cleanSubject + ' (' +
            eStart.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) +
            ' - ' + eEnd.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ')');
        } else {
          const gapBefore = (eventStart - eEnd) / 60000; // mins between prev end and new start
          const gapAfter = (eStart - eventEnd) / 60000;  // mins between new end and next start
          if (gapBefore === 0) {
            // Back-to-back — count as clash
            clashes.push(cleanSubject + ' ends exactly when this starts (' +
              eEnd.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ')');
          } else if (gapBefore > 0 && gapBefore <= 30) {
            nearby.push('📅 ' + eEnd.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ' ends — ' + cleanSubject);
          }
          if (gapAfter === 0) {
            clashes.push(cleanSubject + ' starts exactly when this ends (' +
              eStart.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ')');
          } else if (gapAfter > 0 && gapAfter <= 30) {
            nearby.push('📅 ' + eStart.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ' starts — ' + cleanSubject);
          }
        }
      }
      if (clashes.length) clashNote += '\n\n⚠️ CLASH with: ' + clashes.join(', ');
      if (nearby.length) clashNote += '\n\n⏰ Nearby meetings:\n' + nearby.join('\n');
    } catch (err) { console.error('[calendar] clash check error:', err.message); }

    // Step 3: Build confirmation message with resolved data
    const startStr = new Date(eventData.start).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const endStr = new Date(eventData.end).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
    const loc = eventData.location ? '\n📍 ' + eventData.location : '';
    const acct = eventData.calendarName === 'personal' ? ' [Personal calendar]' : eventData.account === 'iws' ? ' [IWS calendar]' : ' [MYDIS calendar]';
    const attendeeNote = eventData.attendees && eventData.attendees.length
      ? '\n👥 Inviting: ' + eventData.attendees.join(', ')
      : '';
    const confirmMsg = 'Adding to your calendar' + acct + ':\n\n📅 ' + eventData.title + '\n🕐 ' + startStr + ' — ' + endStr + loc + attendeeNote + clashNote + '\n\nSay "yes" to confirm or "cancel" to stop.';

    // Step 3: Ask about Teams link if meeting has attendees and not in-person
    const needsOnlineCheck = eventData.attendees && eventData.attendees.length > 0 && !eventData.onlineMeeting;
    const isObviouslyInPerson = /(site|office|factory|farm|location|address|visit|on.?site|in.?person)/i.test(text || '');

    if (needsOnlineCheck && !isObviouslyInPerson) {
      store.savePendingDraft({ type: 'calendar_event', eventData, awaitingConfirm: true, awaitingTeamsCheck: true });
      const teamsMsg = confirmMsg + '\n\n📹 Add a Teams meeting link? Say "yes teams" or "no"';
      store.saveConversationTurn('penelope', teamsMsg);
      return waSend(teamsMsg);
    }

    store.savePendingDraft({ type: 'calendar_event', eventData, awaitingConfirm: true });
    store.saveConversationTurn('penelope', confirmMsg);
    return waSend(confirmMsg);
  } catch (err) {
    return waSend('Had trouble with that 😕 — ' + err.message);
  }
}

async function handleAddVip(personName, emailAddr) {
  if (!personName && !emailAddr) return waSend('Who do you want to add as a VIP? 👤');
  const session = store.getSession();
  let resolvedEmail = emailAddr, resolvedName = personName;
  if (session && personName) {
    const found = session.emails.find(e => (e.fromName || '').toLowerCase().includes(personName.toLowerCase()) || e.from.toLowerCase().includes(personName.toLowerCase()));
    if (found) { resolvedEmail = found.from; resolvedName = found.fromName || found.from; }
  }
  store.addVip(resolvedEmail, resolvedName, 'Added by Raees');
  const msg = 'Done! ⭐ ' + (resolvedName || resolvedEmail) + ' is now a VIP.';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleRememberRule(ruleText) {
  if (!ruleText) return waSend('What should I remember? 🧠');
  store.saveRule(ruleText);
  const msg = 'Got it! 🧠 "' + ruleText + '"';
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleContactPref(personName, prefText) {
  if (!personName || !prefText) return waSend('Who is this about and what should I know? 👤');
  const session = store.getSession();
  let emailKey = personName.toLowerCase();
  if (session) { const found = session.emails.find(e => (e.fromName || '').toLowerCase().includes(personName.toLowerCase())); if (found) emailKey = found.from.toLowerCase(); }
  const lower = prefText.toLowerCase();
  const formality = lower.includes('informal') || lower.includes('casual') ? 'informal' : lower.includes('formal') || lower.includes('professional') ? 'formal' : null;
  store.saveContactPref(emailKey, { formality: formality || undefined, notes: prefText });
  const msg = 'Noted! 🧠 When writing to ' + personName + ': ' + prefText;
  store.saveConversationTurn('penelope', msg);
  return waSend(msg);
}

async function handleComposeEmail(recipientNames, topic, originalText, autoSend) {
  if (!recipientNames) return waSend('Who do you want to send this to? 👤');
  const session = store.getSession();
  const TEAM_MAP = {
    'hamid':'hamid@mydis.com','falak':'falak@mydis.com','lilian':'lilian@mydis.com',
    'craig':'craig@mydis.com','adegoke':'adegoke@mydis.com','ade':'adegoke@mydis.com',
    'basat':'basat@mydis.com','bas':'basat@mydis.com','shams':'shams@mydis.com','al':'al@iwsuk.com',
  };
  const names = recipientNames.split(/,|and/).map(n => n.trim().toLowerCase()).filter(Boolean);
  const resolved = [], unresolved = [];
  for (const name of names) {
    // 1. MYDIS team map
    const teamEmail = TEAM_MAP[name];
    if (teamEmail) { resolved.push({ name: name.charAt(0).toUpperCase() + name.slice(1), email: teamEmail }); continue; }

    // 2. Session emails (current inbox)
    if (session) {
      const found = session.emails.find(e =>
        (e.fromName || '').toLowerCase().includes(name) || e.from.toLowerCase().includes(name)
      );
      if (found) { resolved.push({ name: found.fromName || found.from, email: found.from }); continue; }
    }

    // 3. VIP contacts
    const vips = store.getVips();
    const vipMatch = Object.values(vips || {}).find(v => (v.name || '').toLowerCase().includes(name));
    if (vipMatch && vipMatch.email) { resolved.push({ name: vipMatch.name || name, email: vipMatch.email }); continue; }

    // 4. Microsoft contacts
    try {
      const contacts = await graph.searchContacts(name, null);
      if (contacts.length > 0) { resolved.push({ name: contacts[0].name || name, email: contacts[0].email }); continue; }
    } catch {}

    // 5. Search sent + inbox emails
    try {
      const foundEmail = await graph.searchEmailsForPerson(name);
      if (foundEmail) {
        resolved.push({ name: name.charAt(0).toUpperCase() + name.slice(1), email: foundEmail });
        continue;
      }
    } catch {}

    unresolved.push(name);
  }
  if (unresolved.length > 0) {
    return waSend('I could not find email addresses for: ' + unresolved.join(', ') + '\n\nTry their full name, or say "add [name] as VIP" after emailing them once.');
  }
  await waSend('Sure Raees, drafting that now... ✍️');
  await new Promise(r => setTimeout(r, 800));
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const travelling = global.PENELOPE_TRAVELLING || false;
  const signature = travelling ? 'Kind Regards\nRaees Sayed\n(I\'m currently travelling so replies may be slower)' : 'Kind Regards\nRaees Sayed';
  const greetingNames = resolved.length === 1
    ? resolved[0].name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : resolved.map(r => r.name.split(' ')[0].charAt(0).toUpperCase() + r.name.split(' ')[0].slice(1)).join(' and ');
  const draftResult = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 500,
    messages: [{ role: 'user', content: 'Draft a professional email from Raees to ' + resolved.map(r=>r.name).join(' and ') + ' about: ' + (topic || originalText) + '\n\nFormatting:\n- Start with "Hi ' + greetingNames + ',"\n- Blank line after greeting\n- Short clear body\n- Blank line then signature:\n' + signature + '\n\nReturn ONLY the email body.' }]
  });
  const draft = draftResult.content[0].text.trim();
  const subjectResult = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 30,
    messages: [{ role: 'user', content: 'Short email subject line (max 8 words) for: ' + (topic || originalText) + '. Return only the subject.' }]
  });
  const subject = subjectResult.content[0].text.trim().replace(/^subject:\s*/i, '');
  const toLine = resolved.map(r => r.name.charAt(0).toUpperCase() + r.name.slice(1) + ' (' + r.email + ')').join(', ');
  // Always show draft — never auto-send without showing Raees first
  store.savePendingDraft({ type: 'new_email', recipients: resolved, subject, draft, awaitingReply: false, awaitingConfirm: true });
  const confirmMsg = 'Here is your draft:\n\nTo: ' + toLine + '\nSubject: ' + subject + '\n\n' + draft + '\n\n"send" to fire it off\n"edit [changes]" to tweak';
  store.saveConversationTurn('penelope', confirmMsg);
  // Store the draft key so calendar handler can reference it
  const savedDraft = store.getPendingDraft();
  if (savedDraft) store.savePendingDraft({ ...savedDraft, _toLine: toLine, _subject: subject });
  return waSend(confirmMsg);
}

async function handleUpdateCalendarEvent(eventKeyword, changeDescription, originalText, autoConfirm) {
  if (!eventKeyword) return waSend('Which meeting do you want to update? 📅');
  await waSend('Sure Raees, finding that meeting... 📅');
  await new Promise(r => setTimeout(r, 600));
  try {
    const [mydisEvent, iwsEvent] = await Promise.all([graph.findCalendarEvent(eventKeyword, 'mydis'), graph.findCalendarEvent(eventKeyword, 'iws')]);
    const found = mydisEvent || iwsEvent;
    const account = mydisEvent ? 'mydis' : 'iws';
    if (!found) return waSend('Could not find a meeting matching "' + eventKeyword + '" 🔍');
    const userEmail = (process.env.USER_EMAIL || '').toLowerCase();
    const organiserEmail = (found.organizer && found.organizer.emailAddress ? found.organizer.emailAddress.address : '').toLowerCase();
    const isOrganiser = organiserEmail.includes(userEmail.split('@')[0]) || organiserEmail === userEmail || organiserEmail === 'raees@iwsuk.com';

    // Parse the requested change FIRST (before organiser check so updates are available)
    const Anthropic = require('@anthropic-ai/sdk');
    const config = require('./config');
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const currentStart = found.start ? found.start.dateTime : '';
    const currentEnd = found.end ? found.end.dateTime : '';
    const parseResult = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 200,
      messages: [{ role: 'user', content: 'Current event: "' + found.subject + '" starts ' + currentStart + ' ends ' + currentEnd + '\nNow: ' + new Date().toISOString() + '\nChange: "' + (changeDescription || originalText) + '"\n\nReturn ONLY JSON: { "start": "ISO8601 or null", "end": "ISO8601 or null", "title": null, "location": null }\nIf only time changes keep same date.' }]
    });
    const rawParse = parseResult.content[0].text.trim();
    const mParse = rawParse.match(/\{[\s\S]*\}/);
    const updates = mParse ? JSON.parse(mParse[0]) : {};
    console.log('[calendar] parsed updates:', JSON.stringify(updates));

    if (!isOrganiser && organiserEmail) {
      const organiserName = (found.organizer && found.organizer.emailAddress ? found.organizer.emailAddress.name : null) || organiserEmail;
      if (autoConfirm) {
        // Attach calendar context to the pending email draft and show combined prompt
        const existingDraft = store.getPendingDraft();
        if (existingDraft) {
          store.savePendingDraft({
            ...existingDraft,
            pendingCalendar: { organiserName, organiserEmail, found, updates, account },
            awaitingCombinedAction: true,
          });
          const calNote = '\n\n📅 Calendar: "' + found.subject + '" is organised by ' + organiserName + ' — they will need to accept the change.\n\n' +
            'What would you like to do?\n' +
            '📧 "send" — send the email only\n' +
            '📅 "propose" — propose the new time on the calendar only\n' +
            '✅ "both" — send the email AND propose the new time';
          const currentDraft = store.getPendingDraft();
          const updatedMsg = currentDraft._lastMsg ? currentDraft._lastMsg + calNote : calNote;
          store.savePendingDraft({ ...store.getPendingDraft(), _calNote: calNote });
          return waSend(calNote);
        }
        return waSend('FYI: ' + organiserName + ' organised "' + found.subject + '" — they need to accept the change.');
      }
      // Save context for follow-up
      store.savePendingDraft({ type: 'organiser_decision', organiserName, organiserEmail, found, updates, account, awaitingOrganiserDecision: true });
      return waSend('You are not the organiser of "' + found.subject + '" — ' + organiserName + ' set it up.\n\nWhat would you like me to do?\n📧 "email them" — email ' + organiserName + ' to request the change\n📅 "propose" — propose the new time on the calendar\n✅ "both" — do both');
    }

    if (!updates.start && !updates.end && !updates.title && !updates.location) {
      return waSend('Not sure what change you want — try "move it to 2pm" or "change it to tomorrow"');
    }
    const newStartStr = updates.start
      ? new Date(updates.start).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : currentStart ? new Date(currentStart).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const newEndStr = (updates.end || currentEnd) ? new Date(updates.end || currentEnd).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
    if (autoConfirm) {
      await graph.updateCalendarEvent(found.id, updates, account);
      const msg = 'Done! ✅ "' + found.subject + '" updated to ' + newStartStr + (newEndStr ? ' — ' + newEndStr : '');
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }
    store.savePendingDraft({ type: 'calendar_update', eventId: found.id, account, updates, eventTitle: found.subject, awaitingConfirm: true });
    const confirmMsg = 'Updating "' + found.subject + '":\n\n📅 New time: ' + newStartStr + (newEndStr ? ' — ' + newEndStr : '') + '\n\nSay "yes" to confirm or "cancel" to stop.';
    store.saveConversationTurn('penelope', confirmMsg);
    return waSend(confirmMsg);
  } catch (err) {
    return waSend('Had trouble updating that 😕 — ' + err.message);
  }
}

function findEmail(session, emailIndex, personName) {
  if (!session || !session.emails) return null;
  if (emailIndex !== null && emailIndex !== undefined && !isNaN(emailIndex)) return session.emails[emailIndex] || null;
  if (personName) {
    const parts = personName.toLowerCase().trim().split(/\s+/);
    return session.emails.find(e => {
      const sn = (e.fromName || '').toLowerCase(), se = e.from.toLowerCase();
      return parts.every(p => sn.includes(p) || se.includes(p));
    }) || null;
  }
  return null;
}

function findEmailByKeyword(session, keyword) {
  if (!session || !session.emails || !keyword) return null;
  const kw = keyword.toLowerCase();
  return session.emails.find(e =>
    (e.fromName || '').toLowerCase().includes(kw) || e.from.toLowerCase().includes(kw) ||
    e.subject.toLowerCase().includes(kw) || e.preview.toLowerCase().includes(kw)
  ) || null;
}

async function handleCalendarSearch(keyword) {
  if (!keyword) return waSend('What event are you looking for? 🔍');
  await waSend('Searching your calendar... 🔍');

  // Extract the key search term — strip question words
  const searchTerm = keyword
    .replace(/^(can you |please )?(tell me |check |find |look up |when is |what day is |what time is |is there |do i have |where is )/i, '')
    .replace(/(meeting|call|appointment|event|session|on my calendar|scheduled|\?)/gi, '')
    .trim() || keyword;

  try {
    const [mydisEvent, iwsEvent] = await Promise.all([
      graph.findCalendarEvent(searchTerm, 'mydis', 90),
      graph.findCalendarEvent(searchTerm, 'iws', 90),
    ]);

    const found = mydisEvent || iwsEvent;
    if (!found) {
      return waSend('I could not find "' + searchTerm + '" in your calendar for the next 90 days 🔍\n\nTry giving me the exact event name.');
    }

    const start = found.start ? found.start.dateTime : found.startTime;
    const end = found.end ? found.end.dateTime : found.endTime;
    const dateStr = new Date(start).toLocaleString('en-GB', {
      timeZone: 'Europe/London', weekday: 'long', day: 'numeric',
      month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const endStr = end ? new Date(end).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) : '';
    const loc = found.location
      ? (typeof found.location === 'string' ? found.location : found.location.displayName || null)
      : null;
    const acct = found.account === 'iws' ? ' [IWS]' : '';
    const msg = '📅 Found it!' + acct + '\n\n' + (found.subject || searchTerm) +
      '\n🗓 ' + dateStr + (endStr ? ' — ' + endStr : '') +
      (loc ? '\n📍 ' + loc : '');
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    return waSend('Had trouble searching 😕 — ' + err.message);
  }
}

async function handleCreateTask(taskContent, sectionHint, originalText) {
  if (!taskContent && !originalText) return waSend('What task should I add? 📋');

  // Use Claude to extract a clean task description from the natural language request
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const result = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 200,
    messages: [{ role: 'user', content: 'Extract a Todoist task from this request: "' + (taskContent || originalText) + '"\n\nReturn ONLY valid JSON:\n{ "title": "concise task title (max 80 chars)", "description": "more detail if needed (max 150 chars)", "due_string": "today or specific date if mentioned", "section": "section name if mentioned, otherwise null" }\n\nFor section: if user says "under Sales" use "Sales", "Operations" use "Operations" etc. If not mentioned return null.' }]
  });

  let parsed;
  try {
    const raw = result.content[0].text.trim();
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { parsed = null; }

  const title = parsed ? parsed.title : (taskContent || originalText).slice(0, 80);
  const description = parsed ? parsed.description : '';
  const dueString = parsed ? (parsed.due_string || 'today') : 'today';
  const section = sectionHint || (parsed ? parsed.section : null) || 'operations';

  try {
    const task = await todoist.createTask({
      title,
      description,
      due_string: dueString,
      section,
    });
    const sectionLabel = section.charAt(0).toUpperCase() + section.slice(1);
    const msg = 'Done! ✅ Task added to ' + sectionLabel + ':\n"' + title + '"\nDue: ' + dueString;
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    return waSend('Had trouble adding that to Todoist 😕 — ' + err.message);
  }
}

async function handleCalendarFree(queryText) {
  await waSend('Checking your calendar... 📅');

  // Extract the day from the query
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const now = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const parseResult = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 100,
    messages: [{ role: 'user', content: 'Today is ' + now + '. From this query: "' + queryText + '" extract the date being asked about. Return ONLY a date in YYYY-MM-DD format. If "next Tuesday" calculate the actual date.' }]
  });
  const dateStr = parseResult.content[0].text.trim().match(/\d{4}-\d{2}-\d{2}/)?.[0];

  if (!dateStr) return waSend('Which day are you asking about? 📅');

  try {
    const offsetDays = Math.round((new Date(dateStr) - new Date().setHours(0,0,0,0)) / 86400000);
    const events = await graph.getCombinedCalendarEvents(offsetDays);
    const dayLabel = new Date(dateStr).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' });

    if (!events.length) {
      const msg = '📅 ' + dayLabel + ' is completely free! 🎉\n\nWould you like to book something?';
      store.saveConversationTurn('penelope', msg);
      return waSend(msg);
    }

    // Work out free slots between 8am and 6pm
    const busySlots = events
      .filter(e => !e.isAllDay && e.startTime)
      .map(e => ({
        start: new Date(e.startTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }),
        end: new Date(e.endTime).toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }),
        title: e.subject,
      }));

    const busyLines = busySlots.map(s => '🔴 ' + s.start + ' - ' + s.end + ' — ' + s.title).join('\n');

    // Find free slots (simple gaps between meetings)
    const sorted = events.filter(e => !e.isAllDay && e.startTime).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    const freeSlots = [];
    let cursor = new Date(dateStr + 'T08:00:00');
    const endOfDay = new Date(dateStr + 'T18:00:00');

    for (const e of sorted) {
      const eStart = new Date(e.startTime);
      const eEnd = new Date(e.endTime);
      const gapMins = (eStart - cursor) / 60000;
      if (gapMins >= 30) {
        freeSlots.push(
          cursor.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) +
          ' - ' +
          eStart.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })
        );
      }
      if (eEnd > cursor) cursor = eEnd;
    }
    if ((endOfDay - cursor) / 60000 >= 30) {
      freeSlots.push(
        cursor.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }) + ' - 18:00'
      );
    }

    const freeLines = freeSlots.length
      ? '\n\n✅ Free slots:\n' + freeSlots.map(s => '🟢 ' + s).join('\n')
      : '\n\nNo significant free slots found.';

    const msg = '📅 ' + dayLabel + '\n\nBusy:\n' + busyLines + freeLines + '\n\nSay "book [time] for 1h with [person]" to schedule something.';
    store.saveConversationTurn('penelope', msg);
    return waSend(msg);
  } catch (err) {
    return waSend('Had trouble checking that 😕 — ' + err.message);
  }
}

module.exports = { handleInbound };
