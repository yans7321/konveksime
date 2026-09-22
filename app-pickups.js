// Konveksi YANS — Phase 3 tailoring pickups bridge (Ambil Jahit).
// Wires the existing tab2 UI to the server transaction API
// (/api/tailoring-pickups) WITHOUT changing existing behavior:
//   - db.tab2 (localStorage mirror) keeps working exactly as before.
//   - When the user has a server session, each saved pickup is mirrored to the
//     server, which re-validates quantity against live availability (klop).
//   - The availability table and history panel are additive UI driven by the
//     server's computed numbers (total / taken / available) — never trusted
//     from the client.
//   - Offline / no session: legacy local flow untouched, availability table
//     falls back to local-only numbers with a status note.
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
    var s = el("t2-avail-status");
    if (s) s.innerText = text || "";
  }

  function setMaxHint(text) {
    var s = el("t2-max-hint");
    if (s) s.innerText = text || "";
  }

  // ---------- Availability table (server-computed; local fallback) ----------

  var availIndex = {}; // serverJobId -> {total, taken, available}

  function localAvailability() {
    // Fallback mirror when no server session: derive from local rows only.
    var out = [];
    (db.tab1 || []).forEach(function (j) {
      var total = (j.variants || []).reduce(function (s, v) { return s + (Number(v.jumlah) || 0); }, 0);
      var taken = (db.tab2 || []).filter(function (p) { return p.jobId == j.id; })
        .reduce(function (s, p) { return s + (p.variants || []).reduce(function (a, v) { return a + (Number(v.jumlah) || 0); }, 0); }, 0);
      out.push({
        jobId: null,
        localJobId: j.id,
        jobCode: j.kodePekerjaan || "-",
        namaPekerjaan: j.model || "",
        perusahaanNama: j.perusahaanNama || (db.perusahaan || []).find(function (x) { return x.id == j.perusahaanId; })?.nama || "-",
        totalQuantity: total,
        takenQuantity: taken,
        availableQuantity: total - taken,
      });
    });
    return out.filter(function (j) { return j.availableQuantity > 0; });
  }

  function renderAvailability(items) {
    var tbody = el("table-t2-avail");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-5 text-center text-slate-400 font-medium">Tidak ada pekerjaan dengan sisa tersedia.</td></tr>';
      return;
    }
    items.forEach(function (j) {
      availIndex[j.jobCode] = j; // for the max hint on the form
      var tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50 transition border-b border-slate-100";
      tr.innerHTML =
        '<td class="p-3"><span class="font-bold text-slate-900 block">' + escapeHtml(j.namaPekerjaan || "-") + '</span><span class="text-[10px] font-bold text-blue-600">' + escapeHtml(j.jobCode || "-") + "</span></td>" +
        '<td class="p-3 text-slate-600">' + escapeHtml(j.perusahaanNama || "-") + "</td>" +
        '<td class="p-3 text-center font-black text-slate-900">' + j.totalQuantity + "</td>" +
        '<td class="p-3 text-center font-black text-amber-600">' + j.takenQuantity + "</td>" +
        '<td class="p-3 text-center font-black text-emerald-600">' + j.availableQuantity + "</td>" +
        '<td class="p-3 text-center"><button type="button" onclick="YansPickups.prefill(' + JSON.stringify(JSON.stringify({ code: j.jobCode, model: j.namaPekerjaan, perusahaan: j.perusahaanNama || "" })).replace(/"/g, "&quot;") + ')" class="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 transition shadow-2xs">Ambil Jahit</button></td>';
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function refreshAvailability() {
    if (!hasSession()) {
      renderAvailability(localAvailability());
      setStatus("Mode lokal — angka dari data browser ini. Login server untuk sinkron penuh.");
      return;
    }
    apiFetch("/api/tailoring-pickups?available=1").then(function (data) {
      renderAvailability(data.items || []);
      setStatus("Angka live dari server (total − sudah diambil).");
    }).catch(function () {
      renderAvailability(localAvailability());
      setStatus("Server tidak terjangkau — angka lokal sementara.");
    });
  }

  // ---------- History (server only; local rows already in table-tab2) ----------

  function renderHistory(items) {
    var tbody = el("table-t2-history");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-5 text-center text-slate-400 font-medium">Belum ada transaksi pengambilan terdaftar.</td></tr>';
      return;
    }
    items.forEach(function (k) {
      var tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50 transition border-b border-slate-100";
      tr.innerHTML =
        '<td class="p-3 text-slate-500">' + escapeHtml(String(k.pickedUpAt || "").slice(0, 10)) + "</td>" +
        '<td class="p-3"><span class="font-bold text-slate-900 block">' + escapeHtml(k.namaPekerjaan || "-") + '</span><span class="text-[10px] font-bold text-blue-600">' + escapeHtml(k.jobCode || "-") + "</span></td>" +
        '<td class="p-3 text-slate-600">' + escapeHtml(k.perusahaanNama || "-") + "</td>" +
        '<td class="p-3 font-bold text-slate-800">' + escapeHtml(k.tukang || "-") + "</td>" +
        '<td class="p-3 text-center font-black text-indigo-600">' + k.quantity + "</td>" +
        '<td class="p-3 text-center text-slate-400 font-mono text-[11px] hidden sm:table-cell">#' + k.id + "</td>";
      tbody.appendChild(tr);
    });
  }

  function refreshHistory() {
    if (!hasSession()) { renderHistory([]); return; }
    apiFetch("/api/tailoring-pickups").then(function (data) {
      renderHistory(data.items || []);
    }).catch(function () { renderHistory([]); });
  }

  // ---------- Max hint on the form (direct feedback on the limit) ----------

  function updateMaxHint() {
    var kodeEl = el("t2-kode");
    if (!kodeEl) return;
    var info = availIndex[(kodeEl.value || "").trim()];
    if (info && info.availableQuantity >= 0) {
      setMaxHint("Tersedia: " + info.availableQuantity + " pcs — maksimal pengambilan " + info.availableQuantity + " pcs.");
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

  hook("loadJobToAmbil", function (original, args) {
    var result = original.apply(null, args);
    updateMaxHint();
    return result;
  });

  hook("saveAmbilJahit", function (original, args) {
    var editIdEl = el("t2-edit-id");
    var editId = editIdEl ? editIdEl.value : "";
    var result = original.apply(null, args);

    // Original handler may abort (validation) — detect by row presence.
    var localRow = null;
    if (editId) localRow = (db.tab2 || []).find(function (x) { return x.id == Number(editId); });
    else {
      var rows = (db.tab2 || []).filter(function (x) { return !x.dbPickupId; });
      localRow = rows.length ? rows[rows.length - 1] : null;
    }
    if (!localRow) return result;

    if (!hasSession()) {
      refreshAvailability();
      return result;
    }

    // Resolve server job: prefer the Phase 2 job map, else match by job code.
    var jMap = {};
    try { jMap = JSON.parse(localStorage.getItem("yans_dbmap_pekerjaan")) || {}; } catch (e) { jMap = {}; }
    var serverJobId = null;
    for (var sid in jMap) {
      if (Number(jMap[sid]) === Number(localRow.jobId)) { serverJobId = Number(sid); break; }
    }
    if (!serverJobId && localRow.kode) {
      var info = availIndex[String(localRow.kode).trim()];
      if (info && info.jobId) serverJobId = info.jobId;
    }

    if (!serverJobId) {
      setStatus("Pengambilan tersimpan lokal — pekerjaan induk belum tersinkron ke server.");
      return result;
    }

    var qty = (localRow.variants || []).reduce(function (s, v) { return s + (Number(v.jumlah) || 0); }, 0);
    var payload = {
      jobId: serverJobId,
      quantity: qty,
      pickedUpAt: localRow.tanggal || null,
      tukang: localRow.tukang || null,
      jenis: localRow.jenis || null,
    };
    if (localRow.dbPickupId) payload.legacyId = localRow.dbPickupId;

    apiFetch("/api/tailoring-pickups", { method: "POST", body: payload })
      .then(function (data) {
        if (data && data.pickup) {
          localRow.dbPickupId = data.pickup.id;
          if (typeof saveData === "function") saveData();
        }
        if (data && data.job) {
          setStatus("Server: total " + data.job.totalQuantity + " · diambil " + data.job.takenQuantity + " · tersedia " + data.job.availableQuantity + " ✓");
        } else {
          setStatus("Tersimpan ke server ✓");
        }
        refreshAvailability();
        refreshHistory();
      })
      .catch(function (err) {
        if (err.status === 409 && err.code === "insufficient_quantity") {
          showModal("Stok Tidak Cukup", err.message + " Tersedia: " + err.data.available + " pcs.", false);
          setStatus("Ditolak server: melebihi jumlah tersedia (" + err.data.available + " pcs).");
        } else if (err.status === 401) {
          setStatus("Sesi berakhir — tersimpan lokal. Login ulang untuk sinkron.");
        } else if (err.status === 400) {
          showModal("Data Tidak Valid", err.message, false);
        } else {
          setStatus("Server belum siap — tersimpan lokal.");
        }
      });
    return result;
  });

  hook("deleteItem", function (original, args) {
    var tabKey = args[0], id = args[1];
    var result = original.apply(null, args);
    if (tabKey === "tab2") {
      refreshAvailability();
      if (hasSession()) refreshHistory();
    }
    return result;
  });

  // ---------- Public API ----------

  window.YansPickups = {
    refresh: function () { refreshAvailability(); refreshHistory(); },
    prefill: function (raw) {
      try {
        var d = JSON.parse(raw);
        var kodeEl = el("t2-kode");
        var modelEl = el("t2-model");
        if (kodeEl) kodeEl.value = d.code || "";
        if (modelEl && d.model) modelEl.value = d.model;
        updateMaxHint();
        var form = el("form-tab2");
        if (form) form.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) { /* ignore malformed */ }
    },
  };

  // ---------- Boot ----------

  function boot() {
    if (!el("form-tab2")) return; // wrong page; do nothing
    var kodeEl = el("t2-kode");
    if (kodeEl) kodeEl.addEventListener("input", updateMaxHint);
    // Availability panel refreshes every time tab2 opens (via switchTab hook
    // below) and once at load.
    refreshAvailability();
  }

  hook("switchTab", function (original, args) {
    var result = original.apply(null, args);
    if (args[0] === "tab2") {
      refreshAvailability();
      refreshHistory();
    }
    return result;
  });

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", function () { boot(); });
})();
