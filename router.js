const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const todoist  = require('./todoist');
const store    = require('./store');

const DELEGATES = {
  // 'lilian': 'lilian@yourdomain.com',
};

async function parseIntent(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const session = store.getSession();
  const emailList = session ? session.emails.map((e, i) =>
    '[' + (i+1) + '] index=' + i + ' | name="' + (e.fromName || '') + '" | email="' + e.from + '" | subject="' + e.subject + '"'
  ).join('\n') : 'No emails loaded.';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 250,
    system: `Parse a command for an email assistant. Return ONLY valid JSON, nothing else.

Current emails:
${emailList}

CRITICAL name matching rules:
- Only match an email if the name Raees mentions is clearly present in the sender name or email address
- Do NOT suggest alternative emails or nearest matches
- If Raees says "Joanne" only match emails where the sender name contains "Joanne" or similar
- If no clear match, set emailIndex to null — do NOT guess
- Raees knows who he means better than you do

Intents: update | reply | send | edit | task | delegate | ignore | unsubscribe | what_sent | period_update | help | unknown

period_update: asking for update on last X mins/hours (e.g. "what happened in the last hour", "update me on last 30 mins")
- Set minutes field (integer): 60 for 1 hour, 30 for 30 mins, 1440 for today, etc

Return JSON:
{ "intent": "...", "emailIndex": null or 0-based integer, "personName": null or string, "delegateTo": null or string, "content": null or string, "minutes": null or integer }`,
    messages: [{ role: 'user', content: text }]
  });

  try {
    const raw = msg.content[0].text.trim();
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { intent: 'unknown' };
  } catch { return { intent: 'unknown' }; }
}

async function handleInbound(text) {
  console.log('[router] received:', text);

  // If we're awaiting a reply body, treat any message as the reply content
  const draft = store.getPendingDraft();
  if (draft && draft.awaitingReply) {
    const lower = text.toLowerCase().trim();
    if (lower !== 'cancel' && lower !== 'send' && lower !== 'update') {
      return handleReplyContent(text, draft);
    }
  }

  const parsed = await parseIntent(text);
  console.log('[router] intent:', JSON.stringify(parsed));

  switch (parsed.intent) {
    case 'update':
      await whatsapp.send('On it! 📬');
      return require('./digest').runDigest();

    case 'period_update':
      return handlePeriodUpdate(parsed.minutes || 60);

    case 'reply':
      return handleReply(parsed.emailIndex, parsed.content, parsed.personName);

    case 'send':
      return handleSend(text);

    case 'edit':
      return handleEdit(parsed.content || text.replace(/^edit\s*/i, '').trim());

    case 'task':
      return handleTask(parsed.emailIndex, parsed.personName);

    case 'delegate':
      return handleDelegate(parsed.emailIndex, parsed.delegateTo, parsed.personName);

    case 'ignore':
      return handleIgnore(parsed.emailIndex, parsed.personName);

    case 'unsubscribe':
      return handleUnsubscribe(parsed.emailIndex, parsed.personName);

    case 'what_sent':
      return handleWhatSent(parsed.personName || parsed.content);

    case 'help':
      return whatsapp.send(
        'Here\'s what you can ask me 👇\n\n' +
        '"update" — get digest now\n' +
        '"what happened in the last hour" — full update for that period\n' +
        '"reply to Joanne" — I\'ll ask what to say\n' +
        '"task 3" — add to Todoist\n' +
        '"delegate 2 to Lilian"\n' +
        '"ignore emails from Katy Payne"\n' +
        '"unsubscribe from email 4"\n' +
        '"what did I send to Jo?"\n' +
        '"send" — dispatch pending draft'
      );

    default:
      await whatsapp.send('Hmm, not sure what you mean there 🤔 Say "help" for a list of things I can do!');
  }
}

async function handlePeriodUpdate(minutes) {
  const session = store.getSession();
  if (!session) {
    await whatsapp.send('On it! 📬');
    return require('./digest').runDigest();
  }
  const label = minutes >= 1440 ? 'today' : minutes >= 60 ? 'the last ' + Math.round(minutes/60) + ' hour' + (minutes > 60 ? 's' : '') : 'the last ' + minutes + ' mins';
  await whatsapp.send('Here\'s your update for ' + label + '... 🔍');
  const actions = store.getEmailActions();
  const summary = await claude.summariseWithContext(session.emails, minutes, actions);
  await whatsapp.send(summary);
}

async function handleReply(emailIndex, content, personName) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No emails loaded yet — say "update" to fetch them first 📬');

  const email = findEmail(session, emailIndex, personName);
  if (!email) {
    if (personName) return whatsapp.send('I couldn\'t find an email from "' + personName + '" in the current digest 🔍\n\nSay "update" to refresh, or check the name matches what\'s shown in the digest.');
    return whatsapp.send('Which email did you want to reply to? Give me a name or number from the digest 📬');
  }

  store.savePendingDraft({ messageId: email.id, toAddress: email.from, toName: email.fromName || email.from, subject: email.subject, draft: '', awaitingReply: true });

  if (!content) {
    return whatsapp.send('Sure! ✉️ Replying to ' + (email.fromName || email.from) + ' re: ' + email.subject + '\n\nWhat would you like to say?');
  }

  return handleReplyContent(content, { messageId: email.id, toAddress: email.from, toName: email.fromName || email.from, subject: email.subject });
}

async function handleReplyContent(content, draftInfo) {
  await whatsapp.send('Polishing that up... ✍️');
  const session = store.getSession();
  const email = session ? session.emails.find(e => e.id === draftInfo.messageId) : null;
  const polished = email ? await claude.reviewReply(email, content) : content;
  store.savePendingDraft({ ...draftInfo, draft: polished, awaitingReply: false });
  await whatsapp.send('Here\'s your draft to ' + draftInfo.toName + ':\n\n' + polished + '\n\n✅ "send" to fire it off\n✏️ "edit [changes]" to tweak it');
}

async function handleSend(originalText) {
  const draft = store.getPendingDraft();
  if (!draft) return whatsapp.send('Nothing waiting to be sent! Start with "reply to [name]" 📝');
  if (!draft.draft) return whatsapp.send('The draft is empty — say "edit [your reply]" to add content 📝');
  await graph.replyToEmail(draft.messageId, draft.draft);
  store.setEmailAction(draft.messageId, 'replied', 'to ' + draft.toName);
  store.clearPendingDraft();
  await whatsapp.send('Done! ✅ Reply sent to ' + draft.toName);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();
  if (!draft) return whatsapp.send('No draft to edit — start with "reply to [name]" first 📝');
  store.savePendingDraft({ ...draft, draft: newText, awaitingReply: false });
  await whatsapp.send('Updated! ✏️\n\n' + newText + '\n\n"send" when you\'re happy 👍');
}

async function handleTask(emailIndex, personName) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No emails loaded — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return whatsapp.send('Couldn\'t find that email 🔍 Try the number from the digest.');
  await whatsapp.send('Adding to Todoist... 📋');
  const taskData = await claude.extractTask(email);
  const task = await todoist.createTask(taskData);
  store.setEmailAction(email.id, 'tasked', task.content);
  await whatsapp.send('Done! ✅ Task added:\n"' + task.content + '"\nDue: ' + (task.due ? task.due.string : taskData.due_string));
}

async function handleDelegate(emailIndex, delegateTo, personName) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No emails loaded — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return whatsapp.send('Couldn\'t find that email 🔍');
  if (!delegateTo) return whatsapp.send('Who should I delegate this to? Say "delegate [number] to [name]" 👤');
  const delegateEmail = DELEGATES[delegateTo.toLowerCase()];
  if (!delegateEmail) return whatsapp.send('I don\'t have ' + delegateTo + '\'s email address yet 👤\n\nAdd it to the DELEGATES list in router.js and I\'ll handle it from there!');
  await whatsapp.send('Drafting the brief for ' + delegateTo + '... ✍️');
  const brief = await claude.draftDelegation(email, delegateTo);
  await graph.sendEmail({ to: delegateEmail, subject: 'For your action: ' + email.subject, body: brief });
  store.setEmailAction(email.id, 'delegated', 'to ' + delegateTo);
  await whatsapp.send('Done! ✅ Brief sent to ' + delegateTo + ' (' + delegateEmail + ')');
}

async function handleIgnore(emailIndex, personName) {
  const session = store.getSession();
  let domainToIgnore = null;
  let nameToIgnore = personName;

  if (session && (emailIndex !== null || personName)) {
    const email = findEmail(session, emailIndex, personName);
    if (email) {
      domainToIgnore = email.from.includes('@') ? email.from.split('@')[1] : email.from;
      nameToIgnore = email.fromName || email.from;
    }
  }

  if (!domainToIgnore && personName) {
    domainToIgnore = personName.toLowerCase().includes('@') ? personName.split('@')[1] : personName;
  }

  if (!domainToIgnore) return whatsapp.send('Who should I ignore? Say "ignore emails from [name]" 👍');

  claude.addIgnored(domainToIgnore);
  await whatsapp.send('Got it! 🙅 I\'ll filter out ' + (nameToIgnore || domainToIgnore) + ' from now on.');
}

async function handleUnsubscribe(emailIndex, personName) {
  const session = store.getSession();
  if (session && (emailIndex !== null || personName)) {
    const email = findEmail(session, emailIndex, personName);
    if (email) {
      const domain = email.from.includes('@') ? email.from.split('@')[1] : email.from;
      claude.addIgnored(domain);
      return whatsapp.send('Done! 🙅 I\'ll stop bringing ' + (email.fromName || domain) + ' to your attention.');
    }
  }
  await whatsapp.send('Which sender? Give me the email number or their name 👍');
}

async function handleWhatSent(personOrTopic) {
  if (!personOrTopic) return whatsapp.send('Who did you send something to? Say "what did I send to [name]?" 🔍');
  try {
    const emails = await graph.getSentEmails(personOrTopic);
    if (!emails.length) return whatsapp.send('No recent emails to ' + personOrTopic + ' found 🔍');
    const list = emails.slice(0, 3).map((e, i) =>
      (i+1) + '. To: ' + e.to + '\nSubject: ' + e.subject + '\n📅 ' +
      new Date(e.sentAt).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) +
      '\n' + e.preview
    ).join('\n\n');
    await whatsapp.send('Here\'s what you sent 📤\n\n' + list);
  } catch (err) {
    await whatsapp.send('Had trouble looking that up 😕 — ' + err.message);
  }
}

// Strict name matching — only match if the name is clearly in the sender details
function findEmail(session, emailIndex, personName) {
  if (!session || !session.emails) return null;

  // Exact index match
  if (emailIndex !== null && emailIndex !== undefined && !isNaN(emailIndex)) {
    return session.emails[emailIndex] || null;
  }

  // Name match — strict, only match on what Raees said
  if (personName) {
    const parts = personName.toLowerCase().trim().split(/\s+/);
    return session.emails.find(e => {
      const senderName = (e.fromName || '').toLowerCase();
      const senderEmail = e.from.toLowerCase();
      // All parts of the name must appear in the sender name or email
      return parts.every(part => senderName.includes(part) || senderEmail.includes(part));
    }) || null;
  }

  return null;
}

module.exports = { handleInbound };
