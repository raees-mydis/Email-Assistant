const axios  = require('axios');
const config = require('./config');

let _cache = { token: null, expiresAt: 0 };
let _iwsCache = { token: null, expiresAt: 0 };

const TEAM_EMAILS = [
  'hamid@mydis.com','falak@mydis.com','lilian@mydis.com','craig@mydis.com',
  'adegoke@mydis.com','basat@mydis.com','shams@mydis.com'
];

async function getToken(tenantId, clientId, clientSecret, cache) {
  if (cache.token && Date.now() < cache.expiresAt - 60000) return cache.token;
  const res = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  cache.token = res.data.access_token;
  cache.expiresAt = Date.now() + res.data.expires_in * 1000;
  return cache.token;
}

async function getMydisToken() {
  return getToken(config.azure.tenantId, config.azure.clientId, config.azure.clientSecret, _cache);
}

async function getIwsToken() {
  const iws = config.iws;
  if (!iws || !iws.tenantId) throw new Error('IWS Azure credentials not configured');
  return getToken(iws.tenantId, iws.clientId, iws.clientSecret, _iwsCache);
}

async function graphGet(path, params, tokenFn) {
  const token = await tokenFn();
  const res = await axios.get('https://graph.microsoft.com/v1.0' + path, {
    headers: { Authorization: 'Bearer ' + token }, params
  });
  return res.data;
}

async function graphPost(path, body, tokenFn) {
  const token = await tokenFn();
  const res = await axios.post('https://graph.microsoft.com/v1.0' + path, body, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  return res.data;
}

async function graphPatch(path, body, tokenFn) {
  const token = await tokenFn();
  await axios.patch('https://graph.microsoft.com/v1.0' + path, body, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
}

function mapMessage(m, account) {
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
    account: account || 'mydis',
  };
}

async function getUnreadEmails(max) {
  const email = config.azure.userEmail;
  const data = await graphGet('/users/' + email + '/messages', {
    '$filter': 'isRead eq false',
    '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
    '$orderby': 'receivedDateTime DESC',
    '$top': max || 40,
  }, getMydisToken);
  return (data.value || []).map(m => mapMessage(m, 'mydis'));
}

async function getIwsUnreadEmails(max) {
  const email = 'raees@iwsuk.com';
  try {
    const data = await graphGet('/users/' + email + '/messages', {
      '$filter': 'isRead eq false',
      '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
      '$orderby': 'receivedDateTime DESC',
      '$top': max || 40,
    }, getIwsToken);
    return (data.value || []).map(m => mapMessage(m, 'iws'));
  } catch (err) {
    console.error('[graph] IWS email error:', err.message);
    return [];
  }
}

async function getRecentEmails(minutesBack) {
  const email = config.azure.userEmail;
  const since = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
  const data = await graphGet('/users/' + email + '/messages', {
    '$filter': "receivedDateTime ge " + since,
    '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
    '$orderby': 'receivedDateTime DESC',
    '$top': 50,
  }, getMydisToken);
  return (data.value || []).map(m => mapMessage(m, 'mydis'));
}

async function getIwsRecentEmails(minutesBack) {
  const email = 'raees@iwsuk.com';
  const since = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();
  try {
    const data = await graphGet('/users/' + email + '/messages', {
      '$filter': "receivedDateTime ge " + since,
      '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
      '$orderby': 'receivedDateTime DESC',
      '$top': 50,
    }, getIwsToken);
    return (data.value || []).map(m => mapMessage(m, 'iws'));
  } catch (err) {
    console.error('[graph] IWS recent email error:', err.message);
    return [];
  }
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
    }, getMydisToken);
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

async function getAttachments(messageId, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  try {
    const data = await graphGet('/users/' + email + '/messages/' + messageId + '/attachments', {}, tokenFn);
    return (data.value || []).filter(a => !a.isInline).map(a => ({
      id: a.id, name: a.name || 'attachment',
      contentType: a.contentType || '', size: a.size || 0,
      contentBytes: a.contentBytes || null,
    }));
  } catch { return []; }
}

async function markAsRead(messageId, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  try { await graphPatch('/users/' + email + '/messages/' + messageId, { isRead: true }, tokenFn); return true; }
  catch { return false; }
}

async function markMultipleAsRead(messageIds, account) {
  let count = 0;
  for (const id of messageIds) {
    if (await markAsRead(id, account)) count++;
    await new Promise(r => setTimeout(r, 100));
  }
  return count;
}

async function replyToEmail(messageId, replyText, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  // Step 1: Create a draft reply
  const draft = await graphPost('/users/' + email + '/messages/' + messageId + '/createReply', {}, tokenFn);
  // Step 2: Update the draft body
  const token = await tokenFn();
  const axios = require('axios');
  await axios.patch('https://graph.microsoft.com/v1.0/users/' + email + '/messages/' + draft.id, {
    body: { contentType: 'Text', content: replyText }
  }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  // Step 3: Send it — this saves to Sent Items automatically
  await graphPost('/users/' + email + '/messages/' + draft.id + '/send', {}, tokenFn);
}

async function sendEmail(opts, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  await graphPost('/users/' + email + '/sendMail', {
    message: {
      subject: opts.subject,
      body: { contentType: 'Text', content: opts.body },
      toRecipients: [{ emailAddress: { address: opts.to } }],
    },
    saveToSentItems: true,
  }, tokenFn);
}

async function getSentEmails(searchTerm) {
  const email = config.azure.userEmail;
  const data = await graphGet('/users/' + email + '/mailFolders/SentItems/messages', {
    '$search': '"' + searchTerm + '"',
    '$select': 'id,subject,toRecipients,bodyPreview,sentDateTime',
    '$top': 5,
  }, getMydisToken);
  return (data.value || []).map(m => ({
    id: m.id, subject: m.subject || '(no subject)',
    to: m.toRecipients && m.toRecipients[0] ? m.toRecipients[0].emailAddress.address : 'unknown',
    preview: m.bodyPreview || '', sentAt: m.sentDateTime,
  }));
}

function getDayRange(offsetDays) {
  const target = new Date();
  target.setDate(target.getDate() + offsetDays);
  const start = new Date(target); start.setHours(0, 0, 0, 0);
  const end = new Date(target); end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function getCalendarEvents(offsetDays) {
  const email = config.azure.userEmail;
  const { start, end } = getDayRange(offsetDays);
  try {
    const data = await graphGet('/users/' + email + '/calendarView', {
      startDateTime: start, endDateTime: end,
      '$select': 'subject,start,end,location,attendees,bodyPreview,isAllDay,isCancelled,showAs,organizer',
      '$orderby': 'start/dateTime', '$top': 20,
    }, getMydisToken);
    return (data.value || []).filter(e => !e.isCancelled && e.showAs !== 'free').map(mapEvent);
  } catch (err) { console.error('[graph] calendar error:', err.message); return []; }
}

async function getIwsCalendarEvents(offsetDays) {
  const email = 'raees@iwsuk.com';
  const { start, end } = getDayRange(offsetDays);
  try {
    const data = await graphGet('/users/' + email + '/calendarView', {
      startDateTime: start, endDateTime: end,
      '$select': 'subject,start,end,location,attendees,bodyPreview,isAllDay,isCancelled,showAs,organizer',
      '$orderby': 'start/dateTime', '$top': 20,
    }, getIwsToken);
    return (data.value || []).filter(e => !e.isCancelled && e.showAs !== 'free').map(e => ({ ...mapEvent(e), account: 'iws' }));
  } catch (err) { console.error('[graph] IWS calendar error:', err.message); return []; }
}

async function getCombinedCalendarEvents(offsetDays) {
  const [mydis, iws] = await Promise.all([
    getCalendarEvents(offsetDays),
    getIwsCalendarEvents(offsetDays),
  ]);
  // Merge and sort by start time
  return [...mydis, ...iws].sort((a, b) => {
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return new Date(a.startTime) - new Date(b.startTime);
  });
}

function mapEvent(e) {
  return {
    subject: e.subject || '(no title)',
    startTime: e.start ? e.start.dateTime : null,
    endTime: e.end ? e.end.dateTime : null,
    isAllDay: e.isAllDay || false,
    location: e.location && e.location.displayName ? e.location.displayName : null,
    organizer: e.organizer && e.organizer.emailAddress ? e.organizer.emailAddress.name || e.organizer.emailAddress.address : null,
    attendees: (e.attendees || []).map(a => a.emailAddress ? (a.emailAddress.name || a.emailAddress.address) : '').filter(Boolean),
    preview: e.bodyPreview || '',
    account: 'mydis',
  };
}

module.exports = {
  getUnreadEmails, getIwsUnreadEmails,
  getRecentEmails, getIwsRecentEmails,
  getThreadTeamReplies, getAttachments,
  markAsRead, markMultipleAsRead,
  replyToEmail, sendEmail, getSentEmails,
  getCalendarEvents, getIwsCalendarEvents, getCombinedCalendarEvents,
  TEAM_EMAILS,
};
