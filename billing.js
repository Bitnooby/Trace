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
