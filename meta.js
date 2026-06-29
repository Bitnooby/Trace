'use strict';
// Relity → Meta auto-post. Facebook Page (Graph API) + Threads (Threads API).
// Both use access-token auth (no OAuth 1.0a signing). Tokens come from env, never hard-coded.
// Posting your own brand content on a schedule is standard — not an automated reply/spam bot.

const FB_VER       = process.env.FB_API_VERSION || 'v21.0';
const FB_PAGE_ID   = process.env.FB_PAGE_ID || '';
const FB_PAGE_TOKEN= process.env.FB_PAGE_TOKEN || '';
const TH_USER_ID   = process.env.THREADS_USER_ID || '';
const TH_TOKEN     = process.env.THREADS_TOKEN || '';
const IG_USER_ID   = process.env.IG_USER_ID || '';
const IG_TOKEN     = process.env.IG_TOKEN || '';

function fbConfigured(){ return !!(FB_PAGE_ID && FB_PAGE_TOKEN); }
function thConfigured(){ return !!(TH_USER_ID && TH_TOKEN); }
function igConfigured(){ return !!(IG_USER_ID && (IG_TOKEN || FB_PAGE_TOKEN)); }

// ---- Facebook Page: POST /{page-id}/feed (message + link) ----
async function postFacebook(message, link){
  if(!fbConfigured()) return { ok:false, error:'Facebook not configured (set FB_PAGE_ID, FB_PAGE_TOKEN).' };
  try{
    const body = new URLSearchParams({ message: String(message).slice(0, 5000), access_token: FB_PAGE_TOKEN });
    if(link) body.set('link', link);
    const r = await fetch(`https://graph.facebook.com/${FB_VER}/${encodeURIComponent(FB_PAGE_ID)}/feed`, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString(), signal: AbortSignal.timeout(12000)
    });
    const j = await r.json().catch(()=>({}));
    if(r.ok && j && j.id) return { ok:true, id:j.id };
    return { ok:false, error:(j && j.error && j.error.message) || ('HTTP '+r.status) };
  }catch(e){ return { ok:false, error:e.message }; }
}

// ---- Threads: 2-step — create a TEXT container, then publish it ----
async function postThreads(text){
  if(!thConfigured()) return { ok:false, error:'Threads not configured (set THREADS_USER_ID, THREADS_TOKEN).' };
  const base = `https://graph.threads.net/v1.0/${encodeURIComponent(TH_USER_ID)}`;
  try{
    const c = new URLSearchParams({ media_type:'TEXT', text:String(text).slice(0, 500), access_token: TH_TOKEN });
    let r = await fetch(`${base}/threads`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:c.toString(), signal: AbortSignal.timeout(12000) });
    let j = await r.json().catch(()=>({}));
    if(!r.ok || !j || !j.id) return { ok:false, error:(j && j.error && j.error.message) || ('container HTTP '+r.status) };
    const creationId = j.id;
    await new Promise(res => setTimeout(res, 1500)); // brief settle before publish
    const p = new URLSearchParams({ creation_id: creationId, access_token: TH_TOKEN });
    r = await fetch(`${base}/threads_publish`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:p.toString(), signal: AbortSignal.timeout(12000) });
    j = await r.json().catch(()=>({}));
    if(r.ok && j && j.id) return { ok:true, id:j.id };
    return { ok:false, error:(j && j.error && j.error.message) || ('publish HTTP '+r.status) };
  }catch(e){ return { ok:false, error:e.message }; }
}


// ---- Instagram: 2-step Content Publishing (image_url must be public; JPEG) ----
async function postInstagram(caption, imageUrl){
  const token = IG_TOKEN || FB_PAGE_TOKEN;
  if(!IG_USER_ID || !token) return { ok:false, error:'Instagram not configured (set IG_USER_ID and IG_TOKEN).' };
  if(!imageUrl) return { ok:false, error:'no image_url for Instagram post' };
  const base = `https://graph.facebook.com/${FB_VER}/${encodeURIComponent(IG_USER_ID)}`;
  try{
    const c = new URLSearchParams({ image_url:imageUrl, caption:String(caption||'').slice(0,2200), access_token:token });
    let r = await fetch(`${base}/media`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:c.toString(), signal: AbortSignal.timeout(15000) });
    let j = await r.json().catch(()=>({}));
    if(!r.ok || !j || !j.id) return { ok:false, error:(j && j.error && j.error.message) || ('container HTTP '+r.status) };
    const creationId = j.id;
    for(let i=0;i<6;i++){
      await new Promise(s=>setTimeout(s, 2000));
      try{
        const sres = await fetch(`${base}/${encodeURIComponent(creationId)}?fields=status_code&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(10000) });
        const sj = await sres.json().catch(()=>({}));
        if(sj && sj.status_code==='FINISHED') break;
        if(sj && sj.status_code==='ERROR') return { ok:false, error:'media processing failed' };
      }catch(e){}
    }
    const p = new URLSearchParams({ creation_id:creationId, access_token:token });
    r = await fetch(`${base}/media_publish`, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:p.toString(), signal: AbortSignal.timeout(15000) });
    j = await r.json().catch(()=>({}));
    if(r.ok && j && j.id) return { ok:true, id:j.id };
    return { ok:false, error:(j && j.error && j.error.message) || ('publish HTTP '+r.status) };
  }catch(e){ return { ok:false, error:e.message }; }
}

module.exports = { fbConfigured, postFacebook, thConfigured, postThreads, igConfigured, postInstagram };
