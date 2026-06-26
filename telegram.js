/* ============================================================
   Relity — Telegram bot
   Send/forward a claim, headline, link, IMAGE, or VIDEO → get a Relity
   evidence read. Free to run. Reuses the site's claim engine, AI classifier,
   image reverse-search + AI vision, video keyframe check, and /check pages.
   Dormant until TELEGRAM_BOT_TOKEN is set.
   ============================================================ */
const crypto = require('crypto');

module.exports = function telegram({ claims, ai, img, video, news, redisOn, redisCmd } = {}) {
  const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
  const SECRET = process.env.RELITY_SECRET || 'dev-insecure';
  const BASE   = (process.env.RELITY_URL || 'https://relity.ai').replace(/\/$/, '');
  const hookSecret = crypto.createHmac('sha256', SECRET).update('telegram-webhook').digest('hex').slice(0, 40);
  const on = !!TOKEN;
  const VIA = '\n\n🔎 via @RelityCheck_bot — forward this, or check anything yourself';

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function api(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return r.json();
  }
  const send = (chatId, text) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

  // ---- daily corroborated-news digest ----
  const DIGEST_HOUR = Number.isFinite(+process.env.DIGEST_HOUR) ? +process.env.DIGEST_HOUR : 13; // UTC hour
  const DIGEST_CHANNEL = process.env.TELEGRAM_DIGEST_CHANNEL || ''; // optional public channel (@handle or numeric id) to auto-post the daily digest
  const memSubs = new Set();
  let lastSentDay = '';
  async function subAdd(id) { id = String(id); memSubs.add(id); if (redisOn) { try { await redisCmd(['SADD', 'relity:digest:subs', id]); } catch {} } }
  async function subDel(id) { id = String(id); memSubs.delete(id); if (redisOn) { try { await redisCmd(['SREM', 'relity:digest:subs', id]); } catch {} } }
  async function subList() { if (redisOn) { try { const v = await redisCmd(['SMEMBERS', 'relity:digest:subs']); if (Array.isArray(v)) return v; } catch {} } return [...memSubs]; }
  async function buildDigest() {
    if (!news || !news.getFeed) return null;
    let data; try { data = await news.getFeed(); } catch { return null; }
    const corrob = (data.clusters || []).filter(c => c.n >= 2).slice(0, 8);
    if (!corrob.length) return null;
    let msg = '🗞️ <b>Relity — corroborated today</b>\n<i>Ranked by how many independent newsrooms carry each story. Breadth of reporting, not proof — read and decide.</i>\n';
    corrob.forEach((c, i) => {
      msg += '\n<b>' + (i + 1) + '. ' + esc(c.rep.title) + '</b>\n' + c.n + ' outlets · ' + esc(c.outlets.join(', ')) + '\n<a href="' + esc(c.rep.link) + '">Read →</a>\n';
    });
    msg += '\n📡 Full feed: ' + BASE + '/feed\nSend /unsubscribe to stop.';
    return msg;
  }
  async function sendDigest() {
    const msg = await buildDigest();
    if (!msg) return { sent: 0, skipped: true };
    const subs = await subList();
    if (DIGEST_CHANNEL) { try { await send(DIGEST_CHANNEL, msg); } catch (e) { console.error('digest channel:', e.message); } }
    let sent = 0;
    for (const id of subs) {
      try { const r = await send(id, msg); if (r && r.ok) sent++; else if (r && r.error_code === 403) await subDel(id); } catch {}
      await new Promise(r => setTimeout(r, 45));
    }
    console.log('telegram digest: sent ' + sent + '/' + subs.length);
    return { sent, total: subs.length };
  }
  async function digestTick() {
    try {
      const now = new Date();
      if (now.getUTCHours() !== DIGEST_HOUR) return;
      const today = now.toISOString().slice(0, 10);
      if (redisOn) { try { if (await redisCmd(['GET', 'relity:digest:lastsent']) === today) return; await redisCmd(['SET', 'relity:digest:lastsent', today]); } catch {} }
      if (lastSentDay === today) return;
      lastSentDay = today;
      await sendDigest();
    } catch (e) { console.error('digestTick:', e.message); }
  }

  async function download(fileId) {
    const f = await api('getFile', { file_id: fileId });
    if (!f || !f.ok || !f.result || !f.result.file_path) return null;
    const fp = f.result.file_path;
    const dl = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${fp}`);
    return { buf: Buffer.from(await dl.arrayBuffer()), path: fp };
  }

  function formatClaim(r) {
    if (!r || r.error) return '⚠️ ' + esc((r && r.error) || 'Could not check that. Try rephrasing.');
    if (!r.read) return '⚠️ Could not check that. Try rephrasing the claim.';
    const rd = r.read;
    let msg = '🔎 <b>Relity</b> — evidence, not verdicts\n\n<b>' + esc(rd.badge) + '</b>\n' + esc(rd.line);
    const items = (r.sources && r.sources.items) || [];
    if (items.length) {
      const doms = [...new Set(items.map(i => i.source).filter(Boolean))].slice(0, 4).join(', ');
      if (doms) msg += '\n\n<i>Seen on:</i> ' + esc(doms);
    }
    return msg + VIA;
  }

  async function captionCheck(caption) {
    const t = (caption || '').toString().trim();
    if (!t || t.length < 8 || !claims || !claims.analyze) return '';
    try {
      const cls = (ai && ai.analyzeClaim) ? await ai.analyzeClaim({ tier: 'free', text: t }).catch(() => null) : null;
      const r = await claims.analyze(t, cls, 'free');
      if (r && r.read) return '\n\n🧾 <b>Caption check</b> — ' + esc(r.read.badge) + '\n' + esc(r.read.line);
    } catch (e) { console.error('captionCheck:', e.message); }
    return '';
  }
  async function checkPhoto(chatId, fileId, caption) {
    if (!img || !img.reverseSearch) { await send(chatId, '📷 Image checking isn’t available right now — try ' + BASE + '.'); return; }
    await send(chatId, '🔎 Checking that image…');
    try {
      const d = await download(fileId);
      if (!d) { await send(chatId, 'Couldn’t fetch that image — try sending it again.'); return; }
      const buf = d.buf;
      const mime = /\.png$/i.test(d.path) ? 'image/png' : (/\.webp$/i.test(d.path) ? 'image/webp' : 'image/jpeg');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const id = sha.slice(0, 10);
      let report = await img.getReport(id);
      if (!report || !report.reverse) {
        await img.putImage(id, buf, mime);
        const reverse = await img.reverseSearch(`${BASE}/img/${id}`);
        const aiRead = (ai && ai.analyzeImage) ? await ai.analyzeImage({ tier: 'free', sha, buffer: buf, mime, caption: caption || null }).catch(() => null) : null;
        report = { id, sha256: sha, createdAt: Date.now(), reverse, aiRead, fact: { connected: false }, prov: null, read: null, findings: [], claim: null, hasImage: true };
        await img.putReport(id, report);
      }
      const reachOK = !!(report.reverse && report.reverse.connected && !report.reverse.degraded);
      const ci = (reachOK && img.interpretDomains) ? img.interpretDomains(report.reverse.domains) : { flag: null, examined: false };
      const vintage = (reachOK && img.vintageYear) ? img.vintageYear(report.reverse.earliest) : null;
      const rd = img.computeConsensus
        ? img.computeConsensus('stripped', ci.flag || null, false, reachOK ? (report.reverse.count || 0) : 0, !!ci.examined, vintage, null)
        : { badge: 'Checked', line: '' };
      let msg = '🔎 <b>Relity</b> — evidence, not verdicts\n\n<b>' + esc(rd.badge) + '</b>\n' + esc(rd.line);
      if (report.aiRead && report.aiRead.text) msg += '\n\n<b>AI vision:</b> ' + esc(report.aiRead.text);
      if (reachOK && report.reverse.domains && report.reverse.domains.length) msg += '\n\n<i>Seen on:</i> ' + esc(report.reverse.domains.slice(0, 4).join(', '));
      try { const ts = ((report.reverse && report.reverse.matches) || []).map(m => m && m.title).filter(Boolean); if (reachOK && ts.length >= 2 && ai && ai.identifyEvent) { const ev = await ai.identifyEvent({ tier: 'free', titles: ts }); if (ev && ev.event) msg += '\n\n📰 <b>Appears in coverage of:</b> ' + esc(ev.event); } } catch (e) {}
      msg += await captionCheck(caption);
      msg += '\n\n📄 Full report: ' + BASE + '/check/' + id;
      await send(chatId, msg);
    } catch (e) { console.error('telegram checkPhoto:', e.message); await send(chatId, '⚠️ Something went wrong checking that image. Try again, or use ' + BASE + '.'); }
  }

  async function checkVideoMessage(chatId, fileId, caption) {
    if (!video || !video.checkVideo) { await send(chatId, '🎬 Video checking isn’t available right now — try ' + BASE + '.'); return; }
    await send(chatId, '🎬 Checking that video’s frames…');
    try {
      const d = await download(fileId);
      if (!d) { await send(chatId, 'Couldn’t fetch that video — it may be larger than Telegram lets bots download (~20MB). Try a shorter clip, or use ' + BASE + '.'); return; }
      const out = await video.checkVideo(d.buf);
      const rd = (out && out.read) || { badge: 'Checked', line: '' };
      let msg = '🔎 <b>Relity</b> — evidence, not verdicts\n\n<b>' + esc(rd.badge) + '</b>\n' + esc(rd.line);
      if (out && out.aiRead && out.aiRead.text) msg += '\n\n<b>AI vision (a frame):</b> ' + esc(out.aiRead.text);
      if (out && out.where && out.where.domains && out.where.domains.length) msg += '\n\n<i>Frames seen on:</i> ' + esc(out.where.domains.slice(0, 4).join(', '));
      if (out && out.where && out.where.event) msg += '\n\n📰 <b>Appears in coverage of:</b> ' + esc(out.where.event);
      msg += await captionCheck(caption);
      msg += '\n\n⚠️ Frame-checking finds where footage already appears online — it is not deepfake detection.';
      await send(chatId, msg);
    } catch (e) { console.error('telegram checkVideoMessage:', e.message); await send(chatId, '⚠️ Something went wrong checking that video. Try a shorter clip, or use ' + BASE + '.'); }
  }

  async function handle(update) {
    try {
      const m = update.message || update.edited_message;
      if (!m || !m.chat) return;
      const chatId = m.chat.id;
      const text = (m.text || m.caption || '').trim();

      if (m.photo && m.photo.length) { await checkPhoto(chatId, m.photo[m.photo.length - 1].file_id, m.caption || ''); return; }
      const vid = m.video || m.video_note || (m.document && /^video\//.test(m.document.mime_type || '') ? m.document : null) || (m.animation || null);
      if (vid && vid.file_id) { await checkVideoMessage(chatId, vid.file_id, m.caption || ''); return; }

      if (/^\/(start|help)\b/.test(text)) {
        await send(chatId, '👋 <b>Relity</b> — evidence, not verdicts.\n\nSend me any of these and I’ll show the evidence:\n• a <b>claim / headline / post</b> → is it a checkable claim backed by evidence, or just opinion?\n• an <b>image</b> → where it appears online + an AI read\n• a <b>video file</b> → where its frames appear online\n\nNote: I can’t open videos from X/social <i>links</i> — download the clip and send the file.\n\n🗞️ /subscribe — a daily digest of what multiple newsrooms corroborate.\n\nFull site: ' + BASE);
        return;
      }
      if (!text) { await send(chatId, 'Send me a claim, headline, image, or video and I’ll show the evidence.'); return; }

      if (/^\/subscribe\b/.test(text)) { await subAdd(chatId); await send(chatId, '✅ Subscribed. You’ll get the <b>daily corroborated-news digest</b> — the top stories multiple independent newsrooms are carrying. Send /digest to see today’s now, or /unsubscribe to stop.'); return; }
      if (/^\/unsubscribe\b/.test(text)) { await subDel(chatId); await send(chatId, 'Done — you’re unsubscribed from the daily digest. Send /subscribe anytime to resume.'); return; }
      if (/^\/digest\b/.test(text)) { const msg = await buildDigest(); await send(chatId, msg || 'No multi-outlet stories on the radar right now — check back soon, or see ' + BASE + '/feed.'); return; }
      if (/^\/share\b/.test(text)) { await send(chatId, '📣 <b>Share Relity</b>\n\nForward this to a friend or drop it in a group:\n\n<i>Is it real? Send any claim, post, image, or video to @RelityCheck_bot and it shows the evidence — sourced, debunked, opinion, or AI-generated. Evidence, not verdicts.</i>\n\nhttps://t.me/RelityCheck_bot'); return; }
      if (/^\/check(@\w+)?\b/i.test(text)) {
        const rest = text.replace(/^\/check(@\w+)?\s*/i, '').trim();
        const tgt = m.reply_to_message;
        if (rest) { const cls = (ai && ai.analyzeClaim) ? await ai.analyzeClaim({ tier: 'free', text: rest }).catch(() => null) : null; await send(chatId, formatClaim(await claims.analyze(rest, cls))); return; }
        if (tgt) {
          if (tgt.photo && tgt.photo.length) { await checkPhoto(chatId, tgt.photo[tgt.photo.length - 1].file_id, tgt.caption || ''); return; }
          const tv = tgt.video || tgt.video_note || (tgt.document && /^video\//.test(tgt.document.mime_type || '') ? tgt.document : null) || tgt.animation;
          if (tv && tv.file_id) { await checkVideoMessage(chatId, tv.file_id, tgt.caption || ''); return; }
          const tt = (tgt.text || tgt.caption || '').replace(/https?:\/\/\S+/gi, '').trim();
          if (tt) { const cls = (ai && ai.analyzeClaim) ? await ai.analyzeClaim({ tier: 'free', text: tt }).catch(() => null) : null; await send(chatId, formatClaim(await claims.analyze(tt, cls))); return; }
        }
        await send(chatId, 'Reply <b>/check</b> to any message, image, or video — or send <b>/check</b> followed by a claim. In a group, reply /check to fact-check what someone shared.'); return;
      }
      const stripped = text.replace(/https?:\/\/\S+/gi, '').trim();
      if (!stripped) {
        await send(chatId, '🔗 That’s a link on its own. I can’t open videos or posts from X/social links directly. To check:\n• an <b>image</b> or <b>video</b> → download it and send the <b>file</b> here\n• a <b>claim</b> → send the text, not just the link\n\nOr paste the link at ' + BASE + '.');
        return;
      }
      const cls = (ai && ai.analyzeClaim) ? await ai.analyzeClaim({ tier: 'free', text: stripped }).catch(() => null) : null;
      const result = await claims.analyze(stripped, cls);
      await send(chatId, formatClaim(result));
    } catch (e) { console.error('telegram handle:', e.message); }
  }

  function mount(app) {
    app.post('/webhook/telegram', (req, res) => {
      if (!on) return res.status(503).end();
      if (req.get('x-telegram-bot-api-secret-token') !== hookSecret) return res.status(401).end();
      res.json({ ok: true });
      handle(req.body || {});
    });
  }

  async function register() {
    if (!on) return;
    try {
      const j = await api('setWebhook', { url: BASE + '/webhook/telegram', secret_token: hookSecret, allowed_updates: ['message'] });
      console.log('telegram setWebhook:', j && j.ok ? 'ok @ ' + BASE + '/webhook/telegram' : JSON.stringify(j).slice(0, 160));
      await api('setMyCommands', { commands: [
        { command: 'start', description: 'What Relity does and how to use it' },
        { command: 'check', description: 'Check a claim — or reply /check to any message, image, or video' },
        { command: 'subscribe', description: 'Daily digest of corroborated news' },
        { command: 'digest', description: 'Today’s corroborated-news digest' },
        { command: 'unsubscribe', description: 'Stop the daily digest' },
        { command: 'share', description: 'Share Relity with a friend or group' },
        { command: 'help', description: 'How to check claims, images, and video' }
      ] });
    } catch (e) { console.error('telegram register:', e.message); }
    setInterval(digestTick, 5 * 60 * 1000);
    console.log('telegram digest scheduler armed for ' + DIGEST_HOUR + ':00 UTC');
  }

  return { mount, register, configured: on };
};
