const fs   = require('fs');
const path = require('path');
const FILE = path.join('/tmp', 'session.json');
const LEARN_FILE = path.join('/tmp', 'learning.json');

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2), 'utf8'); }
function loadLearn() { try { return JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8')); } catch { return { vips: {}, toneExamples: [], contactPrefs: {}, rules: [] }; } }
function saveLearn(d) { fs.writeFileSync(LEARN_FILE, JSON.stringify(d, null, 2), 'utf8'); }

// ── Session ───────────────────────────────────────────────────────────────────
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

function saveDigestContext(items) { const s = load(); s.digestContext = { items, savedAt: new Date().toISOString() }; save(s); }
function getDigestContext() { return load().digestContext || null; }

function saveStakeholderAssignment(topic, person) {
  const s = load();
  if (!s.stakeholders) s.stakeholders = {};
  s.stakeholders[topic.toLowerCase()] = person;
  save(s);
}
function getStakeholderAssignments() { return load().stakeholders || {}; }

function saveChaseItem(emailId, subject, from, receivedAt) {
  const s = load();
  if (!s.chases) s.chases = {};
  s.chases[emailId] = { subject, from, receivedAt, savedAt: new Date().toISOString() };
  save(s);
}
function removeChaseItem(emailId) { const s = load(); if (s.chases) delete s.chases[emailId]; save(s); }
function getChaseItems() { return load().chases || {}; }

function saveConversationTurn(role, text) {
  const s = load();
  if (!s.conversation) s.conversation = [];
  s.conversation.push({ role, text, at: new Date().toISOString() });
  if (s.conversation.length > 10) s.conversation = s.conversation.slice(-10);
  save(s);
}
function getConversation() { return load().conversation || []; }

function savePendingTasks(tasks) { const s = load(); s.pendingTasks = tasks; save(s); }
function getPendingTasks() { return load().pendingTasks || null; }

// ── Learning ──────────────────────────────────────────────────────────────────

// VIP contacts — persisted in learning file
function addVip(email, name, note) {
  const l = loadLearn();
  if (!l.vips) l.vips = {};
  const key = (email || name || '').toLowerCase().trim();
  l.vips[key] = { email: email || '', name: name || '', note: note || '', addedAt: new Date().toISOString() };
  saveLearn(l);
  return l.vips;
}
function getVips() { return loadLearn().vips || {}; }
function removeVip(key) {
  const l = loadLearn();
  delete l.vips[key.toLowerCase()];
  saveLearn(l);
}

// Tone examples — save original + edited draft pairs
function saveToneExample(toEmail, toName, original, edited, subject) {
  const l = loadLearn();
  if (!l.toneExamples) l.toneExamples = [];
  l.toneExamples.push({ toEmail, toName, original, edited, subject, at: new Date().toISOString() });
  // Keep last 30 examples
  if (l.toneExamples.length > 30) l.toneExamples = l.toneExamples.slice(-30);
  saveLearn(l);
}
function getToneExamples() { return loadLearn().toneExamples || []; }

// Contact preferences — formality level, notes about how to communicate
function saveContactPref(emailOrName, prefs) {
  const l = loadLearn();
  if (!l.contactPrefs) l.contactPrefs = {};
  const key = (emailOrName || '').toLowerCase().trim();
  l.contactPrefs[key] = { ...( l.contactPrefs[key] || {}), ...prefs, updatedAt: new Date().toISOString() };
  saveLearn(l);
}
function getContactPref(emailOrName) {
  const l = loadLearn();
  const key = (emailOrName || '').toLowerCase().trim();
  return (l.contactPrefs || {})[key] || null;
}
function getAllContactPrefs() { return loadLearn().contactPrefs || {}; }

// Rules — "never CC X on client emails", "always formal with Y"
function saveRule(rule) {
  const l = loadLearn();
  if (!l.rules) l.rules = [];
  l.rules.push({ rule, at: new Date().toISOString() });
  if (l.rules.length > 50) l.rules = l.rules.slice(-50);
  saveLearn(l);
}
function getRules() { return loadLearn().rules || []; }

// Track reply speed per contact (learn engagement)
function trackReply(toEmail, msToReply) {
  const l = loadLearn();
  if (!l.replySpeed) l.replySpeed = {};
  const key = toEmail.toLowerCase();
  if (!l.replySpeed[key]) l.replySpeed[key] = { count: 0, avgMs: 0 };
  const prev = l.replySpeed[key];
  prev.avgMs = Math.round((prev.avgMs * prev.count + msToReply) / (prev.count + 1));
  prev.count++;
  saveLearn(l);
}
function getReplySpeed(toEmail) {
  const l = loadLearn();
  return (l.replySpeed || {})[(toEmail || '').toLowerCase()] || null;
}

module.exports = {
  saveSession, getSession,
  setEmailAction, getEmailActions,
  savePendingDraft, getPendingDraft, clearPendingDraft,
  saveDigestContext, getDigestContext,
  saveStakeholderAssignment, getStakeholderAssignments,
  saveChaseItem, removeChaseItem, getChaseItems,
  saveConversationTurn, getConversation,
  savePendingTasks, getPendingTasks,
  // Learning
  addVip, getVips, removeVip,
  saveToneExample, getToneExamples,
  saveContactPref, getContactPref, getAllContactPrefs,
  saveRule, getRules,
  trackReply, getReplySpeed,
};
