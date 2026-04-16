// personal-auth.js — OAuth flow for raeessayed@outlook.com personal calendar
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CLIENT_ID     = process.env.PERSONAL_CLIENT_ID     || '07fa9948-a1e3-41d1-b070-31b0dc6cd638';
const CLIENT_SECRET = process.env.PERSONAL_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.PERSONAL_REDIRECT_URI  || 'https://email-assistant-production-8a69.up.railway.app/auth/personal/callback';
const TENANT        = 'consumers'; // personal Microsoft accounts
const SCOPES        = 'Calendars.ReadWrite offline_access';
const TOKEN_FILE    = '/tmp/personal_token.json';

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function saveTokens(t) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t), 'utf8'); }

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES,
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${params}`;
}

async function exchangeCode(code) {
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const tokens = { ...res.data, obtained_at: Date.now() };
  saveTokens(tokens);
  return tokens;
}

async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated — visit /auth/personal to log in');
  // Refresh if expired (with 5 min buffer)
  const expiresAt = tokens.obtained_at + (tokens.expires_in - 300) * 1000;
  if (Date.now() > expiresAt) {
    const res = await axios.post(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
        scope: SCOPES,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const newTokens = { ...res.data, obtained_at: Date.now() };
    saveTokens(newTokens);
    return newTokens.access_token;
  }
  return tokens.access_token;
}

async function getPersonalCalendars() {
  const token = await getAccessToken();
  const res = await axios.get('https://graph.microsoft.com/v1.0/me/calendars', {
    headers: { Authorization: 'Bearer ' + token }
  });
  return res.data.value || [];
}

async function getPersonalCalendarEvents(offsetDays) {
  const token = await getAccessToken();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  const res = await axios.get('https://graph.microsoft.com/v1.0/me/calendarView', {
    headers: { Authorization: 'Bearer ' + token },
    params: {
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      '$select': 'subject,start,end,location,isAllDay,isCancelled',
      '$orderby': 'start/dateTime',
      '$top': 20,
    }
  });
  return (res.data.value || [])
    .filter(e => !e.isCancelled)
    .map(e => ({
      subject: e.subject,
      startTime: e.start.dateTime,
      endTime: e.end.dateTime,
      location: e.location ? e.location.displayName : null,
      isAllDay: e.isAllDay,
      account: 'personal',
    }));
}

async function createPersonalCalendarEvent(opts) {
  const token = await getAccessToken();
  const event = {
    subject: opts.title,
    start: { dateTime: opts.start, timeZone: 'Europe/London' },
    end:   { dateTime: opts.end,   timeZone: 'Europe/London' },
    body:  { contentType: 'Text', content: opts.notes || '' },
  };
  if (opts.location) event.location = { displayName: opts.location };
  const res = await axios.post('https://graph.microsoft.com/v1.0/me/events', event, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  });
  return res.data;
}

function isAuthenticated() { return !!loadTokens(); }

module.exports = { getAuthUrl, exchangeCode, getAccessToken, getPersonalCalendarEvents, createPersonalCalendarEvent, getPersonalCalendars, isAuthenticated };
