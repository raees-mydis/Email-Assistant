const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });
const MODEL = 'claude-sonnet-4-5';

// ─── Helper ──────────────────────────────────────────────────────────────────

async function ask(system, userContent, maxTokens = 1024) {
  const msg = await client.messages.create({
    model:      MODEL,
    max_tokens: maxTokens,
    system,
    messages:   [{ role: 'user', content: userContent }],
  });
  return msg.content[0].text.trim();
}

// ─── 1. Summarise emails into a WhatsApp digest ──────────────────────────────

async function summariseEmails(emails) {
  if (emails.length === 0) {
    return 'No unread emails right now. Enjoy the quiet.';
  }

  const emailBlock = emails.map((e, i) =>
    `[${i + 1}] FROM: ${e.fromName || e.from}
SUBJECT: ${e.subject}
DATE: ${new Date(e.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' })}
IMPORTANCE: ${e.importance}
PREVIEW: ${e.preview}`
  ).join('\n\n---\n\n');

  const system = `You are a concise executive assistant. 
Format responses for WhatsApp and Android Auto text-to-speech.
Rules: plain text only, no markdown symbols, no asterisks, no bullet points.
Use numbered lists. Short sentences. Maximum 30 words per summary.
Skip newsletters, automated notifications, receipts, and calendar invites.`;

  const prompt = `Here are my unread emails. Please:
1. Pick the top 5 most important or time-sensitive ones
2. Write one sentence summary for each
3. State if action is needed today

Format each item exactly like this:
[N] Name | Subject
One sentence summary.
Action: Yes - reason, OR No - FYI only

After the list, add one line:
To act: reply N, task N, or delegate N to name

EMAILS:
${emailBlock}`;

  return ask(system, prompt, 900);
}

// ─── 2. Review and polish a voice-dictated reply ─────────────────────────────

async function reviewReply(originalEmail, dictatedReply) {
  const system = `You are a professional email assistant.
Improve rough voice-dictated text into a clear, professional email reply.
Keep the same intent and tone. Do not add information not in the original.
Return only the email body text. No subject line, no greeting unless one was dictated.
Plain text only.`;

  const prompt = `Original email from ${originalEmail.fromName || originalEmail.from}:
Subject: ${originalEmail.subject}
${originalEmail.preview}

My dictated reply:
${dictatedReply}

Write a polished version of my reply. Keep it concise and professional.`;

  return ask(system, prompt, 500);
}

// ─── 3. Extract a Todoist task from an email ─────────────────────────────────

async function extractTask(email) {
  const system = `Extract a Todoist task from an email.
Return only valid JSON — no explanation, no markdown code fences.
JSON keys: title (string, max 80 chars), description (string, max 200 chars), due_string (string like "tomorrow", "next Monday", "in 3 days" — infer from urgency, default to "in 3 days" if unclear).`;

  const prompt = `Extract the key action item from this email as a Todoist task:

From: ${email.fromName || email.from}
Subject: ${email.subject}
Content: ${email.preview}`;

  const raw = await ask(system, prompt, 300);

  try {
    return JSON.parse(raw);
  } catch {
    // Fallback if Claude wraps in code fences
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return {
      title:       email.subject,
      description: `From ${email.from}: ${email.preview}`,
      due_string:  'in 3 days',
    };
  }
}

// ─── 4. Draft a delegation email ─────────────────────────────────────────────

async function draftDelegation(email, delegateName) {
  const system = `You write short, clear delegation emails.
Write in first person as the person delegating. Be direct and professional.
Return only the email body. Plain text. No subject line.`;

  const prompt = `I need to delegate handling of this email to ${delegateName}.

Original email:
From: ${email.fromName || email.from}
Subject: ${email.subject}
Content: ${email.preview}

Write a brief email to ${delegateName} explaining what this is and what action I need them to take.`;

  return ask(system, prompt, 400);
}

module.exports = { summariseEmails, reviewReply, extractTask, draftDelegation };
