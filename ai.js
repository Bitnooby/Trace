module.exports = function ai({ redisOn, redisCmd } = {}) {
  const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
  const GEMINI_MODEL  = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const ANTH_KEY      = process.env.ANTHROPIC_API_KEY || '';
  const ANTH_MODEL    = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const mem = new Map();
  const prompt = (caption, evidence) =>
    'You are the vision layer of Relity, a media-verification tool whose rule is "evidence, not a verdict." ' +
    'In 2-3 short plain sentences: (1) what the image appears to show; (2) any VISIBLE signs of AI generation or editing — hedge, you cannot be certain from pixels alone; (3) ' +
    (caption ? 'whether the image plausibly matches this caption: "' + caption + '".' : 'whether anything looks internally inconsistent.') +
    ' Describe only what is visible; never assert facts you cannot see; do NOT give a final real/fake verdict — you are one signal among several.' +
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
          const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTH_MODEL, max_tokens: 300, messages: [{ role: 'user', content: [
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
          const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: gen }) });
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
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
      headers: { 'x-api-key': ANTH_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTH_MODEL, max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'text', text: p }] }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error('anthropic ' + r.status);
    return ((j.content || [{}])[0].text) || '';
  }
  const claimPrompt = (text) =>
    'You are the text-analysis layer of Relity, a media-verification tool. Decide whether the TEXT below makes a CHECKABLE FACTUAL CLAIM or is just OPINION/commentary. ' +
    'Reply with STRICT minified JSON ONLY (no markdown, no code fence), exactly this shape: ' +
    '{"kind":"opinion|claim|mixed","claim":"<the single most important checkable factual claim, rewritten as a concise neutral statement for a web search, or empty string if none>","note":"<one short sentence explaining your call>"} ' +
    'Definitions: opinion = value judgments, predictions, feelings, rhetorical or unfalsifiable statements. claim = a concrete verifiable assertion of fact (who/what/when/where, numbers, events). mixed = opinion wrapped around a checkable fact. ' +
    'Do NOT judge whether it is true; only classify and extract the factual core. ' +
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
    const kind = ['opinion', 'claim', 'mixed'].includes(parsed.kind) ? parsed.kind : 'claim';
    const out = { kind, claim: String(parsed.claim || '').slice(0, 300), note: String(parsed.note || '').slice(0, 300),
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
  return { analyzeImage, analyzeClaim, configured: !!(GEMINI_KEY || ANTH_KEY) };
};
