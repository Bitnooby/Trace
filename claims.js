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
const AUTH = ['.gov','.edu','.ac.','wikipedia.','britannica.','nature.com','science.org','sciencemag','scientificamerican','nationalgeographic','smithsonian','who.int','un.org','nih.','noaa.','nasa.','usgs.','esa.int','europa.eu','jstor.','pnas.'];
const LOCAL = ['patch.com','localnews','spectrumlocalnews','spectrumnews','clickorlando','azfamily','localmemphis','wral','wsoctv','wsbtv','wftv','11alive','kxan','kvue','ktla','kcra','king5','wcvb','wbz','ksl.com','abc7','abc11','abc13','abc30','fox5','fox13','fox32','nbc4','cbs2','cbsla','nbcchicago','gazette','tribune','herald','dispatch','courier','sentinel','chronicle','star-','dailynews'];

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
        title: r.title, link: r.link, source: r.source || hostOf(r.link), date: r.date || null, snippet: r.snippet || ''
      }));
      return { connected: true, items };
    } catch { return { connected: true, degraded: true }; }
  }

  function hostOf(link) { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } }

  function bucket(items) {
    const d = (items || []).map(m => (m.link ? hostOf(m.link) : (m.source || '')).toLowerCase());
    const hit = arr => [...new Set(d.filter(x => arr.some(k => x.includes(k))))];
    return { news: hit(NEWS), fc: hit(FC), social: hit(SOCIAL), auth: hit(AUTH), local: hit(LOCAL) };
  }

  function recencyClaim(t) {
    t = (t || '').toLowerCase();
    if (/\b(today|yesterday|breaking|just now|right now|moments? ago|this (week|month|morning|afternoon|evening)|happening now|live now|latest|developing)\b/.test(t)) return true;
    const y = new Date().getFullYear();
    return new RegExp('\\b(' + y + '|' + (y - 1) + ')\\b').test(t);
  }

  const FALSE_RE = /false|pants on fire|fake|hoax|misleading|no evidence|incorrect|debunk|unfounded|baseless/i;
  const STOP = new Set('the a an is are was were be been being of in on to and or that this it its for with as at by from about into over under between among through during before after above below against without within across has have had do does did not no nor so too very just also even still only own same such more most some any all both each few many much other who whom whose which what when where why how here there now will would can could should may might must shall them they their you your we our us i me my he him his she her but because since until while new old said says say see seen get got make made take took went one two back way well off up down again once'.split(' '));
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
      const need = q.size <= 2 ? q.size : Math.max(2, Math.ceil(q.size * 0.5));
      return overlap >= need;
    });
  }

  function weigh(fact, b, recent, query) {
    const E = 'Consensus — the evidence, weighed';
    const recNote = recent ? ' It frames itself as recent/breaking — be extra careful, recycled claims often do.' : '';
    const all = (fact && fact.connected && (fact.claims || [])) || [];
    const fcHits = relevantFactChecks(query, all);
    if (fcHits.length) {
      const top = fcHits[0];
      const fcClaim = (top.claim || query || '').toString().slice(0, 140).replace(/[.\s"”]+$/, '');
      const fcRating = (top.rating || '—').toString().replace(/[.\s"”]+$/, '');
      const cite = (top.publisher || top.rating)
        ? ` ${top.publisher || 'A fact-checker'} reviewed “${fcClaim}” and rated it “${fcRating}.”`
        : '';
      const ratings = fcHits.map(c => c.rating || '').join(' ');
      if (FALSE_RE.test(ratings)) return { eyebrow: E, level: 'debunk', badge: 'Debunked on record', line: 'A fact-check of this claim rates it false or misleading.' + cite + ' Read it in full before sharing.' };
      return { eyebrow: E, level: 'scrutinize', badge: 'On the fact-check record', line: 'Fact-checkers have addressed this claim.' + cite + ' Read their verdict before trusting it.' + recNote };
    }
    const credible = [...new Set([...(b.news || []), ...(b.auth || [])])];
    if (credible.length) return { eyebrow: E, level: 'photo', badge: 'Documented by credible sources', line: `Appears on reputable / authoritative sources (${credible.slice(0,3).join(', ')}). A real trail to read — not proof on its own.` + recNote };
    if (b.local && b.local.length) return { eyebrow: E, level: 'photo', badge: 'Reported by local news', line: `Covered by local news outlets (${b.local.slice(0, 2).join(', ')}) — a real but local trail; verify the specifics.` + recNote };
    if (b.fc.length) return { eyebrow: E, level: 'scrutinize', badge: 'Likely fact-checked', line: `This appears on fact-checking sites (${b.fc.slice(0,2).join(', ')}) — open them and read the conclusion.` + recNote };
    if (b.social.length) return { eyebrow: E, level: 'scrutinize', badge: 'Circulating on social', line: `Found mostly on social platforms (${b.social.slice(0, 3).join(', ')}) with no news or fact-check trail — widely shared is not the same as verified. Treat as unverified until a credible source confirms it.` + recNote };
    return { eyebrow: E, level: 'scrutinize', badge: 'No record found', line: 'Couldn’t find this discussed on the sources we check — unverified. Absence of a record is not proof either way.' + recNote };
  }

  const EYEBROW = 'Consensus — the evidence, weighed';
  async function analyze(text, cls, tier) {
    text = (text || '').toString().slice(0, 1200).trim();
    if (!text) return { error: 'Enter a claim, caption, or post to check.' };
    const kind = (cls && cls.kind) ? cls.kind : 'claim';
    const claimQ = (cls && cls.claim && cls.claim.trim()) ? cls.claim.trim() : text;
    if (kind === 'opinion') {
      return { text, kind, claim: '', classifier: cls || null,
        read: { eyebrow: EYEBROW, level: 'photo', badge: 'Opinion — not a factual claim',
          line: ((cls && cls.note) ? cls.note + ' ' : '') + ((cls && cls.opinion) ? '“' + cls.opinion + '” is the poster’s viewpoint. ' : '') + 'There’s no checkable fact here to weigh — Relity verifies claims, not opinions.' },
        fact: { connected: false }, sources: { count: 0, items: [], buckets: { news: [], fc: [], social: [] } } };
    }
    if (kind === 'question') {
      const [qFact, qWeb] = await Promise.all([factCheck(claimQ), webSearch(claimQ)]);
      const qItems = (qWeb.items || []);
      const qb = bucket(qItems);
      const credible = [...new Set([...(qb.news || []), ...(qb.auth || [])])];
      const ans = (cls && cls.answer) ? cls.answer.trim() : '';
      let line = ans ? ans + ' ' : '';
      if (credible.length) line += `Documented by credible sources (${credible.slice(0, 3).join(', ')}).`;
      else if (qItems.length) line += 'Discussed across several public sources.';
      else line += 'I couldn’t find authoritative sources on this.';
      line += ' This is a general-knowledge answer — verify it for anything important.';
      return { text, kind, claim: claimQ, classifier: cls || null,
        read: { eyebrow: EYEBROW, level: 'photo', badge: 'Answer', line },
        fact: qFact, sources: { count: qItems.length, items: qItems, buckets: qb } };
    }
    const [fact, web] = await Promise.all([factCheck(claimQ), webSearch(claimQ)]);
    const items = (web.items || []);
    const b = bucket(items);
    let read = weigh(fact, b, recencyClaim(text), claimQ);
    // Knowledge check: a topic appearing on credible sources is NOT the same as those sources backing the claim.
    // If the AI is confident the claim contradicts/matches well-established fact, lead with that.
    // A real fact-check debunk (read.level === 'debunk') always takes priority over the AI's knowledge.
    const ks = cls && cls.knownStatus;
    const corr = (cls && cls.correction) ? cls.correction.trim().replace(/[.\s]+$/, '') : '';
    const credSrc = [...new Set([...(b.news || []), ...(b.auth || [])])];
    const srcNote = credSrc.length ? ` Credible sources discuss the topic (${credSrc.slice(0, 2).join(', ')}) — read them, not just the headline.` : '';
    if (ks === 'contradicted' && read.level !== 'debunk') {
      read = { eyebrow: EYEBROW, level: 'debunk', badge: 'Contradicts established facts', line: `“${claimQ}” runs against well-established knowledge${corr ? ' — ' + corr : ''}.${srcNote}` };
    } else if (ks === 'supported' && read.level !== 'debunk') {
      read = { eyebrow: EYEBROW, level: 'photo', badge: 'Matches established facts', line: `“${claimQ}” is consistent with well-established knowledge${corr ? ' — ' + corr : ''}.${srcNote} Still your call on the specifics.` };
    } else if (claimQ && claimQ !== text) {
      read.line = `Checked the factual claim: “${claimQ}”. ` + read.line;
    }
    if (ks !== 'contradicted' && ks !== 'supported' && read.level !== 'debunk' && items.length && ai && ai.synthesizeEvidence) {
      const snips = items.filter(i => i.snippet).slice(0, 5).map(i => ({ title: i.title, source: i.source, snippet: i.snippet }));
      if (snips.length) {
        try { const syn = await ai.synthesizeEvidence({ tier: tier || 'free', claim: claimQ, snippets: snips }); if (syn && syn.summary) read.line += ' What the top sources indicate: ' + syn.summary; } catch {}
      }
    }
    if (cls && cls.opinion) read.line += ` The poster’s own framing — “${cls.opinion}” — is opinion, not something Relity can verify.`;
    return { text, kind, claim: claimQ, classifier: cls || null, read, fact, sources: { count: items.length, items, buckets: b } };
  }

  function mount(app) {
    app.post('/api/check-claim', async (req, res) => {
      try {
        const text = req.body && req.body.text;
        let tier = 'free';
        try { if (tierOf) tier = (await tierOf(req)).tier || 'free'; } catch {}
        let cls = null;
        if (ai && ai.analyzeClaim) { cls = await ai.analyzeClaim({ tier, text }).catch(() => null); }
        res.json(await analyze(text, cls, tier));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  return { analyze, weigh, bucket, recencyClaim, mount };
};
