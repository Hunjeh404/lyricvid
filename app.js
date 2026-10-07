// 가사 영상 만들기 — 모든 처리는 이 브라우저 안에서만 이뤄진다(파일이 밖으로 나가지 않음)
import * as MB from './lib/mediabunny.min.mjs';

let W = 2560, H = 1440;            // 화면 비율에 따라 바뀐다(짧은 변 1440)
const FPS = 30, BITRATE = 6e6;     // BITRATE 는 2560x1440 기준, 화면 넓이에 비례해 조정한다
const RATIOS = [['3:2', 2160, 1440], ['16:9', 2560, 1440], ['2:1', 2880, 1440], ['1:1', 1440, 1440], ['2:3', 1440, 2160], ['9:16', 1440, 2560], ['1:2', 1440, 2880]];
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const audio = $('#audio');

const defStyle = () => ({ fC: '#ffffff', oOn: false, oW: 4, oC: '#000000', sOn: true, sD: 3, sB: 8, sC: '#000000', gOn: false, gS: 14, gC: '#ffd27a' });
const S = {
  cues: [],            // { text, start, end }  start/end 는 초, 아직 안 찍었으면 null
  rec: 0,              // 다음에 찍을 줄 번호
  audioFile: null, dur: 0,
  bg: null, bgImg: null, bgT: { zoom: 1, dx: 0, dy: 0 },   // 배경: 화면 크기로 그려 둔 캔버스 / 원본 / 보일 부분
  bgFill: '#000000', bgFillMode: 'color',   // 배경 이미지가 화면을 다 못 채울 때 빈 곳: 단색('color') 또는 같은 그림을 흐리게('blur')
  ratio: '16:9',
  fmt: 'mov',          // 'mov' = 소리 원본 그대로 / 'mp4' = 어디서나 재생되도록 소리를 AAC로 압축
  crop: { on: false, a: 0, b: 0, from: 0, to: 0 },          // 구간 자르기: a~b초(원곡 기준)
  fx: { inType: 'none', inDur: 1.5, inDir: 'lr', outType: 'none', outDur: 2.5, outDir: 'lr', audio: false },
  eq: null,            // { meta, frames[] }
  beat: { bpm: 0, first: 0, taps: [] },
  sel: 'lyr',
  L: {
    lyr: { ax: .5, ay: 1, mx: 80, my: 120, size: 72, mode: 1, font: '', st: defStyle() },
    eq:  { ax: 0, ay: 1, mx: 60, my: 60, size: 1, st: { ...defStyle(), sOn: false } },
    ttl: { ax: 0, ay: 0, mx: 80, my: 80, size: 56, title: '', artist: '', font: '', st: defStyle() },
  },
  fonts: [],           // { family, name }
  boxes: {},
};

/* ---------- 시간 표기 ---------- */
const fmt = t => t == null ? '' : `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const parseT = s => { s = s.trim(); if (!s) return null; const p = s.split(':').map(Number); if (p.some(isNaN)) return undefined; return p.reduce((a, v) => a * 60 + v, 0); };
const srtT = t => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
const endOf = i => { const c = S.cues[i]; if (c.end != null) return c.end; for (let j = i + 1; j < S.cues.length; j++) if (S.cues[j].start != null) return S.cues[j].start; return Math.min(c.start + 6, S.dur || c.start + 6); };
const activeCue = t => S.cues.findIndex((c, i) => c.start != null && t >= c.start && t < endOf(i));

/* ---------- 화면 전환 ---------- */
let step = 1;
function go(n) {
  step = n; audio.volume = 1;
  $$('.step').forEach(b => b.classList.toggle('on', +b.dataset.step === n));
  $$('main > section').forEach(s => s.hidden = s.id !== 's' + n);
  if (n === 1) drawRec();
  if (n === 2) drawTable();
  if (n === 3) { fitStage(); loadAllFonts(); buildPanel(); }
  if (n === 4) { fitStage(); buildOut(); drawSummary(); }
}
$$('.step').forEach(b => b.onclick = () => go(+b.dataset.step));

/* ---------- 재생 막대 ---------- */
const seek = $('#seek');
$('#play').onclick = () => audio.paused ? audio.play() : audio.pause();
audio.onplay = audio.onpause = () => $('#play').classList.toggle('playing', !audio.paused);
audio.onloadedmetadata = () => { S.dur = audio.duration; seek.max = S.dur; };
seek.oninput = () => audio.currentTime = +seek.value;

$('#fAudio').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  S.audioFile = f; audio.src = URL.createObjectURL(f);
  $('#audioName').textContent = `${f.name} (${(f.size / 1048576).toFixed(1)}MB)`;
};

/* ---------- 1. 시점 기록 ---------- */
$('#applyLyrics').onclick = () => {
  const lines = $('#lyrics').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return;
  if (S.cues.some(c => c.start != null) && !confirm('이미 기록한 시점이 있습니다. 가사를 새로 적용하면 시점이 모두 지워집니다. 계속할까요?')) return;
  S.cues = lines.map(text => ({ text, start: null, end: null })); S.rec = 0; drawRec();
};
function stamp() {
  if (S.rec >= S.cues.length || !S.audioFile) return;
  const c = S.cues[S.rec]; c.start = audio.currentTime; c.end = null; S.rec++; drawRec();
}
function blank() {
  if (!S.rec) return; const c = S.cues[S.rec - 1];
  if (audio.currentTime > c.start) { c.end = audio.currentTime; drawRec(true); }
}
function undo() {
  if (!S.rec) return; S.rec--;
  const c = S.cues[S.rec]; c.start = c.end = null;
  if (S.rec) S.cues[S.rec - 1].end = null;
  audio.currentTime = S.rec ? S.cues[S.rec - 1].start : 0; drawRec();
}
function drawRec(blanked) {
  const c = S.cues, r = S.rec;
  $('#recPrev').textContent = c[r - 1] ? c[r - 1].text : '';
  $('#recNow').textContent = c[r] ? c[r].text : (c.length ? '모든 줄을 찍었습니다. 2번 화면에서 다듬으세요.' : '왼쪽에 음원과 가사를 넣고 가사 적용을 누르세요.');
  $('#recNext').textContent = c[r + 1] ? c[r + 1].text : '';
  $('#recCount').textContent = c.length ? `${r} / ${c.length}줄` + (blanked ? ' · 방금 줄을 여기서 지움' : '') : '';
}
$('#bStamp').onclick = stamp; $('#bBlank').onclick = blank; $('#bUndo').onclick = undo;

addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.code === 'Enter') { e.preventDefault(); $('#play').click(); }
  else if (step === 3 && S.sel === 'bg' && S.bgImg && e.code.startsWith('Arrow')) { e.preventDefault(); nudgeBg(e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0, e.code === 'ArrowUp' ? -1 : e.code === 'ArrowDown' ? 1 : 0); }
  else if (e.code === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 3);
  else if (e.code === 'ArrowRight') audio.currentTime += 3;
  else if (step === 1 && e.code === 'Space') { e.preventDefault(); stamp(); }
  else if (step === 1 && e.code === 'KeyX') blank();
  else if (step === 1 && e.code === 'Backspace') { e.preventDefault(); undo(); }
  else if (step === 3 && e.code === 'KeyB') tapBeat();
});

/* ---------- 2. 세부 수정 ---------- */
function drawTable() {
  const tb = $('#rows'); tb.replaceChildren();
  S.cues.forEach((c, i) => {
    const tIn = (key) => {
      const inp = el('input', { className: 't', value: fmt(key === 'end' && c.start != null && c.end == null ? null : c[key]), placeholder: key === 'end' && c.start != null ? '다음 줄까지' : '' });
      inp.onchange = () => { const v = parseT(inp.value); if (v === undefined) inp.value = fmt(c[key]); else { c[key] = v; if (key === 'start' && v == null) c.end = null; } drawTable(); };
      const nudge = d => el('button', { className: 'mini', textContent: d > 0 ? '+' : '−', title: '0.1초', onclick: () => { const base = c[key] ?? (key === 'end' && c.start != null ? endOf(i) : null); if (base == null) return; c[key] = Math.max(0, +(base + d).toFixed(3)); drawTable(); } });
      return el('td', {}, nudge(-.1), inp, nudge(.1));
    };
    const text = el('input', { className: 'txt', value: c.text }); text.onchange = () => { c.text = text.value; sprites.clear(); };
    tb.append(el('tr', { id: 'row' + i },
      el('td', { className: 'n', textContent: i + 1 }),
      el('td', {}, el('button', { className: 'mini', innerHTML: ICON.play, title: '이 줄부터 듣기', onclick: () => { if (c.start != null) { audio.currentTime = c.start; audio.play(); } } })),
      tIn('start'), tIn('end'), el('td', { className: 'grow' }, text),
      el('td', {},
        el('button', { className: 'mini wide', textContent: '여기부터 다시 찍기', onclick: () => { for (let j = i; j < S.cues.length; j++) S.cues[j].start = S.cues[j].end = null; if (i) S.cues[i - 1].end = null; S.rec = i; audio.currentTime = i ? S.cues[i - 1].start ?? 0 : 0; go(1); } }),
        el('button', { className: 'mini', innerHTML: ICON.trash, title: '줄 삭제', onclick: () => { S.cues.splice(i, 1); if (S.rec > i) S.rec--; sprites.clear(); drawTable(); } }))));
  });
}
$('#addRow').onclick = () => { S.cues.push({ text: '', start: null, end: null }); drawTable(); };
const shiftAll = d => { S.cues.forEach(c => { if (c.start != null) c.start = Math.max(0, c.start + d); if (c.end != null) c.end = Math.max(0, c.end + d); }); drawTable(); };
$('#shiftM').onclick = () => shiftAll(-.1); $('#shiftP').onclick = () => shiftAll(.1);

function makeSrt(a = 0, b = Infinity) {      // a~b 구간만, 시각은 a를 0으로 삼아 내보낸다
  const rows = S.cues.map((c, i) => ({ s: c.start, e: c.start == null ? 0 : endOf(i), text: c.text })).filter(r => r.s != null && r.text)
    .map(r => ({ ...r, s: Math.max(r.s, a), e: Math.min(r.e, b) })).filter(r => r.e - r.s > (a > 0 ? .3 : .05)).sort((x, y) => x.s - y.s);
  return rows.map((r, n) => `${n + 1}\n${srtT(r.s - a)} --> ${srtT(r.e - a)}\n${r.text}\n`).join('\n');
}
const save = (blob, name) => { const a = el('a', { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
const baseName = () => (S.audioFile ? S.audioFile.name.replace(/\.[^.]+$/, '') : 'lyrics');
$('#srtDown').onclick = () => save(new Blob([makeSrt()], { type: 'text/plain' }), baseName() + '.srt');
$('#fSrt').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const cues = [], ts = s => { const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000 : null; };
  for (const blk of (await f.text()).replace(/\r/g, '').split(/\n\s*\n/)) {
    const ls = blk.split('\n').filter(Boolean), k = ls.findIndex(l => l.includes('-->')); if (k < 0) continue;
    const [a, b] = ls[k].split('-->'); cues.push({ text: ls.slice(k + 1).join(' '), start: ts(a), end: ts(b) });
  }
  if (!cues.length) return alert('SRT에서 자막을 찾지 못했습니다.');
  // 끝 시점이 다음 줄 시작과 같으면 "다음 줄까지"로 본다
  cues.forEach((c, i) => { if (cues[i + 1] && Math.abs(cues[i + 1].start - c.end) < .002) c.end = null; });
  S.cues = cues; S.rec = cues.length; sprites.clear(); $('#lyrics').value = cues.map(c => c.text).join('\n'); drawTable(); e.target.value = '';
};

/* ---------- 글꼴 ---------- */
async function readList(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) return [];
    return (await r.text()).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { const [file, name] = l.split('|').map(s => s.trim()); return { file, name: name || file }; });
  } catch { return []; }
}
let fontsLoading = null;
function loadAllFonts() {
  return fontsLoading ??= (async () => {
    for (const [i, f] of (await readList('fonts/list.txt')).entries()) {
      const family = 'lv' + i;
      try { const ff = new FontFace(family, `url("fonts/${encodeURI(f.file)}")`); await ff.load(); document.fonts.add(ff); S.fonts.push({ family, name: f.name }); for (const k of ['lyr', 'ttl']) if (S.wantFont?.[k] === f.name) S.L[k].font = family; } catch { console.warn('글꼴을 불러오지 못함:', f.file); }
      if (!S.L.lyr.font && S.fonts[0]) S.L.lyr.font = S.L.ttl.font = S.fonts[0].family;
      sprites.clear(); if (step === 3) buildPanel();
    }
  })();
}
async function addUserFont(file) {
  const family = 'user' + Date.now();
  try { const ff = new FontFace(family, await file.arrayBuffer()); await ff.load(); document.fonts.add(ff); } catch { return alert('이 글꼴 파일은 읽을 수 없습니다. ttf, otf, woff2 파일을 넣어 주세요.'); }
  S.fonts.push({ family, name: '내 글꼴: ' + file.name.replace(/\.[^.]+$/, '') }); S.L[S.sel].font = family; sprites.clear(); buildPanel();
}

/* ---------- 그리기: 글자와 프리셋에 색·테두리·그림자·빛 입히기 ---------- */
const sprites = new Map();
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };
const mctx = mk(8, 8).getContext('2d');
const padOf = st => Math.ceil((st.oOn ? st.oW : 0) + (st.gOn ? st.gS * 2.5 : 0) + (st.sOn ? st.sD + st.sB * 2 : 0) + 4);
function finish(B, st) {     // 본체 그림 B 뒤에 빛과 그림자를 깔아 완성
  const C = mk(B.width, B.height), g = C.getContext('2d');
  if (st.gOn) { g.shadowColor = st.gC; g.shadowBlur = st.gS; g.drawImage(B, 0, 0); g.drawImage(B, 0, 0); }
  if (st.sOn) { g.shadowColor = st.sC; g.shadowBlur = st.sB; g.shadowOffsetX = g.shadowOffsetY = st.sD; g.drawImage(B, 0, 0); }
  g.shadowColor = 'transparent'; g.shadowBlur = g.shadowOffsetX = g.shadowOffsetY = 0; g.drawImage(B, 0, 0);
  return C;
}
const fontCss = (font, size) => `${size}px "${font}", "Noto Sans KR", "Malgun Gothic", sans-serif`;
function textSprite(text, font, size, st) {
  const key = [text, font, size, JSON.stringify(st)].join('\u0001');
  let s = sprites.get(key); if (s) return s;
  if (sprites.size > 400) sprites.clear();
  mctx.font = fontCss(font, size); const m = mctx.measureText(text || ' ');
  const asc = m.fontBoundingBoxAscent ?? size * .88, desc = m.fontBoundingBoxDescent ?? size * .24;
  const w = Math.ceil(m.width), h = Math.ceil(asc + desc), pad = padOf(st);
  const B = mk(w + pad * 2, h + pad * 2), g = B.getContext('2d'); g.font = fontCss(font, size);
  if (st.oOn) { g.lineJoin = 'round'; g.lineWidth = st.oW * 2; g.strokeStyle = st.oC; g.strokeText(text, pad, pad + asc); }
  g.fillStyle = st.fC; g.fillText(text, pad, pad + asc);
  s = { c: finish(B, st), pad, w, h }; sprites.set(key, s); return s;
}
function maskSprite(bmp, dw, dh, st) {   // 흰 모양(프리셋)에 색과 효과 입히기
  const pad = padOf(st), tint = col => { const t = mk(dw, dh), g = t.getContext('2d'); g.drawImage(bmp, 0, 0, dw, dh); g.globalCompositeOperation = 'source-in'; g.fillStyle = col; g.fillRect(0, 0, dw, dh); return t; };
  const B = mk(dw + pad * 2, dh + pad * 2), g = B.getContext('2d');
  if (st.oOn) { const o = tint(st.oC); for (let k = 0; k < 16; k++) g.drawImage(o, pad + Math.cos(k * Math.PI / 8) * st.oW, pad + Math.sin(k * Math.PI / 8) * st.oW); }
  g.drawImage(tint(st.fC), pad, pad);
  return { c: finish(B, st), pad, w: dw, h: dh };
}
const place = (L, w, h) => ({ x: L.ax === 0 ? L.mx : L.ax === 1 ? W - L.mx - w : (W - w) / 2, y: L.ay === 0 ? L.my : L.ay === 1 ? H - L.my - h : (H - h) / 2, w, h });
const alignX = (L, box, w) => box.x + (box.w - w) * L.ax;

function eqFrame(t) {
  const { meta, frames } = S.eq; let frac;
  if (meta.kind === 'preset') { if (!S.beat.bpm) return frames[0]; const beats = meta.beats || 4, tb = (t - S.beat.first) * S.beat.bpm / 60; frac = (((tb % beats) + beats) % beats) / beats; }
  else frac = (t % meta.loopSeconds) / meta.loopSeconds;
  return frames[Math.min(frames.length - 1, Math.floor(frac * frames.length))];
}

// 한 장면 그리기. edit=true 이면 가사가 없는 순간에도 첫 줄을 보여 줘서 꾸미기 쉽게 한다
function draw(g, t, edit) {
  const boxes = {};
  if (S.bg) g.drawImage(S.bg, 0, 0); else { g.fillStyle = '#1a1816'; g.fillRect(0, 0, W, H); }

  if (S.eq) {
    const L = S.L.eq, m = S.eq.meta, k = (H / 1080) / (m.scale || 1) * L.size;
    const dw = Math.round(m.width * k), dh = Math.round(m.height * k), b = place(L, dw, dh), f = eqFrame(t);
    if (m.kind === 'preset') { const s = maskSprite(f, dw, dh, L.st); g.drawImage(s.c, b.x - s.pad, b.y - s.pad); } else g.drawImage(f, b.x, b.y, dw, dh);
    boxes.eq = b;
  }

  const T = S.L.ttl;
  if (T.title || T.artist) {
    const a = T.title ? textSprite(T.title, T.font, T.size, T.st) : null, c = T.artist ? textSprite(T.artist, T.font, Math.round(T.size * .62), T.st) : null;
    const gap = a && c ? T.size * .12 : 0, b = place(T, Math.max(a?.w || 0, c?.w || 0), (a?.h || 0) + gap + (c?.h || 0));
    if (a) g.drawImage(a.c, alignX(T, b, a.w) - a.pad, b.y - a.pad);
    if (c) g.drawImage(c.c, alignX(T, b, c.w) - c.pad, b.y + (a?.h || 0) + gap - c.pad);
    boxes.ttl = b;
  }

  const L = S.L.lyr; let i = activeCue(t), alpha = 1;
  if (i >= 0) alpha = clamp((t - S.cues[i].start) / .15, 0, 1) * clamp((endOf(i) - t) / .15, 0, 1);
  else if (edit) i = S.cues.findIndex(c => c.text);
  if (i >= 0 && S.cues[i].text) {
    const s2 = Math.round(L.size * .72), a = textSprite(S.cues[i].text, L.font, L.size, L.st);
    const nx = L.mode === 2 && S.cues[i + 1]?.text ? textSprite(S.cues[i + 1].text, L.font, s2, L.st) : null;
    const h2 = L.mode === 2 ? textSprite('가', L.font, s2, L.st).h : 0, gap = L.mode === 2 ? L.size * .16 : 0;
    const b = place(L, Math.max(a.w, nx?.w || 0), a.h + gap + h2);
    g.globalAlpha = alpha; g.drawImage(a.c, alignX(L, b, a.w) - a.pad, b.y - a.pad);
    if (nx) { g.globalAlpha = alpha * .45; g.drawImage(nx.c, alignX(L, b, nx.w) - nx.pad, b.y + a.h + gap - nx.pad); }
    g.globalAlpha = 1; boxes.lyr = b;
  }
  return boxes;
}

/* ---------- 구간 자르기와 화면전환 ---------- */
const span = () => S.crop.on ? { a: S.crop.a, b: Math.max(S.crop.a + .5, Math.min(S.crop.b, S.dur || S.crop.b)) } : { a: 0, b: S.dur || 0 };
const ease = p => p * p * (3 - 2 * p), cosw = p => .5 - .5 * Math.cos(Math.PI * p);
const gain = (tv, dur) => cosw(S.fx.inDur > 0 ? clamp(tv / S.fx.inDur, 0, 1) : 1) * cosw(S.fx.outDur > 0 ? clamp((dur - tv) / S.fx.outDur, 0, 1) : 1);
// src 장면을 e(0=안 보임, 1=다 보임)만큼 드러내 g에 그린다. closing 은 끝 전환
function applyFx(g, src, type, e, dir, closing) {
  g.save(); g.fillStyle = type === 'white' ? '#fff' : '#000'; g.fillRect(0, 0, W, H);
  if (type === 'black' || type === 'white') { g.globalAlpha = e; g.drawImage(src, 0, 0); }
  else if (type === 'blur') { const s = 1 + .08 * (1 - e); g.globalAlpha = Math.min(1, e * 1.6); g.filter = `blur(${((1 - e) * 48).toFixed(1)}px)`; g.drawImage(src, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s); }
  else if (type === 'zoom') { const s = 1 + .14 * (1 - e); g.globalAlpha = e; g.drawImage(src, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s); }
  else {      // 닦아내기와 원형: 가장자리가 부드러운 가림막으로 보일 부분만 남긴다
    const m = scratch[1], mg = m.getContext('2d'); mg.globalCompositeOperation = 'copy'; mg.drawImage(src, 0, 0); mg.globalCompositeOperation = 'destination-in';
    let grad;
    if (type === 'iris') { const R = Math.hypot(W, H) / 2 * 1.1, r = e * R; grad = mg.createRadialGradient(W / 2, H / 2, Math.max(0, r - R * .09), W / 2, H / 2, r + .01); }
    else {
      const horiz = dir === 'lr' || dir === 'rl', rev = dir === 'rl' || dir === 'bt', Lg = horiz ? W : H, F = Lg * .12;
      const o = closing ? (1 - e) * (Lg + F) : e * (Lg + F) - F, t = closing ? (1 - e) * (Lg + F) - F : e * (Lg + F), X = u => rev ? Lg - u : u;
      grad = horiz ? mg.createLinearGradient(X(o), 0, X(t), 0) : mg.createLinearGradient(0, X(o), 0, X(t));
    }
    grad.addColorStop(0, '#000'); grad.addColorStop(1, 'rgba(0,0,0,0)'); mg.fillStyle = grad; mg.fillRect(0, 0, W, H); mg.globalCompositeOperation = 'source-over';
    g.drawImage(m, 0, 0);
  }
  g.restore();
}
function frame(g, tv, dur) {      // 완성 영상의 tv초 장면(구간과 전환 반영)
  const f = S.fx, { a } = span();
  const pi = f.inType !== 'none' && f.inDur > 0 ? clamp(tv / f.inDur, 0, 1) : 1, po = f.outType !== 'none' && f.outDur > 0 ? clamp((dur - tv) / f.outDur, 0, 1) : 1;
  if (pi >= 1 && po >= 1) return draw(g, a + tv, false);
  draw(scratch[0].getContext('2d'), a + tv, false);
  if (pi < 1) applyFx(g, scratch[0], f.inType, ease(pi), f.inDir, false); else applyFx(g, scratch[0], f.outType, ease(po), f.outDir, true);
}
function fadePcm(u8, w, off, total, fi, fo) {     // 전환 구간의 소리 크기만 서서히 조절한다(그 밖은 원본 그대로)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), bps = w.bits / 8, n = u8.byteLength / w.bpf;
  for (let i = 0; i < n; i++) {
    const k = off + i, pi = fi ? Math.min(1, k / fi) : 1, po = fo ? Math.min(1, (total - 1 - k) / fo) : 1; if (pi >= 1 && po >= 1) continue;
    const gn = cosw(pi) * cosw(po);
    for (let c = 0; c < w.ch; c++) {
      const p = i * w.bpf + c * bps;
      if (w.tag === 3) bps === 4 ? dv.setFloat32(p, dv.getFloat32(p, true) * gn, true) : dv.setFloat64(p, dv.getFloat64(p, true) * gn, true);
      else if (bps === 1) dv.setUint8(p, Math.round((dv.getUint8(p) - 128) * gn) + 128);
      else if (bps === 2) dv.setInt16(p, Math.round(dv.getInt16(p, true) * gn), true);
      else if (bps === 3) { const v = Math.round((dv.getUint8(p) | dv.getUint8(p + 1) << 8 | dv.getInt8(p + 2) << 16) * gn); dv.setUint8(p, v & 255); dv.setUint8(p + 1, v >> 8 & 255); dv.setUint8(p + 2, v >> 16 & 255); }
      else dv.setInt32(p, Math.round(dv.getInt32(p, true) * gn), true);
    }
  }
  return u8;
}

/* ---------- 3. 꾸미기와 배치 ---------- */
const cv = $('#cv'), cg = cv.getContext('2d'), stage = $('#stage'), selbox = $('#selbox'), pv = $('#pv'), pg = pv.getContext('2d');
let scratch = [mk(W, H), mk(W, H)];
function rebuildBg() {       // 배경 다시 그리기. zoom 1 = 화면을 꽉 채우는 크기, dx·dy = 가운데에서 벗어난 픽셀
  const bmp = S.bgImg; if (!bmp) { S.bg = null; return; }
  const T = S.bgT, k = Math.max(W / bmp.width, H / bmp.height) * T.zoom, dw = bmp.width * k, dh = bmp.height * k;
  const c = mk(W, H), g = c.getContext('2d'); g.fillStyle = S.bgFillMode === 'blur' ? '#000' : S.bgFill; g.fillRect(0, 0, W, H);
  if (S.bgFillMode === 'blur') {      // 같은 그림을 화면보다 조금 크게 키워 흐리게 깔고 살짝 어둡게 한다
    const kc = Math.max(W / bmp.width, H / bmp.height) * 1.18, cw = bmp.width * kc, ch = bmp.height * kc;
    g.filter = 'blur(48px)'; g.drawImage(bmp, (W - cw) / 2, (H - ch) / 2, cw, ch); g.filter = 'none'; g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, 0, W, H);
  }
  g.imageSmoothingQuality = 'high'; g.drawImage(bmp, (W - dw) / 2 + T.dx, (H - dh) / 2 + T.dy, dw, dh); S.bg = c;
}
function nudgeBg(dx, dy) { if (!S.bgImg) return; S.bgT.dx = Math.round(S.bgT.dx) + dx; S.bgT.dy = Math.round(S.bgT.dy) + dy; rebuildBg(); if ($('#bgX')) { $('#bgX').value = S.bgT.dx; $('#bgY').value = S.bgT.dy; } }
function fitStage() { stage.style.width = `min(100%, calc(72vh * ${W} / ${H}))`; $('#pvwrap').style.width = `min(100%, calc(56vh * ${W} / ${H}))`; }
function setRatio(name) {
  const r = RATIOS.find(x => x[0] === name); S.ratio = name; W = r[1]; H = r[2];
  for (const c of [cv, pv]) { c.width = W; c.height = H; } scratch = [mk(W, H), mk(W, H)]; rebuildBg(); fitStage();
}
$('#fBg').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  S.bgImg = await createImageBitmap(f); S.bgT = { zoom: 1, dx: 0, dy: 0 }; rebuildBg();
  $('#bgName').textContent = `${f.name} (${S.bgImg.width}x${S.bgImg.height})`; if (S.sel === 'bg') buildPanel();
};

async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out = new Map(); let p = buf.byteLength - 22;
  while (p >= 0 && dv.getUint32(p, true) !== 0x06054b50) p--;
  if (p < 0) throw new Error('zip 파일이 아닙니다');
  let n = dv.getUint16(p + 10, true), q = dv.getUint32(p + 16, true);
  while (n--) {
    const method = dv.getUint16(q + 10, true), size = dv.getUint32(q + 20, true), nl = dv.getUint16(q + 28, true), xl = dv.getUint16(q + 30, true), cl = dv.getUint16(q + 32, true), lo = dv.getUint32(q + 42, true);
    const name = new TextDecoder().decode(u8.subarray(q + 46, q + 46 + nl)), ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    let data = u8.subarray(ds, ds + size);
    if (method === 8) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else if (method !== 0) throw new Error('지원하지 않는 압축 방식입니다');
    out.set(name.split('/').pop(), data); q += 46 + nl + xl + cl;
  }
  return out;
}
async function loadEq(buf, label) {
  try {
    const files = await unzip(buf); if (!files.has('meta.json')) throw new Error('이퀄라이저 파일이 아닙니다(meta.json 없음)');
    const meta = JSON.parse(new TextDecoder().decode(files.get('meta.json')));
    const names = [...files.keys()].filter(n => /\.(webp|png)$/i.test(n)).sort();
    const frames = await Promise.all(names.map(n => createImageBitmap(new Blob([files.get(n)], { type: n.endsWith('png') ? 'image/png' : 'image/webp' }))));
    if (!frames.length) throw new Error('그림이 들어 있지 않습니다');
    S.eq = { meta, frames, label }; S.sel = 'eq'; buildPanel();
  } catch (err) { alert('이퀄라이저를 불러오지 못했습니다: ' + err.message); }
}
$('#fEq').onchange = async e => { const f = e.target.files[0]; if (f) { $('#eqPreset').value = ''; S.eqFile = ''; await loadEq(await f.arrayBuffer(), f.name); } };
const presetsReady = readList('eq/list.txt').then(list => { for (const p of list) $('#eqPreset').append(el('option', { value: p.file, textContent: p.name })); });
$('#eqPreset').onchange = async e => {
  S.eqFile = e.target.value;
  if (!e.target.value) { S.eq = null; return buildPanel(); }
  const r = await fetch('eq/' + encodeURI(e.target.value)); if (!r.ok) return alert('프리셋 파일을 찾지 못했습니다.');
  $('#fEq').value = ''; await loadEq(await r.arrayBuffer(), e.target.selectedOptions[0].textContent);
};

function tapBeat() {
  if (S.eq?.meta.kind !== 'preset' || audio.paused) return;
  const b = S.beat; b.taps.push(audio.currentTime);
  if (b.taps.length >= 4) {      // 누른 시각들을 직선에 맞춰 박 간격과 첫 박 위치를 구한다
    const d = b.taps.slice(1).map((t, i) => t - b.taps[i]).sort((x, y) => x - y), med = d[d.length >> 1];
    const xs = b.taps.map(t => Math.round((t - b.taps[0]) / med)), n = xs.length, mx = xs.reduce((a, v) => a + v) / n, my = b.taps.reduce((a, v) => a + v) / n;
    const slope = xs.reduce((a, x, i) => a + (x - mx) * (b.taps[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    b.bpm = +(60 / slope).toFixed(2); b.first = +(my - slope * mx).toFixed(3);
  }
  syncBeat();
}
function syncBeat() { const b = S.beat; if ($('#bpm')) { $('#bpm').value = b.bpm || ''; $('#first').value = b.bpm ? b.first : ''; $('#tapN').textContent = b.taps.length ? `${b.taps.length}번 누름` : ''; } }

// 오른쪽 조절판을 현재 고른 층(가사/이퀄라이저/제목)에 맞춰 다시 만든다
function buildPanel() {
  $$('.ltab').forEach(b => b.classList.toggle('on', b.dataset.l === S.sel));
  const P = $('#panel'), L = S.L[S.sel]; P.replaceChildren();
  const row = (label, ...kids) => el('div', { className: 'row' }, el('label', { textContent: label }), ...kids);
  const num = (obj, key, min, max, stepv = 1, after) => { const i = el('input', { type: 'number', value: obj[key], min, max, step: stepv }); i.oninput = () => { if (i.value !== '') { obj[key] = clamp(+i.value, min, max); after?.(); } }; return i; };
  const range = (obj, key, min, max, stepv = 1) => { const i = el('input', { type: 'range', value: obj[key], min, max, step: stepv }); i.oninput = () => obj[key] = +i.value; return i; };
  const color = (obj, key) => { const i = el('input', { type: 'color', value: obj[key] }); i.oninput = () => obj[key] = i.value; return i; };
  const check = (obj, key, label) => { const i = el('input', { type: 'checkbox', checked: obj[key] }); i.onchange = () => obj[key] = i.checked; return el('label', { className: 'chk' }, i, label); };
  const head = t => el('h4', { textContent: t });

  if (S.sel === 'bg') {
    const rb = el('div', { className: 'ratios' });
    for (const [name] of RATIOS) { const b = el('button', { className: 'seg' + (S.ratio === name ? ' on' : ''), textContent: name }); b.onclick = () => { setRatio(name); buildPanel(); }; rb.append(b); }
    P.append(head('화면 비율'), rb, el('p', { className: 'hint', textContent: `지금 ${W}x${H}. 짧은 변이 1440이 되도록 맞춥니다.` }), head('배경 이미지'));
    if (!S.bgImg) { P.append(el('p', { className: 'hint', textContent: '화면 아래에서 배경 이미지를 넣으세요.' })); return; }
    const T = S.bgT, bmp = S.bgImg, cover = Math.max(W / bmp.width, H / bmp.height);
    const fits = [['가로 맞춤', W / bmp.width / cover], ['세로 맞춤', H / bmp.height / cover], ['원본 크기', 1 / cover]];
    const z = el('input', { type: 'range', min: .1, max: 5, step: .001, value: T.zoom }), zp = el('input', { type: 'number', min: 10, max: 500, step: 1, value: Math.round(T.zoom * 100) }), zn = el('span', { className: 'hint' });
    const label = () => { const f = fits.find(f => Math.abs(f[1] - T.zoom) < 1e-6); zn.textContent = f ? f[0] + '에 붙음' : ''; };
    z.oninput = () => { let v = +z.value; const f = fits.find(f => Math.abs(f[1] - v) < .025 * f[1] + .004); if (f) v = f[1]; T.zoom = v; zp.value = Math.round(v * 100); label(); rebuildBg(); };
    zp.oninput = () => { if (zp.value === '') return; T.zoom = clamp(+zp.value / 100, .1, 5); z.value = T.zoom; label(); rebuildBg(); };
    label();
    const pos = (id, key) => { const i = el('input', { type: 'number', id, step: 1, value: Math.round(T[key]) }); i.oninput = () => { T[key] = +i.value || 0; rebuildBg(); }; return i; };
    const ar = (icon, dx, dy, title) => el('button', { className: 'mini', innerHTML: ICON[icon], title, onclick: () => nudgeBg(dx, dy) });
    const fill = el('input', { type: 'color', value: S.bgFill }); fill.oninput = () => { S.bgFill = fill.value; rebuildBg(); };
    P.append(row('크기', z, zp, el('span', { className: 'hint', textContent: '%' })),
      row('', ...fits.slice(0, 2).map(f => el('button', { className: 'mini wide', textContent: f[0], onclick: () => { T.zoom = f[1]; rebuildBg(); buildPanel(); } })), zn),
      el('p', { className: 'hint', textContent: '100%는 화면을 꽉 채우는 크기입니다. 막대를 움직이면 가로 맞춤, 세로 맞춤, 원본 크기 근처에서 달라붙습니다.' }),
      head('위치'), row('가로', pos('bgX', 'dx'), ar('left', -1, 0, '왼쪽으로 1픽셀'), ar('right', 1, 0, '오른쪽으로 1픽셀')), row('세로', pos('bgY', 'dy'), ar('up', 0, -1, '위로 1픽셀'), ar('down', 0, 1, '아래로 1픽셀')),
      el('p', { className: 'hint', textContent: '화면에서 끌면 가운데와 화면 끝에 달라붙습니다. 그다음 화살표 단추나 키보드 화살표로 1픽셀씩 옮기세요. 0은 가운데입니다.' }),
      row('', el('button', { className: 'mini wide', textContent: '처음 상태로', onclick: () => { S.bgT = { zoom: 1, dx: 0, dy: 0 }; rebuildBg(); buildPanel(); } })),
      head('빈 곳 채우기'), row('방식', ...[['color', '단색'], ['blur', '같은 그림을 흐리게']].map(([v, t]) => { const b = el('button', { className: 'seg' + (S.bgFillMode === v ? ' on' : ''), textContent: t }); b.onclick = () => { S.bgFillMode = v; rebuildBg(); buildPanel(); }; return b; })),
      ...(S.bgFillMode === 'color' ? [row('색', fill)] : []), el('p', { className: 'hint', textContent: '이미지를 줄여서 화면에 빈 곳이 생길 때 채우는 방식입니다.' }));
    return;
  }
  if (S.sel === 'eq' && !S.eq) { P.append(el('p', { className: 'hint', textContent: '위에서 이퀄라이저 파일을 넣거나 프리셋을 고르세요.' })); return; }

  if (S.sel === 'lyr') P.append(head('표시'), row('줄 수',
    ...[[1, '한 줄'], [2, '두 줄 (다음 줄 흐리게)']].map(([v, t]) => { const b = el('button', { className: 'seg' + (L.mode === v ? ' on' : ''), textContent: t }); b.onclick = () => { L.mode = v; buildPanel(); }; return b; })));
  if (S.sel === 'ttl') {
    const ti = el('input', { value: L.title, placeholder: '곡 제목' }), ar = el('input', { value: L.artist, placeholder: '아티스트 이름' });
    ti.oninput = () => L.title = ti.value; ar.oninput = () => L.artist = ar.value;
    P.append(head('글자'), row('제목', ti), row('이름', ar), el('p', { className: 'hint', textContent: '곡 전용 이퀄라이저에는 제목이 이미 들어 있습니다. 프리셋을 쓸 때 여기에 적으세요.' }));
  }

  // 위치: 아홉 칸 + 여백
  const grid = el('div', { className: 'grid9' });
  for (const ay of [0, .5, 1]) for (const ax of [0, .5, 1]) { const b = el('button', { className: L.ax === ax && L.ay === ay ? 'on' : '' }); b.onclick = () => { L.ax = ax; L.ay = ay; buildPanel(); }; grid.append(b); }
  const mxI = num(L, 'mx', 0, W, 1), myI = num(L, 'my', 0, H, 1); mxI.disabled = L.ax === .5; myI.disabled = L.ay === .5; mxI.id = 'mxI'; myI.id = 'myI';
  P.append(head('위치'), el('div', { className: 'posrow' }, grid, el('div', {}, row('가로 여백', mxI), row('세로 여백', myI), el('p', { className: 'hint', textContent: '화면에서 직접 끌어 옮길 수 있습니다. 가운데에 가까워지면 달라붙습니다.' }))));

  // 크기
  const sz = S.sel === 'eq' ? [range(L, 'size', .3, 3, .01)] : [range(L, 'size', 20, 240, 1)]; sz[0].id = 'sizeI';
  P.append(head('크기'), row(S.sel === 'eq' ? '배율' : '글자 크기', ...sz), el('p', { className: 'hint', textContent: '화면에서 모서리 네모를 끌어도 됩니다.' }));

  if (S.sel === 'eq' && S.eq.meta.kind === 'preset') {
    const b = S.beat, bpm = el('input', { type: 'number', id: 'bpm', step: .01, min: 30, max: 300, placeholder: 'BPM' }), first = el('input', { type: 'number', id: 'first', step: .01, placeholder: '초' });
    bpm.oninput = () => b.bpm = +bpm.value || 0; first.oninput = () => b.first = +first.value || 0;
    P.append(head('박자 맞추기'), el('p', { className: 'hint', textContent: '노래를 재생하고, 마디의 첫 박부터 박자에 맞춰 아래 단추(또는 B 키)를 8번쯤 누르세요.' }),
      row('', el('button', { className: 'btn', textContent: '박자 누르기 (B)', onclick: tapBeat }), el('button', { className: 'mini wide', textContent: '다시', onclick: () => { b.taps = []; b.bpm = 0; syncBeat(); } }), el('span', { id: 'tapN', className: 'hint' })),
      row('빠르기', bpm), row('첫 박 위치', first));
    syncBeat();
  }
  if (S.sel === 'eq' && S.eq.meta.kind !== 'preset') { P.append(el('p', { className: 'hint', textContent: '곡 전용 이퀄라이저는 색과 효과가 이미 들어 있어 위치와 크기만 조절합니다.' })); return; }

  if (S.sel !== 'eq') {      // 글꼴: 각 글꼴로 쓴 예시를 보고 고른다
    const sample = (S.sel === 'lyr' ? S.cues.find(c => c.text)?.text : L.title) || '가사 한 줄이 이렇게 보입니다';
    const list = el('div', { className: 'fonts' });
    for (const f of S.fonts) { const b = el('button', { className: L.font === f.family ? 'on' : '' }, el('span', { className: 'fs', textContent: sample, style: `font-family:"${f.family}"` }), el('span', { className: 'fn', textContent: f.name })); b.onclick = () => { L.font = f.family; buildPanel(); }; list.append(b); }
    const up = el('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', hidden: true }); up.onchange = () => up.files[0] && addUserFont(up.files[0]);
    P.append(head('글꼴'), list, el('button', { className: 'btn ghost', innerHTML: ICON.upload + ' 내 글꼴 파일 올리기', onclick: () => up.click() }), up);
  }
  const st = L.st;
  P.append(head('색과 효과'),
    row(S.sel === 'eq' ? '색' : '글자색', color(st, 'fC')),
    row('', check(st, 'oOn', '테두리'), color(st, 'oC'), range(st, 'oW', 1, 24)),
    row('', check(st, 'sOn', '그림자'), color(st, 'sC'), range(st, 'sD', 0, 30), range(st, 'sB', 0, 40)),
    row('', check(st, 'gOn', '빛나는 테두리'), color(st, 'gC'), range(st, 'gS', 2, 60)),
    el('p', { className: 'hint', textContent: '막대는 왼쪽부터 테두리 굵기 / 그림자 거리·번짐 / 빛의 세기입니다.' }));
}
$$('.ltab').forEach(b => b.onclick = () => { S.sel = b.dataset.l; buildPanel(); });

// 화면에서 끌어 옮기기, 모서리로 크기 조절
const toCv = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
let dragging = null;
stage.onpointerdown = e => {
  const p = toCv(e);
  if (S.sel === 'bg') { if (!S.bgImg) return; dragging = { mode: 'bg', px: p.x, py: p.y, dx: S.bgT.dx, dy: S.bgT.dy }; stage.setPointerCapture(e.pointerId); return e.preventDefault(); }
  if (e.target.id === 'handle' && S.boxes[S.sel]) { const b = S.boxes[S.sel], c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }; dragging = { mode: 'size', c, d0: Math.hypot(p.x - c.x, p.y - c.y) || 1, s0: S.L[S.sel].size }; }
  else {
    const hit = [S.sel, 'lyr', 'ttl', 'eq'].find(k => { const b = S.boxes[k]; return b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; });
    if (!hit) return; if (hit !== S.sel) { S.sel = hit; buildPanel(); }
    dragging = { mode: 'move', ox: p.x - S.boxes[hit].x, oy: p.y - S.boxes[hit].y };
  }
  stage.setPointerCapture(e.pointerId); e.preventDefault();
};
stage.onpointermove = e => {
  if (!dragging) return;
  if (dragging.mode === 'bg') {      // 배경 끌기: 가운데와 화면 끝에 달라붙는다
    const q = toCv(e), T = S.bgT, bmp = S.bgImg, k = Math.max(W / bmp.width, H / bmp.height) * T.zoom, hx = (W - bmp.width * k) / 2, hy = (H - bmp.height * k) / 2, SN = 28;
    const snap = (v, h, line, side) => { for (const [c, at] of [[0, '50%'], [-h, '0%'], [h, 'calc(100% - 2px)']]) if (Math.abs(v - c) < SN) { line.hidden = false; line.style[side] = at; return c; } line.hidden = true; return Math.round(v); };
    T.dx = snap(dragging.dx + q.x - dragging.px, hx, $('#gv'), 'left'); T.dy = snap(dragging.dy + q.y - dragging.py, hy, $('#gh'), 'top');
    return rebuildBg();
  }
  const p = toCv(e), L = S.L[S.sel], b = S.boxes[S.sel]; if (!b) return;
  if (dragging.mode === 'size') { const f = Math.hypot(p.x - dragging.c.x, p.y - dragging.c.y) / dragging.d0; L.size = S.sel === 'eq' ? clamp(+(dragging.s0 * f).toFixed(2), .3, 3) : clamp(Math.round(dragging.s0 * f), 20, 240); if ($('#sizeI')) $('#sizeI').value = L.size; return; }
  const nx = p.x - dragging.ox, ny = p.y - dragging.oy, SNAP = 36;
  if (Math.abs(nx + b.w / 2 - W / 2) < SNAP) L.ax = .5; else if (nx + b.w / 2 < W / 2) { L.ax = 0; L.mx = Math.max(0, Math.round(nx)); } else { L.ax = 1; L.mx = Math.max(0, Math.round(W - nx - b.w)); }
  if (Math.abs(ny + b.h / 2 - H / 2) < SNAP) L.ay = .5; else if (ny + b.h / 2 < H / 2) { L.ay = 0; L.my = Math.max(0, Math.round(ny)); } else { L.ay = 1; L.my = Math.max(0, Math.round(H - ny - b.h)); }
  $('#gv').hidden = L.ax !== .5; $('#gh').hidden = L.ay !== .5;
};
stage.onpointerup = stage.onpointercancel = () => { if (dragging) { dragging = null; $('#gv').hidden = $('#gh').hidden = true; $('#gv').style.left = $('#gh').style.top = '50%'; buildPanel(); } };

/* ---------- 화면 갱신 ---------- */
function tick() {
  const t = audio.currentTime || 0;
  if (document.activeElement !== seek) seek.value = t;
  $('#time').textContent = `${fmt(t)} / ${fmt(S.dur)}`;
  if (step === 2) { const i = activeCue(t); $('#live').textContent = i >= 0 ? S.cues[i].text : ''; $$('#rows tr.on').forEach(r => r.classList.remove('on')); if (i >= 0) $('#row' + i)?.classList.add('on'); }
  if (step === 3) {
    S.boxes = draw(cg, t, true); const b = S.boxes[S.sel]; selbox.hidden = !b;
    const hit = (p, q) => p && q && p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, B = S.boxes;
    $('#overlap').hidden = !(hit(B.lyr, B.eq) || hit(B.lyr, B.ttl) || hit(B.eq, B.ttl));
    if (b) Object.assign(selbox.style, { left: b.x / W * 100 + '%', top: b.y / H * 100 + '%', width: b.w / W * 100 + '%', height: b.h / H * 100 + '%' });
  }
  if (step === 4) {      // 완성 영상과 똑같이 미리보기(구간, 전환, 소리 크기)
    const { a, b } = span(); if (!audio.paused && b > a && t >= b) { audio.pause(); audio.currentTime = b; }
    const tv = clamp(t - a, 0, b - a); frame(pg, tv, b - a); audio.volume = S.fx.audio ? clamp(gain(tv, b - a), 0, 1) : 1;
  }
  requestAnimationFrame(tick);
}

/* ---------- 4. 영상 뽑기 ---------- */
async function readWav(file) {     // WAV 안의 소리 데이터를 손대지 않고 그대로 꺼낸다
  const buf = await file.arrayBuffer(), dv = new DataView(buf), id = p => String.fromCharCode(...new Uint8Array(buf, p, 4));
  if (buf.byteLength < 44 || id(0) !== 'RIFF' || id(8) !== 'WAVE') return null;
  let p = 12, f = null;
  while (p + 8 <= buf.byteLength) {
    const sz = dv.getUint32(p + 4, true);
    if (id(p) === 'fmt ') { let tag = dv.getUint16(p + 8, true); if (tag === 0xFFFE && sz >= 26) tag = dv.getUint16(p + 32, true); f = { tag, ch: dv.getUint16(p + 10, true), sr: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) }; }
    if (id(p) === 'data' && f) {
      const codec = f.tag === 1 ? { 8: 'pcm-u8', 16: 'pcm-s16', 24: 'pcm-s24', 32: 'pcm-s32' }[f.bits] : f.tag === 3 ? { 32: 'pcm-f32', 64: 'pcm-f64' }[f.bits] : null;
      if (!codec) return null; const bpf = f.ch * f.bits / 8, len = Math.min(sz, buf.byteLength - p - 8);
      return { ...f, codec, bpf, data: new Uint8Array(buf, p + 8, len - len % bpf) };
    }
    p += 8 + sz + (sz & 1);
  }
  return null;
}
function setCropFromLines() { const C = S.crop; if (S.cues[C.from]?.start != null && S.cues[C.to]?.start != null) { C.a = Math.max(0, S.cues[C.from].start); C.b = Math.min(S.dur || Infinity, endOf(C.to)); } else { C.a = 0; C.b = S.dur; } }
function buildOut() {
  const P = $('#outPanel'), C = S.crop, F = S.fx; P.replaceChildren();
  const head = t => el('h4', { textContent: t }), row = (label, ...kids) => el('div', { className: 'row' }, el('label', { textContent: label }), ...kids), hint = t => el('p', { className: 'hint', textContent: t });
  const listen = from => { if (!S.audioFile) return; audio.currentTime = Math.max(0, from); audio.play(); };
  const stamped = S.cues.map((c, i) => i).filter(i => S.cues[i].start != null);

  const on = el('input', { type: 'checkbox', checked: C.on });
  on.onchange = () => { C.on = on.checked; if (C.on) { if (!C.b) { C.from = stamped[0] ?? 0; C.to = stamped.at(-1) ?? 0; setCropFromLines(); } F.audio = true; } buildOut(); drawSummary(); };
  P.append(head('구간 자르기'), el('label', { className: 'chk free' }, on, '곡의 일부만 영상으로 만들기'));
  if (C.on) {
    const pick = key => { const s = el('select'); for (const i of stamped) s.append(el('option', { value: i, textContent: `${i + 1}. ${S.cues[i].text.slice(0, 22)}`, selected: C[key] === i }));
      s.onchange = () => { C[key] = +s.value; if (C.to < C.from) key === 'from' ? C.to = C.from : C.from = C.to; setCropFromLines(); buildOut(); drawSummary(); }; return s; };
    const setT = (key, v) => { if (key === 'a') C.a = clamp(v, 0, C.b - .5); else C.b = clamp(v, C.a + .5, S.dur || v); buildOut(); drawSummary(); listen(key === 'a' ? C.a : Math.max(C.a, C.b - 2.5)); };
    const tIn = key => { const inp = el('input', { className: 't', value: fmt(C[key]) }); inp.onchange = () => { const v = parseT(inp.value); if (v == null) inp.value = fmt(C[key]); else setT(key, v); };
      const nb = d => el('button', { className: 'mini wide', textContent: (d > 0 ? '+' : '−') + Math.abs(d), onclick: () => setT(key, +(C[key] + d).toFixed(3)) }); return [nb(-1), nb(-.1), inp, nb(.1), nb(1)]; };
    if (stamped.length) P.append(row('시작 줄', pick('from')), row('끝 줄', pick('to')), hint('고른 줄의 시작부터 끝까지로 대강 잡습니다. 아래에서 초 단위로 다듬으세요.'));
    else P.append(hint('시점을 찍은 가사가 없어 줄로 고를 수 없습니다. 아래에 시각을 직접 넣으세요.'));
    P.append(row('시작', ...tIn('a')), row('끝', ...tIn('b')), hint(`영상 길이 ${fmt(C.b - C.a)}. 시각을 바꾸면 그 지점을 바로 들려줍니다.`),
      row('', el('button', { className: 'btn ghost', textContent: '처음부터 듣기', onclick: () => listen(C.a) }), el('button', { className: 'btn ghost', textContent: '끝부분 듣기', onclick: () => listen(C.b - 4) })),
      row('', el('button', { className: 'btn ghost', innerHTML: ICON.download + ' 자른 영상 기준 SRT', onclick: () => { const { a, b } = span(); save(new Blob([makeSrt(a, b)], { type: 'text/plain' }), baseName() + '_cut.srt'); } })));
  }

  P.append(head('파일 형식'), el('div', { className: 'ratios' }, ...[['mov', 'MOV · 소리 원본 그대로'], ['mp4', 'MP4 · 어디서나 재생']].map(([v, t]) => { const b = el('button', { className: 'seg' + (S.fmt === v ? ' on' : ''), textContent: t }); b.onclick = () => { S.fmt = v; buildOut(); drawSummary(); }; return b; })),
    hint(S.fmt === 'mp4' ? 'MP4는 텔레비전, 모니터의 USB 재생, 메신저 등 거의 어디서나 열립니다. 대신 소리를 AAC 고음질로 압축하므로 원본과 똑같지는 않습니다.' : 'MOV는 소리를 원본 그대로 담습니다. 유튜브에 올리거나 편집할 때 알맞습니다.'));
  const TYPES = [['none', '없음'], ['black', '검은 화면'], ['white', '흰 화면'], ['blur', '흐림에서 선명하게'], ['zoom', '확대에서 제자리로'], ['wipe', '닦아내기'], ['iris', '원형 열림']];
  const DIRS = [['lr', '왼쪽에서 오른쪽'], ['rl', '오른쪽에서 왼쪽'], ['tb', '위에서 아래'], ['bt', '아래에서 위']];
  const opt = (obj, key, list) => { const s = el('select'); for (const [v, t] of list) s.append(el('option', { value: v, textContent: t, selected: obj[key] === v })); s.onchange = () => { obj[key] = s.value; buildOut(); drawSummary(); }; return s; };
  const secs = key => { const i = el('input', { type: 'number', value: F[key], min: 0, max: 15, step: .1 }); i.oninput = () => { F[key] = clamp(+i.value || 0, 0, 15); }; return i; };
  P.append(head('시작과 끝 화면전환'),
    row('시작', opt(F, 'inType', TYPES), secs('inDur'), el('span', { className: 'hint', textContent: '초' })), ...(F.inType === 'wipe' ? [row('', opt(F, 'inDir', DIRS))] : []),
    row('끝', opt(F, 'outType', TYPES), secs('outDur'), el('span', { className: 'hint', textContent: '초' })), ...(F.outType === 'wipe' ? [row('', opt(F, 'outDir', DIRS))] : []));
  const au = el('input', { type: 'checkbox', checked: F.audio }); au.onchange = () => { F.audio = au.checked; drawSummary(); };
  P.append(el('label', { className: 'chk free' }, au, '소리도 같은 길이로 서서히 키우고 줄이기'),
    hint('소리 전환을 켜면 전환 구간의 소리만 달라지고, 그 밖은 원본 그대로입니다. 압축은 하지 않습니다.'),
    row('', el('button', { className: 'btn ghost', textContent: '시작 전환 보기', onclick: () => listen(span().a) }), el('button', { className: 'btn ghost', textContent: '끝 전환 보기', onclick: () => listen(span().b - F.outDur - 1.5) })));
}
function wavFloat(w) {      // WAV 소리를 압축기에 넣을 수 있게 소수 값으로 풀기(MP4용)
  const n = w.data.byteLength / w.bpf, bps = w.bits / 8, dv = new DataView(w.data.buffer, w.data.byteOffset, w.data.byteLength), chans = [...Array(w.ch)].map(() => new Float32Array(n));
  const rd = w.tag === 3 ? (bps === 4 ? p => dv.getFloat32(p, true) : p => dv.getFloat64(p, true)) : bps === 1 ? p => (dv.getUint8(p) - 128) / 128 : bps === 2 ? p => dv.getInt16(p, true) / 32768
    : bps === 3 ? p => (dv.getUint8(p) | dv.getUint8(p + 1) << 8 | dv.getInt8(p + 2) << 16) / 8388608 : p => dv.getInt32(p, true) / 2147483648;
  for (let i = 0; i < n; i++) for (let c = 0; c < w.ch; c++) chans[c][i] = rd(i * w.bpf + c * bps);
  return { sr: w.sr, ch: w.ch, n, chans };
}
function drawSummary() {
  const n = S.cues.filter(c => c.start != null && c.text).length;
  $('#summary').replaceChildren(...[
    ['영상', `${W}x${H} (${S.ratio}), ${FPS}fps`], ['길이', !S.dur ? '음원 없음' : S.crop.on ? `${fmt(span().b - span().a)} (원곡의 ${fmt(span().a)} ~ ${fmt(span().b)})` : fmt(S.dur)], ['가사', `${n}줄` + (n < S.cues.length ? ` (시점이 없는 ${S.cues.length - n}줄은 빠짐)` : '')],
    ['배경', S.bg ? '넣음' : '없음 (어두운 단색)'], ['파일', S.fmt === 'mp4' ? 'MP4' : 'MOV'], ['소리', S.fmt === 'mp4' ? 'AAC 고음질로 압축 (원본과 같지 않음)' : S.fx.audio && (S.fx.inDur || S.fx.outDur) ? '압축 없이 담고, 시작과 끝만 서서히 조절' : '원본 그대로'], ['이퀄라이저', S.eq ? S.eq.label + (S.eq.meta.kind === 'preset' && !S.beat.bpm ? ' — 박자를 아직 안 맞춰 움직이지 않습니다' : '') : '없음'],
  ].map(([k, v]) => el('div', { className: 'row' }, el('label', { textContent: k }), el('span', { textContent: v }))));
}
let cancelled = false;
$('#cancel').onclick = () => cancelled = true;

// 영상을 메모리에 쌓지 않고 브라우저 전용 저장 공간의 임시 파일에 바로 쓴다(지원하지 않으면 메모리 방식으로 돌아감)
const TMP = 'lyricvideo-tmp', LOCK = 'lyricvideo-render'; let releaseLock = null;
const hasDisk = () => !!navigator.storage?.getDirectory && 'createWritable' in (window.FileSystemFileHandle?.prototype || {});
const removeTmp = async () => { try { await (await navigator.storage.getDirectory()).removeEntry(TMP); } catch {} };
function takeLock() {      // 이 창이 임시 파일을 쓰고 있다는 표시. 다른 창이 이미 쓰는 중이면 false
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise(res => navigator.locks.request(LOCK, { ifAvailable: true }, lock => { if (!lock) return res(false); res(true); return new Promise(r => releaseLock = r); }));
}
const dropLock = () => { releaseLock?.(); releaseLock = null; };
async function cleanTmp() {      // 지난번에 남은 임시 파일 지우기. 다른 창이 쓰는 중이면 건드리지 않는다
  if (!hasDisk() || releaseLock) return; if (await takeLock()) { await removeTmp(); dropLock(); }
}
async function openDisk(est) {   // 임시 파일 열기. 못 쓰는 상황이면 null
  if (!hasDisk()) return null;
  if (!releaseLock && !(await takeLock())) return null;
  await removeTmp();
  try {
    const e = await navigator.storage.estimate(); if (e.quota - e.usage < est * 2.2) throw new Error('저장 공간 부족');
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(TMP, { create: true }); return { handle, writable: await handle.createWritable() };
  } catch { await removeTmp(); dropLock(); return null; }
}
cleanTmp();
$('#render').onclick = async () => {
  if (!S.audioFile) return alert('음원을 먼저 넣어 주세요.');
  if (!window.VideoEncoder) return alert('이 브라우저에서는 영상을 만들 수 없습니다. 컴퓨터의 크롬이나 엣지에서 열어 주세요.');
  const st = $('#status'), bar = $('#prog'); cancelled = false; audio.pause();
  $('#render').disabled = true; $('#cancel').hidden = false; $('#result').replaceChildren(); bar.hidden = false; bar.value = 0;
  let out, disk = null;
  try {
    await loadAllFonts(); st.textContent = '음원을 읽는 중…';
    const wav = await readWav(S.audioFile); let pcm = null;
    if (!wav) {   // WAV가 아니면 소리를 풀어서 압축 없이 담는다
      const ac = new AudioContext(), ab = await ac.decodeAudioData(await S.audioFile.arrayBuffer()); ac.close();
      pcm = { sr: ab.sampleRate, ch: ab.numberOfChannels, n: ab.length, chans: [...Array(ab.numberOfChannels)].map((_, c) => ab.getChannelData(c)) };
    }
    const mp4 = S.fmt === 'mp4', raw = wav && !mp4;      // raw: WAV 소리 데이터를 그대로 옮겨 담는 경우
    if (wav && mp4) pcm = wavFloat(wav);
    const estDur = S.crop.on ? span().b - span().a : (S.dur || 600), est = estDur * (BITRATE * W * H / (2560 * 1440) / 8 + (raw ? wav.sr * wav.bpf : mp4 ? 32000 : pcm.sr * pcm.ch * 2));
    disk = await openDisk(est);
    const format = mp4 ? new MB.Mp4OutputFormat({ fastStart: disk ? false : 'in-memory' }) : new MB.MovOutputFormat();
    out = new MB.Output({ format, target: disk ? new MB.StreamTarget(disk.writable, { chunked: true, chunkSize: 4 * 1048576 }) : new MB.BufferTarget() });
    let aCodec = 'pcm-s16';
    if (mp4) { aCodec = await MB.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: pcm.ch, sampleRate: pcm.sr, bitrate: 256e3 }); if (!aCodec) throw new Error('이 브라우저가 MP4용 소리 압축을 지원하지 않습니다. MOV로 뽑아 주세요'); }
    const br = Math.round(BITRATE * W * H / (2560 * 1440)), codec = await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, bitrate: br });
    if (!codec) throw new Error(`이 브라우저가 ${W}x${H} 영상 압축을 지원하지 않습니다`);
    const ec = mk(W, H), eg = ec.getContext('2d'), vs = new MB.CanvasSource(ec, { codec, bitrate: br, keyFrameInterval: 5 });
    const as = raw ? new MB.EncodedAudioPacketSource(wav.codec) : new MB.AudioSampleSource(mp4 ? { codec: aCodec, bitrate: 256e3 } : { codec: 'pcm-s16' });
    out.addVideoTrack(vs, { frameRate: FPS }); out.addAudioTrack(as); await out.start();
    const sr = raw ? wav.sr : pcm.sr, allS = raw ? wav.data.byteLength / wav.bpf : pcm.n, { a, b } = S.crop.on ? span() : { a: 0, b: allS / sr };
    const s0 = Math.min(allS - 1, Math.round(a * sr)), totalS = Math.max(1, Math.min(allS, Math.round(b * sr)) - s0), dur = totalS / sr, frames = Math.ceil(dur * FPS), t0 = performance.now();
    const fi = S.fx.audio ? Math.round(S.fx.inDur * sr) : 0, fo = S.fx.audio ? Math.round(S.fx.outDur * sr) : 0, faded = n => (fi || fo) && (sent < fi || sent + n > totalS - fo);
    let sent = 0;
    const pushAudio = async upto => {       // 영상 진행에 맞춰 소리를 1초씩 넣는다
      while (sent < totalS && sent / sr < upto) {
        const n = Math.min(sr, totalS - sent);
        if (raw) { let bytes = wav.data.subarray((s0 + sent) * wav.bpf, (s0 + sent + n) * wav.bpf); if (faded(n)) bytes = fadePcm(bytes.slice(), wav, sent, totalS, fi, fo);
          await as.add(new MB.EncodedPacket(bytes, 'key', sent / sr, n / sr), sent ? undefined : { decoderConfig: { codec: wav.codec, numberOfChannels: wav.ch, sampleRate: sr } }); }
        else { const d = new Float32Array(n * pcm.ch); for (let c = 0; c < pcm.ch; c++) d.set(pcm.chans[c].subarray(s0 + sent, s0 + sent + n), c * n);
          if (faded(n)) for (let i = 0; i < n; i++) { const gn = cosw(fi ? Math.min(1, (sent + i) / fi) : 1) * cosw(fo ? Math.min(1, (totalS - 1 - sent - i) / fo) : 1); if (gn < 1) for (let c = 0; c < pcm.ch; c++) d[c * n + i] *= gn; }
          const s = new MB.AudioSample({ data: d, format: 'f32-planar', numberOfChannels: pcm.ch, sampleRate: sr, timestamp: sent / sr }); await as.add(s); s.close(); }
        sent += n;
      }
    };
    for (let i = 0; i < frames; i++) {
      if (cancelled) throw new Error('cancel');
      frame(eg, i / FPS, dur); await vs.add(i / FPS, 1 / FPS);
      if (i % FPS === FPS - 1) { await pushAudio((i + 1) / FPS); bar.value = i / frames; const el2 = (performance.now() - t0) / 1000; st.textContent = `영상 만드는 중… ${Math.round(i / frames * 100)}% (남은 시간 약 ${Math.ceil(el2 / (i + 1) * (frames - i) / 60)}분)`; }
    }
    await pushAudio(Infinity); st.textContent = '파일로 묶는 중…'; await out.finalize();
    const mime = mp4 ? 'video/mp4' : 'video/quicktime', blob = disk ? (f => f.slice(0, f.size, mime))(await disk.handle.getFile()) : new Blob([out.target.buffer], { type: mime }), name = baseName() + (S.crop.on ? '_cut' : '') + (S.ratio === '16:9' ? '' : '_' + S.ratio.replace(':', 'x')) + (mp4 ? '.mp4' : '.mov'); bar.value = 1;
    st.textContent = `완료. ${(blob.size / 1048576).toFixed(1)}MB, 영상 압축 방식 ${codec.toUpperCase()}, 소리 ${mp4 ? aCodec.toUpperCase() + ' 고음질 압축' : wav ? (fi || fo ? '압축 없이 담고 시작과 끝만 서서히 조절' : '원본 WAV 그대로') : '압축 없이(풀어서) 담음'}.` + (mp4 && (aCodec !== 'aac' || codec !== 'avc') ? ' 이 브라우저가 H.264나 AAC를 지원하지 않아 다른 방식으로 담았습니다. 텔레비전이나 모니터에서 안 열릴 수 있으니 크롬이나 엣지에서 다시 뽑아 보세요.' : '');
    $('#result').append(el('button', { className: 'btn', innerHTML: ICON.download + ' ' + name + ' 저장', onclick: () => save(blob, name) }));
    window.__lastBlob = blob; window.__lastMode = disk ? 'disk' : 'memory'; save(blob, name);
  } catch (err) {
    if (out && out.state !== 'finalized') await out.cancel().catch(() => {});
    if (disk) { await removeTmp(); dropLock(); }
    st.textContent = err.message === 'cancel' ? '취소했습니다.' : '실패: ' + err.message; if (err.message !== 'cancel') console.error(err);
  }
  $('#render').disabled = false; $('#cancel').hidden = true;
};

/* ---------- 작업 저장·불러오기와 내 스타일 ---------- */
const STYLE_KEY = 'lyricvideo-style';
function collect(full) {      // full=true 는 작업 전체(가사·시점 포함), false 는 꾸밈만(내 스타일)
  const L = JSON.parse(JSON.stringify(S.L)), name = fam => S.fonts.find(f => f.family === fam)?.name || S.wantFont?.[fam] || '';
  L.lyr.font = S.fonts.find(f => f.family === S.L.lyr.font)?.name ?? S.wantFont?.lyr ?? ''; L.ttl.font = S.fonts.find(f => f.family === S.L.ttl.font)?.name ?? S.wantFont?.ttl ?? '';
  const o = { app: 'lyricvideo', v: 1, ratio: S.ratio, fmt: S.fmt, bgFill: S.bgFill, bgFillMode: S.bgFillMode, fx: { ...S.fx }, L, eqFile: S.eqFile || '' };
  if (!full) { o.L.ttl.title = o.L.ttl.artist = ''; return o; }
  return { ...o, cues: S.cues, rec: S.rec, crop: { ...S.crop }, beat: { bpm: S.beat.bpm, first: S.beat.first }, bgT: { ...S.bgT } };
}
async function applyState(o) {
  if (o?.app !== 'lyricvideo') throw new Error('이 앱에서 저장한 파일이 아닙니다');
  for (const k of ['lyr', 'eq', 'ttl']) if (o.L?.[k]) { const { st, font, ...rest } = o.L[k]; Object.assign(S.L[k], rest); Object.assign(S.L[k].st, st || {}); }
  S.wantFont = { lyr: o.L?.lyr?.font || '', ttl: o.L?.ttl?.font || '' };
  for (const k of ['lyr', 'ttl']) { const f = S.fonts.find(f => f.name === S.wantFont[k]); if (f) S.L[k].font = f.family; }
  if (o.fx) Object.assign(S.fx, o.fx); if (o.fmt) S.fmt = o.fmt; if (o.bgFill) S.bgFill = o.bgFill; if (o.bgFillMode) S.bgFillMode = o.bgFillMode;
  if (o.cues) { S.cues = o.cues.map(c => ({ text: String(c.text ?? ''), start: c.start ?? null, end: c.end ?? null })); S.rec = Math.min(o.rec ?? S.cues.length, S.cues.length); $('#lyrics').value = S.cues.map(c => c.text).join('\n'); }
  if (o.crop) Object.assign(S.crop, o.crop); if (o.beat) Object.assign(S.beat, o.beat, { taps: [] }); if (o.bgT) S.bgT = { zoom: 1, dx: 0, dy: 0, ...o.bgT };
  if (RATIOS.some(r => r[0] === o.ratio)) setRatio(o.ratio); else rebuildBg();
  sprites.clear(); loadAllFonts();
  if (o.eqFile !== undefined && o.eqFile !== (S.eqFile || '')) { await presetsReady; const sel = $('#eqPreset'); if (!o.eqFile || [...sel.options].some(x => x.value === o.eqFile)) { sel.value = o.eqFile; await sel.onchange({ target: sel }); } }
  go(step);
}
$('#projSave').onclick = () => save(new Blob([JSON.stringify(collect(true), null, 1)], { type: 'application/json' }), baseName() + '_작업.json');
$('#fProj').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (S.cues.some(c => c.start != null) && !confirm('지금 작업 중인 가사와 시점이 불러온 내용으로 바뀝니다. 계속할까요?')) return;
  try { await applyState(JSON.parse(await f.text())); note('작업을 불러왔습니다. 음원, 배경 이미지, 곡 전용 이퀄라이저 파일은 다시 넣어 주세요.'); } catch (err) { alert('불러오지 못했습니다: ' + err.message); }
};
const note = t => { $('#styleNote').textContent = t; };
$('#styleSave').onclick = () => { try { localStorage.setItem(STYLE_KEY, JSON.stringify(collect(false))); note('지금 꾸밈을 내 스타일로 저장했습니다. 다음에 열면 자동으로 적용됩니다.'); $('#styleClear').hidden = false; } catch { alert('이 브라우저에서는 저장할 수 없습니다(사생활 보호 모드일 수 있습니다).'); } };
$('#styleClear').onclick = () => { try { localStorage.removeItem(STYLE_KEY); } catch {} note('내 스타일을 지웠습니다. 다음에 열면 기본 꾸밈으로 시작합니다.'); $('#styleClear').hidden = true; };
try { const saved = localStorage.getItem(STYLE_KEY); if (saved) { $('#styleClear').hidden = false; applyState(JSON.parse(saved)).then(() => note('내 스타일을 불러왔습니다.')).catch(() => {}); } } catch {}

window.__app = { collect, applyState, S, go, draw, frame, setRatio, rebuildBg, buildOut, drawSummary, loadEq, buildPanel, drawTable, drawRec, stamp, blank, undo, tapBeat, span, dims: () => [W, H] };
go(1); tick();
