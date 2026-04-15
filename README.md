# WhatsApp Email Assistant

Office 365 unread emails → Claude AI summary → WhatsApp → Android Auto reads aloud.
Reply by voice to reply, create Todoist tasks, or delegate — all hands-free.

## How it works

- **3x daily** (8am, 12pm, 3pm) the app fetches your unread Office 365 emails,
  asks Claude to summarise and rank the top 5, then sends the digest to your WhatsApp.
- Android Auto reads the message aloud while you drive.
- You reply by voice: `reply 1 thanks approved`, `task 2`, or `delegate 3 to Lilian`.
- Claude polishes your reply, creates the Todoist task, or drafts the delegation email.
- You say `send` to dispatch the reviewed reply.

---

## Setup

### 1. Prerequisites

You need accounts at:
- **Azure Portal** — portal.azure.com (for Office 365 access)
- **Twilio** — twilio.com (WhatsApp delivery)
- **Anthropic** — console.anthropic.com (Claude API)
- **Todoist** — todoist.com

### 2. Azure App Registration

1. Go to portal.azure.com → App registrations → New registration
2. Name: `Email Assistant`, type: single tenant, redirect URI: none needed for app-only auth
3. Copy **Application (client) ID** and **Directory (tenant) ID**
4. Certificates & secrets → New client secret → copy the **Value**
5. API permissions → Add → Microsoft Graph → **Application permissions** (not delegated):
   - `Mail.Read`
   - `Mail.Send`
6. Click **Grant admin consent**

### 3. Twilio WhatsApp

1. Sign up at twilio.com, get your **Account SID** and **Auth Token**
2. Messaging → Try it out → Send a WhatsApp message → join the sandbox
3. Set the inbound webhook URL to: `https://YOUR-DOMAIN/webhook/whatsapp`

### 4. Install and configure

```bash
git clone <this-repo>
cd whatsapp-email-assistant
npm install
cp .env.example .env
# Edit .env with all your credentials
```

### 5. Add your delegates

Open `src/router.js` and fill in the `DELEGATES` map:

```js
const DELEGATES = {
  'lilian': 'lilian@yourdomain.com',
  'sarah':  'sarah@yourdomain.com',
};
```

---

## Running locally (for testing)

```bash
npm run dev
```

Then expose your local server to Twilio using [ngrok](https://ngrok.com):

```bash
ngrok http 3000
```

Copy the `https://xxxx.ngrok.io` URL and set it as your Twilio inbound webhook:
`https://xxxx.ngrok.io/webhook/whatsapp`

**Trigger a digest manually** without waiting for the schedule:
```bash
curl -X POST http://localhost:3000/trigger/digest
```

---

## Deploying to production (Railway — recommended)

Railway gives you a persistent server with a public URL for free (hobby tier).

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Add all environment variables from `.env` in the Railway dashboard
4. Railway auto-assigns a public URL — use that as your Twilio webhook URL

---

## WhatsApp commands

| Command | What it does |
|---|---|
| `reply 1 your message` | Claude polishes your reply, sends back a draft |
| `send` | Dispatches the pending draft reply |
| `edit new text` | Replaces the pending draft with new text |
| `task 2` | Creates a Todoist task from email 2 |
| `delegate 3 to Lilian` | Claude drafts a delegation email and sends it |

---

## Costs (approximate)

| Service | Monthly cost |
|---|---|
| Make.com | Not needed — replaced by this app |
| Railway (hosting) | Free hobby tier |
| Twilio WhatsApp | ~£0.04/message × ~100 messages = ~£4 |
| Claude API | ~£0.50–1.00 at digest volumes |
| **Total** | **~£5/month** |
