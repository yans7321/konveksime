// DIAGNOSTIC ONLY — not part of the test suite, not committed.
// Simulates the browser environment (DOM ids used by the auth forms, a
// localStorage stub, real fetch) and loads the REAL app-api.js to reproduce
// exactly what the frontend does on Register and Google sign-in.
// Usage: node tests/bridge.sim.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const BASE = process.env.BASE_URL || "http://localhost:3000";

// --- minimal browser shims ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
function el(id, value = "") {
  return { id, value, classList: { add: () => {}, remove: () => {} }, innerText: "" };
}
const els = {
  "auth-error": el("auth-error"),
  "login-username": el("login-username"),
  "login-password": el("login-password"),
  "reg-name": el("reg-name", "Tester"),
  "reg-username": el("reg-username", "tester01"),
  "reg-password": el("reg-password", "test1234"),
};
globalThis.document = {
  readyState: "complete",
  getElementById: (id) => (id in els ? els[id] : null),
  addEventListener: () => {},
};
globalThis.window = globalThis;
globalThis.location = { origin: BASE, href: BASE + "/", reload: () => {} };
globalThis.open = (u) => ({ close() {}, closed: false, postMessage: () => {} });
globalThis.alert = () => {};
globalThis.addEventListener = () => {};

// Node fetch cannot resolve relative URLs; emulate browser base-URL resolution.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = typeof input === "string" && input.startsWith("/") ? BASE + input : input;
  return realFetch(u, init);
};

// --- original inline-script globals app-api.js hooks into ---
globalThis.db = {
  users: [], currentUser: null, perusahaan: [], pekerja: ["Pak Budi"],
  tab1: [], tab2: [], tab3: [], tab5: [], gajiStatus: {}, expenses: [], kasbon: [], aset: [],
};
globalThis.saveData = () => {};
globalThis.checkAuth = () => { globalThis.__checkAuthCalls = (globalThis.__checkAuthCalls || 0) + 1; };
globalThis.handleLogout = () => {};
globalThis.deletePekerja = () => {};
globalThis.deletePerusahaan = () => {};

const src = fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "app-api.js"), "utf8");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function show(title) {
  const err = els["auth-error"].innerText;
  console.log(`\n== ${title} ==`);
  console.log("auth-error box:", err ? JSON.stringify(err) : "(empty)");
  console.log("token stored:", localStorage.getItem("yans_api_token") ? "yes" : "no");
  console.log("currentUser:", globalThis.db.currentUser ? globalThis.db.currentUser.username : null);
  console.log("YansApi.status():", JSON.stringify(window.YansApi ? window.YansApi.status() : "n/a"));
}

// load the bridge (IIFE, defer-style immediate execution)
new Function(src)();

console.log("=== BASE:", BASE, "===");
console.log("hooks installed:", typeof window.handleLogin, typeof window.handleRegister, "YansGoogleSignIn:", typeof window.YansGoogleSignIn);

// --- Scenario 1: original localStorage register (no server) ---
show("A) Register via ORIGINAL localStorage handler");
delete globalThis.handleRegister; // restore original: plain local register
globalThis.handleRegister = function (e) {
  if (e && e.preventDefault) e.preventDefault();
  db.users.push({ id: 1, name: els["reg-name"].value, username: els["reg-username"].value, password: els["reg-password"].value, permissions: ["tab1"] });
  db.currentUser = db.users[0];
};
new Function(src)(); // hook it again
{
  const e = { preventDefault: () => {} };
  window.handleRegister(e);
  await wait(400); // wrapper is async; give the fetch/fallback chain time to settle
}
show("A) result after hooked handleRegister");

// --- Scenario 2: original localStorage login of a pre-existing local account (server 401 path) ---
console.log("\n== B) Login existing local account (server 503 -> fallback) ==");
{
  const e = { preventDefault: () => {} };
  els["login-username"].value = "tester01";
  els["login-password"].value = "test1234";
  delete globalThis.handleLogin;
  globalThis.handleLogin = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    const found = db.users.find((u) => u.username === els["login-username"].value && u.password === els["login-password"].value);
    if (found) { db.currentUser = found; }
  };
  new Function(src)();
  window.handleLogin(e);
  await wait(400);
}
show("B) result after hooked handleLogin");

// --- Scenario 3: Google sign-in click ---
console.log("\n== C) Google Login click (YansGoogleSignIn) ==");
let popupUrl = null;
globalThis.open = (u) => { popupUrl = u; return { close() {}, closed: false, postMessage: () => {} }; };
window.YansGoogleSignIn();
console.log("popup URL:", popupUrl);
{
  const res = await fetch(BASE + popupUrl).catch((e) => ({ status: 0, error: e }));
  const text = res.error ? String(res.error) : await res.text();
  console.log("GET", popupUrl, "-> HTTP", res.status);
  if (res.error) console.log("fetch error:", res.error.message);
  else console.log("body:", text.slice(0, 200).replace(/\s+/g, " "));
}

// --- Scenario 4: restoreSession on page load (token present but invalid) ---
console.log("\n== D) restoreSession with stale token ==");
localStorage.setItem("yans_api_token", "stale-token-xyz");
delete globalThis.handleLogin; delete globalThis.handleRegister; delete globalThis.handleLogout;
new Function(src)();
// restoreSession auto-runs (readyState complete); give the fetch a tick
await new Promise((r) => setTimeout(r, 300));
console.log("token after restoreSession:", localStorage.getItem("yans_api_token"));
show("D) state after restoreSession");
