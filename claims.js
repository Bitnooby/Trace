/* ============================================================
   Relity — claim & news checker
   Check a headline / caption / claim on its OWN (no image needed).
   Same philosophy as the image path: gather independent signals,
   weigh them, show evidence — never a hard verdict.

   Signals:
     1. Fact-check record (Google Fact Check Tools)
     2. Where the claim shows up on the web (SerpAPI google search), bucketed
        into news outlets / fact-checkers / social
     3. A recency cue (does the claim present itself as "breaking/today"?)

   Degrades gracefully: with no SERPAPI_KEY / FACTCHECK_KEY those signals
   just return "not configured" and the read says so honestly.
   ============================================================ */

const NEWS = ['reuters','apnews','bbc.','nytimes','washingtonpost','theguardian','cnn.','npr.org','aljazeera','bloomberg','afp.','forbes','independent.co','nbcnews','cbsnews','abcnews','usatoday','politico','axios','time.com','wsj.com'];
const FC   = ['snopes','politifact','factcheck','fullfact','leadstories','checkyourfact','truthorfiction','altnews','boomlive','factly','africacheck','newschecker'];
const SOCIAL = ['x.com','twitter','facebook','instagram','tiktok','reddit','youtube','youtu.be','threads.net','t.me','telegram','medium.com','substack','quora','linkedin'];

module.exports = function claims({ SERPAPI_KEY = '', FACTCHECK_KEY = '', ai = null, tierOf = null } = {}) {

  async function factCheck(q) {
    if (!FACTCHECK_KEY) return { connected: false };
    try {
      const u = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(q)}&key=${FACTCHECK_KEY}`;
      const j = await (await fetch(u)).json();
      const out = [];
      for (const c of (j.claims || [])) {
        const r = (c.claimReview || [])[0] || {};
        out.push({ claim: c.text, rating: r.textualRating, publisher: r.publisher && r.publisher.name, url: r.url });
      }
      return { connected: true, claims: out.slice(0, 6) };
    } catch { return { connected: true, error: true, claims: [] }; }
  }

  async function webSearch(q) {
    if (!SERPAPI_KEY) return { connected: false };
    try {
      const u = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=10&api_key=${SERPAPI_KEY}`;
      const j = await (await fetch(u)).json();
      if (j.error) return { connected: true, degraded: true };
      const items = (j.organic_results || []).slice(0, 10).map(r => ({
        title: r.title, link: r.link, source: r.source || hostOf(r.link), date: r.date || null
      }));
      return { connected: true, items };
    } catch { return { connected: true, degraded: true }; }
  }

  function hostOf(link) { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } }

  function bucket(items) {
    const d = (items || []).map(m => (m.link ? hostOf(m.link) : (m.source || '')).toLowerCase());
    const hit = arr => [...new Set(d.filter(x => arr.some(k => x.includes(k))))];
    return { news: hit(NEWS), fc: hit(FC), social: hit(SOCIAL) };
  }

  function recencyClaim(t) {
    t = (t || '').toLowerCase();
    if (/\b(today|yesterday|breaking|just now|right now|moments? ago|this (week|month|morning|afternoon|evening)|happening now|live now|latest|developing)\b/.test(t)) return true;
    const y = new Date().getFullYear();
    return new RegExp('\\b(' + y + '|' + (y - 1) + ')\\b').test(t);
  }

  const FALSE_RE = /false|pants on fire|fake|hoax|misleading|no evidence|incorrect|debunk|unfounded|baseless/i;
  const STOP = new Set(['the','a','an','is','are','was','were','of','in','on','to','and','or','that','this','it','its','for','with','as','at','by','be','been','has','have','had','do','does','did','no','not','will','can','could','would','should','may','might','from','about','into','than','then','there','their','they','you','your','our','but','if','so']);
  const keyTokens = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
  // Google's fact-check API returns loose keyword matches. Treating ANY "false"-rated result as a debunk
  // produces false "debunked" verdicts (e.g. a true "water on the Moon" claim). Only count a fact-check
  // whose own claim text actually overlaps the claim we're checking.
  function relevantFactChecks(query, list) {
    const q = keyTokens(query);
    if (!q.size) return list || [];
    return (list || []).filter(c => {
      const ct = keyTokens(c.claim);
      let overlap = 0; for (const w of q) if (ct.has(w)) overlap++;
      return q.size <= 2 ? overlap >= q.size : overlap / q.size >= 0.5;
    });
  }

  function weigh(fact, b, recent, query) {
    const E = 'Consensus — the evidence, weighed';
    const recNote = recent ? ' It frames itself as recent/breaking — be extra careful, recycled claims often do.' : '';
    const all = (fact && fact.connected && (fact.claims || [])) || [];
    const fcHits = relevantFactChecks(query, all);
    if (fcHits.length) {
      const top = fcHits[0];
      const cite = (top.publisher || top.rating)
        ? ` ${top.publisher || 'A fact-checker'} reviewed “${(top.claim || query || '').toString().slice(0, 140)}” and rated it “${top.rating || '—'}.”`
        : '';
      const ratings = fcHits.map(c => c.rating || '').join(' ');
      if (FALSE_RE.test(ratings)) return { eyebrow: E, level: 'debunk', badge: 'Debunked on record', line: 'A fact-check of this claim rates it false or misleading.' + cite + ' Read it in full before sharing.' };
      return { eyebrow: E, level: 'scrutinize', badge: 'On the fact-check record', line: 'Fact-checkers have addressed this claim.' + cite + ' Read their verdict before trusting it.' + recNote };
    }
    if (b.news.length) return { eyebrow: E, level: 'photo', badge: 'Covered by news outlets', line: `Reported by reputable outlets (${b.news.slice(0,2).join(', ')}). Coverage is a real trail to read — not proof on its own.` + recNote };
    if (b.fc.length) return { eyebrow: E, level: 'scrutinize', badge: 'Likely fact-checked', line: `This appears on fact-checking sites (${b.fc.slice(0,2).join(', ')}) — open them and read the conclusion.` + recNote };
    if (b.social.length) return { eyebrow: E, level: 'scrutinize', badge: 'Circulating on social', line: 'Found mostly on social platforms with no news or fact-check trail — treat as unverified until a credible source confirms it.' + recNote };
    return { eyebrow: E, level: 'scrutinize', badge: 'No record found', line: 'Couldn’t find this discussed on the sources we check — unverified. Absence of a record is not proof either way.' + recNote };
  }

  const EYEBROW = 'Consensus — the evidence, weighed';
  async function analyze(text, cls) {
    text = (text || '').toString().slice(0, 1200).trim();
    if (!text) return { error: 'Enter a claim, caption, or post to check.' };
    const kind = (cls && cls.kind) ? cls.kind : 'claim';
    const claimQ = (cls && cls.claim && cls.claim.trim()) ? cls.claim.trim() : text;
    if (kind === 'opinion') {
      return { text, kind, claim: '', classifier: cls || null,
        read: { eyebrow: EYEBROW, level: 'photo', badge: 'Opinion — not a factual claim',
          line: ((cls && cls.note) ? cls.note + ' ' : '') + 'There’s no checkable fact here to weigh against evidence — Relity verifies claims, not viewpoints.' },
        fact: { connected: false }, sources: { count: 0, items: [], buckets: { news: [], fc: [], social: [] } } };
    }
    const [fact, web] = await Promise.all([factCheck(claimQ), webSearch(claimQ)]);
    const items = (web.items || []);
    const b = bucket(items);
    const read = weigh(fact, b, recencyClaim(text), claimQ);
    if (kind === 'mixed') read.line = 'This mixes opinion with a checkable claim. ' + read.line;
    if (claimQ && claimQ !== text) read.line = `Checked the factual claim: “${claimQ}”. ` + read.line;
    return { text, kind, claim: claimQ, classifier: cls || null, read, fact, sources: { count: items.length, items, buckets: b } };
  }

  function mount(app) {
    app.post('/api/check-claim', async (req, res) => {
      try {
        const text = req.body && req.body.text;
        let cls = null;
        if (ai && ai.analyzeClaim) {
          let tier = 'free';
          try { if (tierOf) tier = (await tierOf(req)).tier || 'free'; } catch {}
          cls = await ai.analyzeClaim({ tier, text }).catch(() => null);
        }
        res.json(await analyze(text, cls));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  return { analyze, weigh, bucket, recencyClaim, mount };
};
