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
  async function gemini(b64, mime, p) {
    const u = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: p }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { maxOutputTokens: 220, temperature: 0.2 } }) });
    const j = await r.json();
    if (!r.ok) throw new Error('gemini ' + r.status);
    return ((((j.candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '';
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
  async function analyzeImage({ tier, sha, buffer, mime, caption, evidence }) {
    if (!buffer) return null;
    const usePro = tier === 'pro' && ANTH_KEY;
    const provider = usePro ? 'anthropic' : (GEMINI_KEY ? 'gemini' : null);
    if (!provider) return null;
    const key = `relity:ai:${provider}:${sha || 'x'}`;
    if (sha) { const c = await cacheGet(key); if (c) return c; }
    const m = (mime && mime.startsWith('image/')) ? mime : 'image/jpeg';
    const b64 = buffer.toString('base64');
    let text;
    try { text = (usePro ? await anthropic(b64, m, prompt(caption, evidence)) : await gemini(b64, m, prompt(caption, evidence))).trim(); }
    catch (e) { console.error('ai vision:', e.message); return null; }
    if (!text) return null;
    const out = { provider, model: usePro ? ANTH_MODEL : GEMINI_MODEL, tierLabel: usePro ? 'Claude · Pro' : 'Gemini', text };
    if (sha) await cacheSet(key, out);
    return out;
  }
  return { analyzeImage, configured: !!(GEMINI_KEY || ANTH_KEY) };
};
