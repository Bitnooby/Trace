// news.js — corroborated news feed
// Ingest reputable RSS, cluster headlines by shared story, score by how many
// INDEPENDENT outlets carry it. Corroboration = breadth of reporting, NOT proof of truth.
// Pure RSS — no SerpAPI, no AI — so it is free to run.

const FEEDS = [
  { outlet: 'BBC',      cat: 'world',    url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { outlet: 'BBC',      cat: 'tech',     url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
  { outlet: 'BBC',      cat: 'business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { outlet: 'BBC',      cat: 'science',  url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
  { outlet: 'Sky News', cat: 'world',    url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  { outlet: 'Sky News', cat: 'tech',     url: 'https://feeds.skynews.com/feeds/rss/technology.xml' },
  { outlet: 'Sky News', cat: 'business', url: 'https://feeds.skynews.com/feeds/rss/business.xml' },
  { outlet: 'NPR',      cat: 'world',    url: 'https://feeds.npr.org/1004/rss.xml' },
  { outlet: 'NPR',      cat: 'tech',     url: 'https://feeds.npr.org/1019/rss.xml' },
  { outlet: 'NPR',      cat: 'business', url: 'https://feeds.npr.org/1006/rss.xml' },
  { outlet: 'NPR',      cat: 'science',  url: 'https://feeds.npr.org/1007/rss.xml' },
  { outlet: 'Guardian', cat: 'world',    url: 'https://www.theguardian.com/world/rss' },
  { outlet: 'Guardian', cat: 'tech',     url: 'https://www.theguardian.com/technology/rss' },
  { outlet: 'Guardian', cat: 'business', url: 'https://www.theguardian.com/business/rss' },
  { outlet: 'Guardian', cat: 'science',  url: 'https://www.theguardian.com/science/rss' },
  { outlet: 'Al Jazeera', cat: 'world',  url: 'https://www.aljazeera.com/xml/rss/all.xml' }
];
const OUTLETS = [...new Set(FEEDS.map(f => f.outlet))];
const CATS = ['world', 'tech', 'business', 'science'];
const STOP = new Set(('the a an and or but of to in on for at by from with as is are was were be been being it its this that these those will would could can may might has have had not no nor more most than then so what who how why when where amid over after before into out up down off new news say says said also against between during about your you they he she we i us our their his her them out back first two one three say latest').split(' '));
const CACHE_MS = 12 * 60 * 1000;
let cache = { at: 0, items: [], clusters: [] };

function decode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&#8230;|&hellip;/g, '…').replace(/&#8212;|&mdash;/g, '—').replace(/&#8211;|&ndash;/g, '–')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decode(m[1]) : '';
}
function parse(xml, outlet, cat) {
  const out = [];
  const parts = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of parts) {
    const block = raw.split(/<\/item>/i)[0];
    const title = tag(block, 'title');
    let link = tag(block, 'link');
    if (!link) { const m = block.match(/<link[^>]*href=["']([^"']+)["']/i); if (m) link = m[1]; }
    const date = tag(block, 'pubDate') || tag(block, 'dc:date') || tag(block, 'published');
    if (title && link && title.length > 10) out.push({ outlet, cat, title, link, date, ts: Date.parse(date) || 0 });
  }
  return out;
}
function toks(t) {
  return [...new Set((t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)))];
}
function cluster(items) {
  const clusters = [];
  for (const it of items) {
    it._t = toks(it.title);
    let best = null, bestScore = 1;            // require >=2 shared significant tokens
    for (const c of clusters) {
      if (c.outletSet.has(it.outlet)) continue; // same outlet won't corroborate itself into a cluster seed slot
      const shared = it._t.filter(w => c.seed.has(w)).length;
      if (shared > bestScore) { bestScore = shared; best = c; }
    }
    if (best) { best.items.push(it); best.outletSet.add(it.outlet); }
    else clusters.push({ items: [it], seed: new Set(it._t), outletSet: new Set([it.outlet]) });
  }
  for (const c of clusters) {
    c.outlets = [...c.outletSet];
    c.n = c.outlets.length;
    c.items.sort((a, b) => b.ts - a.ts);
    c.rep = c.items.reduce((a, b) => (b.title.length > a.title.length ? b : a), c.items[0]);
    c.ts = Math.max.apply(null, c.items.map(i => i.ts || 0));
    c.cat = c.rep.cat;
  }
  clusters.sort((a, b) => b.n - a.n || b.ts - a.ts);
  return clusters;
}
async function fetchFeed(f) {
  try {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'RelityRadar/1.0 (+https://relity.ai)' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    return parse(await r.text(), f.outlet, f.cat).slice(0, 12);
  } catch { return []; }
}
async function refresh() {
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  cache = { at: Date.now(), items: all, clusters: cluster(all) };
  return cache;
}
async function getFeed() {
  if (Date.now() - cache.at > CACHE_MS || !cache.clusters.length) { try { await refresh(); } catch { /* serve stale */ } }
  return cache;
}
module.exports = function news() {
  refresh().catch(() => {});                   // warm cache at boot
  return { getFeed, refresh, parse, cluster, FEEDS, OUTLETS, CATS };
};
