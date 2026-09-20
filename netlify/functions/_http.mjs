// Shared HTTP helpers for the /api functions.

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function errorResponse(status, code, message) {
  return json({ error: code, message }, status);
}

export async function readJson(req) {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

export function isNonEmptyString(v, max = 200) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

export function isValidEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
}

const MENU_KEYS = [
  "tab1",
  "tab2",
  "tab3",
  "tab5",
  "tab4",
  "kasbon",
  "tab6",
  "tab7",
  "aset",
  "arsip",
  "member",
];

export function sanitizePermissions(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((p) => MENU_KEYS.includes(p)))];
}

// Never leak driver/connection details to the client.
export function safeDbError(e) {
  if (String(e && e.message) === "DB_NOT_CONFIGURED") {
    return errorResponse(503, "db_not_configured", "Database is not configured on the server.");
  }
  return errorResponse(500, "db_error", "Terjadi kesalahan database. Coba lagi nanti.");
}
