// Konveksi YANS — Phase 7 shipments bridge (Kiriman Barang).
// Wires the existing tab5 UI to the server API (/api/shipments) WITHOUT
// changing existing behavior, following the app-pickups/app-storages pattern:
//   - db.tab5 (localStorage mirror) keeps working exactly as before; the
//     original saveKirimanBarang/deleteItem flow runs first, untouched.
//   - When the user has a server session, each saved kiriman is mirrored to
//     PostgreSQL. The server re-validates the order-based ceiling
//     (jumlah_order - SUM(shipped)); the local row gets the server id (dbId).
//   - Local jobId is resolved to the server job via yans_dbmap_pekerjaan
//     (map[serverId] = localId), with a job-code fallback from the shippable
//     snapshot — same strategy as the pickups bridge.
//   - Photo: ONLY metadata (fileName/mimeType/sizeBytes) is sent. The Data URL
//     stays in localStorage; foto_storage_ref stays NULL until a storage
//     provider exists.
//   - Offline / no session: legacy local flow untouched.
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
    var s = el("t5-server-status");
    if (s) s.innerText = text || "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---------- Shippable snapshot (server-computed; local fallback) ----------

  var shippableIndex = {}; // jobCode -> {jobId, remainingQuantity, ...}

  function renderShippable(items) {
    var tbody = el("table-t5-shippable");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-5 text-center text-slate-400 font-medium">Tidak ada pekerjaan dengan sisa belum dikirim.</td></tr>';
      return;
    }
    items.forEach(function (j) {
      if (j.jobCode) shippableIndex[String(j.jobCode).trim()] = j;
      var tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50 transition border-b border-slate-100";
      tr.innerHTML =
        '<td class="p-3"><span class="font-bold text-slate-900 block">' + escapeHtml(j.namaPekerjaan || "-") + '</span><span class="text-[10px] font-bold text-blue-600">' + escapeHtml(j.jobCode || "-") + "</span></td>" +
        '<td class="p-3 text-slate-600">' + escapeHtml(j.perusahaanNama || "-") + "</td>" +
        '<td class="p-3 text-center font-black text-slate-900">' + j.orderQuantity + "</td>" +
        '<td class="p-3 text-center font-black text-indigo-600">' + j.shippedQuantity + "</td>" +
        '<td class="p-3 text-center font-black text-emerald-600">' + j.remainingQuantity + "</td>";
      tbody.appendChild(tr);
    });
  }

  function refreshShippable() {
    if (!hasSession()) {
      setStatus("Mode lokal — angka dari data browser ini. Login server untuk sinkron penuh.");
      return;
    }
    apiFetch("/api/shipments?shippable=1").then(function (data) {
      renderShippable(data.items || []);
      setStatus("Angka live dari server (order − terkirim).");
    }).catch(function () {
      setStatus("Server tidak terjangkau — angka lokal sementara.");
    });
  }

  // ---------- History (server mirror rows) ----------

  function fmtDate(v) {
    if (typeof window !== "undefined" && window.YansDate && window.YansDate.fmtDmy) return window.YansDate.fmtDmy(v);
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return "";
      return String(v.getDate()).padStart(2, "0") + "/" + String(v.getMonth() + 1).padStart(2, "0") + "/" + v.getFullYear();
    }
    return String(v == null ? "" : v).slice(0, 10);
  }

  function renderHistory(items) {
    var tbody = el("table-t5-history");
    if (!tbody) return;
    var startEl = el("t5-server-history-start");
    var endEl = el("t5-server-history-end");
    var startIso = startEl && startEl.value ? startEl.value : null;
    var endIso = endEl && endEl.value ? endEl.value : null;
    var useRange = typeof window !== "undefined" && window.YansDate && !!startIso;
    var inRange = window.YansDate ? window.YansDate.inDateRange : function () { return true; };
    tbody.innerHTML = "";
    if (!items || items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="p-5 text-center text-slate-400 font-medium">Belum ada transaksi kiriman terdaftar.</td></tr>';
      return;
    }
    items.forEach(function (s) {
      if (useRange && !inRange(s.tanggal, startIso, endIso)) return;
      var qty = (s.variants || []).reduce(function (a, v) { return a + (Number(v.jumlah) || 0); }, 0);
      var tr = document.createElement("tr");
      tr.className = "hover:bg-slate-50 transition border-b border-slate-100";
      tr.innerHTML =
        '<td class="p-3 text-slate-500">' + fmtDate(s.tanggal) + "</td>" +
        '<td class="p-3"><span class="font-bold text-slate-900 block">' + escapeHtml(s.namaPekerjaan || "-") + '</span><span class="text-[10px] font-bold text-blue-600">' + escapeHtml(s.jobCode || "-") + "</span></td>" +
        '<td class="p-3 text-slate-600">' + escapeHtml(s.perusahaanNama || "-") + "</td>" +
        '<td class="p-3 text-center font-black text-indigo-600">' + qty + "</td>" +
        '<td class="p-3 text-center text-slate-400 font-mono text-[11px] hidden sm:table-cell">#' + s.id + "</td>";
      tbody.appendChild(tr);
    });
  }

  function refreshHistory() {
    if (!hasSession()) { renderHistory([]); return; }
    apiFetch("/api/shipments").then(function (data) {
      renderHistory(data.items || []);
    }).catch(function () { renderHistory([]); });
  }

  // ---------- jobId resolution (local -> server) ----------

  function resolveServerJobId(localJobId, kode) {
    var jMap = {};
    try { jMap = JSON.parse(localStorage.getItem("yans_dbmap_pekerjaan")) || {}; } catch (e) { jMap = {}; }
    for (var sid in jMap) {
      if (Number(jMap[sid]) === Number(localJobId)) return Number(sid);
    }
    if (kode) {
      var info = shippableIndex[String(kode).trim()];
      if (info && info.jobId) return info.jobId;
    }
    return null;
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

  function readFotoMeta() {
    var input = el("t5-bukti-foto");
    var f = input && input.files && input.files[0];
    if (!f) return null;
    return { fotoName: f.name, fotoMimeType: f.type || null, fotoSizeBytes: f.size };
  }

  hook("saveKirimanBarang", function (original, args) {
    var editIdEl = el("t5-edit-id");
    var editId = editIdEl ? editIdEl.value : "";
    var prevRow = editId ? (db.tab5 || []).find(function (x) { return x.id == Number(editId); }) : null;
    var prevDbId = prevRow && prevRow.dbShipmentId ? prevRow.dbShipmentId : null;
    var fotoMeta = readFotoMeta(); // captured BEFORE the original resets the form

    var result = original.apply(null, args);

    // Detect the row the original handler created/updated.
    var localRow = null;
    if (editId) localRow = (db.tab5 || []).find(function (x) { return x.id == Number(editId); });
    else {
      var rows = (db.tab5 || []).filter(function (x) { return !x.dbShipmentId; });
      localRow = rows.length ? rows[rows.length - 1] : null;
    }
    if (!localRow) return result; // local save aborted; nothing to mirror

    // The original edit path replaces the row object wholesale; restore the
    // bridge field so the mirror targets the same server row.
    if (prevDbId && !localRow.dbShipmentId) localRow.dbShipmentId = prevDbId;
    if (typeof saveData === "function") saveData();

    if (!hasSession()) return result;

    var serverJobId = resolveServerJobId(localRow.jobId, localRow.kode);
    if (!serverJobId) {
      setStatus("Kiriman tersimpan lokal — pekerjaan induk belum tersinkron ke server.");
      return result;
    }

    var payload = {
      jobId: serverJobId,
      tanggal: localRow.tanggal || null,
      status: localRow.statusKiriman || "Selesai",
      penerima: localRow.penerima || "",
      catatan: localRow.catatan || "",
      variants: (localRow.variants || []).map(function (v) {
        return { warna: v.warna || "", ukuran: v.ukuran || v.size || "", jumlah: Number(v.jumlah) || 0 };
      }),
    };
    if (localRow.dbShipmentId) payload.legacyId = localRow.dbShipmentId;
    if (fotoMeta) {
      payload.fotoName = fotoMeta.fotoName;
      payload.fotoMimeType = fotoMeta.fotoMimeType;
      payload.fotoSizeBytes = fotoMeta.fotoSizeBytes;
    }

    apiFetch("/api/shipments", { method: "POST", body: payload })
      .then(function (data) {
        if (data && data.shipment && data.shipment.id) {
          localRow.dbShipmentId = data.shipment.id;
          if (typeof saveData === "function") saveData();
        }
        if (data && data.job) {
          setStatus("Server: order " + data.job.orderQuantity + " · terkirim " + data.job.shippedQuantity + " · sisa " + data.job.remainingQuantity + " ✓");
        } else {
          setStatus("Tersimpan ke server ✓");
        }
        refreshShippable();
        if (hasSession()) refreshHistory();
      })
      .catch(function (err) {
        if (err.status === 409 && err.code === "insufficient_shippable_quantity" && err.data) {
          setStatus("Server menolak: order " + err.data.order + " · terkirim " + err.data.shipped + " · sisa " + err.data.sisa + " (tersimpan lokal).");
        } else {
          setStatus("Kiriman tersimpan lokal (server tidak terjangkau).");
        }
      });
    return result;
  });

  hook("deleteItem", function (original, args) {
    var tabKey = args[0], id = args[1];
    if (tabKey === "tab5" && hasSession()) {
      var row = (db.tab5 || []).find(function (x) { return x.id == id; });
      if (row && row.dbShipmentId) {
        var dbId = row.dbShipmentId;
        apiFetch("/api/shipments?id=" + encodeURIComponent(dbId), { method: "DELETE" })
          .then(function () { refreshShippable(); refreshHistory(); })
          .catch(function () { /* best-effort */ });
      }
    }
    var result = original.apply(null, args);
    if (tabKey === "tab5") refreshShippable();
    return result;
  });

  // ---------- Public API ----------

  window.YansShipments = {
    refresh: function () { refreshShippable(); refreshHistory(); },
  };

  // ---------- Boot ----------

  function boot() {
    if (!el("form-tab5")) return; // wrong page; do nothing
    refreshShippable();
  }

  hook("switchTab", function (original, args) {
    var result = original.apply(null, args);
    if (args[0] === "tab5") {
      refreshShippable();
      refreshHistory();
    }
    return result;
  });

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", function () { boot(); });
})();
