'use strict';
/* Relity news-card image generator.
   Renders the daily top-corroborated story as a branded 1080x1080 PNG
   (Instagram needs an image per post). SVG -> PNG via @resvg/resvg-js,
   using bundled Poppins (OFL). */
const fs = require('fs');
const path = require('path');
let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { /* optional; callers guard via available() */ }
let jpegjs = null;
try { jpegjs = require('jpeg-js'); } catch (e) { /* optional */ }

const FONT_FILES = [
  path.join(__dirname, 'fonts', 'Poppins-700.ttf'),
  path.join(__dirname, 'fonts', 'Poppins-500.ttf'),
].filter(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
const F_BOLD = 'Poppins';
const F_MED  = 'Poppins Medium';

function esc(s){ return String(s==null?'':s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }

function wrap(t, cpl, maxLines){
  const words = String(t||'').trim().split(/\s+/).filter(Boolean);
  const lines=[]; let cur='';
  for(const w of words){
    const test = cur ? cur+' '+w : w;
    if(test.length > cpl && cur){ lines.push(cur); cur=w; } else cur=test;
  }
  if(cur) lines.push(cur);
  if(lines.length > maxLines){
    lines.length = maxLines;
    lines[maxLines-1] = lines[maxLines-1].replace(/[\s.,;:’'"-]+$/,'') + '…';
  }
  return lines;
}

function fitHeadline(title){
  let t = String(title||'').trim();
  if(t.length > 150) t = t.slice(0,148).replace(/\s+\S*$/,'') + '…';
  const L = t.length;
  let size;
  if(L<=38) size=72; else if(L<=62) size=62; else if(L<=90) size=54; else if(L<=118) size=48; else size=44;
  const usable = 1080 - 160;
  const cpl = Math.max(10, Math.floor(usable / (size*0.60)));
  return { size, lines: wrap(t, cpl, 5) };
}

function glyph(x,y,s){
  const k = s/100;
  return `<g transform="translate(${x},${y}) scale(${k})">
    <rect width="100" height="100" rx="24" fill="url(#lg)"/>
    <g transform="translate(50 50) scale(0.74) translate(-50 -50)" stroke="#fff" stroke-width="7" stroke-linecap="round" fill="none">
      <line x1="32" y1="34" x2="50" y2="52"/><line x1="50" y1="52" x2="70" y2="36"/><line x1="50" y1="52" x2="52" y2="78"/>
      <circle cx="50" cy="52" r="13"/></g>
    <g fill="#fff"><circle cx="32" cy="34" r="7.5"/><circle cx="70" cy="36" r="7.5"/><circle cx="52" cy="78" r="7.5"/><circle cx="50" cy="52" r="4.5"/></g>
  </g>`;
}

function buildSvg({ title, n, cat }){
  const { size, lines } = fitHeadline(title);
  const lh = Math.round(size*1.16);
  const headSpan = (lines.length-1)*lh;
  const corrobGap = 96;
  const totalH = headSpan + corrobGap;
  const center = 568;
  let y0 = Math.round(center - totalH/2);
  if(y0 < 384) y0 = 384;
  const lastBaseline = y0 + headSpan;
  const ruleY = lastBaseline + 50;
  const corrobY = lastBaseline + corrobGap + 18;
  const headLines = lines.map((ln,i)=>`<text x="80" y="${y0 + i*lh}" font-family="${F_BOLD}" font-weight="700" font-size="${size}" fill="#FFFFFF">${esc(ln)}</text>`).join('\n  ');
  const catLabel = (cat||'').toUpperCase();
  const nWord = n>=2 ? n : 'a';
  return `<svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0B6E6E"/><stop offset="1" stop-color="#13A8A8"/></linearGradient>
    <radialGradient id="glow" cx="0.16" cy="0.10" r="0.95"><stop offset="0" stop-color="#13A8A8" stop-opacity="0.30"/><stop offset="0.55" stop-color="#0C1A1A" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1080" height="1080" fill="#0C1A1A"/>
  <rect width="1080" height="1080" fill="url(#glow)"/>
  ${glyph(80,78,64)}
  <text x="172" y="120" font-family="${F_BOLD}" font-weight="700" font-size="33" fill="#FFFFFF" letter-spacing="5">RELITY</text>
  <text x="174" y="150" font-family="${F_MED}" font-weight="500" font-size="14" fill="#5FB8B8" letter-spacing="2">EVIDENCE, NOT VERDICTS</text>
  ${catLabel ? `<text x="1000" y="116" text-anchor="end" font-family="${F_MED}" font-weight="500" font-size="17" fill="#5FB8B8" letter-spacing="2">${esc(catLabel)}</text>` : ''}
  <rect x="80" y="196" width="920" height="2" fill="#1E3A3A"/>
  ${headLines}
  <rect x="80" y="${ruleY}" width="66" height="5" rx="2.5" fill="#13A8A8"/>
  <text x="80" y="${corrobY}" font-family="${F_MED}" font-weight="500" font-size="26" fill="#9FD8D8">Reported by <tspan font-family="${F_BOLD}" font-weight="700" fill="#FFFFFF">${nWord}</tspan> independent newsrooms right now —</text>
  <text x="80" y="${corrobY+38}" font-family="${F_MED}" font-weight="500" font-size="26" fill="#9FD8D8">corroborated, not just viral.</text>
  <rect x="80" y="950" width="920" height="2" fill="#1E3A3A"/>
  <text x="80" y="1002" font-family="${F_MED}" font-weight="500" font-size="21" fill="#6FA0A0">What's confirmed vs what's just loud</text>
  <text x="1000" y="1002" text-anchor="end" font-family="${F_BOLD}" font-weight="700" font-size="21" fill="#FFFFFF">relity.ai/feed</text>
</svg>`;
}

function buildFigureSvg({ handle, name, platform, text, date }){
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const L = t.length;
  let size;
  if(L<=110) size=50; else if(L<=220) size=42; else if(L<=380) size=36; else if(L<=560) size=31; else size=27;
  const usable = 1080 - 124 - 80;
  const cpl = Math.max(12, Math.floor(usable / (size*0.56)));
  const lh = Math.round(size*1.34);
  const maxLines = Math.max(3, Math.floor(560 / lh));
  const lines = wrap(t, cpl, maxLines);
  const headSpan = (lines.length-1)*lh;
  const attrGap = 82;
  const totalH = headSpan + attrGap;
  let y0 = Math.round(552 - totalH/2);
  if(y0 < 300) y0 = 300;
  let lastBaseline = y0 + headSpan;
  let attrY = lastBaseline + attrGap;
  if(attrY > 926){ const shift = attrY - 926; y0 = Math.max(292, y0 - shift); lastBaseline = y0 + headSpan; attrY = lastBaseline + attrGap; }
  const barTop = y0 - size + 10;
  const barH = Math.max(20, (lastBaseline + 8) - barTop);
  const quote = lines.map((ln,i)=>`<text x="124" y="${y0 + i*lh}" font-family="${F_MED}" font-weight="500" font-size="${size}" fill="#F4FAFA">${esc(ln)}</text>`).join('\n  ');
  return `<svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0B6E6E"/><stop offset="1" stop-color="#13A8A8"/></linearGradient>
    <radialGradient id="glow" cx="0.16" cy="0.10" r="0.95"><stop offset="0" stop-color="#13A8A8" stop-opacity="0.30"/><stop offset="0.55" stop-color="#0C1A1A" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1080" height="1080" fill="#0C1A1A"/>
  <rect width="1080" height="1080" fill="url(#glow)"/>
  ${glyph(80,76,60)}
  <text x="168" y="113" font-family="${F_BOLD}" font-weight="700" font-size="30" fill="#FFFFFF" letter-spacing="4">RELITY</text>
  <text x="170" y="143" font-family="${F_MED}" font-weight="500" font-size="14" fill="#5FB8B8" letter-spacing="2">ON THE RECORD</text>
  <text x="1000" y="112" text-anchor="end" font-family="${F_MED}" font-weight="500" font-size="17" fill="#5FB8B8" letter-spacing="2">${esc(String(platform||'').toUpperCase())}</text>
  <rect x="80" y="192" width="920" height="2" fill="#1E3A3A"/>
  <rect x="84" y="${barTop}" width="6" height="${barH}" rx="3" fill="#13A8A8"/>
  ${quote}
  <text x="124" y="${attrY}" font-family="${F_BOLD}" font-weight="700" font-size="25" fill="#FFFFFF">— ${esc(String(name||''))} <tspan font-family="${F_MED}" font-weight="500" fill="#9FD8D8">· ${esc(String(date||''))}</tspan></text>
  <rect x="80" y="950" width="920" height="2" fill="#1E3A3A"/>
  <text x="80" y="1002" font-family="${F_MED}" font-weight="500" font-size="20" fill="#6FA0A0">Primary source, unedited — original linked</text>
  <text x="1000" y="1002" text-anchor="end" font-family="${F_BOLD}" font-weight="700" font-size="21" fill="#FFFFFF">relity.ai</text>
</svg>`;
}

function _toJpeg(svg){
  if(!Resvg || !jpegjs) throw new Error('image renderer unavailable (@resvg/resvg-js or jpeg-js missing)');
  const img = new Resvg(svg, { background:'#0C1A1A', font:{ loadSystemFonts:false, fontFiles: FONT_FILES, defaultFontFamily:'Poppins' }, fitTo:{ mode:'width', value:1080 } }).render();
  return jpegjs.encode({ data: Buffer.from(img.pixels), width: img.width, height: img.height }, 90).data;
}

function renderCard(pick){
  return _toJpeg(buildSvg({ title: pick && pick.title, n: (pick && pick.n) || 0, cat: (pick && pick.cat) || '' }));
}

function renderFigureCard(post){
  return _toJpeg(buildFigureSvg({ handle: post && post.handle, name: (post && (post.name || post.figure)) || '', platform: (post && post.platform) || '', text: (post && post.text) || '', date: (post && post.date) || '' }));
}

module.exports = { renderCard, renderFigureCard, buildSvg, buildFigureSvg, available: ()=>!!(Resvg && jpegjs) };
