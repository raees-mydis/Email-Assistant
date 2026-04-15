const fs   = require('fs');
const path = require('path');
const FILE = path.join('/tmp', 'session.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d), 'utf8'); }

function saveSession(emails) { const s = load(); s.session = { emails, savedAt: new Date().toISOString() }; save(s); }
function getSession() { return load().session || null; }
function savePendingDraft(d) { const s = load(); s.pendingDraft = d; save(s); }
function getPendingDraft() { return load().pendingDraft || null; }
function clearPendingDraft() { const s = load(); delete s.pendingDraft; save(s); }

module.exports = { saveSession, getSession, savePendingDraft, getPendingDraft, clearPendingDraft };
