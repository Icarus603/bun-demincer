#!/usr/bin/env node
// build.mjs — Reassemble decoded-organized/ modules back into a runnable Bun bundle.
//
// Usage:
//   node scripts/build.mjs <version-dir> [options]
//
// Arguments:
//   <version-dir>    Path to the version working directory
//                    e.g. work/claude-code-2.1.71
//
// Options:
//   --source <dir>   Source directory name inside version-dir (default: decoded-organized)
//   --out <path>     Output JS file (default: <version-dir>/bundle-rebuilt.js)
//   --no-bun-cjs     Omit @bun @bytecode @bun-cjs header (plain IIFE, more portable)
//   --run            After building, execute with bun and print --version output

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI Parsing ──────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
Usage: node scripts/build.mjs <version-dir> [options]

Arguments:
  <version-dir>    Version working directory (e.g. work/claude-code-2.1.71)

Options:
  --source <dir>   App module source directory inside version-dir (default: decoded-organized)
                   Vendor modules are always taken from the sibling "decoded" directory
                   to avoid prettier-induced class hoisting issues.
  --out <path>     Output bundle JS path (default: <version-dir>/bundle-rebuilt.js)
  --no-bun-cjs     Skip @bun @bytecode @bun-cjs header (plain IIFE, more portable)
  --run            Run the built bundle with bun --version after building
  -h, --help       Show this help
  `);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) { printUsage(); process.exit(0); }

const opts = {
  versionDir: null,
  source: "decoded-organized",
  out: null,
  noBunCjs: false,
  run: false,
};

let i = 0;
while (i < args.length) {
  switch (args[i]) {
    case "--source": opts.source = args[++i]; i++; break;
    case "--out":    opts.out    = args[++i]; i++; break;
    case "--no-bun-cjs": opts.noBunCjs = true; i++; break;
    case "--run": opts.run = true; i++; break;
    default:
      if (!args[i].startsWith("--") && !opts.versionDir) {
        opts.versionDir = args[i]; i++;
      } else {
        console.error(`Unknown argument: ${args[i]}`); process.exit(1);
      }
  }
}

if (!opts.versionDir) {
  console.error("Error: <version-dir> is required.");
  printUsage();
  process.exit(1);
}

const BASE = path.resolve(opts.versionDir, opts.source);
// Native addons (.node files) extracted from the original binary
const NATIVE_DIR = path.resolve(opts.versionDir, "extracted");
// The "decoded" directory (pre-prettier) is always used as the module order
// source and as the fallback for vendor modules.
// App modules in BASE (decoded-organized) override decoded versions.
const DECODED_BASE = path.resolve(opts.versionDir, "decoded");
const MANIFEST = path.join(DECODED_BASE, "manifest.json"); // use decoded fileOrder (correct positions, no dupes)
const ORG_MANIFEST = path.join(BASE, "manifest.json");
const OUT = opts.out ?? path.join(opts.versionDir, "bundle-rebuilt.js");

if (!fs.existsSync(MANIFEST)) {
  console.error(`Error: manifest.json not found at ${MANIFEST}`);
  process.exit(1);
}

// ─── Load Manifests ───────────────────────────────────────────────────────────

// Use decoded manifest for fileOrder (authoritative module positions, no dupes).
// Use org manifest to map module IDs → new org paths (decoded-organized subdir structure).
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const fileOrder = manifest.fileOrder;

// Build decoded-file → org-file override map
const orgOverride = new Map(); // decoded relative path → org relative path
if (BASE !== DECODED_BASE && fs.existsSync(ORG_MANIFEST)) {
  const orgManifest = JSON.parse(fs.readFileSync(ORG_MANIFEST, "utf8"));
  for (const [id, orgMod] of Object.entries(orgManifest.modules)) {
    // Only override app modules (not vendor) — vendor modules keep their decoded
    // minified versions to avoid prettier class-hoisting issues.
    if (orgMod.vendor) continue;
    const decodedMod = manifest.modules[id];
    if (orgMod.file && decodedMod?.file && orgMod.file !== decodedMod.file) {
      if (fs.existsSync(path.join(BASE, orgMod.file))) {
        orgOverride.set(decodedMod.file, orgMod.file);
      }
    }
  }
  console.log(`Org overrides: ${orgOverride.size} app modules`);
}
if (!Array.isArray(fileOrder) || fileOrder.length === 0) {
  console.error("Error: manifest.json has no fileOrder array.");
  process.exit(1);
}

console.log(`Source:  ${BASE}`);
console.log(`Output:  ${OUT}`);
console.log(`Modules: ${fileOrder.length}`);

// ─── Assemble ─────────────────────────────────────────────────────────────────

// Outer wrapper — same as original cli.js
// For --no-bun-cjs: inject a createRequire shim so the CJS wrapper has access to require.
// Bun runs the file as ESM when the @bun-cjs header is absent, so require is not defined.
const CJS_SHIM = opts.noBunCjs
  ? `import { createRequire as __createRequire } from "module";\n` +
    `import { fileURLToPath as __fileURLToPath } from "url";\n` +
    `const require = __createRequire(import.meta.url);\n` +
    `const __filename = __fileURLToPath(import.meta.url);\n` +
    `const __dirname = __fileURLToPath(new URL(".", import.meta.url));\n` +
    `const module = { exports: {} };\n` +
    `const exports = module.exports;\n`
  : "";

const OUTER_OPEN  = (opts.noBunCjs ? "" : "// @bun @bytecode @bun-cjs\n") +
  "(function(exports, require, module, __filename, __dirname) {";
// With @bun-cjs header: Bun's CJS loader calls the wrapper with (exports, require, module, __filename, __dirname).
// Without it (--no-bun-cjs): self-invoke the IIFE and inject Node.js CJS globals manually.
// With shim: pass the pre-defined CJS variables into the IIFE.
// With @bun-cjs: Bun's loader injects them automatically — just close the wrapper.
const OUTER_CLOSE = opts.noBunCjs
  ? `})(exports, require, module, __filename, __dirname)`
  : "})";

const out = fs.createWriteStream(OUT);
if (CJS_SHIM) out.write(CJS_SHIM);
out.write(OUTER_OPEN);

let missing = 0;
let written = 0;
let skippedDupes = 0;
const writtenPaths = new Set();

for (const relPath of fileOrder) {
  // Resolve to org override path if available, else fall back to decoded path
  const orgRelPath = orgOverride.get(relPath);
  let srcPath;

  if (orgRelPath) {
    // App module: use decoded-organized version (prettier + renamed)
    srcPath = path.join(BASE, orgRelPath);
  } else {
    // Vendor module or unchanged: use decoded version (minified, safe)
    srcPath = path.join(DECODED_BASE, relPath);
  }

  if (!fs.existsSync(srcPath)) {
    // Final fallback
    const fallback = path.join(DECODED_BASE, relPath);
    if (!fs.existsSync(fallback)) {
      console.warn(`WARN: missing ${relPath}`);
      missing++;
      continue;
    }
    srcPath = fallback;
  }

  // Skip true duplicates (same physical file seen twice)
  if (writtenPaths.has(srcPath)) {
    skippedDupes++;
    continue;
  }
  writtenPaths.add(srcPath);

  let src = fs.readFileSync(srcPath, "utf8");

  // Strip the resplit/deobfuscate comment header (// resplit: ... line)
  if (src.startsWith("//")) {
    const newline = src.indexOf("\n");
    if (newline !== -1) src = src.slice(newline + 1);
  }

  // Patch /$bunfs/root/ virtual paths → real paths to extracted native addons.
  // These are only valid inside a Bun standalone binary; replace with absolute paths.
  if (src.includes("/$bunfs/root/")) {
    src = src.replaceAll("/$bunfs/root/", NATIVE_DIR + "/");
  }

  out.write(src);
  written++;
}

out.write(OUTER_CLOSE);
out.end();

console.log(`\nWrote ${written} modules (${missing} missing, ${skippedDupes} dupes skipped) → ${OUT}`);

// ─── Run (optional) ───────────────────────────────────────────────────────────

if (opts.run) {
  console.log("\nRunning with bun...");
  try {
    const result = execSync(`bun ${OUT} --version`, { encoding: "utf8", timeout: 10000 });
    console.log(result.trim());
  } catch (e) {
    console.error("Run failed:", e.message);
    process.exit(1);
  }
}
