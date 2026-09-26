// Local transaction integrity (V1) self-test: node --test tests/integrity.mjs
// Proves app-integrity.js enforces the SAME business ceilings as the server
// API for LOCAL transactions, and the identity rule never double counts:
//   Kiriman : order 100, kirim 60 OK -> kirim 40 OK (total 100) -> kirim 1 lagi DITOLAK
//             existing over-data 120 -> 240 is detected but never modified
//   Ambil   : order 100, pickup 60 OK -> pickup 40 OK -> pickup 1 lagi DITOLAK
//   Storan  : pickup 80, stor 50 OK -> stor 30 OK (pending 30) -> stor 1 lagi DITOLAK
//   Identity: jobId-first; kode fallback only for legacy rows; job A never
//             counted into job B.
// Pure functions: no DOM, no network, no database, no credentials.
import test from "node:test";
import assert from "node:assert/strict";

global.window = {};
await import("../app-integrity.js");
const I = global.window.YansIntegrity;

const v = (jumlah) => [{ warna: "A", ukuran: "L", jumlah }];

test("Kiriman: order 100, kirim 60 -> berhasil (sisa 40)", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const res = I.checkShip(job, 60, { shipments: [] });
  assert.equal(res.ok, true);
  // sisa dilaporkan = sisa saat ini (sebelum transaksi), selaras payload penolakan server
  assert.equal(res.sisa, 100);
  const after = I.computeShipmentStats(job, [{ id: 11, jobId: 1, variants: v(60) }]);
  assert.equal(after.sisa, 40);
});

test("Kiriman: kirim 40 lagi -> berhasil, total tepat 100", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const shipments = [
    { id: 11, jobId: 1, kode: "JOB-1", variants: v(60) },
  ];
  const res = I.checkShip(job, 40, { shipments });
  assert.equal(res.ok, true);
  assert.equal(res.sisa, 40);
  // tepat 100% order diperbolehkan
  const sum = I.computeShipmentStats(job, [
    ...shipments,
    { id: 12, jobId: 1, variants: v(40) },
  ]);
  assert.equal(sum.sisa, 0);
  assert.equal(sum.over, false);
});

test("Kiriman: kirim 1 lagi setelah sisa 0 -> DITOLAK", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const shipments = [
    { id: 11, jobId: 1, variants: v(60) },
    { id: 12, jobId: 1, variants: v(40) },
  ];
  const res = I.checkShip(job, 1, { shipments });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "over");
  assert.equal(res.sisa, 0);
  assert.match(res.message, /Sisa yang dapat dikirim: 0 pcs/);
});

test("Kiriman: qty 0, negatif, dan desimal ditolak", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  assert.equal(I.checkShip(job, 0, { shipments: [] }).ok, false);
  assert.equal(I.checkShip(job, -5, { shipments: [] }).ok, false);
  assert.equal(I.checkShip(job, 2.5, { shipments: [] }).ok, false);
  assert.equal(I.checkShip(job, "10", { shipments: [] }).ok, false);
});

test("Kiriman: edit (excludeId) mengembalikan qty lama ke pool", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const shipments = [
    { id: 11, jobId: 1, variants: v(60) },
    { id: 12, jobId: 1, variants: v(30) },
  ];
  // sisa 10; mengedit row #12 (30) -> 30 kembali ke pool -> boleh sampai 40
  const res = I.checkShip(job, 40, { shipments, excludeId: 12 });
  assert.equal(res.ok, true);
  assert.equal(res.sisa, 40);
});

test("Kiriman: data historis over 120 -> 240 terdeteksi, TIDAK diubah/dihapus", () => {
  const job = { id: 1, kodePekerjaan: "JOB-20260924-002", variants: v(120) };
  const shipments = [
    { id: 21, jobId: 1, variants: v(120) },
    { id: 22, jobId: 1, variants: v(120) },
  ];
  const stats = I.computeShipmentStats(job, shipments);
  assert.equal(stats.order, 120);
  assert.equal(stats.shipped, 240);
  assert.equal(stats.sisa, -120);
  assert.equal(stats.over, true);
  // Data lama tetap utuh (referensi objek yang sama, nilai tidak disentuh)
  assert.equal(shipments[0].variants[0].jumlah, 120);
  assert.equal(shipments[1].variants[0].jumlah, 120);
  assert.equal(shipments.length, 2);
  // Kiriman baru tetap ditolak saat historis sudah over
  const res = I.checkShip(job, 1, { shipments });
  assert.equal(res.ok, false);
  assert.equal(res.sisa, -120);
});

test("Ambil: order 100, pickup 60 -> berhasil; pickup 40 -> berhasil (total 100)", () => {
  const job = { id: 2, kodePekerjaan: "JOB-2", variants: v(100) };
  const r1 = I.checkPickup(job, 60, { pickups: [] });
  assert.equal(r1.ok, true);
  const pickups = [{ id: 31, jobId: 2, variants: v(60) }];
  const r2 = I.checkPickup(job, 40, { pickups });
  assert.equal(r2.ok, true);
  const stats = I.computePickupStats(job, [...pickups, { id: 32, jobId: 2, variants: v(40) }]);
  assert.equal(stats.available, 0);
});

test("Ambil: pickup 1 lagi setelah order 60/pickup 60 -> DITOLAK", () => {
  const job = { id: 2, kodePekerjaan: "JOB-2", variants: v(60) };
  const pickups = [{ id: 31, jobId: 2, variants: v(60) }];
  const res = I.checkPickup(job, 1, { pickups });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "over");
  assert.equal(res.available, 0);
  assert.match(res.message, /Sisa yang dapat diambil: 0 pcs/);
  // dan job penuh tidak dianggap tersedia
  assert.equal(I.computePickupStats(job, pickups).available, 0);
});

test("Ambil: qty 0/negatif ditolak; transaksi job A tidak bocor ke job B", () => {
  const jobA = { id: 2, kodePekerjaan: "JOB-2", variants: v(100) };
  const jobB = { id: 3, kodePekerjaan: "JOB-3", variants: v(100) };
  assert.equal(I.checkPickup(jobA, 0, { pickups: [] }).ok, false);
  assert.equal(I.checkPickup(jobA, -1, { pickups: [] }).ok, false);
  const pickups = [{ id: 31, jobId: 2, kode: "JOB-2", variants: v(100) }];
  // job A penuh, job B tetap kosong
  assert.equal(I.checkPickup(jobA, 1, { pickups }).ok, false);
  assert.equal(I.checkPickup(jobB, 100, { pickups }).ok, true);
});

test("Storan: pickup 80, stor 50 -> berhasil (pending 30)", () => {
  const job = { id: 4, kodePekerjaan: "JOB-4", variants: v(100) };
  const pickups = [{ id: 41, jobId: 4, kode: "JOB-4", variants: v(80) }];
  const r1 = I.checkStoran(pickups[0], 50, { pickups, storages: [] });
  assert.equal(r1.ok, true);
  const storages = [{ id: 51, ambilId: 41, variants: v(50) }];
  const stats = I.computeStoranStats(job, pickups, storages);
  assert.equal(stats.taken, 80);
  assert.equal(stats.stored, 50);
  assert.equal(stats.pending, 30);
});

test("Storan: stor 30 lagi -> berhasil tepat habis; stor 1 lagi -> DITOLAK", () => {
  const job = { id: 4, kodePekerjaan: "JOB-4", variants: v(100) };
  const pickups = [{ id: 41, jobId: 4, kode: "JOB-4", variants: v(80) }];
  const storages = [{ id: 51, ambilId: 41, variants: v(50) }];
  const r = I.checkStoran(pickups[0], 30, { pickups, storages });
  assert.equal(r.ok, true);
  assert.equal(r.pending, 30);
  const all = [...storages, { id: 52, ambilId: 41, variants: v(30) }];
  const res = I.checkStoran(pickups[0], 1, { pickups, storages: all });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "over");
  assert.match(res.message, /Sisa yang dapat distor: 0 pcs/);
});

test("Storan: qty 0/negatif ditolak; ceiling pickup lain tidak tercampur", () => {
  const pickups = [
    { id: 41, jobId: 4, kode: "JOB-4", variants: v(80) },
    { id: 42, jobId: 5, kode: "JOB-5", variants: v(90) },
  ];
  const storages = [{ id: 51, ambilId: 42, variants: v(90) }];
  const res = I.checkStoran(pickups[0], 0, { pickups, storages });
  assert.equal(res.ok, false);
  assert.equal(I.checkStoran(pickups[0], -3, { pickups, storages }).ok, false);
  // pending pickup #41 tetap 80 meski pickup #42 sudah lunas distor
  const r = I.checkStoran(pickups[0], 80, { pickups, storages });
  assert.equal(r.ok, true);
  assert.equal(r.pending, 80);
});

test("IDENTITY: transaksi dengan jobId + kode sama hanya dihitung SEKALI", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const tx = { id: 11, jobId: 1, kode: "JOB-1", variants: v(60) };
  assert.deepEqual(I.txKeys(tx), ["job:1"]);
  assert.equal(I.txBelongsToJob(tx, job), true);
  assert.equal(I.computeShipmentStats(job, [tx]).shipped, 60);
  assert.equal(I.computeShipmentStats(job, [tx]).count, 1);
});

test("IDENTITY: transaksi legacy tanpa jobId tetap dihitung via kode", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const legacy = { id: 12, kode: "JOB-1", variants: v(30) }; // no jobId
  assert.deepEqual(I.txKeys(legacy), ["kode:job-1"]);
  assert.equal(I.txBelongsToJob(legacy, job), true);
  const stats = I.computeShipmentStats(job, [
    { id: 11, jobId: 1, kode: "JOB-1", variants: v(60) },
    legacy,
  ]);
  assert.equal(stats.shipped, 90);
  assert.equal(stats.count, 2);
});

test("IDENTITY: transaksi job A tidak masuk ke job B (jobId menang atas kode)", () => {
  const jobA = { id: 1, kodePekerjaan: "JOB-SAMA", variants: v(100) };
  const jobB = { id: 2, kodePekerjaan: "JOB-SAMA", variants: v(100) };
  const txOfA = { id: 11, jobId: 1, kode: "JOB-SAMA", variants: v(70) };
  assert.equal(I.txBelongsToJob(txOfA, jobA), true);
  assert.equal(I.txBelongsToJob(txOfA, jobB), false);
  const stA = I.computeShipmentStats(jobA, [txOfA]);
  const stB = I.computeShipmentStats(jobB, [txOfA]);
  assert.equal(stA.shipped, 70);
  assert.equal(stB.shipped, 0);
  // job tanpa kode (legacy) hanya dijangkau lewat id
  const jobNoCode = { id: 1, variants: v(100) };
  assert.equal(I.txBelongsToJob(txOfA, jobNoCode), true);
});

test("IDENTITY: legacy tanpa kode dan tanpa jobId tidak terhitung (bukan error)", () => {
  const job = { id: 1, kodePekerjaan: "JOB-1", variants: v(100) };
  const orphan = { id: 13, variants: v(50) };
  assert.deepEqual(I.txKeys(orphan), []);
  assert.equal(I.txBelongsToJob(orphan, job), false);
  assert.equal(I.computeShipmentStats(job, [orphan]).shipped, 0);
});
