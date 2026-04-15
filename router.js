const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const todoist  = require('./todoist');
const store    = require('./store');

const DELEGATES = {
  // 'lilian': 'lilian@yourdomain.com',
};

// Use Claude to parse natural language intent
async function parseIntent(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const config = require('./config');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const session = store.getSession();
  const emailList = session ? session.emails.map((e, i) =>
    '[' + (i+1) + '] ' + (e.fromName || e.from) + ' - ' + e.subject
  ).join('\n') : 'No emails loaded yet.';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    system: `You parse commands for an email assistant. Return only valid JSON.

Current emails in session:
${emailList}

Intents:
- update: wants a fresh digest now
- reply: wants to reply to an email (find by number or name/subject match)
- send: wants to send the pending draft
- edit: wants to change the pending draft
- task: wants to add an email to Todoist
- delegate: wants to delegate an email to someone
- ignore: wants to stop seeing emails from a sender or domain
- unsubscribe: wants to unsubscribe from a mailing list
- what_sent: wants to know what they sent to someone
- help: wants to know what commands are available
- unknown: can't determine intent

Return JSON: { "intent": "...", "emailIndex": null or number (0-based), "personName": null or string, "delegateTo": null or string, "content": null or string }

For reply/task/delegate/ignore, match email by number or by searching name/subject in the list above.`,
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
  const parsed = await parseIntent(text);
  console.log('[router] intent:', JSON.stringify(parsed));

  switch (parsed.intent) {
    case 'update':
      await whatsapp.send('On it! 📬 Fetching your emails now...');
      return require('./digest').runDigest();

    case 'reply':
      return handleReply(parsed.emailIndex, parsed.content, parsed.personName);

    case 'send':
      return handleSend();

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
        'Here\'s what you can tell me 👇\n\n' +
        '"update" — get your digest now\n' +
        '"reply to Jo" — I\'ll ask what to say\n' +
        '"reply to email 2 thanks all good" — I\'ll polish and draft it\n' +
        '"task 3" — add to Todoist\n' +
        '"delegate 2 to Lilian" — I\'ll draft and send the brief\n' +
        '"ignore emails from Katy Payne" — filter them out\n' +
        '"unsubscribe from newsletter 4" — I\'ll mark it to ignore\n' +
        '"what did I send to Jo?" — I\'ll look it up\n' +
        '"send" — dispatch your pending draft'
      );

    default:
      await whatsapp.send('Hmm, I\'m not quite sure what you mean 🤔 Say "help" for a list of things I can do!');
  }
}

async function handleReply(emailIndex, content, personName) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No emails loaded yet — say "update" to fetch them first 📬');

  const email = findEmail(session, emailIndex, personName);
  if (!email) return whatsapp.send('I couldn\'t find that email 🔍 Say "update" to refresh, or try using the email number from the digest.');

  // Store which email we're replying to
  store.savePendingDraft({ messageId: email.id, toAddress: email.from, subject: email.subject, draft: '', awaitingReply: true });

  if (!content) {
    return whatsapp.send('Sure! Replying to ' + (email.fromName || email.from) + ' re: ' + email.subject + ' ✉️\n\nWhat would you like to say?');
  }

  await whatsapp.send('Give me a sec, polishing that reply... ✍️');
  const polished = await claude.reviewReply(email, content);
  store.savePendingDraft({ draft: polished, messageId: email.id, toAddress: email.from, subject: email.subject, awaitingReply: false });
  await whatsapp.send('Here\'s your draft to ' + (email.fromName || email.from) + ':\n\n' + polished + '\n\nLooks good? Reply "send" to fire it off, or "edit [changes]" to tweak it 👍');
}

async function handleSend() {
  const draft = store.getPendingDraft();
  if (!draft) return whatsapp.send('Nothing waiting to send! Start with "reply to [name]" 📝');

  // If we're still awaiting the reply content, treat this message as the content
  if (draft.awaitingReply) {
    return whatsapp.send('What would you like the reply to say? Just type it and I\'ll polish it up ✍️');
  }

  if (!draft.draft) return whatsapp.send('The draft is empty — say "edit [your reply]" to add content first 📝');

  await graph.replyToEmail(draft.messageId, draft.draft);
  store.clearPendingDraft();
  await whatsapp.send('Done! ✅ Reply sent to ' + draft.toAddress);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();
  if (!draft) return whatsapp.send('No draft to edit — start with "reply to [name]" first 📝');
  store.savePendingDraft({ ...draft, draft: newText, awaitingReply: false });
  await whatsapp.send('Updated! Here\'s the new draft:\n\n' + newText + '\n\nReply "send" when you\'re happy 👍');
}

async function handleTask(emailIndex, personName) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No emails loaded yet — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return whatsapp.send('Couldn\'t find that email 🔍 Try using the number from the digest.');
  await whatsapp.send('Adding to Todoist... 📋');
  const taskData = await claude.extractTask(email);
  const task = await todoist.createTask(taskData);
  await whatsapp.send('Done! ✅ Task added:\n"' + task.content + '"\nDue: ' + (task.due ? task.due.string : taskData.due_string));
}

async function handleDelegate(emailIndex, delegateTo, personName) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No emails loaded yet — say "update" first 📬');
  const email = findEmail(session, emailIndex, personName);
  if (!email) return whatsapp.send('Couldn\'t find that email 🔍');
  if (!delegateTo) return whatsapp.send('Who should I delegate this to? Say "delegate [email number] to [name]" 👤');
  const delegateEmail = DELEGATES[delegateTo.toLowerCase()];
  if (!delegateEmail) return whatsapp.send('I don\'t have ' + delegateTo + '\'s email address yet. Add it to the DELEGATES list in router.js and I\'ll handle it from there 👍');
  await whatsapp.send('Drafting the brief for ' + delegateTo + '... ✍️');
  const brief = await claude.draftDelegation(email, delegateTo);
  await graph.sendEmail({ to: delegateEmail, subject: 'For your action: ' + email.subject, body: brief });
  await whatsapp.send('All done! ✅ Brief sent to ' + delegateTo + ' (' + delegateEmail + ')');
}

async function handleIgnore(emailIndex, personName) {
  const session = store.getSession();

  let nameToIgnore = personName;
  let domainToIgnore = null;

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
  await whatsapp.send('Got it! 🙅 I\'ll filter out any future emails from ' + (nameToIgnore || domainToIgnore) + '. You won\'t hear about them again unless you ask.');
}

async function handleUnsubscribe(emailIndex, personName) {
  const session = store.getSession();
  if (session && (emailIndex !== null || personName)) {
    const email = findEmail(session, emailIndex, personName);
    if (email) {
      const domain = email.from.includes('@') ? email.from.split('@')[1] : email.from;
      claude.addIgnored(domain);
      return whatsapp.send('Noted! 🙅 I\'ll stop bringing emails from ' + (email.fromName || domain) + ' to your attention. If there\'s an actual unsubscribe link in the email you\'d need to click that yourself, but I\'ll filter them out from now on 👍');
    }
  }
  await whatsapp.send('Which sender do you want to unsubscribe from? Give me the email number from the digest or their name 👍');
}

async function handleWhatSent(personOrTopic) {
  if (!personOrTopic) return whatsapp.send('Who did you send something to? Say "what did I send to [name]?" 🔍');
  try {
    const emails = await graph.getSentEmails(personOrTopic);
    if (!emails.length) return whatsapp.send('I couldn\'t find any recent emails you sent to ' + personOrTopic + ' 🔍');
    const list = emails.slice(0, 3).map((e, i) =>
      (i+1) + '. To: ' + e.to + '\nSubject: ' + e.subject + '\nSent: ' + new Date(e.sentAt).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '\n' + e.preview
    ).join('\n\n');
    await whatsapp.send('Here\'s what you sent 📤\n\n' + list);
  } catch (err) {
    await whatsapp.send('I had trouble looking that up 😕 — ' + err.message);
  }
}

// Find email by index or by searching name/subject
function findEmail(session, emailIndex, personName) {
  if (!session || !session.emails) return null;
  if (emailIndex !== null && emailIndex !== undefined && !isNaN(emailIndex)) {
    return session.emails[emailIndex] || null;
  }
  if (personName) {
    const lower = personName.toLowerCase();
    return session.emails.find(e =>
      (e.fromName || '').toLowerCase().includes(lower) ||
      e.from.toLowerCase().includes(lower) ||
      e.subject.toLowerCase().includes(lower)
    ) || null;
  }
  return null;
}

module.exports = { handleInbound };
