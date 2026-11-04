// Pure image arithmetic for the scanner. Works on ImageData-shaped objects
// ({ width, height, data: Uint8ClampedArray RGBA }) so it runs in the browser
// and under Deno tests alike. No DOM here.

export function makeImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function toGray(img) {
  const { width, height, data } = img;
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return g;
}

// Summed-area table, (w+1)*(h+1), for fast box means.
function integral(gray, w, h) {
  const s = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += gray[(y - 1) * w + (x - 1)];
      s[y * (w + 1) + x] = s[(y - 1) * (w + 1) + x] + row;
    }
  }
  return s;
}

function boxMean(s, w, h, x, y, r) {
  const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
  const x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
  const W = w + 1;
  const sum = s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}

function blur(gray, w, h, r) {
  const s = integral(gray, w, h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = boxMean(s, w, h, x, y, r);
  return out;
}

export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// Largest 4-connected component of mask==1. Returns indices of its pixels.
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let bestPixels = null, next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = next++;
    let sp = 0, n = 0;
    const pixels = [];
    stack[sp++] = start; label[start] = id;
    while (sp) {
      const p = stack[--sp];
      pixels.push(p); n++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
    }
    if (!bestPixels || n > bestPixels.length) bestPixels = pixels;
  }
  return bestPixels || [];
}

export const DEFAULT_QUAD = [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]];

// Finds the page in a (small, ~400px) photo: the largest patch that is
// lighter than its surroundings. Returns corners TL, TR, BR, BL as fractions
// of width/height, or null when nothing page-like stands out.
export function detectQuad(img) {
  const { width: w, height: h } = img;
  const gray = blur(toGray(img), w, h, 2);
  const t = otsu(gray);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] > t ? 1 : 0;
  const comp = largestComponent(mask, w, h);
  const share = comp.length / (w * h);
  if (share < 0.08 || share > 0.97) return null;
  let tl = null, tr = null, br = null, bl = null;
  let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
  for (const p of comp) {
    const x = p % w, y = (p / w) | 0;
    const s = x + y, d = x - y;
    if (s < minS) { minS = s; tl = [x, y]; }
    if (s > maxS) { maxS = s; br = [x, y]; }
    if (d > maxD) { maxD = d; tr = [x, y]; }
    if (d < minD) { minD = d; bl = [x, y]; }
  }
  const quad = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
  if (quadArea(quad) < 0.06) return null;
  return quad;
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Output size for a quad given in source pixels, long side capped.
export function outputSize(quad, maxSide = 2400) {
  const [tl, tr, br, bl] = quad;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

// Solve A x = b (n×n) by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error("degenerate quad");
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

// Homography H (3x3, row-major, h33=1) taking from[i] to to[i].
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

// Flattens the quad (source pixels, TL TR BR BL) of src into a width×height page.
export function warp(src, quad, width, height) {
  const out = makeImage(width, height);
  const rect = [[0, 0], [width, 0], [width, height], [0, height]];
  const H = homography(rect, quad);
  const sw = src.width, sh = src.height, sd = src.data, od = out.data;
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, o += 4) {
      const d = H[6] * (x + 0.5) + H[7] * (y + 0.5) + H[8];
      let u = (H[0] * (x + 0.5) + H[1] * (y + 0.5) + H[2]) / d - 0.5;
      let v = (H[3] * (x + 0.5) + H[4] * (y + 0.5) + H[5]) / d - 0.5;
      if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
      if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
      const x0 = u | 0, y0 = v | 0;
      const x1 = x0 < sw - 1 ? x0 + 1 : x0, y1 = y0 < sh - 1 ? y0 + 1 : y0;
      const fx = u - x0, fy = v - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[p00 + c] + (sd[p10 + c] - sd[p00 + c]) * fx;
        const bot = sd[p01 + c] + (sd[p11 + c] - sd[p01 + c]) * fx;
        od[o + c] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
    }
  }
  return out;
}

// Quarter turns clockwise.
export function rotate(img, turns) {
  turns = ((turns % 4) + 4) % 4;
  if (!turns) return img;
  const { width: w, height: h, data } = img;
  const out = turns % 2 ? makeImage(h, w) : makeImage(w, h);
  const ow = out.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (turns === 1) { nx = h - 1 - y; ny = x; }
      else if (turns === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      const s = (y * w + x) * 4, d = (ny * ow + nx) * 4;
      out.data[d] = data[s]; out.data[d + 1] = data[s + 1];
      out.data[d + 2] = data[s + 2]; out.data[d + 3] = 255;
    }
  }
  return out;
}

// Levels stretch on brightness: the 2nd percentile goes to black, the
// paper (95th) to white. Keeps colour, lifts grey paper and shadows.
export function enhance(img) {
  const gray = toGray(img);
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const pct = (p) => {
    let acc = 0;
    const target = gray.length * p;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  };
  const lo = pct(0.02), hi = Math.max(lo + 30, pct(0.95));
  const scale = 255 / (hi - lo);
  const out = makeImage(img.width, img.height);
  const s = img.data, d = out.data;
  for (let p = 0; p < s.length; p += 4) {
    for (let c = 0; c < 3; c++) d[p + c] = (s[p + c] - lo) * scale;
    d[p + 3] = 255;
  }
  return out;
}

// Black-and-white: each pixel compared with the mean of its neighbourhood,
// so uneven light and shadows across the page don't turn into black blotches.
export function blackWhite(img) {
  const { width: w, height: h } = img;
  const gray = toGray(img);
  const s = integral(gray, w, h);
  const r = Math.max(8, Math.round(Math.max(w, h) / 40));
  const out = makeImage(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = boxMean(s, w, h, x, y, r);
      // Soft edge (12 levels wide) keeps text strokes smooth rather than jagged.
      const v = Math.max(0, Math.min(255, (gray[i] - m * 0.86) * 21 + 128));
      const p = i * 4;
      d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
  }
  return out;
}

export function applyFilter(img, filter) {
  if (filter === "enhanced") return enhance(img);
  if (filter === "bw") return blackWhite(img);
  return img;
}

// "2026-11-04 Tesco" or, untitled, "2026-11-04 14.32 scan". Dates first so
// a folder sorted by name is also sorted by date.
export function fileBaseName(date, title) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  const clean = (title || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? `${day} ${clean}` : `${day} ${p(date.getHours())}.${p(date.getMinutes())} scan`;
}
