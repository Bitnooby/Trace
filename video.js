/* ============================================================
   Relity — video keyframe engine
   Pull a few keyframes from a clip and reverse-search them: the strongest
   signal for RECYCLED / MISCAPTIONED footage (old video, fresh false caption).
   This is NOT deepfake detection — it weighs where the footage has appeared,
   and reports evidence, never a verdict.

   Resilient: if the bundled ffmpeg/ffprobe aren't available, the endpoint
   returns a graceful "unavailable" instead of crashing the server.
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let ffmpegPath = null, ffprobePath = null, ffOK = false;
try { ffmpegPath = require('ffmpeg-static'); ffprobePath = require('ffprobe-static').path; ffOK = !!(ffmpegPath && ffprobePath && fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)); }
catch (e) { console.error('video: ffmpeg not available —', e.message); }

const AI=['aiease','civitai','lexica','midjourney','leonardo.ai','openart','nightcafe','seaart','tensor.art','deepai','craiyon','getimg','ideogram','krea.ai','runwayml','pika','sora','kling','heygen','synthesia'];
const STOCK=['shutterstock','istockphoto','gettyimages','freepik','stock.adobe','dreamstime','alamy','123rf','depositphotos','pexels','unsplash','pixabay'];
const NEWS=['reuters','apnews','bbc.','nytimes','washingtonpost','theguardian','cnn.','npr.org','aljazeera','bloomberg','afp.','forbes','nbcnews','cbsnews','abcnews','usatoday'];
const FC=['snopes','politifact','factcheck','fullfact','leadstories','checkyourfact','altnews','boomlive','factly','africacheck','newschecker'];
const SOCIAL=['x.com','twitter','facebook','instagram','tiktok','reddit','youtube','youtu.be','threads.net','t.me','telegram'];

module.exports = function video({ SERPAPI_KEY = '', putImage, ai } = {}) {

  function run(bin, args) {
    return new Promise((res, rej) => {
      const p = spawn(bin, args); let err = '';
      p.stderr.on('data', d => err += d);
      p.on('error', rej);
      p.on('close', code => code === 0 ? res() : rej(new Error('exit ' + code + ' ' + err.slice(-160))));
    });
  }
  function probeDuration(file) {
    return new Promise(res => {
      try {
        const p = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
        let out = ''; p.stdout.on('data', d => out += d);
        p.on('close', () => res(parseFloat(out) || 0)); p.on('error', () => res(0));
      } catch { res(0); }
    });
  }
  async function extractKeyframes(buf, n = 3) {
    if (!ffOK) return { frames: [], duration: 0, unavailable: true };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relvid-'));
    const inp = path.join(dir, 'in.bin');
    fs.writeFileSync(inp, buf);
    const dur = await probeDuration(inp);
    const pts = dur > 0 ? Array.from({ length: n }, (_, i) => Math.max(0.1, dur * ((i + 0.5) / n))) : [0.1, 1, 2].slice(0, n);
    const frames = [];
    let i = 0;
    for (const t of pts) {
      const out = path.join(dir, 'f' + (i++) + '.jpg');
      try {
        await run(ffmpegPath, ['-ss', t.toFixed(2), '-i', inp, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '3', '-y', out]);
        if (fs.existsSync(out)) frames.push(fs.readFileSync(out));
      } catch (e) { /* skip this frame */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { frames, duration: dur };
  }

  const hostOf = l => { try { return new URL(l).hostname.replace(/^www\./, ''); } catch { return ''; } };
  async function reverseSearch(url) {
    if (!SERPAPI_KEY) return { connected: false };
    try {
      const j = await (await fetch(`https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(url)}&api_key=${SERPAPI_KEY}`)).json();
      if (j.error) return { connected: true, degraded: true };
      const vm = j.visual_matches || [];
      const matches = vm.slice(0, 8).map(m => ({ title: m.title, source: m.source, link: m.link, date: m.date || null }));
      const domains = [...new Set(vm.map(m => hostOf(m.link) || (m.source || '').toLowerCase()).filter(Boolean))].slice(0, 8);
      const dated = matches.filter(m => m.date).sort((a, b) => new Date(a.date) - new Date(b.date));
      return { connected: true, count: vm.length, domains, earliest: dated[0] || null };
    } catch { return { connected: true, degraded: true }; }
  }
  function interpretDomains(domains) {
    const d = (domains || []).map(x => String(x).toLowerCase());
    const hit = arr => [...new Set(d.filter(x => arr.some(k => x.includes(k))))];
    const ai = hit(AI), st = hit(STOCK), nw = hit(NEWS), fc = hit(FC);
    let flag = null; if (ai.length) flag = 'ai'; else if (nw.length) flag = 'news'; else if (st.length) flag = 'stock';
    return { flag, examined: fc.length > 0 };
  }
  function vintageYear(e) { if (!e || !e.date) return null; const m = String(e.date).match(/(19|20)\d{2}/); if (!m) return null; const y = +m[0], now = new Date().getFullYear(); return (y >= 1990 && y <= now - 1) ? y : null; }
  const spread = n => !n ? '' : n <= 3 ? 'a few places' : n <= 15 ? 'several places' : 'many places';

  function weigh(interp, count, vintage) {
    const E = 'Consensus — the evidence, weighed';
    const places = count ? ` (frames seen across ${spread(count)})` : '';
    const vint = vintage ? ` Frames have been online since ${vintage} — old footage paired with a fresh caption is the classic video fake.` : '';
    if (interp.examined) return { eyebrow: E, level: 'scrutinize', badge: 'Likely fact-checked', line: `Frames from this clip appear on fact-checking sites${places} — read their conclusion before sharing.` + vint };
    if (interp.flag === 'ai') return { eyebrow: E, level: 'scrutinize', badge: 'Leans AI / synthetic', line: `Frames appear on AI-generation sites${places} — circumstantial, but it leans AI-made.` + vint };
    if (interp.flag === 'news') return { eyebrow: E, level: 'photo', badge: 'Leans real footage', line: `Frames appear on news outlets${places} — consistent with real footage. Verify the original context.` + vint };
    if (count) return { eyebrow: E, level: 'scrutinize', badge: 'Recycled footage', line: `These frames already appear elsewhere online${places} — the clip is reused, not original. Check the claim attached to it.` + vint };
    return { eyebrow: E, level: 'scrutinize', badge: 'Unverified', line: `Couldn’t find these frames on sources we check. Frame checks can’t confirm a video on their own — and this is not deepfake detection.` + vint };
  }

  async function checkVideo(buf) {
    const E = 'Consensus — the evidence, weighed';
    if (!ffOK) return { read: { eyebrow: E, level: 'scrutinize', badge: 'Video unavailable', line: 'Video analysis is temporarily unavailable.' }, where: null };
    if (!SERPAPI_KEY) return { read: { eyebrow: E, level: 'scrutinize', badge: 'Not configured', line: 'Video web-check needs the reverse-search key.' }, where: null };
    const base = (process.env.RELITY_URL || 'https://relity.ai').replace(/\/$/, '');
    const { frames } = await extractKeyframes(buf, 3);
    if (!frames.length) return { read: { eyebrow: E, level: 'scrutinize', badge: 'Unreadable', line: 'Couldn’t read frames from that video.' }, where: null };
    const per = [];
    for (const fb of frames) {
      const id = 'v' + crypto.randomBytes(6).toString('hex');
      await putImage(id, fb, 'image/jpeg');
      per.push({ id, rev: await reverseSearch(`${base}/img/${id}`) });
    }
    const allDomains = [...new Set(per.flatMap(f => f.rev.domains || []))];
    const totalCount = per.reduce((s, f) => s + (f.rev.count || 0), 0);
    const earliest = per.map(f => f.rev.earliest).filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
    const interp = interpretDomains(allDomains);
    let aiRead = null;
    try {
      const frame = frames[Math.floor(frames.length / 2)];
      if (ai && ai.analyzeImage && frame) {
        const fsha = crypto.createHash('sha256').update(frame).digest('hex');
        aiRead = await ai.analyzeImage({ tier: 'free', sha: fsha, buffer: frame, mime: 'image/jpeg', caption: null });
      }
    } catch (e) { console.error('video aiRead:', e.message); }
    return { read: weigh(interp, totalCount, vintageYear(earliest)), where: { domains: allDomains.slice(0, 8), count: totalCount, earliest }, aiRead };
  }

  function mount(app, uploadVideo) {
    app.post('/api/check-video', uploadVideo.single('video'), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
        if (!ffOK) return res.json({ connected: false, read: { eyebrow: 'Consensus — the evidence, weighed', level: 'scrutinize', badge: 'Video unavailable', line: 'Video analysis is temporarily unavailable on the server.' }, frames: [] });
        if (!SERPAPI_KEY) return res.json({ connected: false, read: { eyebrow: 'Consensus — the evidence, weighed', level: 'scrutinize', badge: 'Not configured', line: 'Video web-check needs the reverse-search key (SERPAPI_KEY).' }, frames: [] });
        const { frames, duration } = await extractKeyframes(req.file.buffer, 3);
        if (!frames.length) return res.status(422).json({ error: 'Could not read frames from that video.' });
        const base = `${req.protocol}://${req.get('host')}`;
        const per = [];
        for (const fb of frames) {
          const id = 'v' + crypto.randomBytes(6).toString('hex');
          await putImage(id, fb, 'image/jpeg');
          per.push({ id, rev: await reverseSearch(`${base}/img/${id}`) });
        }
        const allDomains = [...new Set(per.flatMap(f => f.rev.domains || []))];
        const totalCount = per.reduce((s, f) => s + (f.rev.count || 0), 0);
        const earliest = per.map(f => f.rev.earliest).filter(Boolean).sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;
        const interp = interpretDomains(allDomains);
        const vintage = vintageYear(earliest);
        res.json({
          connected: true, duration,
          frames: per.map(f => ({ img: `/img/${f.id}`, count: f.rev.count || 0 })),
          where: { domains: allDomains.slice(0, 8), count: totalCount, earliest, flag: interp.flag, examined: interp.examined },
          read: weigh(interp, totalCount, vintage)
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  return { extractKeyframes, weigh, interpretDomains, checkVideo, mount, ffOK };
};
