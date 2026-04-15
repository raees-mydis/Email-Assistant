const axios  = require('axios');
const config = require('./config');

let _cache = { token: null, expiresAt: 0 };

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

async function getUnreadEmails(max) {
  const email = config.azure.userEmail;
  const data = await graphGet('/users/' + email + '/messages', {
    '$filter': 'isRead eq false',
    '$select': 'id,subject,from,bodyPreview,receivedDateTime,importance',
    '$orderby': 'receivedDateTime DESC',
    '$top': max || 25,
  });
  return (data.value || []).map(m => ({
    id: m.id,
    subject: m.subject || '(no subject)',
    from: m.from && m.from.emailAddress ? m.from.emailAddress.address : 'unknown',
    fromName: m.from && m.from.emailAddress ? m.from.emailAddress.name : '',
    preview: m.bodyPreview || '',
    receivedAt: m.receivedDateTime,
    importance: m.importance || 'normal',
  }));
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

module.exports = { getUnreadEmails, replyToEmail, sendEmail };
