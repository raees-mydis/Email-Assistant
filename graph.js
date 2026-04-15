const axios  = require('axios');
const config = require('./config');

let _cache = { token: null, expiresAt: 0 };

const TEAM_EMAILS = [
  'hamid@mydis.com','falak@mydis.com','lilian@mydis.com','craig@mydis.com',
  'adegoke@mydis.com','basat@mydis.com','shams@mydis.com'
];

async function getToken() {
  if (_cache.token && Date.now() < _cache.expiresAt - 60000) return _cache.token;
  const { tenantId, clientId, clientSecret } = config.azure;
  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _cache = { token: res.data.access_token, expiresAt: Date.now() + res.data.expires_in * 1000 };
  return _cache.token;
}

async function graphGet(path, params) {
  const token = await getToken();
  const res = await axios.get('https://graph.microsoft.com/v1.0' + path, {
    headers: { Authorization: 'Bearer ' + token }, params
  });
  return res.data;
}

async function graphPost(path, body) {
  const token = await getToken();
  const res = await axios.post('https://graph.microsoft.com/v1.0' + path, body, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  return res.data;
}

async function graphPatch(path, body) {
  const token = await getToken();
  await axios.patch('https://graph.microsoft.com/v1.0' + path, body, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
}

function mapMessage(m) {
  return {
    id: m.id,
    subject: m.subject || '(no subject)',
    from: m.from && m.from.emailAddress ? m.from.emailAddress.address : 'unknown',
    fromName: m.from && m.from.emailAddress ? m.from.emailAddress.name : '',
    preview: m.bodyPreview || '',
    receivedAt: m.receivedDateTime,
    importance: m.importance || 'normal',
    hasAttachments: m.hasAttachments || false,
    conversationId: m.conversationId || '',
    isRead: m.isRead || false,
  };
}

async function getUnreadEmails(max) {
  const email = config.azure.userEmail;
  const data = await graphGet('/users/' + email + '/messages', {
    '$filter': 'isRead eq false',
    '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
    '$orderby': 'receivedDateTime DESC',
    '$top': max || 40,
  });
  return (data.value || []).map(mapMessage);
}

async function getRecentEmails(minutesBack) {
  const email = config.azure.userEmail;
  const since = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
  const data = await graphGet('/users/' + email + '/messages', {
    '$filter': "receivedDateTime ge " + since,
    '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
    '$orderby': 'receivedDateTime DESC',
    '$top': 50,
  });
  return (data.value || []).map(mapMessage);
}

async function getThreadTeamReplies(conversationId) {
  if (!conversationId) return null;
  const email = config.azure.userEmail;
  try {
    const data = await graphGet('/users/' + email + '/messages', {
      '$filter': "conversationId eq '" + conversationId + "'",
      '$select': 'from,sentDateTime,bodyPreview',
      '$orderby': 'sentDateTime DESC',
      '$top': 20,
    });
    const teamReplies = (data.value || []).filter(m => {
      const addr = (m.from && m.from.emailAddress ? m.from.emailAddress.address : '').toLowerCase();
      return TEAM_EMAILS.includes(addr);
    });
    if (!teamReplies.length) return null;
    const latest = teamReplies[0];
    const name = latest.from.emailAddress.name || latest.from.emailAddress.address.split('@')[0];
    return { name, preview: latest.bodyPreview || '', sentAt: latest.sentDateTime };
  } catch { return null; }
}

async function getAttachments(messageId) {
  const email = config.azure.userEmail;
  try {
    const data = await graphGet('/users/' + email + '/messages/' + messageId + '/attachments');
    return (data.value || []).filter(a => !a.isInline).map(a => ({
      id: a.id, name: a.name || 'attachment',
      contentType: a.contentType || '', size: a.size || 0,
      contentBytes: a.contentBytes || null,
    }));
  } catch { return []; }
}

async function markAsRead(messageId) {
  const email = config.azure.userEmail;
  try { await graphPatch('/users/' + email + '/messages/' + messageId, { isRead: true }); return true; }
  catch { return false; }
}

async function markMultipleAsRead(messageIds) {
  let count = 0;
  for (const id of messageIds) {
    if (await markAsRead(id)) count++;
    await new Promise(r => setTimeout(r, 100));
  }
  return count;
}

async function replyToEmail(messageId, replyText) {
  const email = config.azure.userEmail;
  await graphPost('/users/' + email + '/messages/' + messageId + '/reply', { comment: replyText });
}

async function sendEmail(opts) {
  const email = config.azure.userEmail;
  await graphPost('/users/' + email + '/sendMail', {
    message: {
      subject: opts.subject,
      body: { contentType: 'Text', content: opts.body },
      toRecipients: [{ emailAddress: { address: opts.to } }],
    },
    saveToSentItems: true,
  });
}

async function getSentEmails(searchTerm) {
  const email = config.azure.userEmail;
  const data = await graphGet('/users/' + email + '/mailFolders/SentItems/messages', {
    '$search': '"' + searchTerm + '"',
    '$select': 'id,subject,toRecipients,bodyPreview,sentDateTime',
    '$top': 5,
  });
  return (data.value || []).map(m => ({
    id: m.id, subject: m.subject || '(no subject)',
    to: m.toRecipients && m.toRecipients[0] ? m.toRecipients[0].emailAddress.address : 'unknown',
    preview: m.bodyPreview || '', sentAt: m.sentDateTime,
  }));
}

// ─── Calendar ────────────────────────────────────────────────────────────────

function getDayRange(offsetDays) {
  const tz = 'Europe/London';
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + offsetDays);

  const start = new Date(target);
  start.setHours(0, 0, 0, 0);
  const end = new Date(target);
  end.setHours(23, 59, 59, 999);

  return { start: start.toISOString(), end: end.toISOString() };
}

async function getCalendarEvents(offsetDays) {
  const email = config.azure.userEmail;
  const { start, end } = getDayRange(offsetDays);

  try {
    const data = await graphGet('/users/' + email + '/calendarView', {
      startDateTime: start,
      endDateTime: end,
      '$select': 'subject,start,end,location,attendees,bodyPreview,isAllDay,isCancelled,showAs,organizer',
      '$orderby': 'start/dateTime',
      '$top': 20,
    });

    return (data.value || [])
      .filter(e => !e.isCancelled && e.showAs !== 'free')
      .map(e => ({
        subject: e.subject || '(no title)',
        startTime: e.start ? e.start.dateTime : null,
        endTime: e.end ? e.end.dateTime : null,
        isAllDay: e.isAllDay || false,
        location: e.location && e.location.displayName ? e.location.displayName : null,
        organizer: e.organizer && e.organizer.emailAddress ? e.organizer.emailAddress.name || e.organizer.emailAddress.address : null,
        attendees: (e.attendees || []).map(a => a.emailAddress ? (a.emailAddress.name || a.emailAddress.address) : '').filter(Boolean),
        preview: e.bodyPreview || '',
      }));
  } catch (err) {
    console.error('[graph] calendar error:', err.message);
    return [];
  }
}

module.exports = {
  getUnreadEmails, getRecentEmails, getThreadTeamReplies,
  getAttachments, markAsRead, markMultipleAsRead,
  replyToEmail, sendEmail, getSentEmails,
  getCalendarEvents,
  TEAM_EMAILS,
};
