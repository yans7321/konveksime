// Konveksi YANS — Phase 1 API bridge.
// Adds server-side persistence (Netlify Functions + PostgreSQL) and Google login
// on top of the existing app WITHOUT removing localStorage. All existing flows
// keep working: if the server/database is unavailable, the original localStorage
// behaviour is used as fallback.
//
// Notes:
// - `db`, `saveData`, `checkAuth`, ... are top-level bindings of the inline
//   script in index.html. Function declarations become window properties (so
//   hooking window.handleLogin works); `let db` does NOT, so we must not rely
//   on window.db — accessing the bare identifier works because this file runs
//   in the same page global scope.
// - Login/register hit the server API first; on server unavailability (503 /
//   network error) they fall back to the original localStorage handlers, and on
//   a genuine 401 they fall back too so pre-migration local accounts keep
//   working until they next sign in (which upserts them server-side).
// - LocalStorage stays the source of truth for existing behavior; pekerja and
//   perusahaan are mirrored to the database per user (idempotent upserts).
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var TOKEN_KEY = "yans_api_token";
  var GOOGLE_ORIGIN = "https://accounts.google.com";
  var DEFAULT_PERMS = ["tab1", "tab2", "tab3", "tab5", "tab4", "kasbon", "tab6", "tab7", "aset", "arsip", "member"];

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* storage unavailable */ }
  }

  function authFetch(action, payload) {
    var headers = { "Content-Type": "application/json" };
    var t = getToken();
    if (t) headers["Authorization"] = "Bearer " + t;
    return fetch("/api/auth", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    }).then(
      function (res) { return res; },
      function () {
        var err = new Error("offline");
        err.status = 0;
        err.code = "network";
        throw err;
      }
    );
  }

  function parseJson(res) {
    return res.json().catch(function () { return {}; });
  }

  function api(action, payload) {
    return authFetch(action, payload).then(function (res) {
      return parseJson(res).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || "Request gagal.");
          err.status = res.status;
          err.code = data.error || "error";
          throw err;
        }
        return data;
      });
    });
  }

  function syncFetch(kind, items) {
    var headers = { "Content-Type": "application/json" };
    var t = getToken();
    if (t) headers["Authorization"] = "Bearer " + t;
    return fetch("/api/sync", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ kind: kind, items: items }),
    }).then(function (res) {
      return parseJson(res).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || "Sync gagal.");
          err.status = res.status;
          err.code = data.error || "error";
          throw err;
        }
        return data;
      });
    });
  }

  // ---------- Session handling ----------

  function applySession(payload) {
    if (!payload || !payload.user) return;
    setToken(payload.token || null);
    var u = payload.user;
    var localName = u.username || u.email || u.name || "user";
    var existing = null;
    if (typeof db !== "undefined" && Array.isArray(db.users)) {
      existing = db.users.find(function (x) {
        return (x.username || "").toLowerCase() === localName.toLowerCase();
      });
      if (!existing) {
        // Also match via the stored server-account map (username renamed
        // locally, or the mirror row carries dbId from a prior session).
        try {
          var umap = JSON.parse(localStorage.getItem("yans_dbmap_user")) || {};
          if (umap.dbId) existing = db.users.find(function (x) { return x.dbId == umap.dbId; });
        } catch (e2) { /* ignore */ }
      }
    }
    // Keep local permissions when the account already exists locally (localStorage
    // stays authoritative for member management in Phase 1).
    var perms = existing && existing.permissions && existing.permissions.length
      ? existing.permissions
      : (u.permissions && u.permissions.length ? u.permissions : DEFAULT_PERMS);

    if (existing) {
      existing.name = u.name || existing.name || "User";
      if (u.email) existing.email = u.email;
      existing.provider = u.provider || "local";
      existing.dbId = u.id;
      if (typeof db !== "undefined") db.currentUser = existing;
    } else {
      var mirror = {
        id: Date.now(),
        name: u.name || u.email || "User",
        username: localName,
        email: u.email || null,
        provider: u.provider || "local",
        dbId: u.id,
        permissions: perms,
      };
      if (typeof db !== "undefined") {
        db.users.push(mirror);
        db.currentUser = mirror;
      }
    }
    if (typeof saveData === "function") saveData();
    if (typeof checkAuth === "function") checkAuth();
  }

  function restoreSession() {
    var t = getToken();
    if (!t || typeof checkAuth !== "function") {
      if (typeof checkAuth === "function") checkAuth();
      return;
    }
    api("me")
      .then(function (res) {
        if (res && res.user) {
          applySession({ user: res.user, token: t });
          // Refresh the local Pekerjaan mirror (and the local<->server job id
          // map) right after the session is restored.
          if (typeof window.YansJobs !== "undefined" && window.YansJobs.pullJobs) {
            try { window.YansJobs.pullJobs(); } catch (e2) { /* best effort */ }
          }
        }
        else setToken(null);
        if (typeof checkAuth === "function") checkAuth();
      })
      .catch(function () {
        setToken(null);
        if (typeof checkAuth === "function") checkAuth();
      });
  }

  // ---------- Hooks around the existing handlers (fallback preserved) ----------

  function isServerUnavailable(err) {
    return !err || !err.status || err.status === 0 || err.status === 503 || err.code === "db_not_configured" || err.code === "network";
  }

  // Maps a server account to its local mirror row so applySession() updates
  // the existing local user (keeping its permissions) instead of appending a
  // duplicate entry to the member list.
  function saveServerUserMap(res) {
    try {
      if (!res || !res.user) return;
      var key = String(res.user.username || res.user.email || "").toLowerCase();
      if (!key) return;
      localStorage.setItem("yans_dbmap_user", JSON.stringify({ key: key, dbId: res.user.id }));
    } catch (e) { /* ignore */ }
  }

  // Upserts a legacy localStorage-only account into app_users so the SAME
  // credentials work in any browser (server becomes reachable for panels like
  // Ambil Jahit/Storan/Kiriman history). Best effort: failure (offline, 409
  // taken, db unconfigured) never blocks the local sign-in flow.
  function ensureServerAccount(username, password, name) {
    if (!username || !password) return Promise.resolve(null);
    return api("register", { name: name || username, username: username, password: password })
      .then(function (res) {
        saveServerUserMap(res);
        if (res && res.user && typeof db !== "undefined" && Array.isArray(db.users)) {
          var local = db.users.find(function (x) {
            return (x.username || "").toLowerCase() === String(res.user.username || "").toLowerCase();
          });
          if (local) local.dbId = res.user.id;
          if (typeof saveData === "function") saveData();
        }
        return res;
      })
      .catch(function () { return null; });
  }

  function showAuthError(msg) {
    var errDiv = document.getElementById("auth-error");
    if (errDiv) {
      errDiv.innerText = msg;
      errDiv.classList.remove("hidden");
    }
  }

  function hook(name, wrapper) {
    if (typeof window[name] === "function") {
      var original = window[name];
      window[name] = function () {
        return wrapper(original, Array.prototype.slice.call(arguments));
      };
    }
  }

  hook("handleLogin", function (original, args) {
    var e = args[0];
    if (e && e.preventDefault) e.preventDefault();
    var unameEl = document.getElementById("login-username");
    var passEl = document.getElementById("login-password");
    var uname = unameEl ? unameEl.value.trim() : "";
    var pass = passEl ? passEl.value : "";
    if (!uname || !pass) return original(e);
    api("login", { username: uname, password: pass })
      .then(function (res) {
        applySession(res);
        scheduleSync();
      })
      .catch(function (err) {
        // 401 also falls back so accounts that only exist in localStorage
        // (created before Phase 1) can still sign in; on a successful local
        // match the account is mirrored to the server (new scrypt hash of the
        // just-typed password) and the session is established, so the same
        // credentials now work in any browser and server panels go live.
        if (isServerUnavailable(err) || err.status === 401) {
          var result = original(e);
          if (err.status === 401 && typeof db !== "undefined" && Array.isArray(db.users)) {
            var matched = db.users.find(function (x) { return x.username === uname && x.password === pass; });
            if (matched && !matched.dbId) {
              ensureServerAccount(matched.username, pass, matched.name || matched.username)
                .then(function (res) {
                  if (res && res.user) return api("login", { username: matched.username, password: pass });
                  return null;
                })
                .then(function (res2) {
                  if (res2 && res2.user) { applySession(res2); scheduleSync(); }
                })
                .catch(function () { /* best effort; local login stands */ });
            }
          }
          return result;
        }
        showAuthError(err.message || "Login gagal.");
      });
  });

  hook("handleRegister", function (original, args) {
    var e = args[0];
    if (e && e.preventDefault) e.preventDefault();
    var nameEl = document.getElementById("reg-name");
    var unameEl = document.getElementById("reg-username");
    var passEl = document.getElementById("reg-password");
    var name = nameEl ? nameEl.value.trim() : "";
    var uname = unameEl ? unameEl.value.trim() : "";
    var pass = passEl ? passEl.value : "";
    if (!name || !uname || !pass) return original(e);
    api("register", { name: name, username: uname, password: pass })
      .then(function (res) {
        applySession(res);
        saveServerUserMap(res);
        scheduleSync();
      })
      .catch(function (err) {
        if (isServerUnavailable(err) || err.status === 409) return original(e);
        showAuthError(err.message || "Registrasi gagal.");
      });
  });

  hook("handleLogout", function (original, args) {
    var t = getToken();
    if (t) {
      api("logout").catch(function () { /* best effort */ });
      setToken(null);
    }
    return original.apply(null, args);
  });

  // Delete hooks add tombstones so deleted rows are not re-created by sync.
  hook("deletePekerja", function (original, args) {
    var name = args[0];
    addTombstone("pekerja", String(name));
    return original.apply(null, args);
  });
  hook("deletePerusahaan", function (original, args) {
    var id = args[0];
    var p = (typeof db !== "undefined" && Array.isArray(db.perusahaan))
      ? db.perusahaan.find(function (x) { return x.id == id; })
      : null;
    if (p && p.nama) addTombstone("perusahaan", String(p.nama));
    return original.apply(null, args);
  });

  // ---------- Google sign-in (popup) ----------

  function googleStart() {
    var w = window.open("/api/auth/google", "yans-google", "width=480,height=640");
    if (!w) {
      window.location.href = "/api/auth/google";
      return;
    }
    var handler = function (ev) {
      if (!ev.data || ev.data.type !== "yans-google-auth" || !ev.data.payload) return;
      // Only accept the session payload from our own origin. Google itself
      // never posts to this page; the callback page is served from our origin.
      if (ev.origin !== window.location.origin) return;
      window.removeEventListener("message", handler);
      applySession(ev.data.payload);
      scheduleSync();
    };
    window.addEventListener("message", handler);
  }
  window.YansGoogleSignIn = googleStart;

  // ---------- Pekerja / Perusahaan sync (Phase 1 foundation) ----------

  function tombKey(kind) { return "yans_tombstones_" + kind; }
  function getTombstones(kind) {
    try { return JSON.parse(localStorage.getItem(tombKey(kind))) || []; } catch (e) { return []; }
  }
  function addTombstone(kind, val) {
    try {
      var list = getTombstones(kind);
      if (list.indexOf(val) === -1) {
        list.push(val);
        if (list.length > 200) list = list.slice(-200);
        localStorage.setItem(tombKey(kind), JSON.stringify(list));
      }
    } catch (e) { /* ignore */ }
  }

  var syncing = false;
  var syncTimer = null;

  function syncPekerja() {
    if (typeof db === "undefined") return Promise.resolve({ kind: "pekerja", synced: 0 });
    var items = (db.pekerja || []).map(function (n) { return { nama: String(n) }; });
    return syncFetch("pekerja", items).then(function (res) {
      var tomb = getTombstones("pekerja");
      (res.items || []).forEach(function (row) {
        var nm = row.nama;
        if (nm && db.pekerja.indexOf(nm) === -1 && tomb.indexOf(nm) === -1) db.pekerja.push(nm);
      });
      if (typeof saveData === "function") saveData();
      return { kind: "pekerja", synced: res.synced };
    });
  }

  function syncPerusahaan() {
    if (typeof db === "undefined") return Promise.resolve({ kind: "perusahaan", synced: 0 });
    var items = (db.perusahaan || []).map(function (p) {
      return { nama: p.nama, pic: p.pic, telepon: p.telepon, catatan: p.catatan, legacyId: p.id };
    });
    return syncFetch("perusahaan", items).then(function (res) {
      var map = {};
      try { map = JSON.parse(localStorage.getItem("yans_dbmap_perusahaan")) || {}; } catch (e) { map = {}; }
      var tomb = getTombstones("perusahaan");
      (res.items || []).forEach(function (row) {
        var localId = map[row.id];
        var local = localId ? db.perusahaan.find(function (p) { return p.id == localId; }) : null;
        if (!local) {
          local = db.perusahaan.find(function (p) {
            return (p.nama || "").toLowerCase() === (row.nama || "").toLowerCase();
          });
        }
        if (local) {
          map[row.id] = local.id;
          local.pic = row.pic !== undefined ? row.pic : local.pic;
          local.telepon = row.telepon !== undefined ? row.telepon : local.telepon;
          local.catatan = row.catatan !== undefined ? row.catatan : local.catatan;
        } else if (tomb.indexOf(String(row.legacyId || row.id)) === -1 && tomb.indexOf(row.nama) === -1) {
          var nid = Date.now() + Math.floor(Math.random() * 1000);
          db.perusahaan.push({ id: nid, nama: row.nama, pic: row.pic, telepon: row.telepon, catatan: row.catatan });
          map[row.id] = nid;
        }
      });
      try { localStorage.setItem("yans_dbmap_perusahaan", JSON.stringify(map)); } catch (e) { /* ignore */ }
      if (typeof saveData === "function") saveData();
      return { kind: "perusahaan", synced: res.synced };
    });
  }

  function syncNow() {
    if (syncing) return Promise.resolve({ ok: false, reason: "already-running" });
    if (typeof db === "undefined" || !db.currentUser || !getToken()) return Promise.resolve({ ok: false, reason: "not-signed-in" });
    syncing = true;
    return syncPekerja()
      .then(function (a) {
        return syncPerusahaan().then(function (b) { return { ok: true, results: [a, b] }; });
      })
      .then(
        function (r) { syncing = false; return r; },
        function (err) {
          syncing = false;
          return { ok: false, reason: (err && err.message) || "sync-error" };
        }
      );
  }

  function scheduleSync() {
    // Run shortly after login so the first sync does not block rendering.
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      syncNow();
      // Mirror server-created jobs into the local Pekerjaan list (fills
      // yans_dbmap_pekerjaan so Ambil/Storan/Kiriman resolve server job ids).
      if (typeof window.YansJobs !== "undefined" && window.YansJobs.pullJobs) {
        try { window.YansJobs.pullJobs(); } catch (e) { /* best effort */ }
      }
    }, 1200);
  }

  window.YansApi = {
    restoreSession: restoreSession,
    syncNow: syncNow,
    pullJobs: function () {
      if (window.YansJobs && window.YansJobs.pullJobs) return window.YansJobs.pullJobs();
      return Promise.resolve({ ok: false, reason: "unavailable" });
    },
    status: function () {
      var signedIn = typeof db !== "undefined" && !!db.currentUser;
      return {
        hasToken: !!getToken(),
        signedIn: signedIn,
        user: signedIn ? db.currentUser.username : null,
      };
    },
  };

  // This file is loaded with `defer`, so it runs after the page script defines
  // db/checkAuth but before the window `load` event. Restoring the server session
  // here keeps index.html's original window.onload untouched.
  if (document.readyState === "complete") {
    restoreSession();
  } else {
    window.addEventListener("load", function () { restoreSession(); });
  }
})();
