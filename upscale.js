// 배경 이미지 업스케일(일러스트용 Real-ESRGAN). 필요할 때만 불러온다. 이미지는 이 기기 밖으로 나가지 않는다
const PAD = 16, TEXTURE = 0.7;      // TEXTURE: 원본의 입자 질감을 되살리는 정도
let ort = null;
async function session(ep) {
  ort ??= await import('./lib/ort/ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = new URL('./lib/ort/', import.meta.url).href; ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  return ort.InferenceSession.create(new URL('./lib/ort/illust.onnx', import.meta.url).href, { executionProviders: [ep] });
}
export const hasGpu = async () => !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));

// 조각마다 4배로 키운 뒤 필요한 배율 s 로 줄여 결과 캔버스에 바로 그린다(4배 전체를 메모리에 올리지 않는다)
async function run(bmp, s, ep, tile, onProg) {
  const w = bmp.width, h = bmp.height;
  const sc = new OffscreenCanvas(w, h), sg = sc.getContext('2d', { willReadFrequently: true }); sg.drawImage(bmp, 0, 0);
  const src = sg.getImageData(0, 0, w, h).data, N = tile + PAD * 2, plane = N * N, inp = new Float32Array(3 * plane);
  const out = new OffscreenCanvas(Math.round(w * s), Math.round(h * s)), og = out.getContext('2d', { willReadFrequently: true }); og.imageSmoothingQuality = 'high';
  const tc = new OffscreenCanvas(N * 4, N * 4), tg = tc.getContext('2d'), tid = tg.createImageData(N * 4, N * 4);
  const sess = await session(ep), total = Math.ceil(w / tile) * Math.ceil(h / tile); let done = 0;
  try {
    for (let ty = 0; ty < h; ty += tile) for (let tx = 0; tx < w; tx += tile) {
      for (let y = 0; y < N; y++) { const sy = Math.min(h - 1, Math.max(0, ty - PAD + y)) * w;      // 가장자리는 끝 픽셀을 이어 붙여 조각 크기를 항상 같게
        for (let x = 0; x < N; x++) { const p = (sy + Math.min(w - 1, Math.max(0, tx - PAD + x))) * 4, q = y * N + x; inp[q] = src[p] / 255; inp[plane + q] = src[p + 1] / 255; inp[2 * plane + q] = src[p + 2] / 255; } }
      const t = new ort.Tensor('float32', inp, [1, 3, N, N]);
      // 그래픽 가속이 첫 조각에서 30초 넘게 답이 없으면 멈춘 것으로 보고 일반 처리로 넘어간다
      const r = await (done || ep !== 'webgpu' ? sess.run({ x: t }) : Promise.race([sess.run({ x: t }), new Promise((_, no) => setTimeout(() => no(new Error('그래픽 가속 응답 없음')), 30000))])), o = r.y.data, P4 = N * 4 * N * 4, d = tid.data;
      for (let i = 0; i < P4; i++) { d[i * 4] = o[i] * 255 + .5; d[i * 4 + 1] = o[P4 + i] * 255 + .5; d[i * 4 + 2] = o[2 * P4 + i] * 255 + .5; d[i * 4 + 3] = 255; }
      r.y.dispose?.(); tg.putImageData(tid, 0, 0);
      const x0 = Math.round(tx * s), y0 = Math.round(ty * s), x1 = Math.round(Math.min(w, tx + tile) * s), y1 = Math.round(Math.min(h, ty + tile) * s);
      og.save(); og.beginPath(); og.rect(x0, y0, x1 - x0, y1 - y0); og.clip(); og.drawImage(tc, (tx - PAD) * s, (ty - PAD) * s, N * s, N * s); og.restore();
      onProg(++done / total); await new Promise(r => setTimeout(r));
    }
  } finally { await sess.release?.().catch?.(() => {}); }
  return out;
}

// 원본의 입자 질감을 면 부분에만 되살린다(선 주변은 선명하게 둔다). 띠 단위로 처리해 메모리를 아낀다
function keepTexture(out, bmp, k) {
  const W = out.width, H = out.height, g = out.getContext('2d', { willReadFrequently: true }), M = 8, STRIP = 256;
  const rc = new OffscreenCanvas(W, STRIP + M * 2), rg = rc.getContext('2d', { willReadFrequently: true }); rg.imageSmoothingQuality = 'high';
  for (let y0 = 0; y0 < H; y0 += STRIP) {
    const a = Math.max(0, y0 - M), b = Math.min(H, y0 + STRIP + M), hh = b - a, sr = g.getImageData(0, a, W, hh), d = sr.data;
    rg.clearRect(0, 0, W, hh); rg.drawImage(bmp, 0, -a, W, H); const ref = rg.getImageData(0, 0, W, hh).data;
    const gray = new Float32Array(W * hh), mask = new Float32Array(W * hh), tmp = new Float32Array(W * hh);
    for (let i = 0; i < W * hh; i++) gray[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x;
      const gx = gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1] - gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1], gy = gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1] - gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1];
      mask[i] = Math.hypot(gx, gy); }
    for (let pass = 0; pass < 2; pass++) {      // 5칸 평균을 가로세로 두 번: 부드럽게 번지게
      for (let y = 0; y < hh; y++) for (let x = 0; x < W; x++) { let sum = 0, n = 0; for (let j = -2; j <= 2; j++) { const xx = x + j; if (xx >= 0 && xx < W) { sum += mask[y * W + xx]; n++; } } tmp[y * W + x] = sum / n; }
      for (let y = 0; y < hh; y++) for (let x = 0; x < W; x++) { let sum = 0, n = 0; for (let j = -2; j <= 2; j++) { const yy = y + j; if (yy >= 0 && yy < hh) { sum += tmp[yy * W + x]; n++; } } mask[y * W + x] = sum / n; }
    }
    for (let i = 0; i < W * hh; i++) { const m = k * (1 - Math.min(1, mask[i] / 120)); for (let c = 0; c < 3; c++) d[i * 4 + c] += m * (ref[i * 4 + c] - d[i * 4 + c]); }
    g.putImageData(sr, 0, a, 0, y0 - a, W, Math.min(STRIP, H - y0));
  }
}

// bmp 를 s 배(최대 4)로 키운 그림을 돌려준다. onProg(0~1) 가 예외를 던지면 그대로 멈춘다(취소)
export async function upscale(bmp, s, gpu, onProg) {
  let last;
  for (const [ep, tile] of [...(gpu ? [['webgpu', 192]] : []), ['wasm', 192], ['wasm', 96]]) {
    try { const out = await run(bmp, Math.min(4, s), ep, tile, onProg); keepTexture(out, bmp, TEXTURE); return createImageBitmap(out); }
    catch (err) { if (err.message === 'cancel') throw err; console.warn('업스케일 실패', ep, tile, err); last = err; }
  }
  throw last;
}
