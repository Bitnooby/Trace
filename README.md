# Trace — evidence, not verdicts

A tool for checking whether an image is real. It reads what the file reveals,
shows the evidence + the reasoning, and gives a shareable result page. It does
**not** hand down a true/false verdict.

## Two parts

- **`index.html`** — the front door + result page. Runs real checks *in the browser*
  (fingerprint, metadata, Content Credentials, edit traces, AI markers). Works on its
  own with no server.
- **`server.js`** — adds the checks a browser can't do (reverse image search,
  known-fake/fact-check), stores reports, and serves shareable `/check/:id` pages
  that unfurl into a card when pasted on social. It also serves `index.html`, so the
  whole thing is one deploy.

## Run it

```bash
npm install
npm start            # → http://localhost:8080
```

Then, in `index.html`, set:

```js
const TRACE_SERVER = "http://localhost:8080";   // (or your deployed URL)
```

With `TRACE_SERVER = ""` it stays in standalone (browser-only) mode.

## The two keys (both optional)

The web checks light up when you provide API keys. Without them, those rows say
"not configured" — never faked.

```bash
SERPAPI_KEY=xxxx   FACTCHECK_KEY=yyyy   npm start
```

- `SERPAPI_KEY` — reverse image search via Google Lens (serpapi.com). Swap for TinEye
  (accepts direct uploads) or Bing Visual Search if you prefer.
- `FACTCHECK_KEY` — Google Fact Check Tools API (free; Google Cloud key).

## Deploy

Push to any Node host (Render, Railway, Fly, a VPS). Set the two env vars there,
point `TRACE_SERVER` at the deployed URL.

## Prototype → production (swap before real traffic)

- Reports and images are kept **in memory** and reset on restart →
  swap `store` for Redis/Postgres and `imgStore` for object storage.
- Add a rate limit and keep the upload size cap.
- For real shareable links that persist, the DB swap above is the only requirement.

## The honest line on what this can and can't do

It checks **provenance** (tractable) — it does not adjudicate **truth** (mostly not).
Missing metadata doesn't prove a fake; present metadata can be forged. The tool's job
is to assemble evidence transparently so a motivated person decides — not to be an oracle.
