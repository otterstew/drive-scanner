// Google sign-in (OAuth token by redirect, no Google script on the page) and
// Drive uploads. Scope drive.file: the app can only see and change files and
// folders it created itself, nothing else in your Drive.

const SCOPE = "https://www.googleapis.com/auth/drive.file email";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const KEY = "scanner.token";

export const ROOT_FOLDER = "Scans";

export class AuthError extends Error {}

function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function redirectUri() {
  return location.origin + location.pathname;
}

export function signIn(clientId) {
  const state = crypto.getRandomValues(new Uint32Array(4)).join("-");
  save("scanner.state", state);
  const prev = load(KEY);
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
  });
  if (prev?.email) q.set("login_hint", prev.email);
  location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q);
}

// Call once on load. Picks the token out of the URL after Google sends us back.
export async function finishSignIn() {
  if (!location.hash.includes("access_token") && !location.hash.includes("error=")) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  const expected = load("scanner.state");
  localStorage.removeItem("scanner.state");
  if (h.get("error")) return { error: h.get("error") };
  if (!expected || h.get("state") !== expected) return { error: "state_mismatch" };
  const token = {
    access: h.get("access_token"),
    expires: Date.now() + (Number(h.get("expires_in")) || 3600) * 1000,
    email: load(KEY)?.email || "",
  };
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + token.access },
    });
    if (r.ok) token.email = (await r.json()).email || token.email;
  } catch { /* email is only a convenience */ }
  save(KEY, token);
  return { ok: true, email: token.email };
}

export function account() {
  const t = load(KEY);
  return t ? { email: t.email, valid: t.expires > Date.now() + 60_000 } : null;
}

export function signOut() {
  const t = load(KEY);
  localStorage.removeItem(KEY);
  localStorage.removeItem("scanner.folders");
  if (t?.access) {
    fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t.access), { method: "POST" }).catch(() => {});
  }
}

function token() {
  const t = load(KEY);
  if (!t || t.expires < Date.now() + 30_000) throw new AuthError("signed out");
  return t.access;
}

async function call(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: "Bearer " + token(), ...(init.headers || {}) },
  });
  if (r.status === 401) {
    const t = load(KEY);
    if (t) save(KEY, { ...t, expires: 0 });
    throw new AuthError("token expired");
  }
  return r;
}

async function json(r) {
  if (!r.ok) {
    let msg = r.status + "";
    try { msg = (await r.json()).error?.message || msg; } catch { /* keep status */ }
    const e = new Error("Drive: " + msg);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

const quoted = (s) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

async function findOrCreate(name, parent) {
  const q = `name = ${quoted(name)} and mimeType = '${FOLDER}' and trashed = false and ${quoted(parent)} in parents`;
  const found = await json(await call(`${API}/files?` + new URLSearchParams({ q, fields: "files(id)", spaces: "drive" })));
  if (found.files?.length) return found.files[0].id;
  const made = await json(await call(`${API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  }));
  return made.id;
}

async function usable(id) {
  const r = await call(`${API}/files/${encodeURIComponent(id)}?fields=trashed`);
  if (r.status === 404) return false;
  return !(await json(r)).trashed;
}

// Scans/<category>, created on first use and remembered. A remembered folder
// that has since been binned is replaced, so scans never land in the bin.
async function folderFor(category, fresh = false) {
  let cache = fresh ? {} : load("scanner.folders") || {};
  if (cache[category] && !(await usable(cache[category]))) cache = {};
  if (!cache[ROOT_FOLDER]) cache[ROOT_FOLDER] = await findOrCreate(ROOT_FOLDER, "root");
  if (!cache[category]) cache[category] = await findOrCreate(category, cache[ROOT_FOLDER]);
  save("scanner.folders", cache);
  return cache[category];
}

async function send(blob, meta) {
  if (blob.size < 4_500_000) {
    const boundary = "scan" + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(meta),
      `\r\n--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    return json(await call(`${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }));
  }
  // Bigger than multipart allows: resumable session, then one PUT.
  const start = await call(`${UPLOAD}?uploadType=resumable&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": meta.mimeType },
    body: JSON.stringify(meta),
  });
  if (!start.ok) await json(start);
  const where = start.headers.get("Location");
  if (!where) throw new Error("Drive did not return an upload address");
  return json(await call(where, { method: "PUT", headers: { "Content-Type": meta.mimeType }, body: blob }));
}

// item: { blob, name, mimeType, category, note }
export async function upload(item) {
  const meta = (parent) => ({
    name: item.name,
    mimeType: item.mimeType,
    parents: [parent],
    ...(item.note ? { description: item.note } : {}),
  });
  try {
    return await send(item.blob, meta(await folderFor(item.category)));
  } catch (e) {
    // The folder was deleted or trashed since we remembered it: look again once.
    if (e.status === 404) return send(item.blob, meta(await folderFor(item.category, true)));
    throw e;
  }
}

export function folderLink() {
  const id = (load("scanner.folders") || {})[ROOT_FOLDER];
  return id ? `https://drive.google.com/drive/folders/${id}` : "https://drive.google.com/drive/my-drive";
}
