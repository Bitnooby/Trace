'use strict';
/* figures.js — primary-source posts from key public figures.
   We surface what they actually posted, verbatim, and link the original (the receipt).
   Trump (Truth Social): CNN JSON archive (carries engagement counts) with a
   trumpstruth.org RSS fallback. Ranked by engagement (read rate) x recency.
   Evidence, not verdicts. Built multi-figure: add an entry to FIGURES to follow more. */

const FIGURES = [
  {
    id: 'trump',
    name: 'Donald J. Trump',
    handle: '@realDonaldTrump',
    platform: 'Truth Social',
    json: 'https://ix.cnn.io/data/truth-social/truth_archive.json', // structured + engagement
    rss:  'https://trumpstruth.org/feed'                            // fallback (recency only)
  }
];

const UA = { 'User-Agent': 'RelityRadar/1.0 (+https://relity.ai)' };
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, posts: [] };

function clean(s){
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&#8230;|&hellip;/g, '…').replace(/&#8212;|&mdash;/g, '—').replace(/&#8211;|&ndash;/g, '–')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchJson(fig){
  const r = await fetch(fig.json, { headers: UA, signal: AbortSignal.timeout(9000) });
  if(!r.ok) throw new Error('json HTTP ' + r.status);
  const arr = await r.json();
  return (Array.isArray(arr) ? arr : []).map(p => ({
    figure: fig.name, handle: fig.handle, platform: fig.platform,
    id: String(p.id || ''),
    text: clean(p.content || ''),
    url: p.url || '',
    ts: Date.parse(p.created_at) || 0,
    media: Array.isArray(p.media) ? p.media : [],
    eng: (p.favourites_count || 0) + (p.reblogs_count || 0) + (p.replies_count || 0)
  })).filter(p => p.id && p.url);
}

function parseRss(xml, fig){
  const out = [];
  const parts = xml.split(/<item[\s>]/i).slice(1);
  for(const raw of parts){
    const block = raw.split(/<\/item>/i)[0];
    const g = n => { const x = block.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return x ? x[1] : ''; };
    let link = clean(g('link')); if(!link){ const h = block.match(/<link[^>]*href=["']([^"']+)["']/i); if(h) link = h[1]; }
    const text = clean(g('description') || g('content:encoded') || g('title'));
    const date = clean(g('pubDate') || g('published') || g('dc:date'));
    if(text && link) out.push({ figure: fig.name, handle: fig.handle, platform: fig.platform, id: link, text, url: link, ts: Date.parse(date) || 0, media: [], eng: 0 });
  }
  return out;
}

async function fetchFigure(fig){
  if(fig.json){ try { const a = await fetchJson(fig); if(a.length) return a; } catch(e){ /* fall through to rss */ } }
  if(fig.rss){ try { const r = await fetch(fig.rss, { headers: UA, signal: AbortSignal.timeout(9000) }); if(r.ok) return parseRss(await r.text(), fig); } catch(e){ /* none */ } }
  return [];
}

function isSubstantive(t){
  t = (t || '').trim();
  if(t.length < 15) return false;
  if(/^RT[:\s]/i.test(t)) return false;
  if(/^https?:\/\/\S+$/i.test(t)) return false;
  const words = t.replace(/https?:\/\/\S+/g, ' ').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  return words.length >= 4;
}
async function refresh(){
  const all = (await Promise.all(FIGURES.map(fetchFigure))).flat();
  const seen = new Set(), posts = [];
  for(const p of all.sort((a, b) => b.ts - a.ts)){ if(p.id && !seen.has(p.id) && isSubstantive(p.text)){ seen.add(p.id); posts.push(p); } }
  cache = { at: Date.now(), posts };
  return cache;
}
async function getPosts(){
  if(Date.now() - cache.at > CACHE_MS || !cache.posts.length){ try { await refresh(); } catch { /* serve stale */ } }
  return cache;
}
function peek(){
  if(Date.now() - cache.at > CACHE_MS) refresh().catch(() => {});
  return cache;
}

function score(p, now){
  const ageH = Math.max(0, (now - (p.ts || now)) / 3600000);
  const rec = Math.exp(-ageH / 30);                 // favours fresh; a big post can still win
  return (p.eng || 0) * (0.35 + 0.65 * rec) + rec * 0.001; // tiny recency tiebreak when eng==0
}
function pickNotable(opts){
  opts = opts || {};
  const now = Date.now();
  const maxAgeH = opts.maxAgeH || 48;
  const cand = (cache.posts || []).filter(p =>
    p.text && p.text.length >= 15 &&
    (now - (p.ts || 0)) / 3600000 <= maxAgeH &&
    (!opts.exclude || p.id !== opts.exclude)
  );
  if(!cand.length) return null;
  cand.sort((a, b) => score(b, now) - score(a, now));
  return cand[0];
}

module.exports = function figures(){
  refresh().catch(() => {});                          // warm cache at boot
  return { getPosts, peek, refresh, pickNotable, score, FIGURES };
};
