/* ============================================================
   Trace — server
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

   PROTOTYPE NOTES (swap before real traffic):
     • Results + images are kept in memory (Map) and reset on restart.
       Swap `store` / `imgStore` for Redis or Postgres + object storage.
     • Add rate limiting and a size cap before exposing publicly.
   ============================================================ */

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');

const app  = express();
app.set('trust proxy', true);                  // Render sits behind a proxy → makes req.protocol return https
const PORT  = process.env.PORT || 8080;
const SERPAPI_KEY   = process.env.SERPAPI_KEY   || '';   // serpapi.com — Google Lens engine
const FACTCHECK_KEY = process.env.FACTCHECK_KEY || '';   // Google Fact Check Tools API

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
app.use(express.static(__dirname));            // serves index.html
app.use(express.json({ limit: '2mb' }));

const store    = new Map();   // id -> report     (swap for a DB)
const imgStore = new Map();   // id -> {buf,mime} (swap for object storage)
const shortId  = sha => (sha ? sha.slice(0, 10) : crypto.randomBytes(5).toString('hex'));

/* ---------- adapter 1: reverse image search (SerpAPI / Google Lens) ----------
   Lens needs a public image URL, so we host the uploaded bytes at /img/:id
   and hand that URL to the provider. Alternative: TinEye API accepts direct
   uploads (multipart) — swap this function if you use it.                      */
async function reverseSearch(publicImageUrl) {
  if (!SERPAPI_KEY) return { connected: false, note: 'Reverse search not configured (set SERPAPI_KEY).' };
  try {
    const u = `https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(publicImageUrl)}&api_key=${SERPAPI_KEY}`;
    const r = await fetch(u);
    const j = await r.json();
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
    return { connected: true, error: 'Reverse search request failed: ' + e.message };
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
    const sha = (req.body.sha256 || '').trim();
    const id  = shortId(sha);
    let findings = [];
    try { findings = JSON.parse(req.body.findings || '[]'); } catch { /* ignore */ }
    let read = null;
    try { read = JSON.parse(req.body.read || 'null'); } catch { /* ignore */ }

    if (req.file) imgStore.set(id, { buf: req.file.buffer, mime: req.file.mimetype });

    const base = `${req.protocol}://${req.get('host')}`;
    const publicImageUrl = req.file ? `${base}/img/${id}` : null;

    const reverse = publicImageUrl ? await reverseSearch(publicImageUrl) : { connected: false };
    const captions = (reverse.matches || []).map(m => m.title);
    const fact = await factCheck(captions);

    const report = { id, sha256: sha, createdAt: Date.now(), findings, read, reverse, fact, hasImage: !!req.file };
    store.set(id, report);
    res.json({ id, reverse, fact });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/result/:id', (req, res) => {
  const r = store.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.get('/img/:id', (req, res) => {
  const i = imgStore.get(req.params.id);
  if (!i) return res.status(404).end();
  res.set('Content-Type', i.mime || 'image/jpeg').send(i.buf);
});

/* ---------- fetch an image from a pasted link ----------
   Handles a direct image URL, or an article/page URL (pulls its og:image).
   Social posts (X, Instagram, TikTok) usually block this — the UI tells users
   to right-click → Copy image → Ctrl+V instead.
   Guards: https/http only, no private/loopback hosts (SSRF), 8s timeout, 15MB cap. */
const MAX_BYTES = 15 * 1024 * 1024;
const FETCH_UA  = 'Mozilla/5.0 (compatible; TraceBot/0.1; +https://github.com/)';
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

app.get('/api/proxy-image', async (req, res) => {
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
      if (!img) return res.status(422).json({ error: 'No image found on that page. Sites like X, Instagram and TikTok block automatic fetching — use Copy image → Ctrl+V instead.' });
      img = new URL(img, u.href).href;
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

/* ---------- the shareable result page (unfurls on social) ---------- */
app.get('/check/:id', (req, res) => {
  const r = store.get(req.params.id);
  const base = `${req.protocol}://${req.get('host')}`;
  if (!r) return res.status(404).send(page('Report not found', '<p style="color:#586273">This report has expired or never existed. In the prototype, reports live in memory and reset on restart.</p>', base, null));

  const esc = t => (t == null ? '' : String(t)).replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  // render stored file-checks, but skip the two cross-check placeholders — we paint authoritative versions below
  const skip = new Set(['Reverse image search', 'Known-fake database']);
  const rows = (r.findings || []).filter(f => !f.section && !skip.has(f.name)).map(f =>
    `<div class="row"><div><div class="n">${esc(f.name)}</div><div class="rd">${esc(f.read)}</div></div><span class="st st-${f.ic}">${esc((f.state||[])[1]||'')}</span></div>`
  ).join('');

  let web = '';
  if (r.reverse?.connected) {
    const e = r.reverse.earliest;
    const doms = (r.reverse.domains || []).slice(0, 4).join(', ');
    web += `<div class="row"><div><div class="n">Reverse image search</div><div class="rd">Found across ${r.reverse.count||0}+ place(s).${doms?` Appears on: ${esc(doms)}${(r.reverse.count||0)>4?' …and more':''}.`:''}${e?` Earliest dated copy: ${esc(e.source||'')} (${esc(e.date||'')}).`:''}</div></div><span class="st st-signal">Checked</span></div>`;
  }
  if (r.fact?.connected) {
    const claims = r.fact.claims || [];
    if (claims.length) {
      const c = claims.map(x => `${esc(x.publisher||'')}: ${esc(x.rating||'')}`).join(' · ');
      web += `<div class="row"><div><div class="n">Known-fake database</div><div class="rd">Fact-checkers have addressed claims tied to this image. ${c}</div></div><span class="st st-caution">Matches</span></div>`;
    } else {
      web += `<div class="row"><div><div class="n">Known-fake database</div><div class="rd">No published fact-check found for this image. (Means "no debunk on record," not "verified true.")</div></div><span class="st st-present">Clear</span></div>`;
    }
  }

  // instant-read banner — verdict on the evidence, escalated to a debunk if fact-checkers flagged it
  let rd = r.read || { level: 'scrutinize', badge: 'Verify the context', line: 'No origin data in the file. The file alone can’t tell you whether the caption is true.' };
  if (r.fact?.connected && (r.fact.claims || []).length) {
    rd = { level: 'debunk', badge: 'Fact-check debunk on record', line: 'Fact-checkers have published a debunk tied to this image. Read it before sharing.' };
  }
  const rbCls = { ai: 'rb-red', debunk: 'rb-red', verified: 'rb-green', photo: 'rb-blue', scrutinize: 'rb-amber' }[rd.level] || 'rb-amber';
  const banner = `<div class="rb ${rbCls}"><div class="rb-b">${esc(rd.badge)}</div><div class="rb-l">${esc(rd.line)}</div></div>`;

  const desc = (rd.badge || 'Evidence report') + ' — evidence, not a verdict.';
  const og = `
    <meta property="og:title" content="Trace — ${esc(rd.badge||'Evidence report')}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:type" content="website" />
    ${r.hasImage ? `<meta property="og:image" content="${base}/img/${r.id}" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />`;

  res.send(page('Trace — Evidence report', `
    ${r.hasImage ? `<img class="hero" src="${base}/img/${r.id}" alt="" />` : ''}
    ${banner}
    <div class="note"><b>Evidence, not a verdict.</b> This reads the file, not the truth of the caption — weigh it yourself.</div>
    <div class="card">${rows}${web}</div>
    <a class="cta" href="${base}/">Check your own image →</a>
  `, base, og));
});

function page(title, body, base, og) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>${og||''}
  <style>
    :root{--ink:#131722;--g:#586273;--line:#E6EAF0;--paper:#F4F6F9;--signal:#0B6E6E;--ok:#1C8A57;--warn:#B0720B;--ai:#5B4BC4;--srv:#41507E}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,system-ui,sans-serif;line-height:1.5}
    .w{max-width:560px;margin:0 auto;padding:30px 20px 60px}
    .brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:15px;color:var(--signal)}
    .g{width:22px;height:22px;border-radius:6px;background:linear-gradient(150deg,#0B6E6E,#13A8A8)}
    .hero{width:100%;border-radius:14px;margin:18px 0;border:1px solid var(--line)}
    .rb{border-radius:13px;padding:16px 18px;margin:14px 0 14px}
    .rb-b{font-weight:700;font-size:18px;display:flex;align-items:center;gap:9px}
    .rb-b::before{content:"";width:11px;height:11px;border-radius:50%;background:currentColor;flex:0 0 auto}
    .rb-l{font-size:13.5px;margin-top:7px;line-height:1.5;color:var(--g)}
    .rb-red{background:#FAE9E6}.rb-red .rb-b{color:#B83A2B}
    .rb-green{background:#E6F3EC}.rb-green .rb-b{color:var(--ok)}
    .rb-blue{background:#EAF1FB}.rb-blue .rb-b{color:#2D5BA8}
    .rb-amber{background:#FAF0DD}.rb-amber .rb-b{color:var(--warn)}
    .note{background:#E6F4F4;border:1px solid #C5E5E5;border-radius:11px;padding:13px 15px;font-size:14px;color:#274545;margin:6px 0 16px}
    .card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}
    .row{display:flex;justify-content:space-between;gap:14px;padding:14px 16px;border-top:1px solid var(--line);align-items:start}
    .row:first-child{border-top:none}.n{font-weight:600;font-size:14.5px}.rd{color:var(--g);font-size:13px;margin-top:3px}
    .st{font-family:ui-monospace,monospace;font-size:10.5px;font-weight:600;text-transform:uppercase;padding:4px 9px;border-radius:20px;white-space:nowrap;height:fit-content}
    .st-present{background:#E6F3EC;color:var(--ok)}.st-absent{background:var(--paper);color:#8A95A4;border:1px solid var(--line)}
    .st-caution{background:#FAF0DD;color:var(--warn)}.st-signal{background:#E6F4F4;color:var(--signal)}
    .st-ai{background:#EDEBFA;color:var(--ai)}.st-srv{background:#EDF0FA;color:var(--srv)}
    .cta{display:block;text-align:center;margin-top:18px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;padding:14px;border-radius:11px}
  </style></head><body><div class="w">
    <div class="brand"><span class="g"></span> Trace</div>${body}
  </div></body></html>`;
}

app.listen(PORT, () => console.log(`Trace running on http://localhost:${PORT}`));
