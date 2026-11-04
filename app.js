import { detectQuad, DEFAULT_QUAD, outputSize, warp, rotate, applyFilter, fileBaseName } from "./scan.js";
import { buildPdf } from "./pdf.js";
import * as drive from "./drive.js";
import * as store from "./store.js";
import { GOOGLE_CLIENT_ID } from "./config.js";

const $ = (id) => document.getElementById(id);
const SOURCE_MAX = 3000; // long side kept from the camera photo
const PAGE_MAX = 2400;   // long side of a finished page (~250 dpi on A4)

// ---------- settings ----------

function setting(key, fallback) {
  try { return localStorage.getItem("scanner." + key) ?? fallback; } catch { return fallback; }
}
function setSetting(key, value) {
  try { localStorage.setItem("scanner." + key, value); } catch { /* private mode */ }
}
const clientId = () => setting("clientId", "") || GOOGLE_CLIENT_ID;
const categories = () =>
  setting("categories", "Receipts, Documents, Other").split(",").map((s) => s.trim()).filter(Boolean);

// ---------- small helpers ----------

function status(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

function busy(text) {
  $("busy").hidden = !text;
  $("busy-text").textContent = text || "";
  // Let the overlay paint before heavy work blocks the thread.
  // (The timeout covers a page in the background, where frames don't run.)
  return new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 60); });
}

function show(screen) {
  for (const id of ["home", "crop", "review"]) $(id).hidden = id !== screen;
  window.scrollTo(0, 0);
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function pixels(canvas) {
  return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

function toCanvas(img) {
  const c = canvasOf(img.width, img.height);
  const data = img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height);
  c.getContext("2d").putImageData(data, 0, 0);
  return c;
}

function scaled(source, maxSide) {
  const k = Math.min(1, maxSide / Math.max(source.width, source.height));
  const c = canvasOf(Math.max(1, Math.round(source.width * k)), Math.max(1, Math.round(source.height * k)));
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

const jpeg = (canvas, q) => new Promise((r) => canvas.toBlob(r, "image/jpeg", q));

// ---------- the scan in progress ----------

// pages: [{ source: canvas, quad: [[x,y]×4] in source px, turns, flat: canvas, thumb: url }]
let pages = [];
let editing = null;     // index being cropped, or pages.length for a new one
let editSource = null;  // canvas of the photo being cropped
let editQuad = null;

function filter() {
  return document.querySelector('input[name="filter"]:checked')?.value || "enhanced";
}
function format() {
  return document.querySelector('input[name="format"]:checked')?.value || "pdf";
}
function category() {
  return document.querySelector('input[name="category"]:checked')?.value || categories()[0];
}

async function loadPhoto(file) {
  const bmp = await createImageBitmap(file); // applies the photo's rotation tag
  const c = scaled(bmp, SOURCE_MAX);
  bmp.close?.();
  return c;
}

function autoQuad(source) {
  const small = scaled(source, 400);
  const q = detectQuad(pixels(small)) || DEFAULT_QUAD;
  return q.map(([x, y]) => [x * source.width, y * source.height]);
}

async function addPhotos(files) {
  if (!files.length) return;
  await busy("Opening photo…");
  try {
    const list = [...files];
    // With several photos picked at once, trust the auto-crop and go straight
    // to review; each page can still be re-cropped from there.
    if (list.length > 1) {
      for (const f of list) {
        const source = await loadPhoto(f);
        const page = { source, quad: autoQuad(source), turns: 0 };
        await flatten(page);
        pages.push(page);
      }
      await renderPages();
      show("review");
      return;
    }
    editSource = await loadPhoto(list[0]);
    editQuad = autoQuad(editSource);
    editing = pages.length;
    show("crop");
    drawCrop();
  } catch (e) {
    status("Couldn't open that photo: " + e.message, "bad");
  } finally {
    busy(null);
  }
}

async function flatten(page) {
  const size = outputSize(page.quad, PAGE_MAX);
  const flat = rotate(warp(pixels(page.source), page.quad, size.width, size.height), page.turns);
  page.flat = toCanvas(flat);
}

async function thumbFor(page) {
  const small = scaled(page.flat, 360);
  const out = toCanvas(applyFilter(pixels(small), filter()));
  const blob = await jpeg(out, 0.8);
  if (page.thumb) URL.revokeObjectURL(page.thumb);
  page.thumb = URL.createObjectURL(blob);
}

async function renderPages() {
  const box = $("pages");
  box.replaceChildren();
  for (const [i, page] of pages.entries()) {
    await thumbFor(page);
    const fig = document.createElement("figure");
    fig.className = "page";
    const img = document.createElement("img");
    img.src = page.thumb;
    img.alt = `Page ${i + 1}`;
    const cap = document.createElement("figcaption");
    const n = document.createElement("span");
    n.textContent = pages.length > 1 ? `${i + 1}` : "";
    const tools = document.createElement("span");
    tools.className = "tools";
    tools.append(
      iconButton("↻", "Turn page", () => turnPage(i)),
      iconButton("✎", "Re-crop page", () => recrop(i)),
      iconButton("✕", "Remove page", () => removePage(i)),
    );
    cap.append(n, tools);
    fig.append(img, cap);
    box.append(fig);
  }
  updatePreview();
}

function iconButton(text, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon";
  b.textContent = text;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.addEventListener("click", onClick);
  return b;
}

async function turnPage(i) {
  await busy("Turning…");
  pages[i].turns = (pages[i].turns + 1) % 4;
  pages[i].flat = toCanvas(rotate(pixels(pages[i].flat), 1));
  await renderPages();
  busy(null);
}

function recrop(i) {
  editing = i;
  editSource = pages[i].source;
  editQuad = pages[i].quad.map((p) => [...p]);
  show("crop");
  drawCrop();
}

async function removePage(i) {
  if (pages[i].thumb) URL.revokeObjectURL(pages[i].thumb);
  pages.splice(i, 1);
  if (!pages.length) return resetScan();
  await renderPages();
}

function resetScan() {
  for (const p of pages) if (p.thumb) URL.revokeObjectURL(p.thumb);
  pages = [];
  editing = editSource = editQuad = null;
  $("title").value = "";
  $("note").value = "";
  show("home");
}

function fileNames() {
  const base = fileBaseName(new Date(), $("title").value);
  if (format() === "pdf" || pages.length === 1) return [base + (format() === "pdf" ? ".pdf" : ".jpg")];
  return pages.map((_, i) => `${base} (${i + 1} of ${pages.length}).jpg`);
}

function updatePreview() {
  const names = fileNames();
  $("file-preview").textContent =
    `Scans › ${category()} › ${names[0]}` + (names.length > 1 ? ` and ${names.length - 1} more` : "");
}

// ---------- crop screen ----------

const view = { scale: 1, dragging: -1, pointer: null };

function drawCrop() {
  const canvas = $("crop-canvas");
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const maxW = wrap.clientWidth;
  const maxH = Math.max(240, window.innerHeight - 190);
  const k = Math.min(maxW / editSource.width, maxH / editSource.height);
  const cssW = Math.round(editSource.width * k), cssH = Math.round(editSource.height * k);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  view.scale = canvas.width / editSource.width; // device px per source px
  const g = canvas.getContext("2d");
  g.drawImage(editSource, 0, 0, canvas.width, canvas.height);

  const q = editQuad.map(([x, y]) => [x * view.scale, y * view.scale]);
  // Dim everything outside the page.
  g.save();
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.beginPath();
  g.rect(0, 0, canvas.width, canvas.height);
  g.moveTo(...q[0]); for (const p of q.slice(1)) g.lineTo(...p); g.closePath();
  g.fill("evenodd");
  g.restore();

  g.strokeStyle = "#5fd18b";
  g.lineWidth = 2.5 * dpr;
  g.beginPath();
  g.moveTo(...q[0]); for (const p of q.slice(1)) g.lineTo(...p); g.closePath();
  g.stroke();

  for (const [i, [x, y]] of q.entries()) {
    g.beginPath();
    g.arc(x, y, (view.dragging === i ? 14 : 11) * dpr, 0, Math.PI * 2);
    g.fillStyle = "rgba(95,209,139,0.35)";
    g.fill();
    g.lineWidth = 3 * dpr;
    g.stroke();
  }

  if (view.dragging >= 0) drawLoupe(g, q[view.dragging], dpr);
}

// A magnified circle away from the finger, so the corner can be placed exactly.
function drawLoupe(g, [hx, hy], dpr) {
  const r = 58 * dpr, zoom = 2.5;
  const cx = hx < g.canvas.width / 2 ? g.canvas.width - r - 10 * dpr : r + 10 * dpr;
  const cy = r + 10 * dpr;
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  const sx = hx / view.scale, sy = hy / view.scale;
  const span = (r * 2) / (view.scale * zoom); // source px across the loupe
  g.fillStyle = "#000";
  g.fillRect(cx - r, cy - r, r * 2, r * 2);
  g.drawImage(editSource, sx - span / 2, sy - span / 2, span, span, cx - r, cy - r, r * 2, r * 2);
  g.strokeStyle = "#5fd18b";
  g.lineWidth = 1.5 * dpr;
  g.beginPath();
  g.moveTo(cx - 12 * dpr, cy); g.lineTo(cx + 12 * dpr, cy);
  g.moveTo(cx, cy - 12 * dpr); g.lineTo(cx, cy + 12 * dpr);
  g.stroke();
  g.restore();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.strokeStyle = "#fff";
  g.lineWidth = 3 * dpr;
  g.stroke();
}

function sourcePoint(ev) {
  const rect = $("crop-canvas").getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return [
    ((ev.clientX - rect.left) * dpr) / view.scale,
    ((ev.clientY - rect.top) * dpr) / view.scale,
  ];
}

function cropDown(ev) {
  const [x, y] = sourcePoint(ev);
  const reach = (44 * (window.devicePixelRatio || 1)) / view.scale;
  let best = -1, bestD = reach;
  editQuad.forEach(([qx, qy], i) => {
    const d = Math.hypot(qx - x, qy - y);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0) return;
  view.dragging = best;
  // Keep the finger's offset from the corner so it doesn't jump.
  view.pointer = [editQuad[best][0] - x, editQuad[best][1] - y];
  $("crop-canvas").setPointerCapture(ev.pointerId);
  drawCrop();
}

function cropMove(ev) {
  if (view.dragging < 0) return;
  const [x, y] = sourcePoint(ev);
  const nx = Math.min(editSource.width, Math.max(0, x + view.pointer[0]));
  const ny = Math.min(editSource.height, Math.max(0, y + view.pointer[1]));
  editQuad[view.dragging] = [nx, ny];
  drawCrop();
}

function cropUp() {
  if (view.dragging < 0) return;
  view.dragging = -1;
  drawCrop();
}

async function cropDone() {
  await busy("Flattening page…");
  try {
    const existing = editing < pages.length ? pages[editing] : null;
    const page = existing || { source: editSource, turns: 0 };
    page.quad = editQuad;
    await flatten(page);
    if (!existing) pages.push(page);
    editSource = editQuad = null;
    await renderPages();
    show("review");
  } catch (e) {
    status("That shape can't be flattened. Move the corners apart a little.", "bad");
  } finally {
    busy(null);
  }
}

function cropCancel() {
  editSource = editQuad = null;
  show(pages.length ? "review" : "home");
}

// ---------- saving ----------

async function saveScan() {
  if (!pages.length) return;
  if (!clientId()) {
    status("Add the Google client ID in Settings first. The scan is kept on this screen.", "bad");
    return;
  }
  await busy("Making the file…");
  try {
    const look = filter();
    const quality = look === "bw" ? 0.8 : 0.85;
    const jpegs = [];
    for (const page of pages) {
      const out = toCanvas(applyFilter(pixels(page.flat), look));
      const blob = await jpeg(out, quality);
      jpegs.push({ blob, width: out.width, height: out.height });
    }
    const names = fileNames();
    const common = { category: category(), note: $("note").value.trim() };
    if (format() === "pdf") {
      const parts = await Promise.all(jpegs.map(async (j) => ({
        jpeg: new Uint8Array(await j.blob.arrayBuffer()), width: j.width, height: j.height,
      })));
      const pdf = buildPdf(parts, names[0].replace(/\.pdf$/, ""));
      await store.add({ ...common, name: names[0], mimeType: "application/pdf", blob: new Blob([pdf], { type: "application/pdf" }) });
    } else {
      for (const [i, j] of jpegs.entries()) {
        await store.add({ ...common, name: names[i], mimeType: "image/jpeg", blob: j.blob });
      }
    }
    setSetting("filter", look);
    setSetting("format", format());
    resetScan();
  } catch (e) {
    status("Couldn't make the file: " + e.message, "bad");
    busy(null);
    return;
  }
  busy(null);
  await sendOutbox({ signInIfNeeded: true });
}

let sending = false;

async function sendOutbox({ signInIfNeeded = false } = {}) {
  if (sending) return;
  const items = await store.all();
  await renderOutbox(items);
  if (!items.length) return;
  const acct = drive.account();
  if (!acct?.valid) {
    if (signInIfNeeded && clientId() && navigator.onLine) {
      status("Signing in to Google…");
      drive.signIn(clientId());
    } else {
      status(`${items.length} waiting. Sign in to upload.`, "warn");
    }
    return;
  }
  if (!navigator.onLine) {
    status(`No signal. ${items.length} saved on the phone; they'll upload when you're back online.`, "warn");
    return;
  }
  sending = true;
  let done = 0;
  try {
    for (const item of items) {
      await busy(`Uploading ${item.name}…`);
      try {
        const file = await drive.upload(item);
        await store.remove(item.id);
        store.addRecent({ name: file.name, link: file.webViewLink, folder: item.category, at: Date.now() });
        done++;
      } catch (e) {
        if (e instanceof drive.AuthError) {
          busy(null);
          sending = false;
          if (signInIfNeeded) { drive.signIn(clientId()); return; }
          status("Google sign-in has lapsed. Tap Upload now to sign in again.", "warn");
          break;
        }
        await store.put({ ...item, error: e.message });
        status(`Upload failed: ${e.message}. It's saved on the phone; try again later.`, "bad");
        break;
      }
    }
    if (done) status(done === 1 ? "Saved to Drive." : `${done} files saved to Drive.`, "good");
  } finally {
    sending = false;
    busy(null);
    await renderOutbox();
    renderRecent();
  }
}

async function renderOutbox(items) {
  items = items || (await store.all());
  $("outbox").hidden = !items.length;
  $("outbox-list").replaceChildren(...items.map((it) => {
    const li = document.createElement("li");
    li.textContent = `${it.category} › ${it.name}`;
    if (it.error) {
      const e = document.createElement("small");
      e.className = "bad";
      e.textContent = " " + it.error;
      li.append(e);
    }
    const del = iconButton("✕", "Delete this waiting scan", async () => {
      if (!confirm(`Delete "${it.name}" from the phone? It hasn't been uploaded.`)) return;
      await store.remove(it.id);
      renderOutbox();
    });
    li.append(del);
    return li;
  }));
}

function renderRecent() {
  const list = store.recent();
  const ul = $("recent");
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Nothing yet.";
    ul.replaceChildren(li);
  } else {
    ul.replaceChildren(...list.map((r) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = r.link || drive.folderLink();
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = r.name;
      const when = document.createElement("small");
      when.className = "muted";
      when.textContent = ` ${r.folder} · ${new Date(r.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
      li.append(a, when);
      return li;
    }));
  }
  $("drive-link").href = drive.folderLink();
}

// ---------- account, settings, start ----------

function renderAccount() {
  const acct = drive.account();
  const btn = $("account");
  btn.textContent = acct?.email ? `${acct.email} · Sign out` : "Sign in";
  btn.onclick = () => {
    if (acct?.email) {
      if (!confirm("Sign out of Google on this phone?")) return;
      drive.signOut();
      renderAccount();
      status("Signed out.");
    } else if (clientId()) {
      drive.signIn(clientId());
    } else {
      $("settings").open = true;
      status("Add the Google client ID first.", "warn");
    }
  };
  $("setup").hidden = !!clientId();
}

function renderCategories() {
  const box = $("categories");
  const chosen = setting("category", categories()[0]);
  const current = categories().includes(chosen) ? chosen : categories()[0];
  box.querySelectorAll("label").forEach((l) => l.remove());
  for (const c of categories()) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "category";
    input.value = c;
    input.checked = c === current;
    input.addEventListener("change", () => { setSetting("category", c); updatePreview(); });
    const span = document.createElement("span");
    span.textContent = c;
    label.append(input, span);
    box.append(label);
  }
}

function wire() {
  for (const id of ["camera", "gallery"]) {
    $(id).addEventListener("change", (ev) => {
      const files = [...ev.target.files];
      ev.target.value = ""; // same photo can be picked again
      addPhotos(files);
    });
  }
  const canvas = $("crop-canvas");
  canvas.addEventListener("pointerdown", cropDown);
  canvas.addEventListener("pointermove", cropMove);
  canvas.addEventListener("pointerup", cropUp);
  canvas.addEventListener("pointercancel", cropUp);
  window.addEventListener("resize", () => { if (!$("crop").hidden) drawCrop(); });
  $("crop-cancel").onclick = cropCancel;
  $("crop-done").onclick = cropDone;
  $("crop-auto").onclick = () => { editQuad = autoQuad(editSource); drawCrop(); };
  $("crop-whole").onclick = () => {
    const { width: w, height: h } = editSource;
    editQuad = [[0, 0], [w, 0], [w, h], [0, h]];
    drawCrop();
  };

  document.querySelectorAll('input[name="filter"]').forEach((r) => r.addEventListener("change", async () => {
    await busy("Applying…");
    await renderPages();
    busy(null);
  }));
  document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener("change", updatePreview));
  $("title").addEventListener("input", updatePreview);
  $("save").onclick = saveScan;
  $("discard").onclick = () => { if (confirm("Discard this scan?")) resetScan(); };
  $("retry").onclick = () => sendOutbox({ signInIfNeeded: true });
  window.addEventListener("online", () => sendOutbox());

  $("redirect-uri").textContent = drive.redirectUri();
  $("client-id").value = clientId();
  $("category-list").value = categories().join(", ");
  $("save-settings").onclick = () => {
    setSetting("clientId", $("client-id").value.trim());
    const cats = $("category-list").value.split(",").map((s) => s.trim().replace(/[\\/]/g, "-")).filter(Boolean);
    if (cats.length) setSetting("categories", cats.join(", "));
    renderCategories();
    renderAccount();
    status("Settings saved.", "good");
  };

  const f = setting("filter", "enhanced");
  const fmt = setting("format", "pdf");
  (document.querySelector(`input[name="filter"][value="${f}"]`) || {}).checked = true;
  (document.querySelector(`input[name="format"][value="${fmt}"]`) || {}).checked = true;
}

async function start() {
  wire();
  renderCategories();
  const back = await drive.finishSignIn();
  if (back?.error) {
    status(back.error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed: " + back.error, "bad");
  }
  renderAccount();
  renderRecent();
  navigator.storage?.persist?.().catch(() => {});
  await sendOutbox();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

start();

// For checks on a local copy only.
if (["localhost", "127.0.0.1"].includes(location.hostname)) window.scannerDebug = { addPhotos, pages: () => pages, store };
