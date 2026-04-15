const required = [
  'AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET',
  'USER_EMAIL','ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER','YOUR_WHATSAPP_NUMBER',
  'TODOIST_API_TOKEN','TODOIST_PROJECT_ID',
];

const missing = required.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('Missing env vars:', missing.join(', '));
  process.exit(1);
}

module.exports = {
  azure: {
    tenantId:     process.env.AZURE_TENANT_ID,
    clientId:     process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    userEmail:    process.env.USER_EMAIL,
  },
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  twilio: {
    accountSid:    process.env.TWILIO_ACCOUNT_SID,
    authToken:     process.env.TWILIO_AUTH_TOKEN,
    fromNumber:    'whatsapp:' + process.env.TWILIO_WHATSAPP_NUMBER,
    toNumber:      'whatsapp:' + process.env.YOUR_WHATSAPP_NUMBER,
    allowedSender: process.env.ALLOWED_SENDER || process.env.YOUR_WHATSAPP_NUMBER,
  },
  todoist: {
    token:     process.env.TODOIST_API_TOKEN,
    projectId: process.env.TODOIST_PROJECT_ID,
  },
};
