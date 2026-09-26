// Konveksi YANS — date display & filtering helpers (UI polish round).
// Scope: DISPLAY only. Every date is stored/transmitted in the original ISO
// YYYY-MM-DD format (database/API unchanged); this file only formats what the
// user sees and compares range bounds inclusively.
//
//   fmtDmy(v)          -> "24/09/2026" ("" for empty/invalid)
//   inDateRange(v, d, e) -> inclusive [d..e], true when either bound empty
//   showDate(v)        -> fmtDmy for date-like values, passthrough otherwise
//
// Legacy-safe: accepts ISO strings, JS Date objects (pg DATE columns arrive as
// Date in the browser), and pre-existing legacy values (e.g. "24-09-2026") are
// passed through unchanged so old rows stay readable.
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
  var DMY_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

  function asIso(v) {
    if (v == null || v === "") return "";
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return "";
      var y = v.getFullYear();
      var m = String(v.getMonth() + 1).padStart(2, "0");
      var d = String(v.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + d;
    }
    var s = String(v).trim();
    if (ISO_RE.test(s)) return s.slice(0, 10);
    // Legacy "DD-MM-YYYY" kept as-is by design; DMY slash already fine for range.
    return "";
  }

  function fmtDmy(v) {
    if (v == null || v === "") return "";
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return "";
      return String(v.getDate()).padStart(2, "0") + "/" +
        String(v.getMonth() + 1).padStart(2, "0") + "/" + v.getFullYear();
    }
    var s = String(v).trim();
    var m = ISO_RE.exec(s);
    if (m) return m[3] + "/" + m[2] + "/" + m[1];
    var dm = DMY_RE.exec(s);
    if (dm) return ("0" + dm[1]).slice(-2) + "/" + ("0" + dm[2]).slice(-2) + "/" + dm[3];
    return s; // legacy value: show as stored
  }

  function inDateRange(v, startIso, endIso) {
    if (startIso == null || startIso === "") return true;
    if (v == null || v === "") return false;
    if (startIso && endIso == null) {
      // start-only: keep legacy passthrough rows visible (DMY compared lexically
      // against ISO would be wrong; treat as in-range to avoid hiding data).
      var dm = DMY_RE.exec(String(v).trim());
      if (dm) return true;
    }
    var a = asIso(v);
    if (!a) {
      // Unparseable/legacy values stay visible; never silently drop data.
      return true;
    }
    if (startIso && a < startIso) return false;
    if (endIso && a > endIso) return false;
    return true;
  }

  window.YansDate = { fmtDmy: fmtDmy, inDateRange: inDateRange, asIso: asIso };
  // Also expose a flat convenience alias used inside index.html templates.
  window.showDate = function (v) { return window.YansDate.fmtDmy(v); };
})();
