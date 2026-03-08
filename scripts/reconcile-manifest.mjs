#!/usr/bin/env node
// Reconcile manifest.json after manual file moves.
// Builds a global basename→path index (including vendor/), then patches
// every stale path in manifest.modules and manifest.fileOrder.
//
// Note: vendor module basenames (e.g. 0005.js) are NOT globally unique —
// multiple vendor packages can have files with the same name. For vendor-
// flagged modules, we match by vendorPackage name first.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, "../work/claude-code-2.1.71/decoded-organized");
const MANIFEST = path.join(BASE, "manifest.json");

// Build two indexes:
//   appIndex:    basename → rel path   (non-vendor dirs only, basenames unique)
//   vendorIndex: "packageName/basename" → rel path
function buildIndexes() {
  const appIndex = new Map();
  const vendorIndex = new Map();

  function walkApp(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "vendor") continue;
        walkApp(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".js")) {
        const rel = path.relative(BASE, path.join(dir, entry.name));
        if (appIndex.has(entry.name)) {
          console.warn(`WARN: duplicate app basename ${entry.name}: ${appIndex.get(entry.name)} vs ${rel}`);
        } else {
          appIndex.set(entry.name, rel);
        }
      }
    }
  }

  function walkVendor(dir, pkgName) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const childPkg = pkgName ? pkgName : entry.name;
        walkVendor(path.join(dir, entry.name), childPkg);
      } else if (entry.name.endsWith(".js")) {
        const rel = path.relative(BASE, path.join(dir, entry.name));
        const key = `${pkgName}/${entry.name}`;
        vendorIndex.set(key, rel);
      }
    }
  }

  walkApp(BASE);
  walkVendor(path.join(BASE, "vendor"), "");

  return { appIndex, vendorIndex };
}

console.log("Building indexes...");
const { appIndex, vendorIndex } = buildIndexes();
console.log(`  ${appIndex.size} app module files`);
console.log(`  ${vendorIndex.size} vendor module files`);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

// Patch modules
let updatedModules = 0;
let notFoundModules = 0;
for (const [, mod] of Object.entries(manifest.modules || {})) {
  if (!mod.file) continue;
  const base = path.basename(mod.file);

  let actual;
  if (mod.vendor && mod.vendorPackage) {
    // Try vendorIndex with the package name
    const key = `${mod.vendorPackage}/${base}`;
    actual = vendorIndex.get(key);
    // If not found by package, fall back to appIndex (some vendor-flagged modules
    // live in app dirs like settings/)
    if (!actual) actual = appIndex.get(base);
  } else {
    actual = appIndex.get(base);
  }

  if (!actual) {
    notFoundModules++;
    continue;
  }
  if (actual !== mod.file) {
    mod.file = actual;
    updatedModules++;
  }
}

// Patch fileOrder — these entries have no vendor metadata, so use a combined lookup:
// try appIndex first, then accept any vendorIndex match (first found wins)
let updatedOrder = 0;
const vendorByBase = new Map(); // base → first vendor path found (fallback)
for (const [key, val] of vendorIndex) {
  const base = key.split("/").pop();
  if (!vendorByBase.has(base)) vendorByBase.set(base, val);
}

manifest.fileOrder = (manifest.fileOrder || []).map((p) => {
  const base = path.basename(p);
  const actual = appIndex.get(base) || vendorByBase.get(base);
  if (!actual || actual === p) return p;
  updatedOrder++;
  return actual;
});

console.log(`Patched ${updatedModules} module paths, ${updatedOrder} fileOrder entries`);
if (notFoundModules > 0) console.warn(`WARN: ${notFoundModules} modules not resolved`);

fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log("manifest.json written.");

// Staleness check (app modules only — vendor paths may legitimately not match)
const staleApp = (manifest.fileOrder || []).filter((p) => {
  if (p.startsWith("vendor/")) return false;
  if (p === "00-runtime.js") return false;
  return !fs.existsSync(path.join(BASE, p));
});
console.log(`Staleness check (app modules): ${staleApp.length} stale entries`);
if (staleApp.length > 0 && staleApp.length <= 30) console.log("Still stale:", staleApp);
