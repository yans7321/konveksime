// Konveksi YANS — Phase 4 storages bridge (Storan).
// Wires the existing tab3 UI to the server transaction API (/api/storages)
// WITHOUT changing existing behavior:
//   - db.tab3 (localStorage mirror) keeps working exactly as before.
//   - When the user has a server session, each saved storan is mirrored to the
//     server, which re-validates quantity against live pickups - storages
//     (klop: jumlah_diambil - jumlah_stor).
//   - The storable table and history panel are additive UI driven by the
//     server's computed numbers (total / taken / stored / notStored) — never
//     trusted from the client.
//   - Offline / no session: legacy local flow untouched, storable table falls
//     back to local-only numbers with a status note.
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

  function el(id) { return document.getElementById(id); }

  function setStatus(text) {
    var s = el("t3-storable-status");
    if (s) s.innerText = text || "";
  }

  function setMaxHint(text) {
    var s = el("t3-max-hint");
    if (s) s.innerText = text || "";
  }

  // ---------- Storable table (server-computed; local fallback) ----------

  var storableIndex = {}; // jobCode -> {jobId, notStoredQuantity, ...}

  function localStorable() {
    // Fallback mirror when no server session: derive from local rows only.
    var out = [];
    (db.tab2 || []).forEach(function (p) {
      // Local pickup: total taken is the sum of its variant quantities.
      var taken = (p.variants || []).reduce(function (s, v) { return s + (Number(v.jumlah) || 0); }, 0);
      // Local storan linked to this pickup (by ambilId), already stored.
      var stored = (db.tab3 || []).filter(function (s) { return s.ambilId == p.id; })
        .reduce(function (sum, s) { return sum + (s.variants || []).reduce(function (a, v) { return a + (Number(v.jumlah) || 0); }, 0); }, 0);
      out.push({
        jobId: null,
        localPickupId: p.id,
        jobCode: p.kode || "-",
        namaPekerjaan: p.model || "",
        perusahaanNama: p.perusahaanNama || "-",
        totalQuantity: null,
        takenQuantity: taken,
        storedQuantity: stored,
        notStoredQuantity: taken - stored,
      });
    });
    return out.filter(function (j) { return j.notStoredQuantity > 0; });
  }

  function renderStorable(items) {
    var tbody = el("table-t3-storable");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-5 text-center text-slate-400 font-medium">Tidak ada pekerjaan dengan sisa belum distor.</td></tr>';
      return;
    }
    items.forEach(function (j) {
      if (j.jobCode) storableIndex[String(j.jobCode).trim()] = j; // for the max hint on the form
      var total = j.totalQuantity == null ? "—" : j.totalQuantity;
      var tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50 transition border-b border-slate-100";
      tr.innerHTML =
        '<td class="p-3"><span class="font-bold text-slate-900 block">' + escapeHtml(j.namaPekerjaan || "-") + '</span><span class="text-[10px] font-bold text-blue-600">' + escapeHtml(j.jobCode || "-") + "</span></td>" +
        '<td class="p-3 text-slate-600">' + escapeHtml(j.perusahaanNama || "-") + "</td>" +
        '<td class="p-3 text-center font-black text-slate-900">' + total + "</td>" +
        '<td class="p-3 text-center font-black text-indigo-600">' + j.takenQuantity + "</td>" +
        '<td class="p-3 text-center font-black text-amber-600">' + j.storedQuantity + "</td>" +
        '<td class="p-3 text-center font-black text-emerald-600">' + j.notStoredQuantity + "</td>";
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function refreshStorable() {
    if (!hasSession()) {
      renderStorable(localStorable());
      setStatus("Mode lokal — angka dari data browser ini. Login server untuk sinkron penuh.");
      return;
    }
    apiFetch("/api/storages?storable=1").then(function (data) {
      renderStorable(data.items || []);
      setStatus("Angka live dari server (diambil − sudah stor).");
    }).catch(function () {
      renderStorable(localStorable());
      setStatus("Server tidak terjangkau — angka lokal sementara.");
    });
  }

  // ---------- History (server only; local rows already in table-tab3) ----------

  function renderHistory(items) {
    var tbody = el("table-t3-history");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-5 text-center text-slate-400 font-medium">Belum ada transaksi storan terdaftar.</td></tr>';
      return;
    }
    items.forEach(function (s) {
      var tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50 transition border-b border-slate-100";
      tr.innerHTML =
        '<td class="p-3 text-slate-500">' + escapeHtml(String(s.storedAt || "").slice(0, 10)) + "</td>" +
        '<td class="p-3"><span class="font-bold text-slate-900 block">' + escapeHtml(s.namaPekerjaan || "-") + '</span><span class="text-[10px] font-bold text-blue-600">' + escapeHtml(s.jobCode || "-") + "</span></td>" +
        '<td class="p-3 text-slate-600">' + escapeHtml(s.perusahaanNama || "-") + "</td>" +
        '<td class="p-3 text-center font-black text-emerald-600">' + s.quantity + "</td>" +
        '<td class="p-3 text-center text-slate-400 font-mono text-[11px] hidden sm:table-cell">#' + s.id + "</td>";
      tbody.appendChild(tr);
    });
  }

  function refreshHistory() {
    if (!hasSession()) { renderHistory([]); return; }
    apiFetch("/api/storages").then(function (data) {
      renderHistory(data.items || []);
    }).catch(function () { renderHistory([]); });
  }

  // ---------- Max hint on the form (direct feedback on the limit) ----------

  function updateMaxHint() {
    var ambilIdEl = el("t3-ambil-id");
    if (!ambilIdEl || !ambilIdEl.value) { setMaxHint(""); return; }
    var item = null;
    if (typeof db !== "undefined") item = (db.tab2 || []).find(function (x) { return x.id == ambilIdEl.value; });
    if (!item) { setMaxHint(""); return; }
    var kode = String(item.kode || "").trim();
    var info = storableIndex[kode];
    if (info && info.notStoredQuantity >= 0) {
      setMaxHint("Belum distor: " + info.notStoredQuantity + " pcs — maksimal stor " + info.notStoredQuantity + " pcs.");
    } else {
      setMaxHint("");
    }
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

  hook("loadFromAmbilData", function (original, args) {
    var result = original.apply(null, args);
    updateMaxHint();
    return result;
  });

  hook("saveStoranJahit", function (original, args) {
    var editIdEl = el("t3-edit-id");
    var editId = editIdEl ? editIdEl.value : "";
    var result = original.apply(null, args);

    // Original handler may abort (validation) — detect by row presence.
    var localRow = null;
    if (editId) localRow = (db.tab3 || []).find(function (x) { return x.id == Number(editId); });
    else {
      var rows = (db.tab3 || []).filter(function (x) { return !x.dbStorageId; });
      localRow = rows.length ? rows[rows.length - 1] : null;
    }
    if (!localRow) return result;

    if (!hasSession()) {
      refreshStorable();
      return result;
    }

    // Resolve the parent pickup row to get the stable job identity.
    var pickupRow = (db.tab2 || []).find(function (x) { return x.id == localRow.ambilId; });
    var serverJobId = null;

    // Prefer the Phase 2 job map (local job id -> server job id).
    if (pickupRow && pickupRow.jobId) {
      var jMap = {};
      try { jMap = JSON.parse(localStorage.getItem("yans_dbmap_pekerjaan")) || {}; } catch (e) { jMap = {}; }
      for (var sid in jMap) {
        if (Number(jMap[sid]) === Number(pickupRow.jobId)) { serverJobId = Number(sid); break; }
      }
      if (!serverJobId && pickupRow.dbJobId) serverJobId = Number(pickupRow.dbJobId);
    }

    // Fallback: match by job code against the live storable list.
    if (!serverJobId && pickupRow && pickupRow.kode) {
      var info = storableIndex[String(pickupRow.kode).trim()];
      if (info && info.jobId) serverJobId = info.jobId;
    }

    if (!serverJobId) {
      setStatus("Storan tersimpan lokal — data pengambilan induk belum tersinkron ke server.");
      return result;
    }

    var qty = (localRow.variants || []).reduce(function (s, v) { return s + (Number(v.jumlah) || 0); }, 0);
    var payload = {
      jobId: serverJobId,
      quantity: qty,
      storedAt: localRow.tanggal || null,
    };
    if (localRow.dbStorageId) payload.legacyId = localRow.dbStorageId;

    apiFetch("/api/storages", { method: "POST", body: payload })
      .then(function (data) {
        if (data && data.storage) {
          localRow.dbStorageId = data.storage.id;
          if (typeof saveData === "function") saveData();
        }
        if (data && data.job) {
          setStatus("Server: diambil " + data.job.takenQuantity + " · stor " + data.job.storedQuantity + " · belum " + data.job.notStoredQuantity + " ✓");
        } else {
          setStatus("Tersimpan ke server ✓");
        }
        refreshStorable();
        refreshHistory();
      })
      .catch(function (err) {
        if (err.status === 409 && err.code === "insufficient_storable_quantity") {
          showModal("Storan Ditolak", err.message + " Belum distor: " + err.data.notStored + " pcs.", false);
          setStatus("Ditolak server: melebihi jumlah belum distor (" + err.data.notStored + " pcs).");
        } else if (err.status === 401) {
          setStatus("Sesi berakhir — tersimpan lokal. Login ulang untuk sinkron.");
        } else if (err.status === 400) {
          showModal("Data Tidak Valid", err.message, false);
        } else if (err.status === 404) {
          setStatus("Pekerjaan belum diambil di server — tersimpan lokal.");
        } else {
          setStatus("Server belum siap — tersimpan lokal.");
        }
      });
    return result;
  });

  hook("deleteItem", function (original, args) {
    var tabKey = args[0], id = args[1];
    var result = original.apply(null, args);
    if (tabKey === "tab3") {
      refreshStorable();
      if (hasSession()) refreshHistory();
    }
    return result;
  });

  // ---------- Public API ----------

  window.YansStorages = {
    refresh: function () { refreshStorable(); refreshHistory(); },
  };

  // ---------- Boot ----------

  function boot() {
    if (!el("form-tab3")) return; // wrong page; do nothing
    refreshStorable();
  }

  hook("switchTab", function (original, args) {
    var result = original.apply(null, args);
    if (args[0] === "tab3") {
      refreshStorable();
      refreshHistory();
    }
    return result;
  });

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", function () { boot(); });
})();
