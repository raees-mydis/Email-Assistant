const axios = require('axios');
const config = require('./config');

let _tokenCache = { token: null, expiresAt: 0 };

// ─── Authentication ──────────────────────────────────────────────────────────

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const { tenantId, clientId, clientSecret } = config.azure;
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
    grant_type:    'client_credentials',
  });

  const res = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  _tokenCache = {
    token:     res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };

  return _tokenCache.token;
}

function graphClient() {
  return {
    async get(path, params = {}) {
      const token = await getAccessToken();
      const res = await axios.get(`https://graph.microsoft.com/v1.0${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
      });
      return res.data;
    },
    async post(path, body) {
      const token = await getAccessToken();
      const res = await axios.post(`https://graph.microsoft.com/v1.0${path}`, body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      return res.data;
    },
  };
}

// ─── Fetch unread emails ─────────────────────────────────────────────────────

async function getUnreadEmails(maxResults = 25) {
  const graph = graphClient();
  const email = config.azure.userEmail;

  const data = await graph.get(`/users/${email}/messages`, {
    '$filter':  'isRead eq false',
    '$select':  'id,subject,from,bodyPreview,receivedDateTime,importance,conversationId,body',
    '$orderby': 'receivedDateTime DESC',
    '$top':     maxResults,
  });

  return (data.value || []).map(msg => ({
    id:           msg.id,
    subject:      msg.subject || '(no subject)',
    from:         msg.from?.emailAddress?.address || 'unknown',
    fromName:     msg.from?.emailAddress?.name || '',
    preview:      msg.bodyPreview || '',
    body:         msg.body?.content || '',
    receivedAt:   msg.receivedDateTime,
    importance:   msg.importance || 'normal',
    conversationId: msg.conversationId,
  }));
}

// ─── Send a reply to an existing email ──────────────────────────────────────

async function replyToEmail(messageId, replyText) {
  const graph = graphClient();
  const email = config.azure.userEmail;

  await graph.post(`/users/${email}/messages/${messageId}/reply`, {
    comment: replyText,
  });
}

// ─── Send a new email (for delegation) ──────────────────────────────────────

async function sendEmail({ to, subject, body }) {
  const graph = graphClient();
  const email = config.azure.userEmail;

  await graph.post(`/users/${email}/sendMail`, {
    message: {
      subject,
      body: {
        contentType: 'Text',
        content:     body,
      },
      toRecipients: [
        { emailAddress: { address: to } },
      ],
    },
    saveToSentItems: true,
  });
}

module.exports = { getUnreadEmails, replyToEmail, sendEmail };
