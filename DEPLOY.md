# Deploy Trace — plain-English guide (no coding)

Goal: turn these files into a real web address anyone can open, like
`https://trace-xxxx.onrender.com`. We do it in two phases.

- **Phase 1 (now):** get it LIVE. File checks + real shareable links work. No API keys needed.
- **Phase 2 (later):** add two keys to switch on web search + fact-check.

You do NOT need to edit any code. The app connects to its own server automatically.

────────────────────────────────────────
PHASE 1 — GET IT LIVE (about 15 minutes)
────────────────────────────────────────

You'll use two free websites:
- GitHub = a free locker to hold the files online.
- Render = the free host that runs them and gives you the web address.

STEP 1 — Make a GitHub account
  1. Go to github.com → Sign up. It's free.

STEP 2 — Put the 4 files into a GitHub "repository"
  1. Top-right, click the "+" → New repository.
  2. Repository name: trace   →   leave it Public   →   click Create repository.
  3. On the next page, click the link "uploading an existing file"
     (or: Add file → Upload files).
  4. Drag these four files into the browser window:
        index.html   server.js   package.json   README.md
  5. Click Commit changes. (Done — your files now live online.)

STEP 3 — Make a Render account
  1. Go to render.com → Get Started.
  2. Choose "Sign up with GitHub" and approve. (Links the two together.)

STEP 4 — Create the Web Service
  1. In the Render dashboard, click New +  →  Web Service.
  2. Find your "trace" repo and click Connect.
     (If you don't see it: click "Configure account / repository access",
      allow Render to see the trace repo, come back.)
  3. Render fills most of this in. Confirm these boxes say:
        Build Command:   npm install
        Start Command:   npm start
        Instance Type:   Free
  4. Click Create Web Service.

STEP 5 — Wait, then open it
  1. Render builds for ~2-3 minutes. When the top says "Live",
     click the URL (https://trace-xxxx.onrender.com).
  2. That's your tool, live on the internet.
  3. Drop in an image. Now the share link is REAL:
     copy it, open it on your phone — the result page loads.
     Paste it into a chat or X — it unfurls into the Trace card.

Note (honest): the free plan "sleeps" after ~15 min idle, so the first
visit after a quiet spell takes ~30-50 seconds to wake up, then it's fast.
Totally fine for testing and sharing. Upgrade later if traffic grows.

────────────────────────────────────────
PHASE 2 — TURN ON WEB SEARCH + FACT-CHECK (later)
────────────────────────────────────────

When you're ready, get two keys and paste them into Render:

  - SERPAPI_KEY    → reverse image search (sign up at serpapi.com)
  - FACTCHECK_KEY  → Google Fact Check Tools API (a Google Cloud key)

In Render: open your service → Environment → Add Environment Variable →
add each name + its key → Save. Render redeploys, and the two greyed-out
checks switch on by themselves.

(Ask Claude to walk you through getting each key — it's a short, separate errand.)

────────────────────────────────────────
IF SOMETHING LOOKS OFF
────────────────────────────────────────
- Page loads but says "Application failed": in Render, open the "Logs" tab,
  copy the red lines, and send them to Claude.
- Build failed: make sure all four files are in the repo's top level
  (not inside a folder).
- Share link shows a "not found" page: in the free prototype, reports reset
  when the server sleeps/restarts. That's the in-memory storage note in the
  README — swapping in a database fixes it permanently.
