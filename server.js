/* ============================================================
   Relity — server
   What it adds on top of the in-browser checks:
     1. Reverse image search   (where else does this image appear / earliest copy)
     2. Known-fake / fact-check (has this been debunked)
     3. Shareable result pages  (GET /check/:id) that UNFURL nicely on social
   It also serves the frontend (index.html) so the whole thing is ONE deploy.

   Run locally:
     npm install
     SERPAPI_KEY=xxx FACTCHECK_KEY=yyy npm start
     → http://localhost:8080

   Both keys are optional — without them, those checks return
   "not configured" instead of fake results. Nothing is fabricated.

   STORAGE:
     • Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN to keep shared
       reports alive across deploys (90-day TTL). Without them, an in-memory
       fallback is used and reports reset on restart.
     • Large images (>680KB) stay in memory even with Redis on; the report
       text always persists. Add object storage later for full image durability.
     • GET /healthz is a lightweight keep-warm target for an uptime pinger.
     • Add rate limiting before opening the paid/AI tier to the public.
   ============================================================ */

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');

const app  = express();
app.set('trust proxy', true);                  // Render sits behind a proxy → makes req.protocol return https
const PORT  = process.env.PORT || 8080;
const SERPAPI_KEY   = process.env.SERPAPI_KEY   || '';   // serpapi.com — Google Lens engine
const FACTCHECK_KEY = process.env.FACTCHECK_KEY || '';   // Google Fact Check Tools API
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL   || '';  // Upstash Redis (REST) — keeps shared reports alive across deploys
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const redisOn = !!(REDIS_URL && REDIS_TOKEN);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
app.use(express.static(__dirname));            // serves index.html
app.use((req, res, next) => req.path === '/webhook/stripe' ? next() : express.json({ limit: '2mb' })(req, res, next));

/* ---------- persistence: Upstash Redis when configured, else in-memory ----------
   Shared reports (and small images) survive redeploys once UPSTASH_* env vars are set.
   Without them Relity still runs, but resets on restart (fine for local dev).
   The in-memory Maps also act as a fast cache in front of Redis.                  */
const memReport = new Map();          // id -> report
const memImg    = new Map();          // id -> {buf,mime}
const TTL = 60 * 60 * 24 * 90;        // keep shared reports for 90 days
const IMG_PERSIST_MAX = 680 * 1024;   // only push images this small to Redis (REST request cap); larger ones stay in-memory

async function redisCmd(args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}
async function putReport(id, report) {
  memReport.set(id, report);
  if (redisOn) { try { await redisCmd(['SET', 'relity:r:' + id, JSON.stringify(report), 'EX', TTL]); } catch (e) { console.error('redis putReport:', e.message); } }
}
async function getReport(id) {
  if (memReport.has(id)) return memReport.get(id);
  if (redisOn) { try { const v = await redisCmd(['GET', 'relity:r:' + id]); if (v) { const r = JSON.parse(v); memReport.set(id, r); return r; } } catch (e) { console.error('redis getReport:', e.message); } }
  return null;
}
async function putImage(id, buf, mime) {
  memImg.set(id, { buf, mime });
  if (redisOn && buf.length <= IMG_PERSIST_MAX) { try { await redisCmd(['SET', 'relity:i:' + id, JSON.stringify({ mime, b64: buf.toString('base64') }), 'EX', TTL]); } catch (e) { console.error('redis putImage:', e.message); } }
}
async function getImage(id) {
  if (memImg.has(id)) return memImg.get(id);
  if (redisOn) { try { const v = await redisCmd(['GET', 'relity:i:' + id]); if (v) { const o = JSON.parse(v); const img = { buf: Buffer.from(o.b64, 'base64'), mime: o.mime }; memImg.set(id, img); return img; } } catch (e) { console.error('redis getImage:', e.message); } }
  return null;
}
/* ---------- rate limiting (per IP) — Redis-backed when available, else in-memory ----------
   Protects the engine and the paid-API bill from bursts/abuse. Tune via env vars.        */
const RL_PUBLISH = { max: +process.env.RL_PUBLISH_MAX || 40, win: 600 };  // 40 checks / 10 min / IP
const RL_PROXY   = { max: +process.env.RL_PROXY_MAX   || 60, win: 600 };  // 60 link-fetches / 10 min / IP
const memRate = new Map();
async function allow(name, ip, max, win) {
  const k = `relity:rl:${name}:${ip}`;
  if (redisOn) {
    try { const n = await redisCmd(['INCR', k]); if (n === 1) await redisCmd(['EXPIRE', k, win]); return n <= max; }
    catch { /* fall back to in-memory */ }
  }
  const now = Date.now(), rec = memRate.get(k);
  if (!rec || now > rec.resetAt) { memRate.set(k, { count: 1, resetAt: now + win * 1000 }); return true; }
  rec.count++; return rec.count <= max;
}
const clientIp = req => (req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown');

/* ---------- anonymous device id + daily free quota ----------
   No login to use Relity. We mint a random device id in an httpOnly cookie so we can
   meter the one *paid* check (web cross-check) per device per day. The in-browser file
   checks always run and are never gated. Cached web results don't count. Accounts +
   Stripe later raise/remove the limit — this metering layer stays the same.          */
const FREE_DAILY = Number.isFinite(+process.env.RELITY_FREE_DAILY) ? +process.env.RELITY_FREE_DAILY : 10;   // free paid-web-checks / device / day (0 = require sign-in)
const memQuota = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function deviceId(req, res) {
  let id = readCookie(req, 'rid');
  if (!id || !/^[a-f0-9]{24,}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    const secure = req.protocol === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `rid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }
  return id;
}
async function quotaGet(id) {
  const k = `relity:q:${id}:${today()}`;
  if (redisOn) { try { return +(await redisCmd(['GET', k])) || 0; } catch { /* fall back */ } }
  const rec = memQuota.get(k); return rec ? rec.count : 0;
}
async function quotaInc(id) {
  const k = `relity:q:${id}:${today()}`;
  if (redisOn) { try { const n = await redisCmd(['INCR', k]); if (n === 1) await redisCmd(['EXPIRE', k, 172800]); return n; } catch { /* fall back */ } }
  const rec = memQuota.get(k) || { count: 0 }; rec.count++; memQuota.set(k, rec); return rec.count;
}

const billing = require('./billing')({ redisOn, redisCmd, readCookie });
const ai      = require('./ai')({ redisOn, redisCmd });
const claims  = require('./claims')({ SERPAPI_KEY, FACTCHECK_KEY, ai, tierOf: billing.tierOf });
const video   = require('./video')({ SERPAPI_KEY, putImage, ai });
async function meteredGate(name, req, res, next) {
  if (!(await allow(name, clientIp(req), RL_PUBLISH.max, RL_PUBLISH.win)))
    return res.status(429).json({ error: 'Too many checks right now — give it a moment.' });
  const rid = deviceId(req, res);
  const acct = await billing.tierOf(req);
  const limit = acct.tier === 'pro' ? billing.PRO_DAILY : FREE_DAILY;
  if ((await quotaGet(rid)) >= limit) {
    return res.json({ limited: true, read: { eyebrow: 'Consensus — the evidence, weighed', level: 'scrutinize', badge: 'Free limit reached', line: 'You have used your free checks for today — sign in / upgrade to keep checking.' }, frames: [], sources: { items: [], domains: [] } });
  }
  res.on('finish', () => { if (res.statusCode === 200) quotaInc(rid).catch(() => {}); });
  next();
}

const shortId  = sha => (sha ? sha.slice(0, 10) : crypto.randomBytes(5).toString('hex'));

/* ---------- adapter 1: reverse image search (SerpAPI / Google Lens) ----------
   Lens needs a public image URL, so we host the uploaded bytes at /img/:id
   and hand that URL to the provider. Alternative: TinEye API accepts direct
   uploads (multipart) — swap this function if you use it.                      */
async function reverseSearch(publicImageUrl) {
  if (!SERPAPI_KEY) return { connected: false, note: 'Reverse search not configured (set SERPAPI_KEY).' };
  // an honest "we couldn't check" — NOT the same as "appears nowhere", and must never feed a real signal to consensus
  const DEGRADED = { connected: true, degraded: true, note: 'The web-appearance check couldn’t run for this image (search quota or service hiccup).' };
  try {
    const u = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(publicImageUrl)}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(u);
    const j = await r.json();
    if (!r.ok || j.error) return DEGRADED;   // quota exhausted, bad key, or any SerpAPI error JSON
    const matches = (j.visual_matches || []).slice(0, 8).map(m => ({
      title: m.title, source: m.source, link: m.link, date: m.date || null
    }));
    const domains = [...new Set((j.visual_matches || []).map(m => {
      try { return new URL(m.link).hostname.replace(/^www\./, ''); } catch { return (m.source || '').toLowerCase(); }
    }).filter(Boolean))].slice(0, 6);
    const dated = matches.filter(m => m.date).sort((a, b) => new Date(a.date) - new Date(b.date));
    return {
      connected: true,
      count: (j.visual_matches || []).length,
      earliest: dated[0] || null,
      domains,
      matches
    };
  } catch (e) {
    return DEGRADED;
  }
}

/* ---------- adapter 2: fact-check (Google Fact Check Tools) ----------
   Feed it the captions/titles surfaced by reverse search.               */
async function factCheck(queries) {
  if (!FACTCHECK_KEY) return { connected: false, note: 'Fact-check not configured (set FACTCHECK_KEY).' };
  const terms = [...new Set(queries.filter(Boolean))].slice(0, 3);
  if (!terms.length) return { connected: true, claims: [], note: 'No text to query yet.' };
  try {
    const all = [];
    for (const q of terms) {
      const u = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(q)}&key=${FACTCHECK_KEY}`;
      const r = await fetch(u);
      const j = await r.json();
      for (const c of (j.claims || [])) {
        const review = (c.claimReview || [])[0] || {};
        all.push({ claim: c.text, rating: review.textualRating, publisher: review.publisher?.name, url: review.url });
      }
    }
    return { connected: true, claims: all.slice(0, 6) };
  } catch (e) {
    return { connected: true, error: 'Fact-check request failed: ' + e.message };
  }
}

/* ---------- publish: run cross-checks, store, return id ---------- */
app.post('/api/publish', upload.single('image'), async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!(await allow('publish', ip, RL_PUBLISH.max, RL_PUBLISH.win)))
      return res.status(429).json({ error: 'You’re checking images very fast — give it a moment and try again.' });
    const sha = (req.body.sha256 || '').trim();
    const id  = shortId(sha);
    let findings = [];
    try { findings = JSON.parse(req.body.findings || '[]'); } catch { /* ignore */ }
    let read = null;
    try { read = JSON.parse(req.body.read || 'null'); } catch { /* ignore */ }
    let claim = null;
    try { claim = JSON.parse(req.body.claim || 'null'); } catch { /* ignore */ }

    if (req.file) await putImage(id, req.file.buffer, req.file.mimetype);

    const base = `${req.protocol}://${req.get('host')}`;
    const publicImageUrl = req.file ? `${base}/img/${id}` : null;

    // COST CACHE + FREE QUOTA: reverse image search is the paid call.
    // 1) Identical images share a fingerprint (id) → reuse a prior result, free, never metered.
    // 2) Otherwise meter against the device's daily free allowance; over it, skip the paid call.
    const rid = deviceId(req, res);
    const acct = await billing.tierOf(req);
    const limit = acct.tier === 'pro' ? billing.PRO_DAILY : FREE_DAILY;
    const prior = sha ? await getReport(id) : null;
    let reverse, reverseCached = false;
    if (prior && prior.reverse && prior.reverse.connected && !prior.reverse.degraded && !prior.reverse.limited) {
      reverse = prior.reverse; reverseCached = true;
    } else if (publicImageUrl && SERPAPI_KEY) {
      if ((await quotaGet(rid)) >= limit) {
        reverse = { connected: true, limited: true, note: 'Free daily web-checks are used up. The file checks still ran — sign in / upgrade to keep running live web cross-checks.' };
      } else {
        reverse = await reverseSearch(publicImageUrl);
        if (reverse.connected && !reverse.degraded) await quotaInc(rid);   // only a real paid lookup counts
      }
    } else {
      reverse = publicImageUrl ? await reverseSearch(publicImageUrl) : { connected: false };
    }
    const captions = (reverse.matches || []).map(m => m.title);
    // the submitted claim is the most direct thing to fact-check — check it first
    const claimText = claim && (claim.title || claim.description) ? (claim.title || claim.description) : null;
    const fact = await factCheck([claimText, ...captions].filter(Boolean));
    let aiRead = null;
    if (req.file) {
      const ev = (reverse.domains && reverse.domains.length) ? reverse.domains.slice(0, 4).join(', ') : '';
      aiRead = await ai.analyzeImage({ tier: acct.tier, sha, buffer: req.file.buffer, mime: req.file.mimetype, caption: claimText, evidence: ev }).catch(() => null);
    }

    // recontextualization: claim presents the image as current, but the image is demonstrably older
    let claimOut = null;
    if (claim && (claim.title || claim.description)) {
      const vy = vintageYear(reverse.earliest);
      const recent = claimImpliesRecent(`${claim.title || ''} ${claim.description || ''}`);
      const mismatch = (recent && vy) ? { is: true, year: vy } : { is: false };
      claimOut = { title: claim.title || '', description: claim.description || '', source: claim.source || '', mismatch };
      if (claim.verdict && claim.verdict.line) claimOut.verdict = { badge: String(claim.verdict.badge || '').slice(0, 60), line: String(claim.verdict.line || '').slice(0, 400), level: claim.verdict.level || '' };
    }

    const report = { id, sha256: sha, createdAt: Date.now(), findings, read, reverse, reverseCached, fact, aiRead, prov: (req.body.prov || null), claim: claimOut, hasImage: !!req.file };
    await putReport(id, report);
    try {
      if (req.file && claimOut && reverse && reverse.connected && !reverse.limited && !reverse.degraded && (reverse.count||0) >= 5) {
        const trd = consensusOf(report);
        await trendPush({ id, at: Date.now(), cap: clip((claimOut.title||claimOut.description||''),140), src: claimOut.source||'', n: reverse.count||0, badge: trd?trd.badge:'', level: trd?trd.level:'scrutinize' });
      }
    } catch (e) { /* trending is best-effort, never block a check */ }
    res.json({ id, reverse, fact, claim: claimOut, aiRead, quota: { used: await quotaGet(rid), limit, tier: acct.tier } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/result/:id', async (req, res) => {
  const r = await getReport(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.get('/img/:id', async (req, res) => {
  const i = await getImage(req.params.id);
  if (!i) return res.status(404).end();
  res.set('Content-Type', i.mime || 'image/jpeg').send(i.buf);
});

// lightweight keep-warm target for an external uptime pinger (avoids the cold-start wait)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// who am I + how much free quota is left today (no login required)
app.get('/api/me', async (req, res) => {
  const id = deviceId(req, res);
  const acct = await billing.tierOf(req);
  const limit = acct.tier === 'pro' ? billing.PRO_DAILY : FREE_DAILY;
  const used = await quotaGet(id);
  const reset = new Date(); reset.setUTCHours(24, 0, 0, 0);
  res.json({ tier: acct.tier, email: acct.email || null, used, limit, remaining: Math.max(0, limit - used), resetsAt: reset.toISOString(), loginReady: !!billing.loginReady, googleClientId: billing.googleClientId || null, webhookReady: !!billing.webhookReady, paymentsReady: !!billing.configured, telegramReady: !!telegram.configured });
});

/* ---------- fetch an image from a pasted link ----------
   Handles a direct image URL, or an article/page URL (pulls its og:image).
   Social posts (X, Instagram, TikTok) usually block this — the UI tells users
   to right-click → Copy image → Ctrl+V instead.
   Guards: https/http only, no private/loopback hosts (SSRF), 8s timeout, 15MB cap. */
const MAX_BYTES = 15 * 1024 * 1024;
const FETCH_UA  = 'Mozilla/5.0 (compatible; RelityBot/0.1; +https://relity.ai/)';
function hostBlocked(h) {
  h = (h || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}
async function grab(url, accept) {
  return fetch(url, { headers: { 'User-Agent': FETCH_UA, 'Accept': accept }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
}
async function toCappedBuffer(resp) {
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too-large');
  return buf;
}

/* ---------- the claim agent: read the headline/caption wrapped around an image ---------- */
function clip(s,n){ s=(s||'').toString().replace(/\s+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'…':s; }
function decodeEntities(s){ return (s||'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#0?39;|&apos;|&#x27;/gi,"'").replace(/&#8217;|&rsquo;/gi,'’').replace(/&#8220;|&ldquo;/gi,'“').replace(/&#8221;|&rdquo;/gi,'”').replace(/&#8211;|&ndash;/gi,'–').replace(/&#8212;|&mdash;/gi,'—').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)); }
function claimImpliesRecent(text){
  const t=(text||'').toLowerCase();
  if(/\b(today|yesterday|breaking|just now|right now|moments? ago|this (week|month|morning|afternoon|evening)|happening now|live now|latest|developing)\b/.test(t)) return true;
  const now=new Date().getFullYear();
  if(new RegExp('\\b('+now+'|'+(now-1)+')\\b').test(t)) return true;
  return false;
}
function looksLikeClaim(s){
  s=(s||'').trim();
  if(s.length<8) return false;
  if(/[<>]|\/>|="|http-equiv|viewport|initial-scale|device-width|preconnect|stylesheet|user-scalable|charset=|rel=["']/i.test(s)) return false;
  const words=s.split(/\s+/).filter(Boolean);
  if(words.length<3) return false;
  const letters=(s.match(/[a-zA-Z]/g)||[]).length;
  if(letters < s.length*0.5) return false;
  return true;
}
function extractClaim(html, host){
  const meta=(props)=>{
    for(const p of props){
      let m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']'+p+'["\'][^>]*?content=(["\'])([\\s\\S]*?)\\1','i'))
           || html.match(new RegExp('<meta[^>]+content=(["\'])([\\s\\S]*?)\\1[^>]*?(?:property|name)=["\']'+p+'["\']','i'));
      if(m && m[2]){ const v=decodeEntities(m[2]); if(looksLikeClaim(v)) return v; }
    }
    return '';
  };
  let title=meta(['og:title','twitter:title']);
  if(!title){ const tt=decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||''); if(looksLikeClaim(tt)) title=tt; }
  const description=meta(['og:description','twitter:description','description']);
  if(!title && !description) return null;
  return { title: clip(title,200), description: clip(description,300), source: host };
}

app.get('/api/proxy-image', async (req, res) => {
  if (!(await allow('proxy', clientIp(req), RL_PROXY.max, RL_PROXY.win)))
    return res.status(429).json({ error: 'Too many link fetches right now — wait a moment and try again.' });
  const raw = (req.query.url || '').toString().trim();
  let u;
  try { u = new URL(raw); } catch { return res.status(400).json({ error: 'That doesn’t look like a valid link.' }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Only http and https links are supported.' });
  if (hostBlocked(u.hostname)) return res.status(400).json({ error: 'That address isn’t allowed.' });

  try {
    const resp = await grab(u.href, 'image/*,text/html;q=0.9,*/*;q=0.8');
    const ct = (resp.headers.get('content-type') || '').toLowerCase();

    // Direct image
    if (ct.startsWith('image/')) {
      const buf = await toCappedBuffer(resp);
      return res.set('Content-Type', ct).send(buf);
    }

    // HTML page → find a preview image (og:image / twitter:image)
    if (ct.includes('text/html') || ct === '') {
      const html = await resp.text();
      const find = re => { const m = html.match(re); return m ? m[1] : null; };
      let img = find(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i)
             || find(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i)
             || find(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
             || find(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
      if (!img) { const oe2 = await oembed(u.href).catch(() => null); if (oe2 && oe2.thumb) img = oe2.thumb; }
      if (!img) return res.status(422).json({ error: 'No image found on that page. Sites like X, Instagram and TikTok block automatic fetching — use Copy image → Ctrl+V instead.' });
      img = new URL(img, u.href).href;
      // read the claim wrapped around the image (the caption is where the lie usually lives)
      const claim = extractClaim(html, u.hostname);
      if (claim) { res.set('X-Relity-Claim', encodeURIComponent(JSON.stringify(claim))); res.set('Access-Control-Expose-Headers', 'X-Relity-Claim'); }
      const ir = await grab(img, 'image/*');
      const ict = (ir.headers.get('content-type') || '').toLowerCase();
      if (!ict.startsWith('image/')) return res.status(422).json({ error: 'Found a preview link but it wasn’t an image.' });
      const buf = await toCappedBuffer(ir);
      return res.set('Content-Type', ict).send(buf);
    }

    return res.status(422).json({ error: 'That link isn’t an image or a readable page.' });
  } catch (e) {
    if (e.message === 'too-large') return res.status(413).json({ error: 'That image is too large to fetch.' });
    if (e.name === 'TimeoutError') return res.status(504).json({ error: 'That link took too long to respond.' });
    return res.status(502).json({ error: 'Couldn’t reach that link.' });
  }
});

/* ---------- read a social / news LINK: the media + the poster's caption, checked ----------
   oEmbed (YouTube/TikTok/Vimeo) and og/twitter meta tags pull the preview thumbnail and the
   caption; the caption then runs through the same claim engine as the bot and /api/check-claim.
   Locked platforms (X, Instagram) block this — we say so and point to the file / extension. */
const OEMBED = [
  { re: /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i,        ep: u => 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u), video: true },
  { re: /(^|\.)tiktok\.com$/i,                           ep: u => 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(u),            video: true },
  { re: /(^|\.)vimeo\.com$/i,                            ep: u => 'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(u),         video: true },
];
async function oembed(pageUrl) {
  let host; try { host = new URL(pageUrl).hostname; } catch { return null; }
  const m = OEMBED.find(o => o.re.test(host));
  if (!m) return null;
  try {
    const r = await fetch(m.ep(pageUrl), { headers: { 'User-Agent': FETCH_UA, 'Accept': 'application/json' }, redirect: 'follow', signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: clip(decodeEntities(j.title || ''), 300), author: clip(decodeEntities(j.author_name || ''), 80), thumb: (j.thumbnail_url || '').toString(), video: m.video || /video/i.test(j.type || '') };
  } catch { return null; }
}
function platformOf(host) {
  host = (host || '').toLowerCase().replace(/^www\./, '');
  if (/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host))    return { name: 'X', locked: true };
  if (/(^|\.)instagram\.com$/.test(host))                return { name: 'Instagram', locked: true };
  if (/(^|\.)facebook\.com$|(^|\.)fb\.watch$/.test(host)) return { name: 'Facebook', locked: true };
  if (/(^|\.)threads\.net$/.test(host))                  return { name: 'Threads', locked: true };
  if (/(^|\.)tiktok\.com$/.test(host))                   return { name: 'TikTok', locked: false };
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return { name: 'YouTube', locked: false };
  if (/(^|\.)vimeo\.com$/.test(host))                    return { name: 'Vimeo', locked: false };
  if (/(^|\.)reddit\.com$/.test(host))                   return { name: 'Reddit', locked: false };
  return { name: host, locked: false };
}

app.get('/api/check-link', async (req, res) => {
  if (!(await allow('proxy', clientIp(req), RL_PROXY.max, RL_PROXY.win)))
    return res.status(429).json({ error: 'Too many link reads right now — wait a moment and try again.' });
  const raw = (req.query.url || '').toString().trim();
  let u; try { u = new URL(raw); } catch { return res.status(400).json({ error: 'That does not look like a valid link.' }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Only http and https links are supported.' });
  if (hostBlocked(u.hostname)) return res.status(400).json({ error: 'That address is not allowed.' });

  const plat = platformOf(u.hostname);
  let caption = null, mediaUrl = null, isVideo = false;

  // 1) oEmbed first — caption + thumbnail with no scraping (a TikTok caption lives here)
  const oe = await oembed(u.href).catch(() => null);
  if (oe) {
    if (oe.title) caption = { title: oe.title, description: '', source: plat.name + (oe.author ? ' · ' + oe.author : '') };
    if (oe.thumb) mediaUrl = oe.thumb;
    if (oe.video) isVideo = true;
  }

  // 2) og / twitter meta tags — news sites and many platforms expose the caption + preview here
  if (!caption || !mediaUrl) {
    try {
      const resp = await grab(u.href, 'text/html,application/xhtml+xml,*/*;q=0.8');
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('html') || ct === '') {
        const html = (await resp.text()).slice(0, 800000);
        if (!mediaUrl) {
          const find = re => { const m = html.match(re); return m ? m[1] : null; };
          let img = find(/<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i)
                 || find(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i)
                 || find(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
                 || find(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
          if (img) mediaUrl = img;
        }
        if (/property=["']og:video|name=["']twitter:player/i.test(html)) isVideo = true;
        if (!caption) caption = extractClaim(html, plat.name);
      }
    } catch { /* blocked / unreachable — handled below */ }
  }

  if (mediaUrl) { try { mediaUrl = new URL(mediaUrl, u.href).href; } catch { mediaUrl = null; } }

  // 3) the caption is checked separately by the client (keeps the link read fast) — see /api/check-claim
  const captionCheck = null;

  const blocked = !caption && !mediaUrl;
  let note = '';
  if (isVideo) note = 'This is a video post — Relity reads the poster’s thumbnail frame and the caption. The full clip can’t be pulled from a link; to check the footage itself, download it and drop the file here.';
  if (blocked) note = plat.locked
    ? `${plat.name} blocks reading posts from a link. Drop the image or video file here, or use the Relity browser extension right on the post.`
    : 'Could not read a caption or preview from that link. Drop the file here, or paste the caption to check it.';

  res.json({ ok: !blocked, platform: plat.name, locked: !!plat.locked, isVideo, mediaUrl: mediaUrl || null, caption: caption || null, captionCheck, blocked, note });
});


app.post('/api/attach-verdict', async (req, res) => {
  try {
    const id = ((req.body && req.body.id) || '').toString().slice(0, 40);
    const v = req.body && req.body.verdict;
    if (!id || !v || !v.line) return res.json({ ok: false });
    const r = await getReport(id);
    if (!r) return res.json({ ok: false });
    const verdict = { badge: String(v.badge || '').slice(0, 60), line: String(v.line || '').slice(0, 400), level: v.level || '' };
    if (r.claim && (r.claim.title || r.claim.description)) r.claim.verdict = verdict;
    else r.claim = { title: '', description: '', source: '', verdict };
    await putReport(id, r);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});


/* ---------- the shareable result page (unfurls on social) ---------- */
// read meaning from WHERE an image appears (mirrors the client)
function interpretDomains(domains){
  const d=(domains||[]).map(x=>String(x).toLowerCase());
  const hit=arr=>d.filter(x=>arr.some(k=>x.includes(k)));
  const AI=['aiease','monica.im','civitai','lexica','midjourney','leonardo.ai','openart','nightcafe','seaart','tensor.art','starryai','deepai','craiyon','getimg','playground','dezgo','stablediffusion','perchance','pixai','mage.space','dream.ai','artbreeder','fotor','ideogram','krea.ai','prompthero'];
  const STOCK=['vecteezy','shutterstock','istockphoto','gettyimages','freepik','stock.adobe','dreamstime','alamy','123rf','depositphotos','pexels','unsplash','pixabay'];
  const NEWS=['reuters','apnews','bbc.','nytimes','washingtonpost','theguardian','cnn.','npr.org','aljazeera','bloomberg','afp.','dpa.com','forbes','independent.co','nbcnews','cbsnews','abcnews','usatoday','politico','axios','time.com','wsj.com','foxnews','cnbc','msnbc','newsweek','thehill','huffpost','businessinsider','vox.com','theatlantic','latimes','chicagotribune','nypost','propublica','pbs.org','yahoo','telegraph.co','ft.com','economist','skynews','news.sky','dailymail','mirror.co.uk','metro.co.uk','euronews','dw.com','france24','cbc.ca','ctvnews','globalnews','globeandmail','abc.net.au','nzherald','thehindu','timesofindia','indianexpress','ndtv','hindustantimes','indiatoday','scmp.com','straitstimes','japantimes','kyodonews','channelnewsasia','arabnews','timesofisrael','jpost','irishtimes','rte.ie'];
  const FC=['snopes','politifact','factcheck','fullfact','leadstories','checkyourfact','truthorfiction','altnews','boomlive','factly','maldita','verafiles','africacheck','factcrescendo','newschecker','vishvasnews'];
  const SOCIAL=['x.com','twitter','facebook','fb.com','fb.watch','instagram','tiktok','reddit','youtube','youtu.be','pinterest','threads.net','tumblr','vk.com','weibo','t.me','telegram','linkedin','snapchat','mastodon','bsky','bluesky','9gag','imgur','quora'];
  const MARKET=['amazon','ebay','etsy','aliexpress','walmart','temu','redbubble','teepublic','zazzle','wish.com'];
  const u=a=>[...new Set(a)]; const name=a=>u(a).slice(0,2).join(', ');
  const ai=hit(AI),st=hit(STOCK),nw=hit(NEWS),fc=hit(FC),so=hit(SOCIAL),mk=hit(MARKET);
  let flag=null; if(ai.length)flag='ai'; else if(nw.length)flag='news'; else if(st.length)flag='stock';
  let parts=[];
  if(fc.length)parts.push(`fact-checking sites (${name(fc)})`);
  if(nw.length)parts.push(`news outlets (${name(nw)})`);
  if(ai.length)parts.push(`AI-image sites (${name(ai)})`);
  if(st.length)parts.push(`stock sites (${name(st)})`);
  if(so.length)parts.push(`social platforms (${name(so)})`);
  if(mk.length)parts.push(`product listings (${name(mk)})`);
  let text='';
  if(parts.length){
    text='Appears on '+parts.slice(0,3).join(', ')+(parts.length>3?', and more':'')+'. ';
    if(fc.length)text+='Showing up on fact-checkers means it’s likely already been examined — read their conclusion.';
    else if(ai.length)text+='Presence on AI-image sites hints this may be AI-generated.';
    else if(nw.length)text+='Presence on news outlets is consistent with a real photo — verify the original context.';
    else if(mk.length&&so.length)text+='A widely-reused image (social + merch), not a unique original — check the specific claim attached to it.';
    else if(so.length)text+='Heavily shared on social — which says nothing about whether it’s real. Check the caption.';
    else if(st.length)text+='Could be stock or AI stock art.';
  }
  return {flag,examined:fc.length>0,fcHits:u(fc).slice(0,3),text:text.trim(),found:parts.length>0};
}
function vintageYear(earliest){
  if(!earliest||!earliest.date)return null;
  const m=String(earliest.date).match(/(19|20)\d{2}/); if(!m)return null;
  const y=+m[0], now=new Date().getFullYear();
  return (y>=1990&&y<=now-1)?y:null;
}
// the raw Lens count is page-capped (~50-60), so report spread qualitatively, never as a precise (misleading) number
function spreadPhrase(n){ if(!n) return ''; if(n<=3) return 'a few places'; if(n<=15) return 'several places'; return 'many places'; }

// CONSENSUS — weigh all three evidence streams into one honest read (mirrors the client)
function aiLeanOf(t){
  t=(t||'').toString();
  if(/READ:\s*Likely AI-generated/i.test(t)) return 'ai';
  if(/READ:\s*Possibly edited/i.test(t)) return 'edited';
  if(/READ:\s*Likely authentic/i.test(t)) return 'real';
  if(/READ:\s*Inconclusive/i.test(t)) return null;
  if(/lean[s]?[^.]{0,40}AI[- ]?generat/i.test(t)) return 'ai';
  if(/(consistent with|rather than)[^.]{0,30}(real|genuine|authentic|photograph)/i.test(t)) return 'real';
  return null;
}
function computeConsensus(prov, reach, debunked, count, examined, vintage, mismatchYear, aiConcern){
  const E='Consensus — the evidence, weighed';
  const places = count ? ` (seen across ${spreadPhrase(count)})` : '';
  const vint = vintage ? ` It’s been online since ${vintage} — be wary of any caption claiming it’s recent or breaking.` : '';
  const r=(level,badge,line)=>({eyebrow:E,level,badge,line:(level==='debunk'||level==='ai')?line:line+vint});
  if(debunked) return r('debunk','Debunked on record',`Fact-checkers have addressed this image and rated the claim false or misleading${places}. That usually means real footage paired with a false or recycled caption — so treat the image as unreliable, though the underlying event may well be real. Read their finding below.`);
  if(prov==='ai-cred') return r('ai','AI-generated','Its Content Credential declares it AI-generated — a strong, embedded signal'+(reach==='ai'?', and it lives on AI-image sites too. Everything lines up.':'.'));
  if(mismatchYear) return {eyebrow:E,level:'scrutinize',badge:'Likely recontextualized',line:`The caption presents this as current, but the image has been online since ${mismatchYear} — the classic recontextualization move: a real, older photo paired with a false new caption.`};
  if(examined) return r('scrutinize','Likely fact-checked',`This image appears on fact-checking sites${places} — very likely it’s already been examined. Read what they concluded before trusting any caption attached to it.`);
  if(aiConcern==='ai'){
    if(reach==='news'||prov==='camera') return r('scrutinize','Signals conflict',`A vision model read this as likely AI-generated, yet it also carries real-photo signals${reach==='news'?' (it appears on news outlets)':' (camera data)'} — these disagree, so it is genuinely uncertain; weigh both.`);
    return r('scrutinize','Leans AI-generated',`A vision model read this as likely AI-generated${places} — one signal, not proof, and a single frame can’t be certain, but the weight here leans synthetic.`);
  }
  if(prov==='camera' && reach==='ai') return r('scrutinize','Signals conflict','It carries camera data (suggests a real photo) yet lives on AI-image sites (suggests AI). These disagree — genuinely uncertain.');
  if(prov==='ai-marker' && reach==='ai') return r('scrutinize','Leans AI-generated',`It carries an AI-tool marker and lives on AI-image sites${places}. No hard proof, but the weight points to AI.`);
  if(reach==='ai') return r('scrutinize','Leans AI-generated',`No provenance survived, but this image lives on AI-image sites${places} — circumstantial, but it leans AI-generated.`);
  if(prov==='ai-marker') return r('scrutinize','Possible AI','It carries a marker associated with an AI generator — a sign it may be AI-made.');
  if(prov==='camera') return r('photo','Leans authentic','It carries camera/capture data'+(reach==='news'?' and appears on news outlets':'')+' — consistent with a real photo, though metadata can be edited.');
  if(reach==='news') return r('photo','Leans authentic',`The file is stripped, but this image appears on news outlets${places} — consistent with a real news photo.`);
  if(prov==='credential') return r('verified','Origin on record','It carries a Content Credential — a real record of how it was made. Most images carry none.');
  if(aiConcern==='real'){
    if(reach==='news'||prov==='camera') return r('photo','Leans authentic',`The closest look found no signs of manipulation, and it ${reach==='news'?'appears on news outlets':'carries camera data'}${places} — our read leans real. Captions and context can still mislead, so verify what it actually shows.`);
    return r('photo','Leans real',`The closest look found no manipulation tells${places}, so our read leans real — but a clean frame alone can’t rule out AI video and no provenance or news trail survived, so treat the specifics as unconfirmed.`);
  }
  if(aiConcern==='edited') return r('scrutinize','Possibly edited',`The closest look flagged possible signs of editing${places}, so it leans edited — one signal, not proof; find the original to compare.`);
  return r('scrutinize','Unverified','No provenance survived, and no fact-check is on record'+(reach==='stock'?'; it appears on stock-image sites':'')+`${places}. It could be real, AI, or real media with a false caption.`);
}

const memTrend = [];
async function trendPush(entry){
  try{ memTrend.unshift(entry); if(memTrend.length>60) memTrend.length=60; }catch{}
  if(redisOn){ try{ await redisCmd(['LPUSH','relity:trend',JSON.stringify(entry)]); await redisCmd(['LTRIM','relity:trend','0','59']); }catch(e){ console.error('trendPush:',e.message); } }
}
async function trendList(){
  if(redisOn){ try{ const v=await redisCmd(['LRANGE','relity:trend','0','59']); if(Array.isArray(v)) return v.map(x=>{ try{ return typeof x==='string'?JSON.parse(x):x; }catch{ return null; } }).filter(Boolean); }catch(e){ console.error('trendList:',e.message); } }
  return memTrend.slice();
}
function consensusOf(r){
  if(!r) return null;
  const provFromLevel = { ai:'ai-marker', verified:'credential', photo:'camera', scrutinize:'stripped' };
  const prov = r.prov || provFromLevel[(r.read||{}).level] || 'stripped';
  const reachOK = !!(r.reverse && r.reverse.connected && !r.reverse.degraded && !r.reverse.limited);
  const cInterp = reachOK ? interpretDomains(r.reverse.domains) : { flag:null, examined:false };
  const reachFlag = cInterp.flag || null;
  const examined = !!cInterp.examined;
  const vintage = reachOK ? vintageYear(r.reverse.earliest) : null;
  const debunked = !!(r.fact && r.fact.connected && (r.fact.claims || []).length);
  const mismatchYear = (r.claim && r.claim.mismatch && r.claim.mismatch.is) ? r.claim.mismatch.year : null;
  const aiConcern = aiLeanOf(r.aiRead && r.aiRead.text);
  return computeConsensus(prov, reachFlag, debunked, reachOK ? (r.reverse.count || 0) : 0, examined, vintage, mismatchYear, aiConcern);
}
app.get('/trending', async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const esc = t => (t == null ? '' : String(t)).replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  let items=[]; try{ items = await trendList(); }catch(e){ items=[]; }
  const seen=new Set(), list=[];
  for(const it of items){ if(it&&it.id&&!seen.has(it.id)){ seen.add(it.id); list.push(it); } }
  const DOT={debunk:'#A14A38',ai:'#A14A38',verified:'#2E7D5A',photo:'#3C5E8A',scrutinize:'#8A6A2E'};
  const cards=list.slice(0,36).map(it=>{
    const dot=DOT[it.level]||'#8A6A2E';
    return `<a class="tcard" href="${base}/check/${esc(it.id)}"><div class="tthumb" style="background-image:url('${base}/img/${esc(it.id)}')"></div><div class="tbody"><div class="tbadge"><span class="tdot" style="background:${dot}"></span>${esc(it.badge||'Checked')}</div>${it.cap?`<div class="tcap">${esc(it.cap)}</div>`:''}${it.src?`<div class="tsrc">${esc(it.src)}</div>`:''}</div></a>`;
  }).join('');
  const body=`<div class="thead"><h1 class="th1">Trending checks</h1><p class="tsub">Images and clips circulating online, recently run through Relity. <b>Evidence, not a verdict</b> — open any report and judge for yourself.</p></div>${cards?`<div class="tgrid">${cards}</div>`:'<p class="tempty">No trending checks yet. Paste a viral post on the home page to start the board.</p>'}<a class="cta" href="${base}/" style="max-width:320px;margin:26px auto 0">Check something →</a>`;
  res.send(page('Relity — Trending checks', body, base, null, true));
});

app.get('/check/:id', async (req, res) => {
  const r = await getReport(req.params.id);
  const base = `${req.protocol}://${req.get('host')}`;
  if (!r) return res.status(404).send(page('Report not found', '<p style="color:#586273">This report link has expired or never existed. Shared reports are kept for 90 days.</p>', base, null));

  const esc = t => (t == null ? '' : String(t)).replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  // render stored file-checks, but skip the two cross-check placeholders — we paint authoritative versions below
  const skip = new Set(['Where it appears', 'Fact-check record', 'The claim', 'AI vision read']);
  const rows = (r.findings || []).filter(f => !f.section && !skip.has(f.name)).map(f =>
    `<div class="row"><div><div class="n">${esc(f.name)}</div><div class="rd">${esc(f.read)}</div></div><span class="st st-${f.ic}">${esc((f.state||[])[1]||'')}</span></div>`
  ).join('');

  let web = '';
  if (r.claim && (r.claim.title || r.claim.description)) {
    const cl = r.claim, mm = cl.mismatch || {};
    const txt = esc('“'+(cl.title||cl.description)+'”'+(cl.source?'  — '+cl.source:''));
    if (cl.verdict && cl.verdict.line) {
      const vlvl = cl.verdict.level;
      const vst = vlvl === 'debunk' ? 'st-caution' : (vlvl === 'photo' || vlvl === 'verified') ? 'st-present' : 'st-signal';
      web += `<div class="row"><div><div class="n">The poster’s claim — checked</div><div class="rd">${esc(cl.verdict.line)}<br><span class="dim">${txt}</span></div></div><span class="st ${vst}">${esc(cl.verdict.badge || 'Checked')}</span></div>`;
    } else if (mm.is) {
      web += `<div class="row"><div><div class="n">The claim</div><div class="rd">This claim presents the image as current, but the image has been online since ${mm.year} — a classic recontextualization (old image, new caption). Check what it originally showed.<br><span class="dim">${txt}</span></div></div><span class="st st-caution">Mismatch</span></div>`;
    } else {
      web += `<div class="row"><div><div class="n">The claim</div><div class="rd">The headline or caption wrapped around this image, weighed against the fact-check record and the image’s age. Whether the photo truly depicts it is your call.<br><span class="dim">${txt}</span></div></div><span class="st st-present">Recorded</span></div>`;
    }
  }
  if (r.reverse?.connected) {
    if (r.reverse.degraded || r.reverse.limited) {
      web += `<div class="row"><div><div class="n">Where it appears</div><div class="rd">${esc(r.reverse.note||'The web-appearance check couldn’t run for this image.')} That evidence is <strong>missing</strong> for this report — which is not the same as the image appearing nowhere.</div></div><span class="st st-present">Unavailable</span></div>`;
    } else {
      const e = r.reverse.earliest;
      const doms = (r.reverse.domains || []).slice(0, 5).join(', ');
      const interp = interpretDomains(r.reverse.domains);
      const vintage = vintageYear(e);
      const st = interp.examined ? 'st-caution' : (interp.flag === 'ai' ? 'st-ai' : 'st-signal');
      web += `<div class="row"><div><div class="n">Where it appears</div><div class="rd">Where this image appears across the web.${interp.found?' '+esc(interp.text):''}<br><span class="dim">${r.reverse.count?`Seen across ${spreadPhrase(r.reverse.count)} online.`:'Not found on other public sites we could check.'}${doms?` Found across multiple sources: ${doms}${(r.reverse.count||0)>4?' …and more':''}.`:''}${e?` Earliest dated copy: ${esc(e.source||'')} (${esc(e.date||'')})${vintage?` · online since ${vintage}`:''}.`:''}</span></div></div><span class="st ${st}">${(r.reverse.count||0)>0?'Found':'Checked'}</span></div>`;
    }
  }
  if (r.fact?.connected) {
    const claims = r.fact.claims || [];
    if (claims.length) {
      const _t={}; claims.forEach(x=>{var k=(x.publisher||'')+': '+(x.rating||''); _t[k]=(_t[k]||0)+1;}); const c = Object.keys(_t).map(k=> esc(k)+(_t[k]>1?' ('+_t[k]+' fact-checks)':'')).join(' · ');
      web += (function(){ var top=claims[0]; var ctxt=esc(((top.claim||'')+'').replace(/\s+/g,' ').trim().slice(0,170)); var pubs=esc([...new Set(claims.map(x=>x.publisher).filter(Boolean))].slice(0,2).join(', ')||'A fact-checker'); var link=top.url?` <a href="${esc(top.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--signal);text-decoration:none">Read it ↗</a>`:''; return `<div class="row"><div><div class="n">Fact-check record</div><div class="rd">${pubs} reviewed this${ctxt?` and rated “${ctxt}”`:''} as <b>${esc(top.rating||'—')}</b>.${link}<br><span class="dim">A “false” rating often means the footage is real but miscaptioned or recycled — read it to see exactly what was checked.</span></div></div><span class="st st-caution">Fact-checked</span></div>`; })();
    } else {
      web += `<div class="row"><div><div class="n">Fact-check record</div><div class="rd">No published fact-check matched this image — no debunk is on record, which is not the same as "verified true."</div></div><span class="st st-present">No debunk</span></div>`;
    }
  }

  let aiBlock;
  if (r.aiRead && r.aiRead.text) {
    const t = esc(r.aiRead.text).replace(/^(Claude|Gemini)\s*—\s*$/gm, '</p><div class="ai-model">$1</div><p>').replace(/^READ:\s*([^\n·•]+?)\s*[·•]\s*(\d{1,3})\s*%\s*$/gmi, '</p><div class="ai-chip">$1 · $2%</div><p>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/^#{1,6}\s*(.+)$/gm, '<div class="aih">$1</div>').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
    aiBlock = `<div class="card"><div class="sec">AI vision read — the closest look at the media</div><div class="airead"><p>${t}</p><div class="aimeta">AI vision · ${esc(r.aiRead.model || r.aiRead.provider || '')} — one model’s read, weighed with the evidence.  <span class="st st-ai">${esc(r.aiRead.tierLabel || 'AI')}</span></div></div></div>`;
  } else {
    aiBlock = `<div class="card"><div class="sec">AI vision read</div><div class="airead"><p>The vision model didn’t return a read for this frame this time — the other signals still stand. Re-run the check to try the AI read again.</p></div></div>`;
  }

  // CONSENSUS — weigh provenance + where-it-appears + fact-check into one honest read
  const provFromLevel = { ai:'ai-marker', verified:'credential', photo:'camera', scrutinize:'stripped' };
  const prov = r.prov || provFromLevel[(r.read||{}).level] || 'stripped';
  const reachOK = !!(r.reverse?.connected && !r.reverse.degraded && !r.reverse.limited);
  const cInterp = reachOK ? interpretDomains(r.reverse.domains) : { flag:null, examined:false };
  const reachFlag = cInterp.flag || null;
  const examined = !!cInterp.examined;
  const vintage = reachOK ? vintageYear(r.reverse.earliest) : null;
  const debunked = !!(r.fact?.connected && (r.fact.claims || []).length);
  const mismatchYear = (r.claim && r.claim.mismatch && r.claim.mismatch.is) ? r.claim.mismatch.year : null;
  const aiConcern = aiLeanOf(r.aiRead && r.aiRead.text);
  const rd = computeConsensus(prov, reachFlag, debunked, reachOK ? (r.reverse.count || 0) : 0, examined, vintage, mismatchYear, aiConcern);
  const rbCls = { ai: 'rb-red', debunk: 'rb-red', verified: 'rb-green', photo: 'rb-blue', scrutinize: 'rb-amber' }[rd.level] || 'rb-amber';
  const banner = `<div class="rb ${rbCls}"><div class="rb-eye">${esc(rd.eyebrow||'')}</div><div class="rb-b">${esc(rd.badge)}</div><div class="rb-l">${esc(rd.line)}</div></div>`;

  const SC = { green: '#57A07D', blue: '#6E91C2', amber: '#C7A24E', red: '#C16A57', gray: '#9aa7b2', teal: '#2E8F8F' };
  const pcol = prov === 'credential' ? SC.green : (prov === 'ai-cred' || prov === 'ai-marker') ? SC.red : prov === 'camera' ? SC.blue : SC.gray;
  const wcol = !reachOK ? SC.gray : reachFlag === 'ai' ? SC.red : reachFlag === 'news' ? SC.blue : examined ? SC.amber : ((r.reverse && r.reverse.count) ? SC.teal : SC.gray);
  const fcol = debunked ? SC.red : SC.gray;
  const acol = (r.aiRead && r.aiRead.text) ? SC.teal : SC.gray;
  const ccol = ({ ai: SC.red, debunk: SC.red, verified: SC.green, photo: SC.blue, scrutinize: SC.amber })[rd.level] || SC.amber;
  const cnode = (x, col, lab) => `<line x1="${x}" y1="44" x2="300" y2="140" stroke="#d5dce3" stroke-width="2"/><circle cx="${x}" cy="44" r="12" fill="${col}"/><text x="${x}" y="74" text-anchor="middle" fill="#586273" font-size="12" font-family="system-ui,sans-serif">${lab}</text>`;
  const constellation = `<div class="card" style="margin-top:12px"><div class="sec">Consensus across independent signals</div><svg viewBox="0 0 600 184" style="width:100%;max-width:520px;display:block;margin:4px auto 0" role="img" aria-label="Independent signals converging into one consensus">${cnode(70, pcol, 'Provenance')}${cnode(230, wcol, 'Where it appears')}${cnode(370, fcol, 'Fact-check')}${cnode(530, acol, 'AI vision')}<circle cx="300" cy="140" r="20" fill="${ccol}"/><text x="300" y="176" text-anchor="middle" fill="#131722" font-size="13" font-weight="600" font-family="system-ui,sans-serif">Consensus</text></svg></div>`;
  const desc = (rd.badge || 'Evidence report') + ' — evidence, not a verdict.';
  const og = `
    <meta property="og:title" content="Relity — ${esc(rd.badge||'Evidence report')}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:type" content="website" />
    ${r.hasImage ? `<meta property="og:image" content="${base}/img/${r.id}" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />`;

  res.send(page('Relity — Evidence report', `
    <div class="rpt">
      <aside class="rpt-side">
        ${r.hasImage ? `<img class="thumb" src="${base}/img/${r.id}" alt="" />` : ''}
        ${banner}
        ${constellation}
      </aside>
      <main class="rpt-main">
        ${aiBlock}
        <div class="note"><b>Evidence, not a verdict.</b> This reads the file, not the truth of the caption — weigh it yourself.</div>
        <div class="card">
          <div class="sec">What the web shows</div>
          ${web || '<div class="row"><div><div class="rd dim">Web checks run on the live server (reverse search + fact-check).</div></div></div>'}
          <div class="sec">What the file shows</div>
          ${rows}
        </div>
      </main>
    </div>
    <div class="rpt-foot">
      <a class="cta" href="${base}/">Check your own image →</a>
      <button id="cardBtn" class="cta cta-ghost" style="margin-top:10px;cursor:pointer">📸 Save a share card</button>
      <canvas id="rcard" width="1200" height="630" style="display:none"></canvas>
    </div>
    <script>
    (function(){
      var RC=${JSON.stringify({ badge: rd.badge||'', line: rd.line||'', level: rd.level||'scrutinize', img: r.hasImage ? base + '/img/' + r.id : '', url: base + '/check/' + r.id }).replace(/</g, '\\u003c')};
      var btn=document.getElementById('cardBtn'); if(!btn) return;
      btn.onclick=function(){
        var cv=document.getElementById('rcard'), x=cv.getContext('2d'), W=1200, H=630;
        var g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,'#0B6E6E'); g.addColorStop(1,'#06201f'); x.fillStyle=g; x.fillRect(0,0,W,H);
        var colors={debunk:'#E89483',ai:'#E89483',verified:'#6FC79E',photo:'#8FB8E8',scrutinize:'#E6C879'};
        function rr(X,Y,w,h,r){ x.beginPath(); x.moveTo(X+r,Y); x.arcTo(X+w,Y,X+w,Y+h,r); x.arcTo(X+w,Y+h,X,Y+h,r); x.arcTo(X,Y+h,X,Y,r); x.arcTo(X,Y,X+w,Y,r); x.closePath(); }
        function wrap(t,X,Y,maxW,lh,maxLines){ var words=String(t||'').split(' '), line='', yy=Y, n=0; for(var i=0;i<words.length;i++){ var test=line?line+' '+words[i]:words[i]; if(x.measureText(test).width>maxW && line){ x.fillText(line,X,yy); yy+=lh; line=words[i]; n++; if(maxLines&&n>=maxLines){ x.fillText(line+'…',X,yy); return; } } else line=test; } x.fillText(line,X,yy); }
        function draw(){
          var tw = RC.img ? 600 : 1080;
          x.fillStyle='rgba(255,255,255,.85)'; x.font='600 27px Arial,Helvetica,sans-serif'; x.fillText('RELITY  —  evidence, not verdicts', 56, 72);
          x.fillStyle=colors[RC.level]||'#f4c152'; x.font='bold 56px Arial,Helvetica,sans-serif'; wrap(RC.badge,56,172,tw,60,2);
          x.fillStyle='#eafffb'; x.font='28px Arial,Helvetica,sans-serif'; wrap(RC.line,56,300,tw,38,7);
          x.fillStyle='#7be8e8'; x.font='bold 30px Arial,Helvetica,sans-serif'; x.fillText('relity.ai', 56, H-48);
          cv.toBlob(function(b){ if(!b) return; var a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='relity-card.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){URL.revokeObjectURL(a.href);},2000); }, 'image/png');
        }
        if(RC.img){ var im=new Image(); im.onload=function(){ var iw=440,ih=440,ix=W-iw-56,iy=(H-ih)/2; x.save(); rr(ix,iy,iw,ih,20); x.clip(); var rt=Math.max(iw/im.width,ih/im.height), dw=im.width*rt, dh=im.height*rt; x.drawImage(im,ix+(iw-dw)/2,iy+(ih-dh)/2,dw,dh); x.restore(); x.strokeStyle='rgba(255,255,255,.25)'; x.lineWidth=2; rr(ix,iy,iw,ih,20); x.stroke(); draw(); }; im.onerror=draw; im.src=RC.img; } else { draw(); }
      };
    })();
    </script>
  `, base, og, true));
});

function page(title, body, base, og, wide) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"/><link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;450;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>${og||''}
  <style>
    :root{--ink:#131722;--g:#556074;--line:#E4E9F1;--paper:#F1F4F9;--signal:#0B6E6E;--ok:#2E7D5A;--warn:#8A6A2E;--ai:#5B4BC4;--srv:#41507E;--shadow:0 1px 2px rgba(20,27,45,.05),0 14px 36px -10px rgba(20,27,45,.12)}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;line-height:1.5}
    .w{max-width:560px;margin:0 auto;padding:30px 20px 60px}
    .brand{display:flex;align-items:center;gap:9px;font-family:'Space Grotesk',system-ui,sans-serif;font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:15px;color:var(--signal)}
    .g{width:22px;height:22px;border-radius:6px;background:linear-gradient(150deg,#0B6E6E,#13A8A8);display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}
    .g svg{width:15px;height:15px}
    .hero{display:block;width:100%;max-height:440px;object-fit:contain;background:#eef2f6;border-radius:14px;margin:18px 0;border:1px solid var(--line)}
    .rb{border-radius:13px;padding:16px 18px;margin:14px 0 14px}
    .rb-eye{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-bottom:6px}
    .rb-b{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:700;font-size:18px;display:flex;align-items:center;gap:9px}
    .rb-b::before{content:"";width:11px;height:11px;border-radius:50%;background:currentColor;flex:0 0 auto}
    .rb-l{font-size:13.5px;margin-top:7px;line-height:1.5;color:var(--g)}
    .rb-red{background:#F3EAE6}.rb-red .rb-b{color:#A14A38}
    .rb-green{background:#E8F1EC}.rb-green .rb-b{color:var(--ok)}
    .rb-blue{background:#ECF0F6}.rb-blue .rb-b{color:#3C5E8A}
    .rb-amber{background:#F3ECDE}.rb-amber .rb-b{color:var(--warn)}
    .note{background:#E6F4F4;border:1px solid #C5E5E5;border-radius:11px;padding:13px 15px;font-size:14px;color:#274545;margin:6px 0 16px}
    .card{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}
    .row{display:flex;justify-content:space-between;gap:14px;padding:14px 16px;border-top:1px solid var(--line);align-items:start}
    .row:first-child{border-top:none}.n{font-weight:600;font-size:14.5px}.rd{color:var(--g);font-size:13px;margin-top:3px;overflow-wrap:anywhere}
    .st{font-family:ui-monospace,monospace;font-size:10.5px;font-weight:600;text-transform:uppercase;padding:4px 9px;border-radius:20px;white-space:nowrap;height:fit-content}
    .st-present{background:#E8F1EC;color:var(--ok)}.st-absent{background:var(--paper);color:#8A95A4;border:1px solid var(--line)}
    .st-caution{background:#F3ECDE;color:var(--warn)}.st-signal{background:#E6F4F4;color:var(--signal)}
    .st-ai{background:#EDEBFA;color:var(--ai)}.st-srv{background:#EDF0FA;color:var(--srv)}
    .sec{padding:9px 16px;background:var(--paper);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8A95A4;border-top:1px solid var(--line)}
    .sec:first-child{border-top:none}
    .dim{color:#8A95A4;font-size:12px}
    .cta{display:block;text-align:center;margin-top:18px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;padding:14px;border-radius:11px}
    @media (max-width:560px){
      .w{padding:22px 15px 46px}
      .hero{margin:14px 0}
      .rb{padding:14px 15px}.rb-b{font-size:16.5px}.rb-l{font-size:13px}
      .row{padding:13px 13px;gap:11px}.n{font-size:14px}.rd{font-size:12.5px}
      .st{font-size:10px;padding:4px 8px}
    }
    .w.wide{max-width:1060px}
    .rpt{display:grid;grid-template-columns:1fr;gap:18px;margin-top:16px}
    .thumb{display:block;width:100%;max-height:300px;object-fit:contain;background:#0d1117;border-radius:13px;border:1px solid var(--line);margin-bottom:14px}
    .airead{padding:16px 18px;font-size:14px;line-height:1.62}
    .airead p{margin:0 0 10px;color:var(--g)}
    .airead .aih{font-weight:700;color:var(--ink);font-size:13px;margin:15px 0 5px}
    .airead .aimeta{margin-top:12px;font-size:11.5px;color:#8A95A4;border-top:1px solid var(--line);padding-top:10px}
    .ai-model{font-weight:700;font-size:13.5px;color:var(--ink);margin:16px 0 0}
    .ai-chip{display:inline-block;font-family:ui-monospace,monospace;font-size:11.5px;font-weight:600;background:#EDEBFA;color:#5B4BC4;border-radius:20px;padding:4px 11px;margin:5px 0 7px;letter-spacing:.02em}
    .cta-ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
    .rpt-foot{max-width:620px;margin:6px auto 0}
    @media(min-width:920px){
      .rpt{grid-template-columns:minmax(0,1.65fr) minmax(330px,1fr);gap:22px;align-items:start}
      .rpt-main{order:1}
      .rpt-side{order:2;position:sticky;top:20px}
    }
    .thead{margin:8px 0 20px}
    .th1{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:700;font-size:30px;letter-spacing:-.02em;margin:0 0 6px;color:var(--ink)}
    .tsub{color:var(--g);font-size:14.5px;margin:0;max-width:64ch;line-height:1.55}
    .tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-top:8px}
    .tcard{display:flex;flex-direction:column;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;box-shadow:var(--shadow);transition:transform .12s ease}
    .tcard:hover{transform:translateY(-2px)}
    .tthumb{width:100%;aspect-ratio:16/10;background:#0d1117 center/cover no-repeat;border-bottom:1px solid var(--line)}
    .tbody{padding:12px 13px}
    .tbadge{display:flex;align-items:center;gap:7px;font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;font-size:13px;color:var(--ink)}
    .tdot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
    .tcap{color:var(--g);font-size:12.5px;line-height:1.45;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .tsrc{color:#8A95A4;font-size:11.5px;margin-top:7px;font-family:ui-monospace,monospace}
    .tempty{color:var(--g);font-size:15px;text-align:center;padding:46px 0}
  </style></head><body><div class="w${wide ? ' wide' : ''}">
    <div class="brand"><span class="g"><svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="#fff" stroke-width="8" stroke-linecap="round"><line x1="32" y1="34" x2="50" y2="52"/><line x1="50" y1="52" x2="70" y2="36"/><line x1="50" y1="52" x2="52" y2="78"/></g><circle cx="32" cy="34" r="8" fill="#fff"/><circle cx="70" cy="36" r="8" fill="#fff"/><circle cx="52" cy="78" r="8" fill="#fff"/><circle cx="50" cy="52" r="9.5" fill="#fff"/></svg></span> Relity</div>${body}
  </div></body></html>`;
}

billing.mount(app, express);
app.use('/api/check-claim', (req, res, next) => meteredGate('claim', req, res, next));
claims.mount(app);
const telegram = require('./telegram')({ claims, ai, video, img: { putImage, getReport, putReport, reverseSearch, interpretDomains, vintageYear, computeConsensus } });
telegram.mount(app);
app.use('/api/check-video', (req, res, next) => meteredGate('video', req, res, next));
video.mount(app, uploadVideo);

app.get('/privacy', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relity — Privacy Policy</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#131722;background:#fff;line-height:1.6}main{max-width:720px;margin:0 auto;padding:48px 22px 80px}a{color:#0B6E6E}h1{font-size:30px;margin:0 0 6px}h2{font-size:18px;margin:30px 0 8px;color:#0B6E6E}.sub{color:#586273;margin:0 0 28px}p,li{color:#2b3344;font-size:15.5px}ul{padding-left:20px}code{background:#F4F6F9;padding:1px 5px;border-radius:4px;font-size:13px}.foot{margin-top:40px;border-top:1px solid #E6EAF0;padding-top:16px;color:#8A95A4;font-size:13px}</style></head>
<body><main>
<h1>Privacy Policy</h1>
<p class="sub">Relity — evidence, not verdicts. Last updated June 2026.</p>
<p>Relity helps you check whether media and claims are what they appear to be. We built it to need as little of your data as possible. This policy covers the relity.ai website and the Relity browser extension.</p>
<h2>The browser extension</h2>
<p>The extension adds right-click menu items. When you choose one, it opens relity.ai in a new tab with the item you selected — an image address, a link, highlighted text, or the page address. That is all it does.</p>
<ul>
<li>It does <b>not</b> run in the background, track your browsing, or use analytics.</li>
<li>It collects and stores <b>no</b> personal data.</li>
<li>Its only permission is <code>contextMenus</code> (to add the right-click menu). It acts only when you explicitly click a menu item.</li>
</ul>
<h2>What you submit to relity.ai</h2>
<ul>
<li><b>Image file checks</b> (metadata, content credentials, AI markers, fingerprint) run locally in your browser — the file itself is not uploaded for these.</li>
<li><b>Web cross-checks and AI reads:</b> when you ask for reverse-image search, fact-checks, "where it appears," or an AI vision/text read, the content you submit is sent to the services that produce those signals so the report can be generated.</li>
<li>Results may be cached by a content <b>fingerprint</b> so a widely-shared item is analyzed once rather than repeatedly.</li>
</ul>
<h2>Accounts, cookies &amp; payments</h2>
<ul>
<li>Free use needs no account. We use an anonymous device cookie only to count your daily free checks.</li>
<li>If you sign in (email link or Google), we store your email to remember your Pro status, kept in a signed session cookie.</li>
<li>Payments are processed by Stripe. We never see or store your card details.</li>
</ul>
<h2>Services we rely on</h2>
<p>Render (hosting), Upstash (storage &amp; caching), Stripe (payments), Resend (sign-in emails), Google and SerpAPI (search &amp; fact-check), and Google Gemini &amp; Anthropic Claude (AI reads). Content is shared with these only as needed to produce your report or run your account.</p>
<h2>What we don't do</h2>
<p>No advertising. No selling your data. No tracking you across the web.</p>
<h2>Contact</h2>
<p>Questions about this policy? Email <a href="mailto:support@relity.ai">support@relity.ai</a>.</p>
<div class="foot">© 2026 Relity · <a href="/">relity.ai</a></div>
</main></body></html>`);
});

app.listen(PORT, () => { console.log(`Relity running on http://localhost:${PORT}`); telegram.register(); });
