// Konveksi YANS — Phase 6 ledger bridge (expenses / kasbon / aset).
// Wires the existing tab6/kasbon/aset UI to the server API (/api/ledger)
// WITHOUT changing existing behavior:
//   - db.expenses / db.kasbon / db.aset (localStorage mirror) keep working
//     exactly as before; saveData() and the local flow are untouched.
//   - When the user has a server session, each save/delete is mirrored to
//     PostgreSQL. The server row (stable bigserial id) is attached to the
//     local row as `dbId`; the local Date.now() id is sent as legacyId so the
//     server updates the same row on edit instead of duplicating it.
//   - Offline / no session: the original localStorage-only flow runs as-is
//     (server sync is retried on the next save after sign-in).
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var TOKEN_KEY = "yans_api_token";
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    var t = getToken();
    if (t) headers["Authorization"] = "Bearer " + t;
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || "Request gagal.");
          err.status = res.status;
          err.code = data.error || "error";
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function hasSession() {
    return typeof db !== "undefined" && !!db.currentUser && !!getToken();
  }

  // ---------- Payload builders (only real db.* fields; nothing invented) ----------

  // Only mirror rows that already live in db — no historical migration here.
  function payload(mod, item) {
    var body = {
      module: mod,
      legacyId: item.id,
      tanggal: item.tanggal || null,
    };
    if (mod === "expenses") {
      body.kategori = item.kategori || "Lain-lain";
      body.keterangan = item.keterangan;
      body.nominal = Number(item.nominal);
    } else if (mod === "kasbon") {
      body.keterangan = item.keterangan;
      body.jumlah = Number(item.jumlah);
    } else {
      body.nama = item.nama;
      body.harga = Number(item.harga);
    }
    return body;
  }

  function findLocal(listKey, id) {
    if (typeof db === "undefined") return null;
    return (db[listKey] || []).find(function (x) { return x.id == id; });
  }

  function syncOne(mod, listKey, id) {
    if (!hasSession()) return;
    var item = findLocal(listKey, id);
    if (!item) return;
    apiFetch("/api/ledger?module=" + mod, { method: "POST", body: payload(mod, item) })
      .then(function (data) {
        if (data && data.item && data.item.id) {
          item.dbId = data.item.id;
          if (typeof saveData === "function") saveData();
        }
      })
      .catch(function () { /* server unreachable: local row already saved */ });
  }

  function deleteOne(mod, id) {
    if (!hasSession()) return;
    var dbId = null;
    if (typeof db !== "undefined") {
      var item = (db.expenses || []).concat(db.kasbon || [], db.aset || [])
        .find(function (x) { return x.id == id; });
      dbId = item && item.dbId ? item.dbId : null;
    }
    if (!dbId) return; // never mirrored; nothing to delete server-side
    apiFetch("/api/ledger?module=" + mod + "&id=" + encodeURIComponent(dbId), { method: "DELETE" })
      .catch(function () { /* best-effort */ });
  }

  // ---------- Hooks (original handlers always run first) ----------

  function hook(name, wrapper) {
    if (typeof window[name] === "function") {
      var original = window[name];
      window[name] = function () {
        return wrapper(original, Array.prototype.slice.call(arguments));
      };
    }
  }

  // addExpenseItem pushes {id: Date.now(), ...} then calls saveData() —
  // mirror after the local save settles.
  hook("addExpenseItem", function (original, args) {
    var before = (db.expenses || []).length;
    var result = original.apply(null, args);
    if ((db.expenses || []).length > before) {
      syncOne("expenses", "expenses", db.expenses[db.expenses.length - 1].id);
    }
    return result;
  });

  hook("deleteExpenseItem", function (original, args) {
    var id = args[0];
    deleteOne("expenses", id);
    return original.apply(null, args);
  });

  hook("saveKasbon", function (original, args) {
    var before = (db.kasbon || []).length;
    var result = original.apply(null, args);
    if ((db.kasbon || []).length > before) {
      syncOne("kasbon", "kasbon", db.kasbon[db.kasbon.length - 1].id);
    }
    return result;
  });

  hook("deleteKasbon", function (original, args) {
    var id = args[0];
    deleteOne("kasbon", id);
    return original.apply(null, args);
  });

  hook("saveAset", function (original, args) {
    var before = (db.aset || []).length;
    var result = original.apply(null, args);
    if ((db.aset || []).length > before) {
      syncOne("aset", "aset", db.aset[db.aset.length - 1].id);
    }
    return result;
  });

  hook("deleteAset", function (original, args) {
    var id = args[0];
    deleteOne("aset", id);
    return original.apply(null, args);
  });

  // ---------- Public API ----------

  window.YansLedger = {
    status: function () {
      return {
        signedIn: hasSession(),
        counts: {
          expenses: (typeof db !== "undefined" && db.expenses || []).length,
          kasbon: (typeof db !== "undefined" && db.kasbon || []).length,
          aset: (typeof db !== "undefined" && db.aset || []).length,
        },
      };
    },
  };
})();
