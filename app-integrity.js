// Konveksi YANS — Local transaction integrity helpers (V1).
// Pure functions only: no DOM, no localStorage, no network. They enforce the
// SAME business ceilings as the server API for LOCAL (offline/fallback)
// transactions, so new invalid rows like "Order 120 -> Kirim 240" can no
// longer be written from the local flow:
//   - Ambil Jahit : available = jumlah_order - SUM(pickup)   (= /api/tailoring-pickups)
//   - Storan      : pending  = SUM(pickup) - SUM(storan)     (= /api/storages)
//   - Kiriman     : sisa     = jumlah_order - SUM(kiriman)   (= /api/shipments)
//
// Job identity rule (a transaction is counted exactly once):
//   A. A transaction with a usable jobId belongs to that jobId only.
//   B. Only jobId-less (legacy) transactions fall back to kode matching.
// So a transaction whose jobId AND kode both match is never double counted,
// and job A's transactions never leak into job B.
//
// Historical rows are NEVER modified here — over-quota history is only
// detected (compute*Stats -> over: true) so the UI can label it
// "Data historis melebihi jumlah order" without touching the data.
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  // Sum of variant quantities of one row (mirrors the app's own sums).
  function sumVariants(row) {
    return (row && Array.isArray(row.variants) ? row.variants : []).reduce(function (s, v) {
      return s + (Number(v && v.jumlah) || 0);
    }, 0);
  }

  // Strict quantity validation, same as the server (positive integer only).
  function isPositiveInt(qty) {
    return Number.isInteger(qty) && qty > 0;
  }

  function excludeMatch(row, excludeId) {
    return excludeId !== undefined && excludeId !== null && Number(row && row.id) === Number(excludeId);
  }

  // Canonical key(s) a JOB can be referenced by: its id and its kode.
  function jobKeys(job) {
    var keys = [];
    if (!job || typeof job !== "object") return keys;
    if (job.id !== undefined && job.id !== null && String(job.id).trim() !== "") {
      var n = Number(job.id);
      keys.push("job:" + (Number.isFinite(n) && n > 0 ? n : String(job.id)));
    }
    var k = String(job.kodePekerjaan || job.kode || "").trim().toLowerCase();
    if (k) keys.push("kode:" + k);
    return keys;
  }

  // Canonical key a TRANSACTION is counted under (priority A -> B): jobId when
  // present, otherwise kode. Returns at most ONE key, so a caller can never
  // count the same transaction twice even when jobId and kode both match.
  function txKeys(tx) {
    if (!tx || typeof tx !== "object") return [];
    if (tx.jobId !== undefined && tx.jobId !== null && String(tx.jobId).trim() !== "") {
      var n = Number(tx.jobId);
      return ["job:" + (Number.isFinite(n) && n > 0 ? n : String(tx.jobId))];
    }
    var k = String(tx.kode || tx.kodePekerjaan || "").trim().toLowerCase();
    return k ? ["kode:" + k] : [];
  }

  function txBelongsToJob(tx, job) {
    var tk = txKeys(tx);
    if (!tk.length) return false;
    return jobKeys(job).indexOf(tk[0]) !== -1;
  }

  // Order quantity: prefer the normalized mirror field (server-fresh), else
  // the legacy row's variant total.
  function orderQty(job) {
    if (!job) return 0;
    var n = Number(job.jumlahOrder);
    if (Number.isFinite(n) && n > 0) return n;
    return sumVariants(job);
  }

  // ---------- Live stats (local rows only; historical data is never changed) ----------

  function computePickupStats(job, pickups, excludeId) {
    var order = orderQty(job);
    var taken = 0;
    (pickups || []).forEach(function (k) {
      if (!excludeMatch(k, excludeId) && txBelongsToJob(k, job)) taken += sumVariants(k);
    });
    return { order: order, taken: taken, available: order - taken };
  }

  // Storan: stored rows attach directly by jobId, or via ambilId to a pickup
  // of the job (legacy storan rows may carry no jobId of their own).
  function computeStoranStats(job, pickups, storages, excludeId) {
    var stats = computePickupStats(job, pickups, null);
    var pickupIds = {};
    (pickups || []).forEach(function (k) {
      if (txBelongsToJob(k, job)) pickupIds[String(k && k.id)] = true;
    });
    var stored = 0;
    (storages || []).forEach(function (st) {
      if (excludeMatch(st, excludeId)) return;
      if (txBelongsToJob(st, job)) { stored += sumVariants(st); return; }
      var amb = st && st.ambilId !== undefined && st.ambilId !== null ? String(st.ambilId) : "";
      if (amb && pickupIds[amb]) stored += sumVariants(st);
    });
    return { taken: stats.taken, stored: stored, pending: stats.taken - stored };
  }

  function computeShipmentStats(job, shipments, excludeId) {
    var order = orderQty(job);
    var shipped = 0, count = 0;
    (shipments || []).forEach(function (k) {
      if (!excludeMatch(k, excludeId) && txBelongsToJob(k, job)) { shipped += sumVariants(k); count += 1; }
    });
    return { order: order, shipped: shipped, sisa: order - shipped, over: order - shipped < 0, count: count };
  }

  // ---------- Checks (same rules as the server; returns {ok, message, ...}) ----------

  function checkPickup(job, qty, opts) {
    opts = opts || {};
    if (!job) return { ok: false, reason: "no_job", message: "Pekerjaan tidak ditemukan." };
    if (!isPositiveInt(qty)) return { ok: false, reason: "invalid_qty", message: "Jumlah pengambilan harus angka bulat lebih dari 0." };
    var st = computePickupStats(job, opts.pickups || [], opts.excludeId);
    if (qty > st.available) {
      return { ok: false, reason: "over", available: st.available, message: "Jumlah pengambilan melebihi sisa yang tersedia. Sisa yang dapat diambil: " + st.available + " pcs." };
    }
    return { ok: true, available: st.available };
  }

  function checkStoran(pickup, qty, opts) {
    opts = opts || {};
    if (!pickup) return { ok: false, reason: "no_pickup", message: "Muat data pengambilan terlebih dahulu." };
    if (!isPositiveInt(qty)) return { ok: false, reason: "invalid_qty", message: "Jumlah storan harus angka bulat lebih dari 0." };
    var job = null;
    if (pickup.jobId !== undefined && pickup.jobId !== null && String(pickup.jobId).trim() !== "") {
      job = { id: pickup.jobId, kodePekerjaan: pickup.kode };
    } else if (String(pickup.kode || "").trim() !== "") {
      job = { kodePekerjaan: pickup.kode };
    }
    var pending;
    if (job) {
      pending = computeStoranStats(job, opts.pickups || [], opts.storages || [], opts.excludeId).pending;
    } else {
      // Pure-legacy pickup without any job identity: per-pickup ceiling.
      var stored = 0;
      (opts.storages || []).forEach(function (st) {
        if (excludeMatch(st, opts.excludeId)) return;
        if (st && st.ambilId !== undefined && st.ambilId !== null && Number(st.ambilId) === Number(pickup.id)) stored += sumVariants(st);
      });
      pending = sumVariants(pickup) - stored;
    }
    if (qty > pending) {
      return { ok: false, reason: "over", pending: pending, message: "Jumlah storan melebihi sisa yang belum distor. Sisa yang dapat distor: " + pending + " pcs." };
    }
    return { ok: true, pending: pending };
  }

  function checkShip(job, qty, opts) {
    opts = opts || {};
    if (!job) return { ok: false, reason: "no_job", message: "Pekerjaan tidak ditemukan." };
    if (!isPositiveInt(qty)) return { ok: false, reason: "invalid_qty", message: "Jumlah kirim harus angka bulat lebih dari 0." };
    var st = computeShipmentStats(job, opts.shipments || [], opts.excludeId);
    if (qty > st.sisa) {
      return { ok: false, reason: "over", sisa: st.sisa, message: "Jumlah kirim melebihi sisa yang tersedia. Sisa yang dapat dikirim: " + st.sisa + " pcs." };
    }
    return { ok: true, sisa: st.sisa };
  }

  window.YansIntegrity = {
    sumVariants: sumVariants,
    jobKeys: jobKeys,
    txKeys: txKeys,
    txBelongsToJob: txBelongsToJob,
    computePickupStats: computePickupStats,
    computeStoranStats: computeStoranStats,
    computeShipmentStats: computeShipmentStats,
    checkPickup: checkPickup,
    checkStoran: checkStoran,
    checkShip: checkShip,
  };
})();
