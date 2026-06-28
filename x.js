'use strict';
// Relity → X (Twitter) auto-post. OAuth 1.0a user-context signing, posts via API v2.
// Credentials come from env (never hard-coded). Posting your own brand content is standard
// scheduled posting — not an automated reply/spam bot.
const crypto = require('crypto');

const KEY = process.env.X_API_KEY || '';
const SECRET = process.env.X_API_SECRET || '';
const TOKEN = process.env.X_ACCESS_TOKEN || '';
const TOKEN_SECRET = process.env.X_ACCESS_SECRET || '';

function configured(){ return !!(KEY && SECRET && TOKEN && TOKEN_SECRET); }

// RFC 3986 percent-encoding (stricter than encodeURIComponent)
function penc(s){
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Build the OAuth 1.0a Authorization header. extraParams = query/body form params to include
// in the signature base string. For a v2 JSON POST, pass {} (the JSON body is NOT signed).
function oauthHeader(method, url, extraParams, creds){
  creds = creds || { key:KEY, secret:SECRET, token:TOKEN, tokenSecret:TOKEN_SECRET };
  const oauth = {
    oauth_consumer_key: creds.key,
    oauth_nonce: creds.nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(creds.timestamp || Math.floor(Date.now()/1000)),
    oauth_token: creds.token,
    oauth_version: '1.0'
  };
  const all = Object.assign({}, extraParams || {}, oauth);
  const paramString = Object.keys(all).sort().map(k => penc(k) + '=' + penc(all[k])).join('&');
  const baseString = method.toUpperCase() + '&' + penc(url) + '&' + penc(paramString);
  const signingKey = penc(creds.secret) + '&' + penc(creds.tokenSecret);
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauth.oauth_signature = signature;
  const header = 'OAuth ' + Object.keys(oauth).sort().map(k => penc(k) + '="' + penc(oauth[k]) + '"').join(', ');
  return { header, baseString, signature };
}

async function postTweet(text){
  if(!configured()) return { ok:false, error:'X API not configured (set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).' };
  const url = 'https://api.twitter.com/2/tweets';
  const { header } = oauthHeader('POST', url, {}, null); // JSON body is not part of the signature
  try{
    const r = await fetch(url, {
      method:'POST',
      headers:{ 'Authorization': header, 'Content-Type':'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 280) }),
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json().catch(()=>({}));
    if(r.ok && j && j.data) return { ok:true, id:j.data.id };
    return { ok:false, error:(j && (j.detail||j.title||(j.errors&&JSON.stringify(j.errors))))||('HTTP '+r.status) };
  }catch(e){ return { ok:false, error:e.message }; }
}

module.exports = { configured, postTweet, oauthHeader, penc };
