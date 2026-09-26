// Konveksi YANS — Phase 2 jobs bridge.
// Connects the existing "Pekerjaan" (tab1) UI to the server API (/api/jobs,
// /api/job-accessories, /api/job-documents) WITHOUT changing existing behavior:
//   - localStorage stays the source of truth for the UI mirror (saveData intact).
//   - When the user has a server session and the server is reachable, saves /
//     edits / deletes are mirrored to PostgreSQL and server IDs are attached
//     (dbId) so Phase 3/4/5 can reference stable job IDs.
//   - When offline / no session / DB unconfigured, everything falls back to the
//     original localStorage-only flow and a small status note is shown.
//   - File bytes are NEVER sent to the ERP API: nota files are staged locally
//     and only registered (metadata) once a storage provider is configured.
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  // Token helpers mirror app-api.js (same storage key, read-only here).
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
          throw err;
        }
        return data;
      });
    });
  }

  function hasSession() {
    return typeof db !== "undefined" && !!db.currentUser && !!getToken();
  }

  // ---------- Form field helpers (all additive UI, original fields untouched) ----------

  function el(id) { return document.getElementById(id); }

  function ensureAccContainer() {
    var c = el("container-acc-t1");
    if (c && c.children.length === 0) addAccRow();
  }

  function getAccRowsData() {
    var c = el("container-acc-t1");
    if (!c) return [];
    var rows = c.getElementsByClassName("acc-row-t1");
    var list = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var nama = (r.querySelector(".acc-nama").value || "").trim();
      if (!nama) continue;
      list.push({
        namaAsesoris: nama,
        satuan: (r.querySelector(".acc-satuan").value || "").trim(),
        jumlah: Number(r.querySelector(".acc-jumlah").value) || 0,
        catatan: (r.querySelector(".acc-catatan") ? r.querySelector(".acc-catatan").value.trim() : ""),
      });
    }
    return list;
  }

  function setAccRows(list) {
    var c = el("container-acc-t1");
    if (!c) return;
    c.innerHTML = "";
    (list || []).forEach(function (a) { addAccRow(a); });
    if (c.children.length === 0) addAccRow();
  }

  function addAccRow(existing) {
    var c = el("container-acc-t1");
    if (!c) return;
    if (c.children.length >= 30) return;
    var div = document.createElement("div");
    div.className = "flex flex-wrap gap-3 acc-row-t1 bg-white p-3 rounded-xl border border-slate-200 items-center shadow-2xs";
    div.innerHTML =
      '<input type="text" placeholder="Nama (Kancing, Sleting...)" value="' + (existing ? escapeAttr(existing.namaAsesoris || existing.nama || "") : "") + '" class="acc-nama flex-1 min-w-[110px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-500/20">' +
      '<input type="text" placeholder="Satuan (pcs/meter)" value="' + (existing ? escapeAttr(existing.satuan || "") : "") + '" class="acc-satuan w-28 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-blue-500/20">' +
      '<input type="number" min="0" placeholder="Jumlah" value="' + (existing ? Number(existing.jumlah) || 0 : "") + '" class="acc-jumlah w-24 bg-blue-50 border border-blue-200 text-blue-800 font-black rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20">' +
      '<input type="text" placeholder="Catatan" value="' + (existing ? escapeAttr(existing.catatan || "") : "") + '" class="acc-catatan flex-1 min-w-[90px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500/20">' +
      '<button type="button" onclick="this.parentElement.remove()" class="text-rose-400 hover:text-rose-600 px-2 font-bold transition"><i class="fa-solid fa-trash-can"></i></button>';
    c.appendChild(div);
  }

  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function setServerStatus(text) {
    var s = el("t1-server-status");
    if (s) s.innerText = text || "";
  }

  function setNotaStatus(text) {
    var s = el("t1-nota-status");
    if (s) s.innerText = text || "";
  }

  // ---------- Nota staging (no upload in Phase 2; storage provider pending) ----------

  var stagedNotas = []; // {fileName, mimeType, sizeBytes, storageRef:null, registered:false}

  function bindNotaInput() {
    var input = el("t1-nota-input");
    if (!input || input.dataset.yansBound) return;
    input.dataset.yansBound = "1";
    input.addEventListener("change", function () {
      for (var i = 0; i < input.files.length; i++) {
        var f = input.files[i];
        stagedNotas.push({ fileName: f.name, mimeType: f.type || null, sizeBytes: f.size, storageRef: null });
      }
      input.value = "";
      renderNotaStatus();
    });
  }

  function renderNotaStatus() {
    if (stagedNotas.length === 0) { setNotaStatus(""); return; }
    var names = stagedNotas.map(function (n) { return n.fileName; }).join(", ");
    var sRef = stagedNotas.some(function (n) { return n.storageRef; });
    setNotaStatus(
      sRef
        ? "Nota terdaftar: " + names
        : "Nota dipilih (" + names + ") — menunggu storage provider untuk upload."
    );
  }

  function registerNotas(jobId, token) {
    // Registers staged document metadata for jobId. Best-effort; without a
    // storage provider only file names/mime/size are recorded (storageRef null).
    if (!stagedNotas.length) return Promise.resolve();
    return Promise.all(
      stagedNotas.map(function (n) {
        return apiFetch("/api/job-documents", {
          method: "POST",
          headers: token ? { Authorization: "Bearer " + token } : {},
          body: {
            jobId: jobId,
            fileName: n.fileName,
            mimeType: n.mimeType,
            sizeBytes: n.sizeBytes,
            storageRef: n.storageRef,
          },
        }).then(function (d) {
          if (d && d.document && d.document.storageRef) n.storageRef = d.document.storageRef;
          n.registered = true;
        });
      })
    ).then(function () { renderNotaStatus(); });
  }

  window.YansJobs = {
    pickNota: function () {
      bindNotaInput();
      var input = el("t1-nota-input");
      if (input) input.click();
    },
    addAccRow: function () { addAccRow(); },
    // Pull server jobs into the local mirror. Used after sign-in/session
    // restore so Ambil Jahit / Storan / Kiriman can resolve server job ids
    // even when the Pekerjaan row was created in another browser.
    pullJobs: function () { return pullJobs(); },
  };

  // ---------- Pull (server -> local mirror), used after sign-in and on demand ----------

  function serverToLocalJob(j) {
    var variants = Array.isArray(j.variants) && j.variants.length
      ? j.variants.map(function (v) { return { warna: v.warna, ukuran: v.ukuran || "", jumlah: Number(v.jumlah) || 0 }; })
      : [{ warna: "-", ukuran: "", jumlah: Number(j.jumlahOrder) || 0 }];
    var perusahaanId = j.perusahaanId;
    var perusahaanNama = null;
    if (typeof db !== "undefined") {
      // Perusahaan mapping lives in the Phase 1 perusahaan map, not the job map.
      var pMap = {};
      try { pMap = JSON.parse(localStorage.getItem("yans_dbmap_perusahaan")) || {}; } catch (e) { pMap = {}; }
      var localId = pMap[String(j.perusahaanId)];
      if (localId) {
        var p = (db.perusahaan || []).find(function (x) { return x.id == localId; });
        if (p) { perusahaanId = p.id; perusahaanNama = p.nama; }
      }
    }
    return {
      id: j.legacyId || Date.now() + Math.floor(Math.random() * 1000),
      dbId: j.id,
      kodePekerjaan: j.jobCode,
      perusahaanId: perusahaanId,
      perusahaanNama: perusahaanNama,
      tanggal: (j.tanggalMasuk || "").slice(0, 10) || "",
      deadline: (j.deadline || "").slice(0, 10) || "",
      model: j.namaPekerjaan || "",
      harga: Number(j.hargaPerPcs) || 0,
      jumlahOrder: Number(j.jumlahOrder) || 0,
      catatan: j.catatan || "",
      status: j.status || "aktif",
      accessories: j.accessories || [],
      documents: j.documents || [],
      variants: variants,
    };
  }

  function readMap() {
    try { return JSON.parse(localStorage.getItem("yans_dbmap_pekerjaan")) || {}; } catch (e) { return {}; }
  }

  function writeMap(map) {
    try { localStorage.setItem("yans_dbmap_pekerjaan", JSON.stringify(map)); } catch (e) { /* ignore */ }
  }

  function pullJobs() {
    if (!hasSession()) return Promise.resolve({ ok: false, reason: "no-session" });
    return apiFetch("/api/jobs?accessories=1&documents=1").then(function (data) {
      var items = data.items || [];
      var map = readMap();
      var fresh = [];
      items.forEach(function (j) {
        var local = (db.tab1 || []).find(function (x) { return x.dbId == j.id; });
        if (local) {
          // Refresh server-managed fields; keep the local row identity.
          local.kodePekerjaan = j.jobCode;
          local.tanggal = (j.tanggalMasuk || "").slice(0, 10) || local.tanggal;
          local.deadline = (j.deadline || "").slice(0, 10) || "";
          local.model = j.namaPekerjaan || local.model;
          local.harga = Number(j.hargaPerPcs) || 0;
          local.jumlahOrder = Number(j.jumlahOrder) || 0;
          local.catatan = j.catatan || "";
          local.status = j.status || "aktif";
          local.accessories = j.accessories || [];
          local.documents = j.documents || [];
        } else {
          fresh.push(serverToLocalJob(j));
        }
      });
      fresh.forEach(function (row) { db.tab1.push(row); });
      // Refresh the local id -> server id map, including rows that already had
      // a dbId from a previous session (map can be lost between browsers).
      try {
        (db.tab1 || []).forEach(function (row) {
          if (row.dbId) map[String(row.dbId)] = row.id;
        });
        writeMap(map);
      } catch (e) { /* best effort */ }
      if (typeof saveData === "function") saveData();
      if (typeof renderTableTab1 === "function") renderTableTab1();
      return { ok: true, count: items.length };
    });
  }

  // ---------- Hook: save (create/update) ----------

  function hook(name, wrapper) {
    if (typeof window[name] === "function") {
      var original = window[name];
      window[name] = function () {
        return wrapper(original, Array.prototype.slice.call(arguments));
      };
    }
  }

  function jobPayloadFromForm() {
    var catatanEl = el("t1-catatan");
    var deadlineEl = el("t1-deadline");
    var payload = {
      kodePekerjaan: el("t1-kode").value.trim(),
      perusahaanId: Number(el("t1-perusahaan").value) || null,
      tanggalMasuk: el("t1-tanggal").value,
      namaPekerjaan: el("t1-model").value.trim(),
      harga: parseFloat(el("t1-harga").value) || 0,
      jumlahOrder: getVariantsTotal(),
      catatan: catatanEl ? catatanEl.value.trim() : "",
      deadline: deadlineEl && deadlineEl.value ? deadlineEl.value : null,
    };
    return payload;
  }

  function getVariantsTotal() {
    try {
      var vs = getVariantsData("t1");
      return vs.reduce(function (s, v) { return s + (Number(v.jumlah) || 0); }, 0);
    } catch (e) { return 0; }
  }

  hook("saveOrderKantor", function (original, args) {
    var e = args[0];
    var editIdEl = el("t1-edit-id");
    var editId = editIdEl ? editIdEl.value : "";
    var prevRow = editId ? (db.tab1 || []).find(function (x) { return x.id == Number(editId); }) : null;
    var prevDbId = prevRow && prevRow.dbId ? prevRow.dbId : null;
    var prevDocs = prevRow ? prevRow.documents : undefined;
    var payload = jobPayloadFromForm();
    var acc = getAccRowsData();
    var session = hasSession();

    // Run the original local save first (unchanged behavior), then mirror.
    var result = original.apply(null, args);

    // The original handler may have aborted (validation) — detect by checking
    // whether the local row exists now.
    var localRow = null;
    if (editId) localRow = (db.tab1 || []).find(function (x) { return x.id == Number(editId); });
    else localRow = (db.tab1 || []).find(function (x) { return x.kodePekerjaan === payload.kodePekerjaan && !x.dbId; });
    if (!localRow) return result; // local save aborted; nothing to mirror

    if (prevDbId && !localRow.dbId) {
      // The original edit path rebuilds the row object and drops the bridge
      // fields; restore them so the update targets the same server row.
      localRow.dbId = prevDbId;
      if (localRow.documents === undefined) localRow.documents = prevDocs || [];
    }

    localRow.accessories = acc;
    localRow.deadline = payload.deadline || "";
    localRow.catatan = payload.catatan || "";
    localRow.jumlahOrder = payload.jumlahOrder;
    if (typeof saveData === "function") saveData();
    if (!editId) {
      // Create flow: the original handler resets the main form but not the
      // Phase 2 extras — clear them so the next entry starts fresh.
      setAccRows([]);
      stagedNotas = [];
      renderNotaStatus();
    }

    if (!session) { setServerStatus("Tersimpan lokal (belum login server)."); return result; }

    // Perusahaan mapping: prefer a server id from the Phase 1 map.
    var pMap = {};
    try { pMap = JSON.parse(localStorage.getItem("yans_dbmap_perusahaan")) || {}; } catch (er) { pMap = {}; }
    var serverPerusahaanId = null;
    (function () {
      for (var sid in pMap) {
        if (Number(pMap[sid]) === Number(payload.perusahaanId)) { serverPerusahaanId = Number(sid); return; }
      }
    })();

    var token = getToken();
    var method = localRow.dbId ? "PUT" : "POST";
    var url = method === "PUT" ? "/api/jobs?id=" + encodeURIComponent(localRow.dbId) : "/api/jobs";
    var body = Object.assign({}, payload, { perusahaanNama: null });
    if (serverPerusahaanId) {
      body.perusahaanId = serverPerusahaanId;
    } else {
      // Local perusahaan ids mean nothing to the server — omit the id and let
      // it resolve by name (master data was synced at sign-in). If we cannot
      // name it either, POST fails validation and an update keeps the existing
      // server value instead of failing.
      delete body.perusahaanId;
      var pObj = (db.perusahaan || []).find(function (x) { return x.id == payload.perusahaanId; });
      body.perusahaanNama = pObj ? pObj.nama : null;
    }

    apiFetch(url, { method: method, body: body })
      .then(function (data) {
        if (data && data.job) {
          var map = readMap();
          map[String(data.job.id)] = localRow.id;
          writeMap(map);
          localRow.dbId = data.job.id;
          if (typeof saveData === "function") saveData();
          if (data.job.id && acc.length) syncAccessories(localRow.dbId, acc, token);
          if (stagedNotas.length) registerNotas(data.job.id, token);
        }
        setServerStatus("Tersimpan ke server ✓");
        if (typeof pullJobs === "function") pullJobs().catch(function () {});
      })
      .catch(function (err) {
        if (err.status === 409) {
          showModal("Kode Duplikat", err.message || "Kode pekerjaan sudah dipakai di server untuk akun ini.", false);
          setServerStatus("Gagal: kode duplikat di server.");
        } else if (err.status === 401) {
          setServerStatus("Sesi berakhir — tersimpan lokal. Login ulang untuk sinkron.");
        } else {
          setServerStatus("Server belum siap — tersimpan lokal.");
        }
      });
    return result;
  });

  function syncAccessories(jobId, acc, token) {
    return Promise.all(
      acc.map(function (a) {
        return apiFetch("/api/job-accessories", {
          method: "POST",
          headers: token ? { Authorization: "Bearer " + token } : {},
          body: {
            jobId: jobId,
            namaAsesoris: a.namaAsesoris,
            satuan: a.satuan,
            jumlah: a.jumlah,
            catatan: a.catatan || null,
          },
        }).catch(function () { /* best effort; pull refreshes */ });
      })
    );
  }

  // ---------- Hook: edit (prefill extra fields + accessories) ----------

  hook("editOrderKantor", function (original, args) {
    var id = args[0];
    var result = original.apply(null, args);
    var item = (db.tab1 || []).find(function (x) { return x.id == id; });
    if (!item) return result;
    var dl = el("t1-deadline"); if (dl) dl.value = item.deadline || "";
    var ct = el("t1-catatan"); if (ct) ct.value = item.catatan || "";
    setAccRows(item.accessories || []);
    stagedNotas = (item.documents || []).map(function (d) {
      return { fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, storageRef: d.storageRef, registered: true };
    });
    renderNotaStatus();
    setServerStatus(item.dbId ? "Terhubung server (ID " + item.dbId + ")." : "");
    return result;
  });

  // ---------- Hook: delete (soft delete server-side when mapped) ----------

  hook("deleteItem", function (original, args) {
    var tabKey = args[0], id = args[1];
    var willMirror = tabKey === "tab1" && hasSession();
    var row = willMirror ? (db.tab1 || []).find(function (x) { return x.id == id; }) : null;
    var dbId = row && row.dbId ? row.dbId : null;
    // Run the original handler first: it confirms with the user and may abort.
    // Mirror to the server only when the local row is really gone.
    var result = original.apply(null, args);
    if (dbId && willMirror) {
      var stillThere = (db.tab1 || []).find(function (x) { return x.id == id; });
      if (!stillThere) {
        var map = readMap();
        delete map[String(dbId)];
        writeMap(map);
        apiFetch("/api/jobs?id=" + encodeURIComponent(dbId), { method: "DELETE" }).catch(function () { /* keep local flow */ });
      }
    }
    if (tabKey === "tab1") { stagedNotas = []; renderNotaStatus(); setServerStatus(""); }
    return result;
  });

  // ---------- Hook: cancel edit ----------

  hook("cancelEdit", function (original, args) {
    var result = original.apply(null, args);
    if (args[0] === "t1") {
      setAccRows([]);
      stagedNotas = [];
      renderNotaStatus();
      setServerStatus("");
    }
    return result;
  });

  // ---------- Boot ----------

  function boot() {
    if (!el("form-tab1")) return; // wrong page or markup missing; do nothing
    ensureAccContainer();
    bindNotaInput();
    // After the Phase 1 session restore, pull server jobs into the mirror.
    if (typeof window.YansApi === "object" && window.YansApi && typeof window.YansApi.status === "function") {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        var st = window.YansApi.status();
        if (st.signedIn && st.hasToken) {
          clearInterval(timer);
          pullJobs().then(function (r) {
            if (r && r.ok && r.count > 0) setServerStatus("Sinkron dengan server (" + r.count + " pekerjaan).");
          }).catch(function () { /* offline: local only */ });
        } else if (tries > 20 || (!st.hasToken && tries > 5)) {
          clearInterval(timer);
        }
      }, 300);
    }
  }

  if (document.readyState === "complete") boot();
  else window.addEventListener("load", function () { boot(); });
})();
