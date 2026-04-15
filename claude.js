const Anthropic = require('@anthropic-ai/sdk');
const config    = require('./config');
const fs        = require('fs');
const path      = require('path');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const IGNORE_FILE = path.join('/tmp', 'ignored.json');

function loadIgnored() { try { return JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')); } catch { return []; } }
function saveIgnored(list) { fs.writeFileSync(IGNORE_FILE, JSON.stringify(list), 'utf8'); }
function addIgnored(entry) { const list = loadIgnored(); const e = entry.toLowerCase().trim(); if (!list.includes(e)) { list.push(e); saveIgnored(list); } return list; }
function isIgnored(email) {
  const list = loadIgnored();
  const addr = (email.from || '').toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  return list.some(e => addr.includes(e) || (domain && domain.includes(e)));
}

async function ask(system, content, maxTokens) {
  const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: maxTokens || 800, system, messages: [{ role: 'user', content }] });
  return msg.content[0].text.trim();
}

async function summariseEmails(emails) {
  if (!emails.length) return 'No unread emails right now.';
  const filtered = emails.filter(e => !isIgnored(e));
  const skipped = emails.length - filtered.length;
  if (!filtered.length) return 'All emails are from ignored senders. ' + skipped + ' skipped.';

  const block = filtered.map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + ' <' + e.from + '>\nSUBJECT: ' + e.subject + '\nRECEIVED: ' + date + '\nPREVIEW: ' + e.preview;
  }).join('\n\n---\n\n');

  return ask(
    `You are a sharp executive assistant for Raees. Filter his emails ruthlessly. Only surface emails where he personally needs to act.

SHOW RAEES:
- Potential customers asking about services, pricing, or availability
- Technical faults or system issues needing his decision
- Requests for his sign-off, approval, or authorisation
- Complaints needing a personal response from him
- Legal, financial, or contractual matters needing his input
- Time-sensitive requests from known contacts

FILTER OUT COMPLETELY - do not mention these:
- Recruitment, job applications, headhunters
- Sales emails where someone is trying to sell to him or his company
- Marketing, newsletters, promotions, announcements
- Automated notifications, receipts, invoices that are FYI only
- Emails where he is CC'd only and no personal action is needed
- Cold outreach from unknown companies

Format each email you include exactly like this:
[N] Name | Subject
Received: date and time
Action needed: one sentence - what specifically must Raees do?
Urgency: URGENT (today) / SOON (this week) / LOW (no rush)

End with: To act: reply N, task N, delegate N to Name, ignore N

If nothing needs attention say: Nothing needs your attention right now. List briefly what was filtered.`,
    'Emails to review for Raees:\n\n' + block + (skipped > 0 ? '\n\n(' + skipped + ' already skipped from ignored senders)' : ''),
    1200
  );
}

async function reviewReply(email, dictated) {
  return ask('Improve this dictated reply into a professional email. Keep same intent. Plain text only. Return only the email body.', 'Original from ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview + '\n\nDictated:\n' + dictated, 500);
}

async function extractTask(email) {
  const raw = await ask('Extract a Todoist task. Return only valid JSON with keys: title (max 80 chars), description (max 200 chars), due_string.', 'From ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview, 300);
  try { return JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return { title: email.subject, description: email.preview, due_string: 'in 3 days' }; }
}

async function draftDelegation(email, name) {
  return ask('Write a short delegation email in first person as Raees. Direct and professional. Return only the email body.', 'Delegate to ' + name + '.\nFrom: ' + (email.fromName || email.from) + '\nSubject: ' + email.subject + '\n' + email.preview, 400);
}

module.exports = { summariseEmails, reviewReply, extractTask, draftDelegation, addIgnored, isIgnored };
