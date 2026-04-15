const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'session.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Store the current email session ─────────────────────────────────────────
// Called after each digest so inbound commands can reference emails by number

function saveSession(emails) {
  const store = load();
  store.session = {
    emails,
    savedAt: new Date().toISOString(),
  };
  save(store);
}

function getSession() {
  return load().session || null;
}

// ─── Store a pending draft reply awaiting "send" confirmation ────────────────

function savePendingDraft({ draft, messageId, toAddress, subject }) {
  const store = load();
  store.pendingDraft = { draft, messageId, toAddress, subject, savedAt: new Date().toISOString() };
  save(store);
}

function getPendingDraft() {
  return load().pendingDraft || null;
}

function clearPendingDraft() {
  const store = load();
  delete store.pendingDraft;
  save(store);
}

module.exports = { saveSession, getSession, savePendingDraft, getPendingDraft, clearPendingDraft };
