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
app.use(express.static(__dirname));            // serves index.html
app.use(express.json({ limit: '2mb' }));

/* ---------- persistence: Upstash Redis when configured, else in-memory ----------
   Shared reports (and small images) survive redeploys once UPSTASH_* env vars are set.
   Without them Trace still runs, but resets on restart (fine for local dev).
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
  if (redisOn) { try { await redisCmd(['SET', 'trace:r:' + id, JSON.stringify(report), 'EX', TTL]); } catch (e) { console.error('redis putReport:', e.message); } }
}
async function getReport(id) {
  if (memReport.has(id)) return memReport.get(id);
  if (redisOn) { try { const v = await redisCmd(['GET', 'trace:r:' + id]); if (v) { const r = JSON.parse(v); memReport.set(id, r); return r; } } catch (e) { console.error('redis getReport:', e.message); } }
  return null;
}
async function putImage(id, buf, mime) {
  memImg.set(id, { buf, mime });
  if (redisOn && buf.length <= IMG_PERSIST_MAX) { try { await redisCmd(['SET', 'trace:i:' + id, JSON.stringify({ mime, b64: buf.toString('base64') }), 'EX', TTL]); } catch (e) { console.error('redis putImage:', e.message); } }
}
async function getImage(id) {
  if (memImg.has(id)) return memImg.get(id);
  if (redisOn) { try { const v = await redisCmd(['GET', 'trace:i:' + id]); if (v) { const o = JSON.parse(v); const img = { buf: Buffer.from(o.b64, 'base64'), mime: o.mime }; memImg.set(id, img); return img; } } catch (e) { console.error('redis getImage:', e.message); } }
  return null;
}
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
    let claim = null;
    try { claim = JSON.parse(req.body.claim || 'null'); } catch { /* ignore */ }

    if (req.file) await putImage(id, req.file.buffer, req.file.mimetype);

    const base = `${req.protocol}://${req.get('host')}`;
    const publicImageUrl = req.file ? `${base}/img/${id}` : null;

    const reverse = publicImageUrl ? await reverseSearch(publicImageUrl) : { connected: false };
    const captions = (reverse.matches || []).map(m => m.title);
    // the submitted claim is the most direct thing to fact-check — check it first
    const claimText = claim && (claim.title || claim.description) ? (claim.title || claim.description) : null;
    const fact = await factCheck([claimText, ...captions].filter(Boolean));

    // recontextualization: claim presents the image as current, but the image is demonstrably older
    let claimOut = null;
    if (claim && (claim.title || claim.description)) {
      const vy = vintageYear(reverse.earliest);
      const recent = claimImpliesRecent(`${claim.title || ''} ${claim.description || ''}`);
      const mismatch = (recent && vy) ? { is: true, year: vy } : { is: false };
      claimOut = { title: claim.title || '', description: claim.description || '', source: claim.source || '', mismatch };
    }

    const report = { id, sha256: sha, createdAt: Date.now(), findings, read, reverse, fact, prov: (req.body.prov || null), claim: claimOut, hasImage: !!req.file };
    await putReport(id, report);
    res.json({ id, reverse, fact, claim: claimOut });
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
      // read the claim wrapped around the image (the caption is where the lie usually lives)
      const claim = extractClaim(html, u.hostname);
      if (claim) { res.set('X-Trace-Claim', encodeURIComponent(JSON.stringify(claim))); res.set('Access-Control-Expose-Headers', 'X-Trace-Claim'); }
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
// read meaning from WHERE an image appears (mirrors the client)
function interpretDomains(domains){
  const d=(domains||[]).map(x=>String(x).toLowerCase());
  const hit=arr=>d.filter(x=>arr.some(k=>x.includes(k)));
  const AI=['aiease','monica.im','civitai','lexica','midjourney','leonardo.ai','openart','nightcafe','seaart','tensor.art','starryai','deepai','craiyon','getimg','playground','dezgo','stablediffusion','perchance','pixai','mage.space','dream.ai','artbreeder','fotor','ideogram','krea.ai','prompthero'];
  const STOCK=['vecteezy','shutterstock','istockphoto','gettyimages','freepik','stock.adobe','dreamstime','alamy','123rf','depositphotos','pexels','unsplash','pixabay'];
  const NEWS=['reuters','apnews','bbc.','nytimes','washingtonpost','theguardian','cnn.','npr.org','aljazeera','bloomberg','afp.','dpa.com','forbes','independent.co','nbcnews','cbsnews','abcnews','usatoday'];
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

// CONSENSUS — weigh all three evidence streams into one honest read (mirrors the client)
function computeConsensus(prov, reach, debunked, count, examined, vintage, mismatchYear){
  const E='Consensus — the evidence, weighed';
  const places = count ? ` (seen on ${count}+ sites)` : '';
  const vint = vintage ? ` It’s been online since ${vintage} — be wary of any caption claiming it’s recent or breaking.` : '';
  const r=(level,badge,line)=>({eyebrow:E,level,badge,line:(level==='debunk'||level==='ai')?line:line+vint});
  if(debunked) return r('debunk','Debunked on record',`Fact-checkers have already debunked this image — the strongest signal there is. Treat it as false${places}.`);
  if(prov==='ai-cred') return r('ai','AI-generated','Its Content Credential declares it AI-generated — a strong, embedded signal'+(reach==='ai'?', and it lives on AI-image sites too. Everything lines up.':'.'));
  if(mismatchYear) return {eyebrow:E,level:'scrutinize',badge:'Likely recontextualized',line:`The caption presents this as current, but the image has been online since ${mismatchYear} — the classic recontextualization move: a real, older photo paired with a false new caption.`};
  if(examined) return r('scrutinize','Likely fact-checked',`This image appears on fact-checking sites${places} — very likely it’s already been examined. Read what they concluded before trusting any caption attached to it.`);
  if(prov==='camera' && reach==='ai') return r('scrutinize','Signals conflict','It carries camera data (suggests a real photo) yet lives on AI-image sites (suggests AI). These disagree — genuinely uncertain.');
  if(prov==='ai-marker' && reach==='ai') return r('scrutinize','Leans AI-generated',`It carries an AI-tool marker and lives on AI-image sites${places}. No hard proof, but the weight points to AI.`);
  if(reach==='ai') return r('scrutinize','Leans AI-generated',`No provenance survived, but this image lives on AI-image sites${places} — circumstantial, but it leans AI-generated.`);
  if(prov==='ai-marker') return r('scrutinize','Possible AI','It carries a marker associated with an AI generator — a sign it may be AI-made.');
  if(prov==='camera') return r('photo','Leans authentic','It carries camera/capture data'+(reach==='news'?' and appears on news outlets':'')+' — consistent with a real photo, though metadata can be edited.');
  if(reach==='news') return r('photo','Leans authentic',`The file is stripped, but this image appears on news outlets${places} — consistent with a real news photo.`);
  if(prov==='credential') return r('verified','Origin on record','It carries a Content Credential — a real record of how it was made. Most images carry none.');
  return r('scrutinize','Unverified','No provenance survived, and no fact-check is on record'+(reach==='stock'?'; it appears on stock-image sites':'')+`${places}. It could be real, AI, or real media with a false caption.`);
}

app.get('/check/:id', async (req, res) => {
  const r = await getReport(req.params.id);
  const base = `${req.protocol}://${req.get('host')}`;
  if (!r) return res.status(404).send(page('Report not found', '<p style="color:#586273">This report link has expired or never existed. Shared reports are kept for 90 days.</p>', base, null));

  const esc = t => (t == null ? '' : String(t)).replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  // render stored file-checks, but skip the two cross-check placeholders — we paint authoritative versions below
  const skip = new Set(['Where it appears', 'Fact-check record', 'The claim']);
  const rows = (r.findings || []).filter(f => !f.section && !skip.has(f.name)).map(f =>
    `<div class="row"><div><div class="n">${esc(f.name)}</div><div class="rd">${esc(f.read)}</div></div><span class="st st-${f.ic}">${esc((f.state||[])[1]||'')}</span></div>`
  ).join('');

  let web = '';
  if (r.claim && (r.claim.title || r.claim.description)) {
    const cl = r.claim, mm = cl.mismatch || {};
    const txt = esc('“'+(cl.title||cl.description)+'”'+(cl.source?'  — '+cl.source:''));
    if (mm.is) {
      web += `<div class="row"><div><div class="n">The claim</div><div class="rd">This claim presents the image as current, but the image has been online since ${mm.year} — a classic recontextualization (old image, new caption). Check what it originally showed.<br><span class="dim">${txt}</span></div></div><span class="st st-caution">Mismatch</span></div>`;
    } else {
      web += `<div class="row"><div><div class="n">The claim</div><div class="rd">The headline or caption wrapped around this image, weighed against the fact-check record and the image’s age. Whether the photo truly depicts it is your call.<br><span class="dim">${txt}</span></div></div><span class="st st-present">Recorded</span></div>`;
    }
  }
  if (r.reverse?.connected) {
    const e = r.reverse.earliest;
    const doms = (r.reverse.domains || []).slice(0, 4).join(', ');
    const interp = interpretDomains(r.reverse.domains);
    const vintage = vintageYear(e);
    const st = interp.examined ? 'st-caution' : (interp.flag === 'ai' ? 'st-ai' : 'st-signal');
    web += `<div class="row"><div><div class="n">Where it appears</div><div class="rd">Where this image appears across the web.${interp.found?' '+esc(interp.text):''}<br><span class="dim">Found across ${r.reverse.count||0}+ place(s).${doms?` Appears on: ${esc(doms)}${(r.reverse.count||0)>4?' …and more':''}.`:''}${e?` Earliest dated copy: ${esc(e.source||'')} (${esc(e.date||'')})${vintage?` · online since ${vintage}`:''}.`:''}</span></div></div><span class="st ${st}">${(r.reverse.count||0)>0?'Found':'Checked'}</span></div>`;
  }
  if (r.fact?.connected) {
    const claims = r.fact.claims || [];
    if (claims.length) {
      const c = claims.map(x => `${esc(x.publisher||'')}: ${esc(x.rating||'')}`).join(' · ');
      web += `<div class="row"><div><div class="n">Fact-check record</div><div class="rd">Fact-checkers have addressed claims tied to this image. ${c}</div></div><span class="st st-caution">Matches</span></div>`;
    } else {
      web += `<div class="row"><div><div class="n">Fact-check record</div><div class="rd">No published fact-check matched this image — no debunk is on record, which is not the same as "verified true."</div></div><span class="st st-present">No debunk</span></div>`;
    }
  }

  // CONSENSUS — weigh provenance + where-it-appears + fact-check into one honest read
  const provFromLevel = { ai:'ai-marker', verified:'credential', photo:'camera', scrutinize:'stripped' };
  const prov = r.prov || provFromLevel[(r.read||{}).level] || 'stripped';
  const cInterp = r.reverse?.connected ? interpretDomains(r.reverse.domains) : { flag:null, examined:false };
  const reachFlag = cInterp.flag || null;
  const examined = !!cInterp.examined;
  const vintage = r.reverse?.connected ? vintageYear(r.reverse.earliest) : null;
  const debunked = !!(r.fact?.connected && (r.fact.claims || []).length);
  const mismatchYear = (r.claim && r.claim.mismatch && r.claim.mismatch.is) ? r.claim.mismatch.year : null;
  const rd = computeConsensus(prov, reachFlag, debunked, r.reverse?.count || 0, examined, vintage, mismatchYear);
  const rbCls = { ai: 'rb-red', debunk: 'rb-red', verified: 'rb-green', photo: 'rb-blue', scrutinize: 'rb-amber' }[rd.level] || 'rb-amber';
  const banner = `<div class="rb ${rbCls}"><div class="rb-eye">${esc(rd.eyebrow||'')}</div><div class="rb-b">${esc(rd.badge)}</div><div class="rb-l">${esc(rd.line)}</div></div>`;

  const desc = (rd.badge || 'Evidence report') + ' — evidence, not a verdict.';
  const og = `
    <meta property="og:title" content="Relity — ${esc(rd.badge||'Evidence report')}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta property="og:type" content="website" />
    ${r.hasImage ? `<meta property="og:image" content="${base}/img/${r.id}" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />`;

  res.send(page('Relity — Evidence report', `
    ${r.hasImage ? `<img class="hero" src="${base}/img/${r.id}" alt="" />` : ''}
    ${banner}
    <div class="note"><b>Evidence, not a verdict.</b> This reads the file, not the truth of the caption — weigh it yourself.</div>
    <div class="card">
      <div class="sec">What the web shows</div>
      ${web || '<div class="row"><div><div class="rd dim">Web checks run on the live server (reverse search + fact-check).</div></div></div>'}
      <div class="sec">What the file shows</div>
      ${rows}
    </div>
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
    .g{width:22px;height:22px;border-radius:6px;background:linear-gradient(150deg,#0B6E6E,#13A8A8);display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}
    .g svg{width:15px;height:15px}
    .hero{width:100%;border-radius:14px;margin:18px 0;border:1px solid var(--line)}
    .rb{border-radius:13px;padding:16px 18px;margin:14px 0 14px}
    .rb-eye{font-family:'Space Grotesk',system-ui,sans-serif;font-weight:600;font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-bottom:6px}
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
    .sec{padding:9px 16px;background:var(--paper);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8A95A4;border-top:1px solid var(--line)}
    .sec:first-child{border-top:none}
    .dim{color:#8A95A4;font-size:12px}
    .cta{display:block;text-align:center;margin-top:18px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;padding:14px;border-radius:11px}
  </style></head><body><div class="w">
    <div class="brand"><span class="g"><svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="#fff" stroke-width="8" stroke-linecap="round"><line x1="32" y1="34" x2="50" y2="52"/><line x1="50" y1="52" x2="70" y2="36"/><line x1="50" y1="52" x2="52" y2="78"/></g><circle cx="32" cy="34" r="8" fill="#fff"/><circle cx="70" cy="36" r="8" fill="#fff"/><circle cx="52" cy="78" r="8" fill="#fff"/><circle cx="50" cy="52" r="9.5" fill="#fff"/></svg></span> Relity</div>${body}
  </div></body></html>`;
}

app.listen(PORT, () => console.log(`Trace running on http://localhost:${PORT}`));
