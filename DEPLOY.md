# Deploy & update Relity — plain-English guide (no coding)

Relity is already live at **https://relity.ai** (served by Render, domain via Porkbun → Cloudflare DNS).
This guide is mostly about **pushing updates** and **turning on features with keys**.

How updates work: your files live in the GitHub repo, and Render watches that repo.
**Push new files to GitHub → Render rebuilds and redeploys automatically.** That's the whole loop.

────────────────────────────────────────
A. PUSH AN UPDATE (about 3 minutes)
────────────────────────────────────────
Do this whenever the local files change (like the rename + Pro features we just added).

1. Go to your GitHub repo (the `Bitnooby/Trace` tab).
2. Click **Add file → Upload files**.
3. Drag in the changed files from your `Truth Project` folder:
      index.html   server.js   billing.js   package.json   (and DEPLOY.md / README.md if you like)
   - `billing.js` is new — make sure it goes in.
4. Click **Commit changes**.
5. Open the Render tab. The service starts building on its own (~2–3 min). When it says **Live**, refresh https://relity.ai.

Tip to confirm the new build is live: the share card should now read **relity.ai/check/…** (the old build said `trace.app`).

⚠️ Do NOT rename the Render service (`trace-g59u`) or the GitHub repo casually — your domain’s DNS
points at `trace-g59u.onrender.com`, so renaming breaks https://relity.ai until you update Porkbun.

────────────────────────────────────────
B. ENVIRONMENT VARIABLES (set once, in Render)
────────────────────────────────────────
Render → your service → **Environment** → Add Environment Variable. Add the name + value, Save (it redeploys).
Everything is optional — anything you leave out simply stays "not configured", nothing breaks.

Web checks (Phase 2):
  • SERPAPI_KEY            — reverse image search (serpapi.com)
  • FACTCHECK_KEY          — Google Fact Check Tools API (free Google Cloud key)

Storage (you already have Upstash connected — keeps shared links, cache, quota, rate limits alive):
  • UPSTASH_REDIS_REST_URL
  • UPSTASH_REDIS_REST_TOKEN

Cost + abuse controls (sensible defaults built in; override only if you want):
  • RELITY_FREE_DAILY      — free web-checks per device per day (default 10; 0 = require sign-in)
  • RL_PUBLISH_MAX         — checks per IP per 10 min (default 40)
  • RL_PROXY_MAX           — link-fetches per IP per 10 min (default 60)

Accounts + payments (Phase 4 — see section C):
  • RELITY_SECRET          — long random string used to sign the login cookie (REQUIRED before charging)
  • STRIPE_SECRET          — sk_live_… (or sk_test_… while testing)
  • STRIPE_PRICE           — price_… for your monthly plan
  • STRIPE_WEBHOOK_SECRET  — whsec_… from the webhook you create
  • RELITY_PRO_DAILY       — Pro daily allowance (default 1000 ≈ unlimited for consumers)

────────────────────────────────────────
C. TURN ON PRO (Stripe) — one-time setup
────────────────────────────────────────
The code is already wired; you just need a Stripe account and four values.

1. Create a Stripe account at stripe.com. Start in **Test mode** (toggle, top-right) until it works.
2. **Product + price:** Products → Add product → name "Relity Pro", recurring **monthly**, set the price
   (the model suggested ~$8). Save, then copy the **Price ID** (looks like `price_...`) → that's STRIPE_PRICE.
3. **Secret key:** Developers → API keys → copy the **Secret key** (`sk_test_...`) → that's STRIPE_SECRET.
4. **Webhook:** Developers → Webhooks → Add endpoint:
      URL:     https://relity.ai/webhook/stripe
      Events:  checkout.session.completed, customer.subscription.deleted, invoice.payment_failed
   Save, then copy the **Signing secret** (`whsec_...`) → that's STRIPE_WEBHOOK_SECRET.
5. Put all four (plus a long random RELITY_SECRET) into Render → Environment → Save.
6. Test with Stripe's test card `4242 4242 4242 4242`, any future date, any CVC.
   When it works, switch Stripe to **Live mode**, redo the key + webhook with live values, update Render.

How it behaves: the site shows "N free web-checks left today · Upgrade". Upgrade → Stripe Checkout →
back to relity.ai as Pro on that device. File checks always stay free for everyone, no login.

────────────────────────────────────────
IF SOMETHING LOOKS OFF
────────────────────────────────────────
• Build failed: Render → Logs → copy the red lines, send them to Claude.
• "Application failed": same — Logs tab, red lines.
• Upgrade button says "not set up": Stripe env vars aren’t in Render yet (section C).
• Shared link 404s after a deploy: shared reports live in Upstash; if Redis isn’t connected they reset on restart.
