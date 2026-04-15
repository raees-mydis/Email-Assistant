const fs   = require('fs');
const path = require('path');
const FILE = path.join('/tmp', 'session.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d), 'utf8'); }

function saveSession(emails) {
  const s = load();
  // Preserve existing actions if we already know about these emails
  const existing = s.actions || {};
  s.session = { emails, savedAt: new Date().toISOString() };
  s.actions = existing;
  save(s);
}

function getSession() { return load().session || null; }

// Track what's been done with each email
// status: 'replied' | 'awaiting' | 'tasked' | 'delegated' | 'fyi'
function setEmailAction(emailId, status, note) {
  const s = load();
  if (!s.actions) s.actions = {};
  s.actions[emailId] = { status, note: note || '', at: new Date().toISOString() };
  save(s);
}

function getEmailActions() { return load().actions || {}; }

function savePendingDraft(d) { const s = load(); s.pendingDraft = d; save(s); }
function getPendingDraft() { return load().pendingDraft || null; }
function clearPendingDraft() { const s = load(); delete s.pendingDraft; save(s); }

module.exports = { saveSession, getSession, savePendingDraft, getPendingDraft, clearPendingDraft, setEmailAction, getEmailActions };
