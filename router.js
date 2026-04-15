const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const todoist  = require('./todoist');
const store    = require('./store');

const DELEGATES = {
  // 'lilian': 'lilian@yourdomain.com',
};

async function handleInbound(text) {
  const lower = text.toLowerCase().trim();
  console.log('[router] command:', lower);
if (lower === 'update') { await whatsapp.send('Fetching your emails...'); return require('./digest').runDigest(); }
  if (lower === 'send') return handleSend();

  const replyMatch = lower.match(/^reply\s+(\d+)(?:\s+([\s\S]+))?$/);
  if (replyMatch) return handleReply(parseInt(replyMatch[1]) - 1, text.slice(text.toLowerCase().indexOf(replyMatch[1]) + replyMatch[1].length).trim());

  const taskMatch = lower.match(/^task\s+(\d+)$/);
  if (taskMatch) return handleTask(parseInt(taskMatch[1]) - 1);

  const delegateMatch = lower.match(/^delegate\s+(\d+)\s+to\s+(.+)$/);
  if (delegateMatch) return handleDelegate(parseInt(delegateMatch[1]) - 1, delegateMatch[2].trim());

  const editMatch = lower.match(/^edit\s+([\s\S]+)$/);
  if (editMatch) return handleEdit(text.slice(5).trim());

  await whatsapp.send('Commands:\nreply N your message\ntask N\ndelegate N to Name\nsend\nedit new text');
}

async function handleReply(idx, dictated) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No email session. Wait for next digest.');
  const email = session.emails[idx];
  if (!email) return whatsapp.send('No email at position ' + (idx+1));
  if (!dictated) {
    store.savePendingDraft({ messageId: email.id, toAddress: email.from, subject: email.subject, draft: '' });
    return whatsapp.send('Replying to: ' + (email.fromName || email.from) + ' - ' + email.subject + '\n\nSend your reply text as the next message.');
  }
  await whatsapp.send('Reviewing your reply...');
  const polished = await claude.reviewReply(email, dictated);
  store.savePendingDraft({ draft: polished, messageId: email.id, toAddress: email.from, subject: email.subject });
  await whatsapp.send('Draft reply:\n\n' + polished + '\n\nReply SEND to dispatch or EDIT to change.');
}

async function handleSend() {
  const draft = store.getPendingDraft();
  if (!draft || !draft.draft) return whatsapp.send('No pending draft. Use reply N first.');
  await graph.replyToEmail(draft.messageId, draft.draft);
  store.clearPendingDraft();
  await whatsapp.send('Sent to ' + draft.toAddress);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();
  if (!draft) return whatsapp.send('No pending draft.');
  store.savePendingDraft({ ...draft, draft: newText });
  await whatsapp.send('Draft updated:\n\n' + newText + '\n\nReply SEND to dispatch.');
}

async function handleTask(idx) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No email session. Wait for next digest.');
  const email = session.emails[idx];
  if (!email) return whatsapp.send('No email at position ' + (idx+1));
  await whatsapp.send('Creating task...');
  const taskData = await claude.extractTask(email);
  const task = await todoist.createTask(taskData);
  await whatsapp.send('Task added: ' + task.content + '\nDue: ' + (task.due ? task.due.string : taskData.due_string));
}

async function handleDelegate(idx, name) {
  const session = store.getSession();
  if (!session) return whatsapp.send('No email session. Wait for next digest.');
  const email = session.emails[idx];
  if (!email) return whatsapp.send('No email at position ' + (idx+1));
  const delegateEmail = DELEGATES[name.toLowerCase()];
  if (!delegateEmail) return whatsapp.send('Unknown delegate "' + name + '". Add them to the DELEGATES map in router.js');
  await whatsapp.send('Drafting brief for ' + name + '...');
  const brief = await claude.draftDelegation(email, name);
  await graph.sendEmail({ to: delegateEmail, subject: 'For your action: ' + email.subject, body: brief });
  await whatsapp.send('Delegated to ' + name + '. Brief sent.');
}

module.exports = { handleInbound };
