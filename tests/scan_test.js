// deno run --no-config tests/scan_test.js
import { makeImage, detectQuad, homography, applyH, outputSize, warp, rotate, enhance, blackWhite, fileBaseName } from "../scan.js";
import { buildPdf, pdfString } from "../pdf.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " — " + detail}`);
  if (!ok) failed++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A dark "table" with a light, tilted "page" drawn on it.
function photo(w, h, quad, paper = 230, table = 60) {
  const img = makeImage(w, h);
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = quad[i], [x2, y2] = quad[(i + 1) % 4];
      const c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      if (c !== 0) { if (sign && Math.sign(c) !== sign) return false; sign = Math.sign(c); }
    }
    return true;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = inside(x + 0.5, y + 0.5) ? paper : table;
    const p = (y * w + x) * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  return img;
}

// detectQuad finds a tilted page.
{
  const q = [[90, 40], [320, 70], [300, 360], [60, 330]];
  const img = photo(400, 400, q);
  const found = detectQuad(img);
  const ok = found && found.every(([x, y], i) => near(x * 400, q[i][0], 6) && near(y * 400, q[i][1], 6));
  check("detectQuad finds the four corners of a tilted page", ok, JSON.stringify(found?.map(([x, y]) => [x * 400, y * 400])));
}

// detectQuad gives up on a featureless photo.
{
  const img = photo(200, 200, [[0, 0], [0, 0], [0, 0], [0, 0]], 120, 120);
  check("detectQuad returns null with nothing to find", detectQuad(img) === null);
}

// Homography maps corners exactly.
{
  const from = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const to = [[10, 20], [200, 5], [220, 180], [0, 160]];
  const H = homography(from, to);
  const ok = from.every((p, i) => {
    const [u, v] = applyH(H, ...p);
    return near(u, to[i][0], 1e-6) && near(v, to[i][1], 1e-6);
  });
  check("homography maps each corner to its target", ok);
}

// Warping the page out of the photo leaves only paper.
{
  const q = [[90, 40], [320, 70], [300, 360], [60, 330]];
  const img = photo(400, 400, q);
  const size = outputSize(q, 2400);
  const out = warp(img, q, size.width, size.height);
  let dark = 0;
  // ignore a 3px border where bilinear sampling blends with the table
  for (let y = 3; y < out.height - 3; y++) for (let x = 3; x < out.width - 3; x++) {
    if (out.data[(y * out.width + x) * 4] < 200) dark++;
  }
  check("warp output is all page, no table", dark === 0, `${dark} dark pixels`);
  check("outputSize follows the longest edges", near(size.width, 240, 3) && near(size.height, 290, 3), JSON.stringify(size));
}

{
  const s = outputSize([[0, 0], [4000, 0], [4000, 3000], [0, 3000]], 2400);
  check("outputSize caps the long side", s.width === 2400 && s.height === 1800, JSON.stringify(s));
}

// Rotation.
{
  const img = makeImage(3, 2);
  img.data.set([1, 0, 0, 255], 0); // top-left pixel marked
  const r1 = rotate(img, 1);
  check("rotate swaps width and height", r1.width === 2 && r1.height === 3);
  check("rotate moves top-left to top-right", r1.data[(0 * 2 + 1) * 4] === 1);
  const r4 = rotate(img, 4);
  check("four turns is no turn", r4 === img);
}

// Enhance stretches greys; black-and-white keeps paper white and ink black.
{
  const img = makeImage(100, 100);
  for (let i = 0; i < 100 * 100; i++) {
    const ink = (i % 100) > 45 && (i % 100) < 55;
    const v = ink ? 70 : 170;
    img.data.set([v, v, v, 255], i * 4);
  }
  const e = enhance(img);
  check("enhance makes the paper white", e.data[0] === 255, e.data[0]);
  const bw = blackWhite(img);
  check("black & white: paper is white", bw.data[0] === 255, bw.data[0]);
  check("black & white: ink is black", bw.data[(50 * 100 + 50) * 4] === 0, bw.data[(50 * 100 + 50) * 4]);
}

// File names.
{
  const d = new Date(2026, 10, 4, 9, 5);
  check("named file", fileBaseName(d, "  Tesco / lunch ") === "2026-11-04 Tesco lunch", fileBaseName(d, "  Tesco / lunch "));
  check("untitled file gets the time", fileBaseName(d, "") === "2026-11-04 09.05 scan", fileBaseName(d, ""));
}

// PDF: structure and cross-reference offsets are right.
{
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const pdf = buildPdf([{ jpeg: fakeJpeg, width: 100, height: 200 }, { jpeg: fakeJpeg, width: 300, height: 100 }], "Café (1)");
  const text = new TextDecoder("latin1").decode(pdf);
  check("pdf starts with header", text.startsWith("%PDF-1.4"));
  check("pdf ends with %%EOF", text.trimEnd().endsWith("%%EOF"));
  check("pdf has 2 pages", /\/Count 2\b/.test(text));
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
  check("startxref points at xref", text.slice(startxref, startxref + 4) === "xref");
  const entries = text.slice(startxref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
  const allOk = entries.every((line, i) => {
    const off = Number(line.slice(0, 10));
    return text.slice(off).startsWith(`${i + 1} 0 obj`);
  });
  check("every xref offset points at its object", entries.length === 9 && allOk, `${entries.length} entries`);
  check("page height follows the image shape", text.includes("/MediaBox [0 0 595 1190]"));
  check("non-ASCII title is UTF-16", pdfString("Café") === "<FEFF00430061006600E9>");
  check("ASCII title escapes brackets", pdfString("a(b)") === "(a\\(b\\))");
}

if (failed) { console.log(`\n${failed} failed`); Deno.exit(1); }
console.log("\nall passed");
