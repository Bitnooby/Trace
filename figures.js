'use strict';
/* figures.js — primary-source posts from key public figures, across the spectrum.
   Verbatim, with the original linked (the receipt). No sides — a verified statement from everyone.
     Trump    (Truth Social) -> CNN JSON archive (+ trumpstruth.org RSS fallback)   [free]
     AOC      (X)            -> X API v2 user timeline                               [paid: Basic tier]
     Araghchi (X)            -> X API v2 user timeline                               [paid: Basic tier]
   X reads are throttled (X_POLL_MS) + capped (max_results) to respect the monthly read quota.
   Bearer auto-derives from X_API_KEY/X_API_SECRET — no extra secret needed. */

const FIGURES = [
  { id:'trump',    name:'Donald J. Trump',          handle:'@realDonaldTrump', platform:'Truth Social',
    json:'https://ix.cnn.io/data/truth-social/truth_archive.json', rss:'https://trumpstruth.org/feed' },
  { id:'aoc',      name:'Alexandria Ocasio-Cortez', handle:'@aoc.bsky.social', platform:'Bluesky', bsky:'aoc.bsky.social' },
  { id:'araghchi', name:'Abbas Araghchi',           handle:'@araghchi',  platform:'X', x:'araghchi' }
];

const UA = { 'User-Agent': 'RelityRadar/1.0 (+https://relity.ai)' };
const CACHE_MS = 5 * 60 * 1000;
const X_POLL_MS = parseInt(process.env.FIGURE_X_POLL_MIN || '60', 10) * 60000;
const X_MAX = Math.max(5, Math.min(100, parseInt(process.env.FIGURE_X_MAX || '5', 10)));
let cache = { at: 0, posts: [] };
let _xCache = { at: 0, posts: [] };

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
function isSubstantive(t){
  t = (t || '').trim();
  if(t.length < 15) return false;
  if(/^RT[:\s@]/i.test(t)) return false;
  if(/^https?:\/\/\S+$/i.test(t)) return false;
  const words = t.replace(/https?:\/\/\S+/g, ' ').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  return words.length >= 4;
}

async function fetchJson(fig){
  const r = await fetch(fig.json, { headers: UA, signal: AbortSignal.timeout(9000) });
  if(!r.ok) throw new Error('json HTTP ' + r.status);
  const arr = await r.json();
  return (Array.isArray(arr) ? arr : []).map(p => ({
    figId: fig.id, figure: fig.name, handle: fig.handle, platform: fig.platform,
    id: String(p.id || ''), text: clean(p.content || ''), url: p.url || '',
    ts: Date.parse(p.created_at) || 0, media: Array.isArray(p.media) ? p.media : [],
    eng: (p.favourites_count || 0) + (p.reblogs_count || 0) + (p.replies_count || 0)
  })).filter(p => p.id && p.url);
}
function parseRss(xml, fig){
  const out = [];
  for(const raw of xml.split(/<item[\s>]/i).slice(1)){
    const block = raw.split(/<\/item>/i)[0];
    const g = n => { const x = block.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return x ? x[1] : ''; };
    let link = clean(g('link')); if(!link){ const h = block.match(/<link[^>]*href=["']([^"']+)["']/i); if(h) link = h[1]; }
    const text = clean(g('description') || g('content:encoded') || g('title'));
    const date = clean(g('pubDate') || g('published') || g('dc:date'));
    if(text && link) out.push({ figId: fig.id, figure: fig.name, handle: fig.handle, platform: fig.platform, id: link, text, url: link, ts: Date.parse(date) || 0, media: [], eng: 0 });
  }
  return out;
}
async function fetchBluesky(fig){
  const url = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=' + encodeURIComponent(fig.bsky) + '&limit=40&filter=posts_no_replies';
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(9000) });
  if(!r.ok) throw new Error('bsky HTTP ' + r.status);
  const j = await r.json();
  const out = [];
  for(const item of (j.feed || [])){
    if(item.reason) continue;
    const p = item.post; if(!p || !p.record) continue;
    if(p.author && p.author.handle !== fig.bsky) continue;
    if(p.record.reply) continue;
    const rkey = String(p.uri || '').split('/').pop();
    out.push({ figId: fig.id, figure: fig.name, handle: fig.handle, platform: fig.platform,
      id: p.uri, text: clean(p.record.text || ''),
      url: rkey ? ('https://bsky.app/profile/' + fig.bsky + '/post/' + rkey) : (p.uri || ''),
      ts: Date.parse(p.record.createdAt) || 0, media: [],
      eng: (p.likeCount || 0) + (p.repostCount || 0) + (p.replyCount || 0) });
  }
  return out;
}

let _bearer = null, _bearerAt = 0; const _xid = {};
async function xBearer(){
  if(_bearer && Date.now() - _bearerAt < 3 * 3600000) return _bearer;
  const key = process.env.X_API_KEY || '', sec = process.env.X_API_SECRET || '';
  if(!key || !sec) return null;
  const basic = Buffer.from(encodeURIComponent(key) + ':' + encodeURIComponent(sec)).toString('base64');
  const r = await fetch('https://api.twitter.com/oauth2/token', { method:'POST',
    headers:{ 'Authorization':'Basic ' + basic, 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
    body:'grant_type=client_credentials', signal: AbortSignal.timeout(9000) });
  const j = await r.json().catch(() => ({}));
  if(j && j.access_token){ _bearer = j.access_token; _bearerAt = Date.now(); return _bearer; }
  return null;
}
async function xUserId(bearer, username){
  if(_xid[username]) return _xid[username];
  const r = await fetch('https://api.twitter.com/2/users/by/username/' + encodeURIComponent(username), { headers:{ 'Authorization':'Bearer ' + bearer }, signal: AbortSignal.timeout(9000) });
  const j = await r.json().catch(() => ({}));
  const id = j && j.data && j.data.id;
  if(id) _xid[username] = id;
  return id;
}
async function fetchX(fig){
  const bearer = await xBearer(); if(!bearer) return [];
  const id = fig.xid || await xUserId(bearer, fig.x); if(!id) return [];
  const url = 'https://api.twitter.com/2/users/' + id + '/tweets?max_results=' + X_MAX + '&exclude=retweets,replies&tweet.fields=created_at,public_metrics';
  const r = await fetch(url, { headers:{ 'Authorization':'Bearer ' + bearer }, signal: AbortSignal.timeout(9000) });
  if(!r.ok) throw new Error('x read HTTP ' + r.status);
  const j = await r.json();
  return (j.data || []).map(t => {
    const m = t.public_metrics || {};
    return { figId: fig.id, figure: fig.name, handle: fig.handle, platform: fig.platform,
      id: t.id, text: clean(t.text || ''), url: 'https://x.com/' + fig.x + '/status/' + t.id,
      ts: Date.parse(t.created_at) || 0, media: [],
      eng: (m.like_count||0) + (m.retweet_count||0) + (m.reply_count||0) + (m.quote_count||0) };
  }).filter(p => p.id && p.text);
}
async function fetchXAll(){
  const xfigs = FIGURES.filter(f => f.x);
  if(!xfigs.length) return [];
  if(_xCache.at && Date.now() - _xCache.at < X_POLL_MS) return _xCache.posts;
  try{
    const res = (await Promise.all(xfigs.map(f => fetchX(f).catch(() => [])))).flat();
    _xCache = { at: Date.now(), posts: res };
  }catch(e){ _xCache.at = Date.now(); }
  return _xCache.posts;
}

async function fetchFigure(fig){
  if(fig.bsky){ try { return await fetchBluesky(fig); } catch(e){ return []; } }
  if(fig.json){ try { const a = await fetchJson(fig); if(a.length) return a; } catch(e){ /* fall through */ } }
  if(fig.rss){ try { const r = await fetch(fig.rss, { headers: UA, signal: AbortSignal.timeout(9000) }); if(r.ok) return parseRss(await r.text(), fig); } catch(e){} }
  return [];
}

async function refresh(){
  const nonX = FIGURES.filter(f => !f.x);
  const a = (await Promise.all(nonX.map(fetchFigure))).flat();
  const b = await fetchXAll();
  const seen = new Set(), posts = [];
  for(const p of a.concat(b).sort((x, y) => y.ts - x.ts)){ if(p.id && !seen.has(p.id) && isSubstantive(p.text)){ seen.add(p.id); posts.push(p); } }
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
  const rec = Math.exp(-ageH / 30);
  return (p.eng || 0) * (0.35 + 0.65 * rec) + rec * 0.001;
}
function pickNotable(opts){
  opts = opts || {};
  const now = Date.now();
  const maxAgeH = opts.maxAgeH || 48;
  const cand = (cache.posts || []).filter(p =>
    p.text && p.text.length >= 15 &&
    (!opts.figId || p.figId === opts.figId) &&
    (now - (p.ts || 0)) / 3600000 <= maxAgeH &&
    (!opts.exclude || p.id !== opts.exclude));
  if(!cand.length) return null;
  cand.sort((a, b) => score(b, now) - score(a, now));
  return cand[0];
}

module.exports = function figures(){
  refresh().catch(() => {});
  return { getPosts, peek, refresh, pickNotable, score, FIGURES };
};
