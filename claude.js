const Anthropic = require('@anthropic-ai/sdk');
const config    = require('./config');
const fs        = require('fs');
const path      = require('path');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const IGNORE_FILE = path.join('/tmp', 'ignored.json');

function loadIgnored() {
  try { return JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')); } catch { return []; }
}

function saveIgnored(list) {
  fs.writeFileSync(IGNORE_FILE, JSON.stringify(list), 'utf8');
}

function addIgnored(senderOrDomain) {
  const list = loadIgnored();
  const entry = senderOrDomain.toLowerCase().trim();
  if (!list.includes(entry)) { list.push(entry); saveIgnored(list); }
  return list;
}

function isIgnored(email) {
  const list = loadIgnored();
  const addr = (email.from || '').toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  return list.some(entry => addr.includes(entry) || (domain && domain.includes(entry)));
}

async function ask(system, content, maxTokens) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: maxTokens || 800,
    system, messages: [{ role: 'user', content }],
  });
  return msg.content[0].text.trim();
}

async function summariseEmails(emails) {
  if (!emails.length) return 'No unread emails right now.';

  const filtered = emails.filter(e => !isIgnored(e));
  const skipped  = emails.length - filtered.length;

  if (!filtered.length) return 'All unread emails are from ignored senders. ' + skipped + ' skipped.';

  const block = filtered.map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    });
    return '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + ' <' + e.from + '>\n' +
           'SUBJECT: ' + e.subject + '\n' +
           'RECEIVED: ' + date + '\n' +
           'PREVIEW: ' + e.preview;
  }).join('\n\n---\n\n');

  const summary = await ask(
    `You are a sharp executive assistant for Raees. Your job is to give him a concise, actionable email digest.

Rules:
- Plain text only. No markdown. No bullet symbols.
- Numbered list, max 7 emails.
- For each email include: who it is from, when it arrived, a one sentence summary, urgency level, and who needs to act.
- Urgency levels: URGENT (needs action today), SOON (needs action this week), FYI (no action needed).
- If the email is addressed to a group or someone else is CC'd, state clearly who the action is for. For example "Action for Lucy, not you" or "Group email - check if you need to respond".
- Be specific about deadlines if mentioned in the preview.
- Skip newsletters, automated notifications, and marketing emails entirely.
- End with one line: To act: reply N, task N, delegate N to Name, ignore N`,

    'My name is Raees. Here are my unread emails. Give me a clear digest:\n\n' + block +
    (skipped > 0 ? '\n\n(' + skipped + ' emails skipped from ignored senders)' : ''),
    1100
  );

  return summary;
}

async function reviewReply(email, dictated) {
  return ask(
    'Improve this dictated reply into a professional email. Keep same intent and tone. Plain text only. Return only the email body.',
    'Original email from ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview + '\n\nDictated reply:\n' + dictated,
    500
  );
}

async function extractTask(email) {
  const raw = await ask(
    'Extract a Todoist task from this email. Return only valid JSON with keys: title (max 80 chars), description (max 200 chars), due_string (like "tomorrow" or "in 3 days").',
    'Email from ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview,
    300
  );
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return { title: email.subject, description: email.preview, due_string: 'in 3 days' };
  }
}

async function draftDelegation(email, name) {
  return ask(
    'Write a short delegation email in first person as Raees. Direct and professional. Return only the email body.',
    'Delegate this email to ' + name + '.\nFrom: ' + (email.fromName || email.from) + '\nSubject: ' + email.subject + '\n' + email.preview,
    400
  );
}

module.exports = { summariseEmails, reviewReply, extractTask, draftDelegation, addIgnored, isIgnored };
