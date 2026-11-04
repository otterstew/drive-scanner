// A minimal PDF writer: one JPEG per page, no library needed.
// pages: [{ jpeg: Uint8Array, width, height }] (pixel size of the JPEG).
// Each page is 595pt (A4) wide and as tall as the image's shape needs.

const enc = new TextEncoder();

// PDF text string: plain ASCII in (…) with escapes, anything else as UTF-16BE hex.
export function pdfString(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return "(" + s.replace(/[\\()]/g, (c) => "\\" + c) + ")";
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return "<" + hex + ">";
}

export function buildPdf(pages, title = "") {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (part) => {
    const bytes = typeof part === "string" ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  // 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageIds = pages.map((_, i) => 4 + i * 3);
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
  obj(3, `<< /Producer (Scanner) /Title ${pdfString(title)} >>`);

  pages.forEach((pg, i) => {
    const id = pageIds[i];
    const W = 595;
    const H = Math.round((W * pg.height) / pg.width * 100) / 100;
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(id + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[id + 2] = length;
    push(`${id + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`);
    push(pg.jpeg);
    push("\nendstream\nendobj\n");
  });

  const size = 4 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
