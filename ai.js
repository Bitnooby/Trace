module.exports = function ai({ redisOn, redisCmd } = {}) {
  const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
  const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const ANTH_KEY      = process.env.ANTHROPIC_API_KEY || '';
  const ANTH_MODEL    = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const mem = new Map();
  const fetchT = (url, opts, ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 15000); return fetch(url, Object.assign({}, opts || {}, { signal: c.signal })).finally(() => clearTimeout(t)); };
  const prompt = (caption, evidence) =>
    'You are the forensic vision layer of Relity, a media-verification tool whose rule is "evidence, not a verdict." ' +
    'Examine the image closely, like an analyst, and report ONLY what is visible. Actively scan for the tell-tale signs of AI generation or photo manipulation: ' +
    'malformed hands or fingers (wrong count, fused, bent wrong); distorted teeth, eyes, ears, or jewelry; ' +
    'garbled, melted, or nonsensical text on signs, labels, or clothing; impossible anatomy, scale, or physics; ' +
    'inconsistent shadows, reflections, or lighting directions; objects that warp, melt, blur, or merge into each other; ' +
    'unnaturally smooth "plastic" or waxy skin; repeated or nonsensical background patterns; and warped, haloed, or smeared edges. ' +
    'Reply in 3-4 short, plain sentences: ' +
    '(1) what the image appears to show; ' +
    '(2) ANY anomalies or physically impossible details you can actually see — name them specifically and where they are — or state plainly that you see no obvious anomalies; ' +
    (caption ? '(3) whether it plausibly matches this caption: "' + caption + '"; ' : '(3) whether anything looks internally inconsistent; ') +
    '(4) a hedged read: do the visible details look consistent with a real photograph, or do they lean AI-generated / edited? Describe the evidence — do NOT declare certainty, and never give a final real/fake verdict; you are one signal among several. ' +
    'Describe only what is visible; never assert facts you cannot see.' +
    (evidence ? ' Context: reverse image search found it on ' + evidence + '.' : '');
  const GEMINI_MODELS = [GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'].filter((v, i, a) => v && a.indexOf(v) === i);
  async function gemini(b64, mime, p) {
    let lastErr = 'gemini: no model worked';
    for (const model of GEMINI_MODELS) {
      // Prefer thinking OFF (faster/cheaper + no budget eaten by hidden reasoning, which truncates the answer).
      // If a model rejects thinkingConfig, retry it plain. maxOutputTokens is high enough to never cut the read short either way.
      for (const noThink of [true, false]) {
        try {
          const gen = { maxOutputTokens: 1024, temperature: 0.2 };
          if (noThink) gen.thinkingConfig = { thinkingBudget: 0 };
          const u = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
          const r = await fetchT(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: p }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: gen }) });
          const j = await r.json();
          if (!r.ok) { lastErr = 'gemini ' + model + ' HTTP ' + r.status + ' ' + JSON.stringify((j && j.error && j.error.message) || '').slice(0, 140); continue; }
          const t = ((((j.candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '';
          if (t) return t;
          lastErr = 'gemini ' + model + ' empty';
        } catch (e) { lastErr = 'gemini ' + model + ' ' + e.message; }
      }
    }
    throw new Error(lastErr);
  }
  async function anthropic(b64, mime, p) {
    const r = await fetchT('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTH_MODEL, max_tokens: 500, messages: [{ role: 'user', content: [
        { type: 'text', text: p }, { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } } ] }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error('anthropic ' + r.status);
    return ((j.content || [{}])[0].text) || '';
  }
  async function cacheGet(k) { if (redisOn) { try { const v = await redisCmd(['GET', k]); if (v) return JSON.parse(v); } catch {} } return mem.get(k) || null; }
  async function cacheSet(k, v) { if (redisOn) { try { await redisCmd(['SET', k, JSON.stringify(v), 'EX', 60 * 60 * 24 * 30]); return; } catch {} } mem.set(k, v); }

  // ---- text classifier: opinion vs checkable claim (+ extract the claim) ----
  function parseJsonBlock(s) { try { const m = String(s).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }
  async function geminiText(p) {
    let lastErr = 'gemini-text: no model worked';
    for (const model of GEMINI_MODELS) {
      for (const noThink of [true, false]) {
        try {
          const gen = { maxOutputTokens: 512, temperature: 0 };
          if (noThink) gen.thinkingConfig = { thinkingBudget: 0 };
          const u = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
          const r = await fetchT(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: gen }) });
          const j = await r.json();
          if (!r.ok) { lastErr = 'gemini ' + model + ' HTTP ' + r.status; continue; }
          const t = ((((j.candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '';
          if (t) return t;
          lastErr = 'gemini ' + model + ' empty';
        } catch (e) { lastErr = 'gemini ' + model + ' ' + e.message; }
      }
    }
    throw new Error(lastErr);
  }
  async function anthropicText(p) {
    const r = await fetchT('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTH_MODEL, max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'text', text: p }] }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error('anthropic ' + r.status);
    return ((j.content || [{}])[0].text) || '';
  }
  const claimPrompt = (text) =>
    'You are the text-analysis layer of Relity, a media-verification tool. Read the TEXT (a social post, caption, question, or news snippet) and SEPARATE fact from opinion. ' +
    'Reply with STRICT minified JSON ONLY (no markdown, no code fence), exactly this shape: ' +
    '{"kind":"opinion|claim|mixed|question","claim":"<the single most important CHECKABLE factual assertion, or for a question the topic to search, as a concise neutral phrase; empty string if none>","opinion":"<the poster\'s subjective take, framing, emotion or judgement, in a short phrase; empty string if none>","answer":"<if the TEXT is a question, a concise factual answer from well-established collective knowledge (say if uncertain); empty string otherwise>","knownStatus":"supported|contradicted|unsure","correction":"<one short sentence stating the accurate well-established fact, ONLY when knownStatus is supported or contradicted; empty otherwise>","note":"<one short sentence explaining your call>"} ' +
    'Definitions: question = the TEXT asks something. opinion = value judgments, predictions, feelings, sarcasm, or unfalsifiable statements. claim = a concrete verifiable assertion of fact. mixed = a checkable fact wrapped in opinion or framing. ' +
    'knownStatus: judge the claim ONLY against TIMELESS, well-established, uncontroversial knowledge that does not change over time (settled science, history, geography, math, physical constants). Use "contradicted" if it clearly conflicts with such facts (e.g. "there are 5 planets in the solar system") and give the correct fact in "correction". Use "supported" if it clearly matches such facts. Use "unsure" for ANYTHING contested, political, recent or current-events, niche, or that you are not highly confident about. CRUCIAL: also use "unsure" for any claim whose answer can CHANGE OVER TIME or that you may have outdated knowledge of — e.g. who is currently the richest/biggest/best/tallest, current prices, current records or rankings, who currently holds an office or title, and anything with "now/currently/latest/today/this year". Your training may be stale, so defer those to live sources by choosing "unsure". When in any doubt, choose "unsure". ' +
    'Put the factual core (or the question topic) in "claim", the subjective part in "opinion", and answer any question in "answer". ' +
    'TEXT: """' + String(text || '').slice(0, 1200) + '"""';
  async function analyzeClaim({ tier, text } = {}) {
    text = (text || '').toString().trim();
    if (!text) return null;
    const isPro = tier === 'pro';
    const provider = (isPro && ANTH_KEY) ? 'anthropic' : (GEMINI_KEY ? 'gemini' : null);
    if (!provider) return null;
    const sha = require('crypto').createHash('sha256').update(provider + ':' + text).digest('hex').slice(0, 16);
    const ckey = `relity:claimai:${sha}`;
    const cached = await cacheGet(ckey); if (cached) return cached;
    let raw;
    try { raw = provider === 'anthropic' ? await anthropicText(claimPrompt(text)) : await geminiText(claimPrompt(text)); }
    catch (e) { console.error('analyzeClaim:', e.message); return null; }
    const parsed = parseJsonBlock(raw);
    if (!parsed || !parsed.kind) return null;
    const kind = ['opinion', 'claim', 'mixed', 'question'].includes(parsed.kind) ? parsed.kind : 'claim';
    const out = { kind, claim: String(parsed.claim || '').slice(0, 300), opinion: String(parsed.opinion || '').slice(0, 300), answer: String(parsed.answer || '').slice(0, 400), knownStatus: ['supported', 'contradicted', 'unsure'].includes(parsed.knownStatus) ? parsed.knownStatus : 'unsure', correction: String(parsed.correction || '').slice(0, 300), note: String(parsed.note || '').slice(0, 300),
      provider, model: provider === 'anthropic' ? ANTH_MODEL : GEMINI_MODEL, tierLabel: provider === 'anthropic' ? 'Claude · Pro' : 'Gemini' };
    await cacheSet(ckey, out);
    return out;
  }
  async function analyzeImage({ tier, sha, buffer, mime, caption, evidence }) {
    if (!buffer) return null;
    const isPro = tier === 'pro';
    const providers = [];
    if (isPro && ANTH_KEY) providers.push('anthropic');
    if (GEMINI_KEY) providers.push('gemini');
    if (!providers.length) return null;
    const ckey = `relity:ai:${providers.join('+')}:${sha || 'x'}`;
    if (sha) { const c = await cacheGet(ckey); if (c) return c; }
    const m = (mime && mime.startsWith('image/')) ? mime : 'image/jpeg';
    const b64 = buffer.toString('base64');
    const p = prompt(caption, evidence);
    const reads = await Promise.all(providers.map(async pv => {
      try {
        const t = (pv === 'anthropic' ? await anthropic(b64, m, p) : await gemini(b64, m, p)).trim();
        return t ? { label: pv === 'anthropic' ? 'Claude' : 'Gemini', model: pv === 'anthropic' ? ANTH_MODEL : GEMINI_MODEL, text: t } : null;
      } catch (e) { console.error('ai', pv, e.message); return null; }
    }));
    const ok = reads.filter(Boolean);
    if (!ok.length) return null;
    let out;
    if (ok.length === 1) out = { provider: ok[0].label.toLowerCase(), model: ok[0].model, tierLabel: ok[0].label + (isPro ? ' · Pro' : ''), text: ok[0].text };
    else out = { provider: 'multi', model: ok.map(r => r.model).join(' + '), tierLabel: ok.map(r => r.label).join(' + ') + ' · Pro', text: ok.map(r => r.label + ' —\n' + r.text).join('\n\n') };
    if (sha) await cacheSet(ckey, out);
    return out;
  }
  function synthesisPrompt(claim, snippets) {
    const s = (snippets || []).slice(0, 5).map((x, i) => `${i + 1}. [${x.source || ''}] ${x.title || ''} — ${(x.snippet || '').toString().slice(0, 220)}`).join('\n');
    return 'You are the evidence layer of Relity. Using ONLY the SNIPPETS below from web search results, judge whether they support, refute, are mixed on, or do not address the CLAIM. ' +
      'Reply with STRICT minified JSON only: {"stance":"support|refute|mixed|unaddressed","summary":"<one neutral sentence on what these sources indicate about the claim; use only what the snippets say, add no outside facts>"}. ' +
      'Be conservative — if the snippets do not clearly speak to the claim, use "unaddressed". Do not declare the claim true or false; only report what the sources indicate. ' +
      'CLAIM: "' + String(claim || '').slice(0, 200) + '"\nSNIPPETS:\n' + s;
  }
  async function synthesizeEvidence({ tier, claim, snippets } = {}) {
    claim = (claim || '').toString().trim();
    if (!claim || !snippets || !snippets.length) return null;
    const provider = (tier === 'pro' && ANTH_KEY) ? 'anthropic' : (GEMINI_KEY ? 'gemini' : null);
    if (!provider) return null;
    const key = `relity:syn:${require('crypto').createHash('sha256').update(provider + ':' + claim + ':' + snippets.map(s => s.title || '').join('|')).digest('hex').slice(0, 16)}`;
    const cached = await cacheGet(key); if (cached) return cached;
    let raw;
    try { raw = provider === 'anthropic' ? await anthropicText(synthesisPrompt(claim, snippets)) : await geminiText(synthesisPrompt(claim, snippets)); }
    catch (e) { console.error('synthesizeEvidence:', e.message); return null; }
    const p = parseJsonBlock(raw);
    if (!p || !p.summary) return null;
    const out = { stance: ['support', 'refute', 'mixed', 'unaddressed'].includes(p.stance) ? p.stance : 'unaddressed', summary: String(p.summary).slice(0, 300) };
    await cacheSet(key, out);
    return out;
  }
  function eventPrompt(titles) {
    const t = (titles || []).slice(0, 8).filter(Boolean).map((x, i) => `${i + 1}. ${String(x).slice(0, 140)}`).join('\n');
    return 'You are Relity. Below are TITLES of web/news results that a photo or video matched. If they clearly describe ONE specific real-world event or subject, name it in a short neutral phrase (include place/time if evident). If they are unrelated, generic, or unclear, return empty. ' +
      'Reply STRICT minified JSON only: {"event":"<short phrase naming the event or subject, e.g. the 2026 Venezuela earthquake; empty string if unclear>"}. Do not invent details not supported by the titles. ' +
      'TITLES:\n' + t;
  }
  async function identifyEvent({ tier, titles } = {}) {
    const list = (titles || []).filter(Boolean);
    if (list.length < 2) return null;
    const provider = (tier === 'pro' && ANTH_KEY) ? 'anthropic' : (GEMINI_KEY ? 'gemini' : null);
    if (!provider) return null;
    const key = `relity:evt:${require('crypto').createHash('sha256').update(provider + ':' + list.join('|')).digest('hex').slice(0, 16)}`;
    const cached = await cacheGet(key); if (cached) return cached;
    let raw;
    try { raw = provider === 'anthropic' ? await anthropicText(eventPrompt(list)) : await geminiText(eventPrompt(list)); }
    catch (e) { console.error('identifyEvent:', e.message); return null; }
    const p = parseJsonBlock(raw);
    const event = (p && p.event) ? String(p.event).slice(0, 160).trim() : '';
    const out = { event };
    await cacheSet(key, out);
    return out;
  }
  return { analyzeImage, analyzeClaim, synthesizeEvidence, identifyEvent, configured: !!(GEMINI_KEY || ANTH_KEY) };
};
