const Anthropic = require('@anthropic-ai/sdk');
const config    = require('./config');
const fs        = require('fs');
const path      = require('path');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const IGNORE_FILE = path.join('/tmp', 'ignored.json');

// Domains that are always prioritised
const PRIORITY_DOMAINS = [
  'cplfoods.co.uk',
  'cmagriculture.co.uk',
  'annyallachicks.com',
  '2agriculture.co.uk',
];

function loadIgnored() { try { return JSON.parse(fs.readFileSync(IGNORE_FILE, 'utf8')); } catch { return []; } }
function saveIgnored(list) { fs.writeFileSync(IGNORE_FILE, JSON.stringify(list), 'utf8'); }
function addIgnored(entry) { const list = loadIgnored(); const e = entry.toLowerCase().trim(); if (!list.includes(e)) { list.push(e); saveIgnored(list); } return list; }
function isIgnored(email) {
  const list = loadIgnored();
  const addr = (email.from || '').toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  return list.some(e => addr.includes(e) || (domain && domain.includes(e)));
}
function isPriority(email) {
  const addr = (email.from || '').toLowerCase();
  const domain = addr.includes('@') ? addr.split('@')[1] : '';
  return PRIORITY_DOMAINS.some(d => domain.includes(d) || addr.includes(d));
}

async function ask(system, content, maxTokens) {
  const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: maxTokens || 800, system, messages: [{ role: 'user', content }] });
  return msg.content[0].text.trim();
}

async function analyseAttachment(attachment) {
  const supportedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
  const isPdf = attachment.contentType.includes('pdf');
  const isDoc = attachment.contentType.includes('word') || attachment.contentType.includes('document');

  if (!attachment.contentBytes) return null;
  if (!isPdf && !isDoc) return null;

  try {
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            data: attachment.contentBytes,
          }
        },
        {
          type: 'text',
          text: 'This is an attachment called "' + attachment.name + '". Extract the key details in plain text: what is this document for, who is it from, total amounts (inc VAT if shown), due date if any, and a one sentence summary. Be concise.'
        }
      ]
    }];

    const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 400, messages });
    return msg.content[0].text.trim();
  } catch (err) {
    console.error('[claude] attachment analysis error:', err.message);
    return null;
  }
}

async function summariseEmails(emails) {
  if (!emails.length) return 'All clear — nothing needs your attention right now! 🎉';

  const priorityEmails = emails.filter(e => isPriority(e) && !isIgnored(e));
  const filtered = emails.filter(e => !isIgnored(e));
  if (!filtered.length) return 'All clear — nothing needs your attention right now! 🎉';

  const block = filtered.map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const priority = isPriority(e) ? ' [PRIORITY SENDER]' : '';
    const attach = e.hasAttachments ? ' [HAS ATTACHMENTS]' : '';
    const attachNote = e.attachmentSummary ? '\nATTACHMENT: ' + e.attachmentSummary : '';
    return '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + ' <' + e.from + '>' + priority + attach +
           '\nSUBJECT: ' + e.subject +
           '\nRECEIVED: ' + date +
           '\nPREVIEW: ' + e.preview + attachNote;
  }).join('\n\n---\n\n');

  const priorityNote = priorityEmails.length > 0
    ? 'IMPORTANT: The following domains are priority senders and must ALWAYS be included regardless of content: ' + PRIORITY_DOMAINS.join(', ') + '\n\n'
    : '';

  return ask(
    `You are a sharp, friendly PA for Raees. Keep messages concise and scannable.

${priorityNote}ONLY surface emails where Raees personally needs to act:
- Emails from PRIORITY SENDER domains — always include these, no exceptions
- Potential customers asking about services, pricing, availability
- Technical faults or system issues needing his decision
- Sign-off, approval, or authorisation requests
- Complaints needing a personal response
- Legal, financial, or contractual matters
- Time-sensitive requests from known contacts
- Emails with invoice or quotation attachments — always include these

SILENTLY FILTER (do not mention):
- Recruitment, job applications, headhunters
- Sales/marketing emails, newsletters, promotions
- Automated notifications, FYI receipts
- Emails where he is CC'd only with no action needed
- Cold outreach from unknown companies

Format — keep it tight and scannable:
[N] 👤 Name | Subject
📅 date and time
➡️ What Raees needs to do — one sentence
📎 Attachment: key details if present (totals, what it's for)
🔴 URGENT / 🟡 SOON / 🟢 LOW

End with: To act: reply N, task N, delegate N to Name, ignore N

If nothing needs attention: All clear — nothing needs your attention right now! 🎉`,
    'Emails for Raees:\n\n' + block,
    1400
  );
}

async function summariseWithContext(emails, minutes, actions) {
  if (!emails.length) return 'Nothing in that window 📭';
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const inWindow = emails.filter(e => new Date(e.receivedAt) >= cutoff && !isIgnored(e));
  if (!inWindow.length) return 'Nothing came in during that period 📭';

  const block = inWindow.map((e, i) => {
    const date = new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const action = actions[e.id];
    const actionNote = action ? ' [' + action.status.toUpperCase() + (action.note ? ': ' + action.note : '') + ']' : '';
    return '[' + (i+1) + '] FROM: ' + (e.fromName || e.from) + actionNote + '\nSUBJECT: ' + e.subject + '\nRECEIVED: ' + date + '\nPREVIEW: ' + e.preview;
  }).join('\n\n---\n\n');

  return ask(
    `You are a sharp, friendly PA for Raees giving a period update. Include everything in this window — actioned, awaiting, FYI, still needing action. Be concise and scannable.

Format:
[N] 👤 Name | Subject
📅 date and time
Status: ✅ Done / ⏳ Awaiting reply / ℹ️ FYI / ➡️ Still needs action
🔴 URGENT / 🟡 SOON / 🟢 LOW`,
    'All emails in window:\n\n' + block,
    1000
  );
}

async function reviewReply(email, dictated) {
  return ask('Improve this dictated reply into a professional email. Keep same intent and tone. Plain text only. Return only the email body.', 'Original from ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview + '\n\nDictated:\n' + dictated, 500);
}

async function extractTask(email) {
  const raw = await ask('Extract a Todoist task. Return only valid JSON: title (max 80 chars), description (max 200 chars), due_string.', 'From ' + (email.fromName || email.from) + ':\nSubject: ' + email.subject + '\n' + email.preview, 300);
  try { return JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return { title: email.subject, description: email.preview, due_string: 'in 3 days' }; }
}

async function draftDelegation(email, name) {
  return ask('Write a short delegation email in first person as Raees. Direct and professional. Return only the email body.', 'Delegate to ' + name + '.\nFrom: ' + (email.fromName || email.from) + '\nSubject: ' + email.subject + '\n' + email.preview, 400);
}

module.exports = { summariseEmails, summariseWithContext, reviewReply, extractTask, draftDelegation, addIgnored, isIgnored, analyseAttachment, PRIORITY_DOMAINS };
