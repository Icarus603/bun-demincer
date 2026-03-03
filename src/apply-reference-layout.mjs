#!/usr/bin/env node
/**
 * apply-reference-layout.mjs — Apply a reference version's file layout to a target directory.
 *
 * Takes the file paths and vendor classifications from a reference manifest
 * (e.g., the fully-organized v2.1.63) and applies them to a target directory
 * (e.g., a freshly reproduced decoded-organized). Moves files to match the
 * reference layout and updates the target manifest.
 *
 * This replaces running move-vendors.mjs + move-vendors-utils.mjs +
 * move-uncategorized.mjs separately — all of which have hardcoded paths.
 *
 * Usage:
 *   node apply-reference-layout.mjs <target-dir> [options]
 *
 * Options:
 *   --reference <dir>   Reference decoded-organized directory
 *                        (default: versions/2026-02-28_v2.1.63/decoded-organized)
 *   --dry-run           Show what would change, don't modify files
 *   --stats             Print detailed statistics
 */

import fs from "fs";
import path from "path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    target: null,
    reference: path.join(__dirname, "versions/2026-02-28_v2.1.63/decoded-organized"),
    dryRun: false,
    stats: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--reference") opts.reference = args[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--stats") opts.stats = true;
    else if (a === "-h" || a === "--help") {
      console.error(`Usage: node apply-reference-layout.mjs <target-dir> [options]

Options:
  --reference <dir>   Reference decoded-organized directory
  --dry-run           Show what would change
  --stats             Print statistics`);
      process.exit(0);
    }
    else if (!opts.target) opts.target = a;
  }

  if (!opts.target) {
    console.error("Error: <target-dir> required");
    process.exit(1);
  }

  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const opts = parseArgs();
const targetDir = path.resolve(opts.target);
const refDir = path.resolve(opts.reference);

const refManifest = JSON.parse(fs.readFileSync(path.join(refDir, "manifest.json"), "utf8"));
const targetManifest = JSON.parse(fs.readFileSync(path.join(targetDir, "manifest.json"), "utf8"));

console.log(`Reference: ${refDir}`);
console.log(`Target:    ${targetDir}`);
console.log(`Modules:   ${Object.keys(refManifest.modules).length} ref, ${Object.keys(targetManifest.modules).length} target`);
console.log();

// Detect concatenated vendor files in the reference (old resplit format:
// multiple modules share vendor/<pkg>.js). For these, we keep individual files
// but move them to vendor/<pkg>/ directory.
const refFileCounts = {};
for (const meta of Object.values(refManifest.modules)) {
  refFileCounts[meta.file] = (refFileCounts[meta.file] || 0) + 1;
}
const concatenatedFiles = new Set(
  Object.entries(refFileCounts)
    .filter(([f, c]) => c > 1 && f.startsWith("vendor/"))
    .map(([f]) => f)
);

// Per-package counters for individual vendor file naming
const vendorPkgCounters = new Map();

// Build the move plan: for each module in target, check if ref has a different path
const moves = [];       // { modId, from, to, vendorChange }
const noRef = [];       // modules in target but not in ref
const noTarget = [];    // modules in ref but not in target
let alreadyCorrect = 0;

for (const [modId, targetMeta] of Object.entries(targetManifest.modules)) {
  const refMeta = refManifest.modules[modId];
  if (!refMeta) {
    noRef.push(modId);
    continue;
  }

  const targetFile = targetMeta.file;
  let refFile = refMeta.file;

  // Handle concatenated vendor files: ref says "vendor/aws-sdk.js" (old format)
  // but we want to keep individual files. Use "vendor/<pkg>/<NNNN>.js" instead.
  if (concatenatedFiles.has(refFile)) {
    const pkg = refFile.replace("vendor/", "").replace(".js", "");
    if (!vendorPkgCounters.has(pkg)) vendorPkgCounters.set(pkg, 1);
    const idx = vendorPkgCounters.get(pkg);
    vendorPkgCounters.set(pkg, idx + 1);

    // Keep the target's basename if it's already in the right vendor dir
    const targetBasename = path.basename(targetFile);
    if (targetFile.startsWith(`vendor/${pkg}/`)) {
      refFile = targetFile; // already in the right place
    } else {
      refFile = `vendor/${pkg}/${String(idx).padStart(4, "0")}.js`;
    }
  }

  if (targetFile === refFile) {
    alreadyCorrect++;
    continue;
  }

  moves.push({
    modId,
    from: targetFile,
    to: refFile,
    vendorChange: refMeta.vendor && !targetMeta.vendor,
    newVendor: !!refMeta.vendor,
    newVendorPackage: refMeta.vendorPackage || null,
  });
}

for (const modId of Object.keys(refManifest.modules)) {
  if (!targetManifest.modules[modId]) noTarget.push(modId);
}

console.log(`Already correct: ${alreadyCorrect}`);
console.log(`Need to move:    ${moves.length}`);
console.log(`  Vendor reclassify: ${moves.filter(m => m.vendorChange).length}`);
console.log(`  Dir change only:   ${moves.filter(m => !m.vendorChange).length}`);
console.log(`No ref match:    ${noRef.length} (new modules, left as-is)`);
console.log(`Missing in target: ${noTarget.length} (removed modules)`);
console.log();

if (opts.dryRun) {
  // Show sample moves
  const samples = moves.slice(0, 20);
  console.log("=== Sample moves ===");
  for (const m of samples) {
    const tag = m.vendorChange ? " [→vendor]" : "";
    console.log(`  ${m.from} → ${m.to}${tag}`);
  }
  if (moves.length > 20) console.log(`  ... and ${moves.length - 20} more`);
  console.log();
  console.log("Dry run — no files modified.");
  process.exit(0);
}

// ─── Execute moves ────────────────────────────────────────────────────────────

let moved = 0, created = 0, skipped = 0;
const createdDirs = new Set();
const fileOrderMap = new Map(); // old path → new path

for (const m of moves) {
  const srcPath = path.join(targetDir, m.from);
  const dstPath = path.join(targetDir, m.to);

  if (!fs.existsSync(srcPath)) {
    skipped++;
    continue;
  }

  // Create destination directory
  const dstDir = path.dirname(dstPath);
  if (!createdDirs.has(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
    createdDirs.add(dstDir);
  }

  // Check for collision
  if (fs.existsSync(dstPath) && srcPath !== dstPath) {
    // Append module ID to avoid collision
    const ext = path.extname(m.to);
    const base = m.to.slice(0, -ext.length);
    const newTo = `${base}-${m.modId}${ext}`;
    const newDstPath = path.join(targetDir, newTo);
    fs.renameSync(srcPath, newDstPath);
    m.to = newTo;
  } else {
    fs.renameSync(srcPath, dstPath);
  }

  // Update manifest — always sync vendor flag with reference
  targetManifest.modules[m.modId].file = m.to;
  targetManifest.modules[m.modId].vendor = m.newVendor;
  if (m.newVendorPackage) {
    targetManifest.modules[m.modId].vendorPackage = m.newVendorPackage;
  } else {
    delete targetManifest.modules[m.modId].vendorPackage;
  }

  fileOrderMap.set(m.from, m.to);
  moved++;
}

// Sync vendor flags for all modules (including those that didn't need moving)
for (const [modId, refMeta] of Object.entries(refManifest.modules)) {
  if (!targetManifest.modules[modId]) continue;
  targetManifest.modules[modId].vendor = !!refMeta.vendor;
  if (refMeta.vendorPackage) {
    targetManifest.modules[modId].vendorPackage = refMeta.vendorPackage;
  } else {
    delete targetManifest.modules[modId].vendorPackage;
  }
}

// Update fileOrder
if (targetManifest.fileOrder) {
  targetManifest.fileOrder = targetManifest.fileOrder.map(f => fileOrderMap.get(f) || f);
}

// Update sourceOrder
if (targetManifest.sourceOrder) {
  for (const entry of targetManifest.sourceOrder) {
    if (entry.file && fileOrderMap.has(entry.file)) {
      entry.file = fileOrderMap.get(entry.file);
    }
  }
}

// Add metadata
targetManifest._meta = {
  ...targetManifest._meta,
  layoutAppliedFrom: refDir,
  layoutAppliedAt: new Date().toISOString(),
};

// Write updated manifest
fs.writeFileSync(
  path.join(targetDir, "manifest.json"),
  JSON.stringify(targetManifest, null, 2)
);

// Clean up empty directories
function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name));
    }
  }
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
    }
  } catch (e) { /* ignore */ }
}
removeEmptyDirs(targetDir);

console.log(`Moved:   ${moved} files`);
console.log(`Skipped: ${skipped} (source not found)`);
console.log(`Dirs created: ${createdDirs.size}`);
console.log(`Manifest updated.`);

if (opts.stats) {
  console.log();
  console.log("=== Post-layout stats ===");
  let vendorCount = 0, appCount = 0;
  const dirs = new Set();
  for (const [, meta] of Object.entries(targetManifest.modules)) {
    if (meta.vendor) vendorCount++;
    else appCount++;
    const dir = meta.file.split("/").slice(0, -1).join("/") || ".";
    dirs.add(dir);
  }
  console.log(`  App modules:    ${appCount}`);
  console.log(`  Vendor modules: ${vendorCount}`);
  console.log(`  Directories:    ${dirs.size}`);
}
