// Lightweight structural validation of netlify.toml (no TOML dependency).
// Catches the class of failure that broke deploys in ccfaa5c/0af5f99, where
// two statements fused into one line:  `status = 200[[redirects]]`
// (invalid TOML -> Netlify fails at "Reading and parsing configuration files").
// Full TOML parsing happens on Netlify; here we assert the invariants that
// matter for this file: no fused statements, every redirect block is complete,
// and every from= maps to a unique block.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import url from "node:url";

const tomlPath = url.fileURLToPath(new URL("../netlify.toml", import.meta.url));
const raw = fs.readFileSync(tomlPath, "utf8");
const lines = raw.split(/\r?\n/);

test("netlify.toml: tidak ada statement yang menempel dengan header blok", () => {
  const fused = lines.findIndex((l) => /=[^\n]*\[\[/.test(l));
  assert.equal(fused, -1, `baris ${fused + 1} menggabungkan value dengan [[header]]: "${lines[fused] ?? ""}"`);
});

test("netlify.toml: setiap blok [[redirects]] lengkap (from/to/status)", () => {
  const blocks = [];
  let cur = null;
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "[[redirects]]") {
      cur = { start: i + 1, from: null, to: null, status: null };
      blocks.push(cur);
    } else if (cur && line.trim() && !line.trim().startsWith("#")) {
      if (/^from\s*=/.test(line.trim())) cur.from = line.trim();
      else if (/^to\s*=/.test(line.trim())) cur.to = line.trim();
      else if (/^status\s*=/.test(line.trim())) cur.status = line.trim();
    }
  }
  assert.ok(blocks.length >= 10, "minimal 10 redirect terdaftar");
  for (const b of blocks) {
    assert.ok(b.from, `blok di baris ${b.start} tanpa from=`);
    assert.ok(b.to, `blok di baris ${b.start} tanpa to=`);
    assert.ok(b.status, `blok di baris ${b.start} tanpa status=`);
  }
});

test("netlify.toml: tidak ada rute /api/ yang duplikat", () => {
  const froms = lines.filter((l) => l.trim().startsWith("from =")).map((l) => l.trim());
  const dupes = froms.filter((f, i) => froms.indexOf(f) !== i);
  assert.deepEqual(dupes, [], `rute duplikat: ${dupes.join(", ")}`);
});

test("netlify.toml: bagian [build] dan [functions] utuh", () => {
  assert.match(raw, /\[build\][\s\S]*publish\s*=\s*"\."/, "[build] publish hilang");
  assert.match(raw, /\[functions\][\s\S]*directory\s*=\s*"netlify\/functions"/, "[functions] directory hilang");
});
