# Civic Shower Screens — Backend Setup Guide

## What you are deploying

A single Vercel serverless function at `/api/scan`.

Your phone calls this URL. The function holds the Anthropic API key and calls
the Anthropic API on the server. Your phone never talks to Anthropic directly.

```
Phone  →  https://your-app.vercel.app/api/scan  →  api.anthropic.com
                    (your backend — holds the key)
```

---

## Step 1 — Get an Anthropic API key

1. Go to https://console.anthropic.com/keys
2. Click "Create Key"
3. Copy the key — it starts with `sk-ant-`
4. Store it somewhere safe (password manager). You will need it in Step 4.

---

## Step 2 — Create a GitHub repository

You need Git installed. Run in your terminal:

```bash
# In the civic-backend folder
git init
git add .
git commit -m "Initial backend"
```

Then:
1. Go to https://github.com/new
2. Create a new repository (e.g. `civic-screens-api`)
3. Push your code:

```bash
git remote add origin https://github.com/YOUR_USERNAME/civic-screens-api.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Deploy to Vercel (free)

1. Go to https://vercel.com and sign in with GitHub
2. Click "Add New Project"
3. Import your `civic-screens-api` repository
4. Leave all build settings as default — Vercel auto-detects serverless functions
5. Click "Deploy"

After ~30 seconds you will have a URL like:
`https://civic-screens-api-abc123.vercel.app`

---

## Step 4 — Add your API key to Vercel (this is the important security step)

1. In your Vercel project, go to **Settings → Environment Variables**
2. Add a new variable:
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (your key from Step 1)
   - Environment: select "Production", "Preview", and "Development"
3. Click Save
4. Go to **Deployments** and click **Redeploy** to pick up the new variable

The key is now stored encrypted in Vercel's environment. It is never in your
code, never in Git, and never sent to the phone.

---

## Step 5 — Update the app with your backend URL

In `glass-installer-app.jsx`, find this line near the top:

```js
const BACKEND_SCAN_URL = "https://your-app.vercel.app/api/scan";
```

Replace it with your actual Vercel URL:

```js
const BACKEND_SCAN_URL = "https://civic-screens-api-abc123.vercel.app/api/scan";
```

---

## Step 6 — Test from your phone

Open a browser on your phone and go to:

```
https://civic-screens-api-abc123.vercel.app/api/scan
```

You should see: `{"error":"Method not allowed. Use POST."}`

That means the backend is live and reachable. If you see a Vercel error page,
check the Vercel dashboard logs under "Functions".

Now test the full scan from the app on your phone.

---

## Local development (optional)

To run the backend on your laptop while building:

```bash
npm install
npx vercel dev
```

This starts the backend at `http://localhost:3000`.

Then in the app, temporarily change:

```js
const BACKEND_SCAN_URL = "http://localhost:3000/api/scan";
```

Note: localhost will NOT work from your phone — use ngrok or deploy to Vercel
to test on a physical device.

To test on your phone while developing locally, install ngrok:

```bash
npx ngrok http 3000
```

ngrok gives you a public URL like `https://abc123.ngrok.io` that tunnels to
your localhost. Use that in `BACKEND_SCAN_URL` for quick phone testing without
a full Vercel deploy.

---

## Where the API key lives — summary

| Location         | Has the key? | Why                                      |
|------------------|-------------|------------------------------------------|
| Your phone/app   | ❌ Never    | Frontend is public — anyone can read it  |
| git repository   | ❌ Never    | Committed keys get scraped in minutes    |
| .env.local       | ✅ Yes      | Local dev only, in .gitignore            |
| Vercel env vars  | ✅ Yes      | Encrypted, injected at runtime, not code |
| api/scan.js code | ❌ Never    | Reads from process.env, never hardcoded  |

---

## Do you need Expo, Supabase, or another backend?

- **Expo** — not needed unless you want a native iOS/Android app in the App Store.
  For a web app that works on phone browsers, you don't need it.

- **Supabase** — not needed for this. Supabase Edge Functions work similarly to
  Vercel functions but add a database. Use it later when you want to store jobs
  in the cloud or support multiple installers.

- **Vercel** — the right choice now. Free, instant deploys, no server management,
  handles CORS, and the function runs close to Anthropic's servers for speed.

- **Express/Node server** — works but overkill. Vercel serverless gives you the
  same result with zero server maintenance.
