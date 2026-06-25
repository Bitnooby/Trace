/* ============================================================
   Relity — Telegram bot
   Send/forward a claim, headline, or link → get a Relity evidence read back.
   Free to run (Telegram Bot API has no fee). Reuses the same claim engine
   + AI classifier as the website. Dormant until TELEGRAM_BOT_TOKEN is set.
   ============================================================ */
const crypto = require('crypto');

module.exports = function telegram({ claims, ai } = {}) {
  const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
  const SECRET = process.env.RELITY_SECRET || 'dev-insecure';
  const BASE   = (process.env.RELITY_URL || 'https://relity.ai').replace(/\/$/, '');
  const hookSecret = crypto.createHmac('sha256', SECRET).update('telegram-webhook').digest('hex').slice(0, 40);
  const on = !!TOKEN;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function api(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return r.json();
  }
  const send = (chatId, text) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

  function format(r) {
    if (!r || r.error) return '⚠️ ' + esc((r && r.error) || 'Could not check that. Try rephrasing.');
    if (!r.read) return '⚠️ Could not check that. Try rephrasing the claim.';
    const rd = r.read;
    let msg = '🔎 <b>Relity</b> — evidence, not verdicts\n\n<b>' + esc(rd.badge) + '</b>\n' + esc(rd.line);
    const items = (r.sources && r.sources.items) || [];
    if (items.length) {
      const doms = [...new Set(items.map(i => i.source).filter(Boolean))].slice(0, 4).join(', ');
      if (doms) msg += '\n\n<i>Seen on:</i> ' + esc(doms);
    }
    msg += '\n\n📷 To check an image, paste it at ' + BASE;
    return msg;
  }

  async function handle(update) {
    try {
      const m = update.message || update.edited_message;
      if (!m || !m.chat) return;
      const chatId = m.chat.id;
      const text = (m.text || m.caption || '').trim();
      if (m.photo) {
        await send(chatId, '📷 Image-checking in the bot is coming soon. For now, open ' + BASE + ' and paste the image — the file checks run privately in your browser. Got a caption or claim? Send it as text and I’ll check it.');
        return;
      }
      if (!text) { await send(chatId, 'Send me a claim, headline, or link and I’ll show the evidence — e.g. “NASA found water on the moon.”'); return; }
      if (/^\/(start|help)\b/.test(text)) {
        await send(chatId, '👋 <b>Relity</b> — evidence, not verdicts.\n\nSend a <b>claim, headline, or post</b> and I’ll tell you whether it’s a checkable claim backed by evidence — or just opinion — with sources.\n\nFor images, paste them at ' + BASE + '.');
        return;
      }
      const cls = (ai && ai.analyzeClaim) ? await ai.analyzeClaim({ tier: 'free', text }).catch(() => null) : null;
      const result = await claims.analyze(text, cls);
      await send(chatId, format(result));
    } catch (e) { console.error('telegram handle:', e.message); }
  }

  function mount(app) {
    app.post('/webhook/telegram', (req, res) => {
      if (!on) return res.status(503).end();
      if (req.get('x-telegram-bot-api-secret-token') !== hookSecret) return res.status(401).end();
      res.json({ ok: true });          // ack Telegram immediately
      handle(req.body || {});          // then process + reply
    });
  }

  async function register() {
    if (!on) return;
    try {
      const j = await api('setWebhook', { url: BASE + '/webhook/telegram', secret_token: hookSecret, allowed_updates: ['message'] });
      console.log('telegram setWebhook:', j && j.ok ? 'ok @ ' + BASE + '/webhook/telegram' : JSON.stringify(j).slice(0, 160));
    } catch (e) { console.error('telegram register:', e.message); }
  }

  return { mount, register, configured: on };
};
