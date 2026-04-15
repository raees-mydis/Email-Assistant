const graph    = require('./graph');
const claude   = require('./claude');
const whatsapp = require('./whatsapp');
const todoist  = require('./todoist');
const store    = require('./store');

// ─── Main inbound handler ─────────────────────────────────────────────────────

async function handleInbound(text) {
  const lower = text.toLowerCase().trim();
  console.log(`[inbound] "${text}"`);

  // ── "send" — dispatch a pending reviewed draft ────────────────────────────
  if (lower === 'send') {
    return handleSend();
  }

  // ── "reply N [optional text]" ─────────────────────────────────────────────
  const replyMatch = lower.match(/^reply\s+(\d+)(?:\s+(.+))?$/s);
  if (replyMatch) {
    const index   = parseInt(replyMatch[1], 10) - 1;
    const content = text.slice(text.indexOf(replyMatch[1]) + replyMatch[1].length).trim();
    return handleReply(index, content);
  }

  // ── "task N" ──────────────────────────────────────────────────────────────
  const taskMatch = lower.match(/^task\s+(\d+)$/);
  if (taskMatch) {
    return handleTask(parseInt(taskMatch[1], 10) - 1);
  }

  // ── "delegate N to Name" ──────────────────────────────────────────────────
  const delegateMatch = lower.match(/^delegate\s+(\d+)\s+to\s+(.+)$/);
  if (delegateMatch) {
    const index = parseInt(delegateMatch[1], 10) - 1;
    const name  = delegateMatch[2].trim();
    return handleDelegate(index, name);
  }

  // ── "edit [new text]" — replace pending draft ────────────────────────────
  const editMatch = lower.match(/^edit\s+(.+)$/s);
  if (editMatch) {
    return handleEdit(text.slice(5).trim());
  }

  // ── Unrecognised ─────────────────────────────────────────────────────────
  await whatsapp.send(
    'Commands:\n' +
    'reply N your message — reply to email N\n' +
    'task N — add email N as a Todoist task\n' +
    'delegate N to Name — delegate email N\n' +
    'send — dispatch the reviewed draft\n' +
    'edit your changes — update the pending draft'
  );
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleReply(emailIndex, dictatedText) {
  const session = store.getSession();

  if (!session) {
    return whatsapp.send('No email session found. Wait for the next digest.');
  }

  const email = session.emails[emailIndex];
  if (!email) {
    return whatsapp.send(`No email at position ${emailIndex + 1}. Check the digest numbering.`);
  }

  await whatsapp.send('Reviewing your reply...');

  // If no reply text was given, prompt for it
  if (!dictatedText) {
    store.savePendingDraft({ messageId: email.id, toAddress: email.from, subject: email.subject, draft: '' });
    return whatsapp.send(`Replying to: ${email.fromName || email.from} — ${email.subject}\n\nDictate your reply and send it as a new message.`);
  }

  // Polish the dictated reply with Claude
  const polished = await claude.reviewReply(email, dictatedText);

  // Store the draft awaiting "send" confirmation
  store.savePendingDraft({
    draft:     polished,
    messageId: email.id,
    toAddress: email.from,
    subject:   email.subject,
  });

  await whatsapp.send(
    `Draft reply to ${email.fromName || email.from}:\n\n${polished}\n\n` +
    'Reply SEND to dispatch, or EDIT followed by your corrections.'
  );
}

async function handleSend() {
  const draft = store.getPendingDraft();

  if (!draft) {
    return whatsapp.send('No pending draft to send. Use "reply N your message" first.');
  }

  if (!draft.draft) {
    return whatsapp.send('Draft is empty. Use "edit your reply text" to add content first.');
  }

  await graph.replyToEmail(draft.messageId, draft.draft);
  store.clearPendingDraft();

  await whatsapp.send(`Sent. Reply dispatched to ${draft.toAddress}.`);
}

async function handleEdit(newText) {
  const draft = store.getPendingDraft();

  if (!draft) {
    return whatsapp.send('No pending draft to edit. Use "reply N your message" first.');
  }

  store.savePendingDraft({ ...draft, draft: newText });

  await whatsapp.send(
    `Draft updated:\n\n${newText}\n\n` +
    'Reply SEND to dispatch, or EDIT again to revise.'
  );
}

async function handleTask(emailIndex) {
  const session = store.getSession();

  if (!session) {
    return whatsapp.send('No email session found. Wait for the next digest.');
  }

  const email = session.emails[emailIndex];
  if (!email) {
    return whatsapp.send(`No email at position ${emailIndex + 1}.`);
  }

  await whatsapp.send('Creating task...');

  const taskData = await claude.extractTask(email);
  const task     = await todoist.createTask(taskData);

  await whatsapp.send(
    `Task added to Todoist:\n${task.content}\nDue: ${task.due?.string || taskData.due_string}`
  );
}

async function handleDelegate(emailIndex, delegateName) {
  const session = store.getSession();

  if (!session) {
    return whatsapp.send('No email session found. Wait for the next digest.');
  }

  const email = session.emails[emailIndex];
  if (!email) {
    return whatsapp.send(`No email at position ${emailIndex + 1}.`);
  }

  // Look up delegate email address from a simple name→email map
  const delegateEmail = resolveDelegateEmail(delegateName);
  if (!delegateEmail) {
    return whatsapp.send(
      `Unknown delegate "${delegateName}". Add them to the DELEGATES map in src/router.js.`
    );
  }

  await whatsapp.send(`Drafting delegation brief for ${delegateName}...`);

  const brief   = await claude.draftDelegation(email, delegateName);
  const subject = `For your action: ${email.subject}`;

  await graph.sendEmail({ to: delegateEmail, subject, body: brief });

  await whatsapp.send(`Delegated to ${delegateName} (${delegateEmail}). Brief sent.`);
}

// ─── Delegate name → email map ────────────────────────────────────────────────
// Add the people you regularly delegate to here.

const DELEGATES = {
  // 'lilian': 'lilian@yourdomain.com',
  // 'sarah':  'sarah@yourdomain.com',
  // 'tom':    'tom@yourdomain.com',
};

function resolveDelegateEmail(name) {
  return DELEGATES[name.toLowerCase()] || null;
}

module.exports = { handleInbound, DELEGATES };
