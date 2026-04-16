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
  const cc = (m.ccRecipients || []).map(r => ({
    name: r.emailAddress ? r.emailAddress.name : '',
    email: r.emailAddress ? r.emailAddress.address : '',
  })).filter(r => r.email);
  const toRecipients = (m.toRecipients || []).map(r => ({
    name: r.emailAddress ? r.emailAddress.name : '',
    email: r.emailAddress ? r.emailAddress.address : '',
  })).filter(r => r.email);
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
    ccRecipients: cc,
    toRecipients: toRecipients,
  };
}

async function getUnreadEmails(max) {
  const email = config.azure.userEmail;
  const data = await graphGet('/users/' + email + '/messages', {
    '$filter': 'isRead eq false',
    '$select': 'id,subject,from,toRecipients,ccRecipients,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
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
      '$select': 'id,subject,from,toRecipients,ccRecipients,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
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
    '$select': 'id,subject,from,toRecipients,ccRecipients,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
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
      '$select': 'id,subject,from,toRecipients,ccRecipients,bodyPreview,receivedDateTime,importance,hasAttachments,conversationId,isRead',
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
  await graphPost('/users/' + email + '/messages/' + messageId + '/reply', { comment: replyText }, tokenFn);
}

async function sendEmail(opts, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  // Support single address (string) or multiple (array of {email, name} or strings)
  let toRecipients;
  if (Array.isArray(opts.to)) {
    toRecipients = opts.to.map(r => ({
      emailAddress: typeof r === 'string' ? { address: r } : { address: r.email, name: r.name || '' }
    }));
  } else {
    toRecipients = [{ emailAddress: { address: opts.to } }];
  }
  await graphPost('/users/' + email + '/sendMail', {
    message: {
      subject: opts.subject,
      body: { contentType: 'Text', content: opts.body },
      toRecipients,
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
    // Get events from ALL calendars including shared ones
    const calendars = await getCalendars('mydis');
    // Filter out noise calendars
    const skipCalendars = ['united states holidays', 'holidays', 'birthdays', 'mysync'];
    const relevantCals = calendars.filter(c => !skipCalendars.some(s => c.name.toLowerCase().includes(s)));
    console.log('[graph] fetching from', relevantCals.length, 'calendars:', relevantCals.map(c => c.name).join(', '));
    const allEvents = [];
    for (const cal of relevantCals) {
      try {
        const data = await graphGet('/users/' + email + '/calendars/' + cal.id + '/calendarView', {
          startDateTime: start, endDateTime: end,
          '$select': 'subject,start,end,location,attendees,bodyPreview,isAllDay,isCancelled,showAs,organizer',
          '$orderby': 'start/dateTime', '$top': 20,
        }, getMydisToken);
        const events = (data.value || [])
          .filter(e => !e.isCancelled && e.showAs !== 'free')
          .map(e => ({ ...mapEvent(e), calendarName: cal.name }));
        allEvents.push(...events);
      } catch (err) {
        console.error('[graph] calendar fetch error for', cal.name, ':', err.message);
      }
    }
    // Sort by start time
    return allEvents.sort((a, b) => new Date(a.startTime || 0) - new Date(b.startTime || 0));
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

async function findCalendarEvent(searchTerm, account, daysAhead) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  // Search across next 30 days by default
  const start = new Date();
  const end = new Date(Date.now() + (daysAhead || 30) * 86400000);
  try {
    const data = await graphGet('/users/' + email + '/calendarView', {
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      '$select': 'id,subject,start,end,location,attendees,bodyPreview,isAllDay,organizer',
      '$orderby': 'start/dateTime',
      '$top': 50,
    }, tokenFn);
    const events = (data.value || []);
    const kw = searchTerm.toLowerCase().trim();
    const words = kw.split(/\s+/).filter(w => w.length > 2);
    // Score by keyword match — weight exact phrase match highly
    const scored = events.map(e => {
      const subj = (e.subject || '').toLowerCase();
      let score = 0;
      // Exact phrase match scores highest
      if (subj.includes(kw)) score += 10;
      // Individual word matches
      score += words.filter(w => subj.includes(w)).length * 2;
      return { event: e, score };
    }).filter(e => e.score > 0);
    scored.sort((a, b) => b.score - a.score);
    console.log('[calendar search] term:', kw, '| top match:', scored[0] ? scored[0].event.subject + ' (score:' + scored[0].score + ')' : 'none');
    return scored.length > 0 ? scored[0].event : null;
  } catch (err) {
    console.error('[graph] findCalendarEvent error:', err.message);
    return null;
  }
}

async function updateCalendarEvent(eventId, updates, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  const token = await tokenFn();
  const body = {};
  if (updates.start) body.start = { dateTime: updates.start, timeZone: 'Europe/London' };
  if (updates.end)   body.end   = { dateTime: updates.end,   timeZone: 'Europe/London' };
  if (updates.title) body.subject = updates.title;
  if (updates.location) body.location = { displayName: updates.location };
  const axios = require('axios');
  const res = await axios.patch('https://graph.microsoft.com/v1.0/users/' + email + '/events/' + eventId, body, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  return res.data;
}

async function getCalendars(account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  try {
    const data = await graphGet('/users/' + email + '/calendars', {}, tokenFn);
    return (data.value || []).map(c => ({ id: c.id, name: c.name, owner: c.owner ? c.owner.address : null, canEdit: c.canEdit }));
  } catch (err) {
    console.error('[graph] getCalendars error:', err.message);
    return [];
  }
}

async function createCalendarEvent(opts, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;

  const event = {
    subject: opts.title,
    start: { dateTime: opts.start, timeZone: 'Europe/London' },
    end:   { dateTime: opts.end,   timeZone: 'Europe/London' },
    body:  { contentType: 'Text', content: opts.notes || '' },
  };

  if (opts.location) event.location = { displayName: opts.location };
  if (opts.attendees && opts.attendees.length) {
    event.attendees = opts.attendees.map(a => ({
      emailAddress: { address: a },
      type: 'required',
    }));
  }

  // If personal calendar requested, use personal OAuth account
  if (opts.calendarName && opts.calendarName.toLowerCase().includes('personal')) {
    try {
      const personalAuth = require('./personal-auth');
      if (personalAuth.isAuthenticated()) {
        console.log('[graph] routing to personal calendar via OAuth');
        return personalAuth.createPersonalCalendarEvent(opts);
      }
    } catch (err) {
      console.error('[graph] personal calendar error:', err.message);
    }
  }
  let calendarPath = '/users/' + email + '/events';

  console.log('[graph] creating event at:', calendarPath);
  console.log('[graph] event payload:', JSON.stringify({ subject: event.subject, start: event.start, end: event.end }));
  try {
    const result = await graphPost(calendarPath, event, tokenFn);
    console.log('[graph] event created:', result.id, result.subject);
    return result;
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('[graph] createCalendarEvent failed:', detail);
    throw err;
  }
}

async function searchContacts(name, account) {
  const email = account === 'iws' ? 'raees@iwsuk.com' : config.azure.userEmail;
  const tokenFn = account === 'iws' ? getIwsToken : getMydisToken;
  try {
    const data = await graphGet('/users/' + email + '/contacts', {
      '$search': '"' + name + '"',
      '$select': 'displayName,emailAddresses',
      '$top': 5,
    }, tokenFn);
    return (data.value || []).map(c => ({
      name: c.displayName,
      email: c.emailAddresses && c.emailAddresses.length ? c.emailAddresses[0].address : null,
    })).filter(c => c.email);
  } catch (err) {
    console.error('[graph] searchContacts error:', err.message);
    return [];
  }
}

async function resolveAttendees(names, session) {
  const resolved = [];
  const TEAM_MAP = {
    'hamid': 'hamid@mydis.com', 'falak': 'falak@mydis.com',
    'lilian': 'lilian@mydis.com', 'craig': 'craig@mydis.com',
    'adegoke': 'adegoke@mydis.com', 'ade': 'adegoke@mydis.com',
    'basat': 'basat@mydis.com', 'bas': 'basat@mydis.com',
    'shams': 'shams@mydis.com', 'al': 'al@iwsuk.com',
  };

  for (const name of names) {
    const lower = name.toLowerCase().trim();

    // 1. Check session emails first — most likely context
    if (session && session.emails) {
      const found = session.emails.find(e => {
        const senderName = (e.fromName || '').toLowerCase();
        return senderName.includes(lower) || lower.includes(senderName.split(' ')[0]);
      });
      if (found) {
        console.log('[attendee] resolved', name, 'from session to', found.from);
        resolved.push(found.from);
        continue;
      }
    }

    // 2. Check MYDIS internal team
    if (TEAM_MAP[lower]) {
      console.log('[attendee] resolved', name, 'from team map to', TEAM_MAP[lower]);
      resolved.push(TEAM_MAP[lower]);
      continue;
    }

    // 3. Search Microsoft contacts
    try {
      const contacts = await searchContacts(name, 'mydis');
      if (contacts.length > 0) {
        console.log('[attendee] resolved', name, 'from contacts to', contacts[0].email);
        resolved.push(contacts[0].email);
        continue;
      }
    } catch {}

    // 4. Unresolved — keep name as placeholder
    console.log('[attendee] could not resolve', name);
    resolved.push(name + ' (email unknown)');
  }
  return resolved;
}

module.exports = {
  searchContacts, resolveAttendees,
  getUnreadEmails, getIwsUnreadEmails,
  getRecentEmails, getIwsRecentEmails,
  getThreadTeamReplies, getAttachments,
  markAsRead, markMultipleAsRead,
  replyToEmail, sendEmail, getSentEmails,
  getCalendars, getCalendarEvents, getIwsCalendarEvents, getCombinedCalendarEvents, createCalendarEvent, findCalendarEvent, updateCalendarEvent,
  TEAM_EMAILS,
};
