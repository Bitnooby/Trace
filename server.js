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
    const dated = matches.filter(m => m.date).sort((a, b) => new Date(a.date) - new Date(b.date));
    return {
      connected: true,
      count: (j.visual_matches || []).length,
      earliest: dated[0] || null,
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

    if (req.file) imgStore.set(id, { buf: req.file.buffer, mime: req.file.mimetype });

    const base = `${req.protocol}://${req.get('host')}`;
    const publicImageUrl = req.file ? `${base}/img/${id}` : null;

    const reverse = publicImageUrl ? await reverseSearch(publicImageUrl) : { connected: false };
    const captions = (reverse.matches || []).map(m => m.title);
    const fact = await factCheck(captions);

    const report = { id, sha256: sha, createdAt: Date.now(), findings, reverse, fact, hasImage: !!req.file };
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
    web += `<div class="row"><div><div class="n">Reverse image search</div><div class="rd">Found across ${r.reverse.count||0} place(s).${e?` Earliest known copy: ${esc(e.source||'')} (${esc(e.date||'')}).`:''}</div></div><span class="st st-signal">Checked</span></div>`;
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

  const desc = 'Provenance, camera origin & edits traced — evidence, not a verdict.';
  const og = `
    <meta property="og:title" content="Trace — Evidence report" />
    <meta property="og:description" content="${desc}" />
    <meta property="og:type" content="website" />
    ${r.hasImage ? `<meta property="og:image" content="${base}/img/${r.id}" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />`;

  res.send(page('Trace — Evidence report', `
    ${r.hasImage ? `<img class="hero" src="${base}/img/${r.id}" alt="" />` : ''}
    <div class="note"><b>Evidence, not a verdict.</b> Weigh the signals below; the judgment is yours.</div>
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
