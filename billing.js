/* ============================================================
   Relity — accounts & billing (Stripe)
   Self-contained. Degrades gracefully: with no Stripe keys the
   upgrade endpoints return "not configured" and the app runs free-only.

   How Pro works (no login wall):
     1. Free users are metered anonymously by device (the 'rid' cookie in server.js).
     2. To get more, a user pays via Stripe Checkout (hosted page).
     3. On return we verify the session, mark their email Pro, and sign them in
        on this device with a signed 'ruid' cookie. Pro persists by email.
     4. A webhook keeps Pro in sync if a subscription is cancelled or payment fails.

   Env (all optional until you turn billing on):
     RELITY_SECRET           — secret used to sign the session cookie (set a long random value)
     STRIPE_SECRET           — sk_live_… / sk_test_…
     STRIPE_PRICE            — price_… for your monthly plan
     STRIPE_WEBHOOK_SECRET   — whsec_… from the webhook endpoint
     RELITY_PRO_DAILY        — daily web-check allowance for Pro (default 1000 ≈ unlimited)
   ============================================================ */
const crypto = require('crypto');

module.exports = function billing({ redisOn, redisCmd, readCookie }) {
  const SECRET         = process.env.RELITY_SECRET || 'dev-insecure-change-me';
  const STRIPE_SECRET  = process.env.STRIPE_SECRET || '';
  const STRIPE_PRICE   = process.env.STRIPE_PRICE  || '';
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
  const PRO_DAILY      = Number.isFinite(+process.env.RELITY_PRO_DAILY) ? +process.env.RELITY_PRO_DAILY : 1000;
  const on = !!(STRIPE_SECRET && STRIPE_PRICE);
  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  const MAIL_FROM  = process.env.RELITY_MAIL_FROM || 'Relity <noreply@relity.ai>';
  const loginOn    = !!RESEND_KEY;

  let stripe = null;
  if (STRIPE_SECRET) { try { stripe = require('stripe')(STRIPE_SECRET); } catch (e) { console.error('stripe lib not installed:', e.message); } }

  const memPro = new Map();
  const b64   = s => Buffer.from(s).toString('base64url');
  const unb64 = s => Buffer.from(s, 'base64url').toString('utf8');
  const sig   = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);

  /* ---- signed session cookie (identity = email) ---- */
  function getEmail(req) {
    const t = readCookie(req, 'ruid'); if (!t) return null;
    const i = t.lastIndexOf('.'); if (i < 1) return null;
    const p = t.slice(0, i), s = t.slice(i + 1);
    if (sig(p) !== s) return null;
    try { return unb64(p); } catch { return null; }
  }
  function sessionCookie(email) {
    const p = b64(email);
    return `ruid=${p}.${sig(p)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
  }

  /* ---- magic-link email login (passwordless) ---- */
  async function sendMail(to, subject, html) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
    });
    if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
  }
  const loginEmailHtml = (link) =>
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:460px;margin:auto;padding:24px;color:#111">` +
    `<h2 style="margin:0 0 6px">Sign in to Relity</h2>` +
    `<p style="color:#555;margin:0 0 18px">Click below to sign in. This link expires in 30 minutes.</p>` +
    `<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">Sign in to Relity</a></p>` +
    `<p style="color:#999;font-size:12px;margin-top:18px">If you didn’t request this, you can ignore it. — Relity · evidence, not verdicts</p>` +
    `</div>`;

  /* ---- Pro state (Redis when available, else in-memory) ---- */
  async function isPro(email) {
    if (!email) return false;
    if (redisOn) { try { return (await redisCmd(['GET', `relity:pro:${email}`])) === 'active'; } catch { /* fall back */ } }
    return memPro.get(email) === 'active';
  }
  async function setPro(email, active) {
    if (!email) return;
    if (redisOn) { try { if (active) await redisCmd(['SET', `relity:pro:${email}`, 'active']); else await redisCmd(['DEL', `relity:pro:${email}`]); return; } catch { /* fall back */ } }
    if (active) memPro.set(email, 'active'); else memPro.delete(email);
  }
  async function tierOf(req) {
    const email = getEmail(req);
    return { email, tier: (await isPro(email)) ? 'pro' : 'free' };
  }

  /* ---- routes ---- */
  function mount(app, express) {
    // Start a subscription Checkout → returns { url } for the client to redirect to.
    app.post('/api/checkout', async (req, res) => {
      if (!on || !stripe) return res.status(503).json({ error: 'Billing isn’t set up yet (add STRIPE_SECRET + STRIPE_PRICE).' });
      try {
        const base = `${req.protocol}://${req.get('host')}`;
        const s = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price: STRIPE_PRICE, quantity: 1 }],
          allow_promotion_codes: true,
          success_url: `${base}/?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/`
        });
        res.json({ url: s.url });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // After Stripe redirects back: verify payment, mark Pro, sign in on this device.
    app.get('/api/claim', async (req, res) => {
      if (!on || !stripe) return res.status(503).json({ error: 'Billing not configured.' });
      try {
        const s = await stripe.checkout.sessions.retrieve((req.query.session_id || '').toString());
        const email = s.customer_details?.email || s.customer_email;
        if (s.payment_status === 'paid' && email) {
          await setPro(email, true);
          res.setHeader('Set-Cookie', sessionCookie(email));
          return res.json({ ok: true, tier: 'pro', email });
        }
        res.status(402).json({ ok: false, error: 'Payment not complete yet.' });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/signout', (req, res) => {
      res.setHeader('Set-Cookie', 'ruid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      res.json({ ok: true });
    });

    // Magic-link login: email a one-time sign-in link.
    app.post('/api/login', async (req, res) => {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
      if (!loginOn) return res.status(503).json({ error: 'Email login isn’t set up yet.' });
      try {
        const payload = b64(JSON.stringify({ e: email, x: Date.now() + 30 * 60 * 1000 }));
        const tok = `${payload}.${sig(payload)}`;
        const base = `${req.protocol}://${req.get('host')}`;
        const link = `${base}/api/auth?token=${encodeURIComponent(tok)}`;
        await sendMail(email, 'Your Relity sign-in link', loginEmailHtml(link));
        res.json({ ok: true });
      } catch (e) { console.error('login:', e.message); res.status(500).json({ error: 'Could not send the link. Try again shortly.' }); }
    });

    // Click the emailed link -> verify token, sign in on this device, bounce home.
    app.get('/api/auth', async (req, res) => {
      const tok = (req.query.token || '').toString();
      const i = tok.lastIndexOf('.');
      let o = null;
      if (i > 1 && sig(tok.slice(0, i)) === tok.slice(i + 1)) { try { o = JSON.parse(unb64(tok.slice(0, i))); } catch {} }
      if (!o || !o.e || !o.x || Date.now() > o.x) return res.redirect(302, '/?login=expired');
      res.setHeader('Set-Cookie', sessionCookie(o.e));
      res.redirect(302, '/?login=ok');
    });

    // Stripe webhook — keep Pro in sync with the subscription lifecycle. Needs the RAW body.
    app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
      if (!stripe || !WEBHOOK_SECRET) return res.status(503).end();
      let evt;
      try { evt = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET); }
      catch (e) { return res.status(400).send(`bad signature: ${e.message}`); }
      try {
        const o = evt.data.object;
        if (evt.type === 'checkout.session.completed') {
          const email = o.customer_details?.email || o.customer_email;
          if (email) await setPro(email, true);
        } else if (evt.type === 'customer.subscription.deleted' || evt.type === 'invoice.payment_failed') {
          if (o.customer) { const c = await stripe.customers.retrieve(o.customer); if (c && c.email) await setPro(c.email, false); }
        }
      } catch (e) { console.error('stripe webhook handler:', e.message); }
      res.json({ received: true });
    });
  }

  return { tierOf, isPro, setPro, getEmail, sessionCookie, mount, PRO_DAILY, configured: on };
};
