const Anthropic = require('@anthropic-ai/sdk');
const config    = require('./config');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

async function ask(system, content, maxTokens) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: maxTokens || 800,
    system, messages: [{ role: 'user', content }],
  });
  return msg.content[0].text.trim();
}

async function summariseEmails(emails) {
  if (!emails.length) return 'No unread emails right now.';
  const block = emails.map((e, i) =>
    '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + '\nSUBJECT: ' + e.subject + '\nPREVIEW: ' + e.preview
  ).join('\n\n---\n\n');
  return ask(
    'You are a concise executive assistant. Plain text only, no markdown. Numbered lists. Short sentences.',
    'Summarise these emails. Pick top 5 most important. One sentence each. State if action needed.\n\nFormat:\n[N] Name | Subject\nSummary.\nAction: Yes/No\n\nEnd with: To act: reply N, task N, or delegate N to name\n\n' + block,
    900
  );
}

async function reviewReply(email, dictated) {
  return ask(
    'Improve this dictated reply into a professional email. Keep same intent. Plain text only. Return only the email body.',
    'Original email from ' + (email.fromName || email.from) + ':\n' + email.preview + '\n\nDictated reply:\n' + dictated,
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
    'Write a short delegation email in first person. Direct and professional. Return only the email body.',
    'Delegate this email to ' + name + '.\nFrom: ' + (email.fromName || email.from) + '\nSubject: ' + email.subject + '\n' + email.preview,
    400
  );
}

module.exports = { summariseEmails, reviewReply, extractTask, draftDelegation };
