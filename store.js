const fs   = require('fs');
const path = require('path');
const FILE = path.join('/tmp', 'session.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2), 'utf8'); }

function saveSession(emails) {
  const s = load();
  s.session = { emails, savedAt: new Date().toISOString() };
  if (!s.actions) s.actions = {};
  save(s);
}
function getSession() { return load().session || null; }

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

// Saves the last digest summary items for context referencing
function saveDigestContext(items) {
  const s = load();
  s.digestContext = { items, savedAt: new Date().toISOString() };
  save(s);
}
function getDigestContext() { return load().digestContext || null; }

// Stakeholder assignments e.g. "Craig handles site issues"
function saveStakeholderAssignment(topic, person) {
  const s = load();
  if (!s.stakeholders) s.stakeholders = {};
  s.stakeholders[topic.toLowerCase()] = person;
  save(s);
}
function getStakeholderAssignments() { return load().stakeholders || {}; }

// Track emails awaiting reply for chase suggestions
function saveChaseItem(emailId, subject, from, receivedAt) {
  const s = load();
  if (!s.chases) s.chases = {};
  s.chases[emailId] = { subject, from, receivedAt, savedAt: new Date().toISOString() };
  save(s);
}
function removeChaseItem(emailId) {
  const s = load();
  if (s.chases) delete s.chases[emailId];
  save(s);
}
function getChaseItems() { return load().chases || {}; }

// Last few conversation exchanges for context
function saveConversationTurn(role, text) {
  const s = load();
  if (!s.conversation) s.conversation = [];
  s.conversation.push({ role, text, at: new Date().toISOString() });
  if (s.conversation.length > 10) s.conversation = s.conversation.slice(-10);
  save(s);
}
function getConversation() { return load().conversation || []; }

module.exports = {
  saveSession, getSession,
  setEmailAction, getEmailActions,
  savePendingDraft, getPendingDraft, clearPendingDraft,
  saveDigestContext, getDigestContext,
  saveStakeholderAssignment, getStakeholderAssignments,
  saveChaseItem, removeChaseItem, getChaseItems,
  saveConversationTurn, getConversation,
};
