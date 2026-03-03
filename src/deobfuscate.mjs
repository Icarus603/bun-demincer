#!/usr/bin/env node
/**
 * Full Deobfuscation Pipeline for Bun Bundle Chunks
 *
 * Runs a multi-stage pipeline to transform minified split files into
 * beautifully formatted, human-readable code.
 *
 * Stages:
 *   1. wakaru unminify — structural transforms (!0→true, void 0→undefined,
 *      split comma exprs, restore ?./??/, var→const/let, arrow functions)
 *   2. lebab — ES5→ES6+ (safety net for anything wakaru missed:
 *      arrow, obj-shorthand, for-of, etc.)
 *   3. extract — auto-generate rename map from MR() export mappings
 *   3b. extract-names — auto-generate renames from this.name/displayName patterns
 *   4. rename.mjs — our AST-based identifier rename pass (batch JSON)
 *   5. prettier — final consistent formatting
 *
 * Usage:
 *   node deobfuscate.mjs --dir versions/2026-02-28_v2.1.63/decoded/
 *   node deobfuscate.mjs --dir decoded/ --batch renames-v2.1.63.json
 *   node deobfuscate.mjs --dir decoded/ --skip wakaru --skip lebab
 *   node deobfuscate.mjs --dir decoded/ --only prettier
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Argument parsing ──────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dir: null,
    batch: [],  // multiple batch files supported
    skip: new Set(),
    only: null, // if set, run only this stage
    concurrency: 4,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--dir":
        opts.dir = args[++i];
        i++;
        break;
      case "--batch":
        opts.batch.push(args[++i]);
        i++;
        break;
      case "--skip":
        opts.skip.add(args[++i]);
        i++;
        break;
      case "--only":
        opts.only = args[++i];
        i++;
        break;
      case "--concurrency":
        opts.concurrency = parseInt(args[++i], 10);
        i++;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  if (!opts.dir) {
    console.error("Error: --dir is required");
    printUsage();
    process.exit(1);
  }

  return opts;
}

function printUsage() {
  console.log(`
Usage: node deobfuscate.mjs --dir <path> [options]

Options:
  --dir <path>         Directory containing split .js files (required)
  --batch <path>       Rename JSON file for the rename stage
  --skip <stage>       Skip a stage (wakaru, lebab, extract, extract-names, rename, prettier)
  --only <stage>       Run only this stage
  --concurrency <n>    Max concurrent wakaru processes (default: 4)
  -h, --help           Show this help

Stages: wakaru → lebab → extract → extract-names → rename → prettier
  extract auto-generates a rename map from MR() export mappings
  extract-names finds renames from this.name/displayName patterns
  `);
}

// ── Stage 1: wakaru unminify ──────────────────────────────────────

async function stageWakaru(dir, files, concurrency) {
  console.log("\n━━━ Stage 1: wakaru unminify ━━━");

  // wakaru requires input files inside CWD and outputs to an output dir.
  // Strategy: run wakaru with CWD=dir, output to .wakaru-out, copy back.
  //
  // For vendor/ files, group by directory and process each separately.
  const topFiles = files.filter((f) => !f.includes(path.sep));
  const vendorByDir = new Map(); // dir -> [basename, ...]
  for (const f of files) {
    if (!f.startsWith("vendor" + path.sep)) continue;
    const vendorSubdir = path.dirname(f); // e.g., "vendor/rxjs" or "vendor"
    const absDir = path.join(dir, vendorSubdir);
    if (!vendorByDir.has(absDir)) vendorByDir.set(absDir, []);
    vendorByDir.get(absDir).push(path.basename(f));
  }

  let processed = 0;
  let errors = 0;

  // Process top-level files
  if (topFiles.length > 0) {
    const result = await runWakaru(dir, topFiles, concurrency);
    processed += result.processed;
    errors += result.errors;
  }

  // Process vendor files (per directory)
  for (const [vendorDir, vendorFiles] of vendorByDir) {
    if (vendorFiles.length > 0 && fs.existsSync(vendorDir)) {
      const result = await runWakaru(vendorDir, vendorFiles, concurrency);
      processed += result.processed;
      errors += result.errors;
    }
  }

  console.log(
    `  Processed ${processed}/${files.length} files` +
      (errors > 0 ? ` (${errors} errors)` : "")
  );
  console.log("  Done.");
}

async function runWakaru(cwd, files, concurrency) {
  const outDir = path.join(cwd, ".wakaru-out");
  fs.rmSync(outDir, { recursive: true, force: true });

  const LARGE_FILE_THRESHOLD = 500_000; // 500KB
  const LARGE_FILE_TIMEOUT = 600_000;   // 10 min
  const NORMAL_TIMEOUT = 180_000;       // 3 min

  // Separate large files from normal ones
  const largeFiles = [];
  const normalFiles = [];
  for (const f of files) {
    const filePath = path.join(cwd, f);
    const size = fs.statSync(filePath).size;
    if (size > LARGE_FILE_THRESHOLD) {
      largeFiles.push(f);
    } else {
      normalFiles.push(f);
    }
  }

  if (largeFiles.length > 0) {
    console.log(`  Large files (>500KB, extended timeout): ${largeFiles.join(", ")}`);
  }

  let processed = 0;
  let errors = 0;

  // Process large files one at a time with extended timeout
  for (const f of largeFiles) {
    try {
      execSync(
        `npx @wakaru/cli unminify ${JSON.stringify(f)} -o .wakaru-out -f`,
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: LARGE_FILE_TIMEOUT,
        }
      );
    } catch (err) {
      // wakaru may partially succeed — we check output below
    }

    const outPath = path.join(outDir, f);
    if (fs.existsSync(outPath)) {
      processed++;
    } else {
      console.warn(`  Warning: wakaru failed on ${f} (large file)`);
      errors++;
    }
    process.stdout.write(
      `  ${path.basename(cwd)}: ${processed}/${files.length} files\r`
    );
  }

  // Process normal files in batches
  const batches = [];
  for (let i = 0; i < normalFiles.length; i += concurrency) {
    batches.push(normalFiles.slice(i, i + concurrency));
  }

  for (const batch of batches) {
    const fileArgs = batch.map((f) => JSON.stringify(f)).join(" ");
    try {
      execSync(
        `npx @wakaru/cli unminify ${fileArgs} -o .wakaru-out -f --concurrency ${batch.length}`,
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: NORMAL_TIMEOUT,
        }
      );
    } catch (err) {
      // wakaru may partially succeed — we check output files below
    }

    // Check which files were output
    for (const f of batch) {
      const outPath = path.join(outDir, f);
      if (fs.existsSync(outPath)) {
        processed++;
      } else {
        console.warn(`  Warning: wakaru failed on ${f}`);
        errors++;
      }
    }
    process.stdout.write(
      `  ${path.basename(cwd)}: ${processed}/${files.length} files\r`
    );
  }
  console.log();

  // Copy results back (overwrite originals)
  for (const f of files) {
    const outPath = path.join(outDir, f);
    if (fs.existsSync(outPath)) {
      fs.copyFileSync(outPath, path.join(cwd, f));
    }
  }

  // Clean up
  fs.rmSync(outDir, { recursive: true, force: true });

  return { processed, errors };
}

// ── Stage 2: lebab ────────────────────────────────────────────────

function stageLebab(dir, files) {
  console.log("\n━━━ Stage 2: lebab (ES5→ES6+) ━━━");

  const lebab = require("lebab");
  // Safe transforms only — these won't break code
  const transforms = [
    "arrow",
    "arrow-return",
    "for-of",
    "arg-rest",
    "arg-spread",
    "obj-method",
    "obj-shorthand",
    "no-strict",
    "multi-var",
  ];

  let changed = 0;
  let totalWarnings = 0;

  for (const f of files) {
    const filePath = path.join(dir, f);
    const code = fs.readFileSync(filePath, "utf-8");

    try {
      const result = lebab.transform(code, transforms);
      if (result.code !== code) {
        fs.writeFileSync(filePath, result.code, "utf-8");
        changed++;
      }
      totalWarnings += result.warnings.length;
    } catch (err) {
      console.warn(`  Warning: lebab failed on ${f}: ${err.message}`);
    }
  }

  console.log(`  Modified ${changed}/${files.length} files (${totalWarnings} warnings)`);
  console.log("  Done.");
}

// ── Stage 3: extract-exports (auto-rename map) ──────────────────

function stageExtract(dir) {
  console.log("\n━━━ Stage 3: extract (auto-rename from MR() exports) ━━━");

  const extractMjs = path.join(__dirname, "extract-exports.mjs");
  const outFile = path.join(dir, ".auto-renames.json");

  try {
    const result = execSync(
      `node "${extractMjs}" "${dir}" --out "${outFile}" --stats`,
      {
        cwd: __dirname,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }
    );

    // --stats output goes to stderr
    if (!fs.existsSync(outFile)) {
      console.warn("  Warning: extract-exports produced no output file");
      return null;
    }

    const data = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    const count = Object.keys(data).length;
    console.log(`  Extracted ${count} auto-renames from MR() export mappings`);

    return outFile;
  } catch (err) {
    // Print any stats/info from stderr
    if (err.stderr) {
      const stats = err.stderr.toString().trim();
      if (stats) console.log(`  ${stats}`);
    }
    console.warn("  Warning: extract-exports failed, continuing without auto-renames");
    // Clean up partial output
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
    return null;
  }
}

// ── Stage 3b: extract-names (this.name/displayName patterns) ─────

function stageExtractNames(dir, existingBatchFiles) {
  console.log("\n━━━ Stage 3b: extract-names (this.name/displayName patterns) ━━━");

  const extractNamesMjs = path.join(__dirname, "extract-names.mjs");
  const outFile = path.join(dir, ".auto-names.json");

  // Build --exclude-existing args from all batch files collected so far
  const excludeArgs = existingBatchFiles
    .filter((f) => fs.existsSync(f))
    .map((f) => `"${f}"`)
    .join(" ");
  const excludeFlag = excludeArgs ? `--exclude-existing ${excludeArgs}` : "";

  try {
    execSync(
      `node "${extractNamesMjs}" "${dir}" --out "${outFile}" --stats ${excludeFlag}`,
      {
        cwd: __dirname,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }
    );

    if (!fs.existsSync(outFile)) {
      console.warn("  Warning: extract-names produced no output file");
      return null;
    }

    const data = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    const count = Object.keys(data).length;
    console.log(`  Extracted ${count} auto-renames from name patterns`);

    return outFile;
  } catch (err) {
    if (err.stderr) {
      const stats = err.stderr.toString().trim();
      if (stats) console.log(`  ${stats}`);
    }
    console.warn("  Warning: extract-names failed, continuing without name renames");
    if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
    return null;
  }
}

// ── Stage 4: rename.mjs ──────────────────────────────────────────

function stageRename(dir, batchFiles) {
  console.log("\n━━━ Stage 4: rename (AST identifier rename) ━━━");

  if (!batchFiles || batchFiles.length === 0) {
    console.log("  Skipped (no --batch file provided)");
    return;
  }

  const renameMjs = path.join(__dirname, "rename.mjs");

  // Merge all batch files into a single rename map
  const merged = {};
  for (const bf of batchFiles) {
    const batchPath = path.resolve(bf);
    if (!fs.existsSync(batchPath)) {
      console.warn(`  Warning: batch file not found: ${batchPath}`);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(batchPath, "utf-8"));
    Object.assign(merged, data);
  }

  if (Object.keys(merged).length === 0) {
    console.log("  Skipped (no renames to apply)");
    return;
  }

  // Write merged renames to temp file
  const tmpBatch = path.join(dir, ".rename-batch-tmp.json");
  fs.writeFileSync(tmpBatch, JSON.stringify(merged, null, 2));

  try {
    const output = execSync(
      `node "${renameMjs}" --batch "${tmpBatch}" --dir "${dir}"`,
      {
        cwd: __dirname,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120000,
      }
    );
    const lines = output.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) console.log(`  ${line}`);
    }
  } catch (err) {
    if (err.stdout) {
      const lines = err.stdout.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) console.log(`  ${line}`);
      }
    }
    if (err.stderr) {
      console.warn(`  Rename stderr: ${err.stderr.toString().slice(0, 500)}`);
    }
  }

  // Clean up
  fs.rmSync(tmpBatch, { force: true });

  console.log("  Done.");
}

// ── Stage 5: prettier ─────────────────────────────────────────────

async function formatWithFallback(prettier, code) {
  const parsers = ["babel", "babel-flow", "meriyah", "acorn"];
  for (const parser of parsers) {
    try {
      return { result: await prettier.format(code, {
        parser,
        printWidth: 100,
        tabWidth: 2,
        semi: true,
        singleQuote: false,
        trailingComma: "all",
      }), parser };
    } catch (err) {
      // Try next parser
    }
  }
  return null; // all parsers failed
}

async function stagePrettier(dir, files) {
  console.log("\n━━━ Stage 5: prettier (final formatting) ━━━");

  const prettier = await import("prettier");

  let formatted = 0;
  let errors = 0;
  let fallbacks = 0;

  for (const f of files) {
    const filePath = path.join(dir, f);
    const code = fs.readFileSync(filePath, "utf-8");

    const formatted_result = await formatWithFallback(prettier, code);
    if (formatted_result) {
      if (formatted_result.parser !== "babel") {
        fallbacks++;
        console.log(`  Fallback: ${f} formatted with parser "${formatted_result.parser}"`);
      }
      if (formatted_result.result !== code) {
        fs.writeFileSync(filePath, formatted_result.result, "utf-8");
        formatted++;
      }
    } else {
      console.warn(`  Warning: prettier failed on ${f} (all parsers failed)`);
      errors++;
    }
  }

  console.log(
    `  Formatted ${formatted}/${files.length} files` +
    (fallbacks > 0 ? ` (${fallbacks} used fallback parser)` : "") +
    (errors > 0 ? ` (${errors} errors)` : "")
  );
  console.log("  Done.");
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const dir = path.resolve(opts.dir);

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  // Find all JS files (exclude manifest.json, vendor/ handled separately)
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort();

  // Also process vendor/ if it exists (supports flat, nested, and scoped pkg dirs)
  const vendorDir = path.join(dir, "vendor");
  const vendorFiles = [];
  if (fs.existsSync(vendorDir)) {
    function scanVendorDir(absDir, relDir) {
      for (const entry of fs.readdirSync(absDir)) {
        const absPath = path.join(absDir, entry);
        const stat = fs.statSync(absPath);
        if (stat.isFile() && entry.endsWith(".js")) {
          vendorFiles.push(path.join(relDir, entry));
        } else if (stat.isDirectory() && entry !== ".wakaru-out") {
          scanVendorDir(absPath, path.join(relDir, entry));
        }
      }
    }
    scanVendorDir(vendorDir, "vendor");
  }

  const allFiles = [...files, ...vendorFiles];

  console.log(`Deobfuscation pipeline: ${allFiles.length} files in ${dir}`);

  const stages = ["wakaru", "lebab", "extract", "extract-names", "rename", "prettier"];
  const activeStages = opts.only
    ? stages.filter((s) => s === opts.only)
    : stages.filter((s) => !opts.skip.has(s));

  console.log(`Active stages: ${activeStages.join(" → ")}`);

  const startTime = Date.now();
  let autoRenamesFile = null; // track for cleanup after rename
  let autoNamesFile = null;   // track for cleanup after rename

  for (const stage of activeStages) {
    const stageStart = Date.now();

    switch (stage) {
      case "wakaru":
        await stageWakaru(dir, allFiles, opts.concurrency);
        break;
      case "lebab":
        stageLebab(dir, allFiles);
        break;
      case "extract":
        autoRenamesFile = stageExtract(dir);
        if (autoRenamesFile) {
          opts.batch.push(autoRenamesFile);
        }
        break;
      case "extract-names":
        autoNamesFile = stageExtractNames(dir, opts.batch);
        if (autoNamesFile) {
          opts.batch.push(autoNamesFile);
        }
        break;
      case "rename":
        stageRename(dir, opts.batch);
        // Clean up auto-generated renames files
        if (autoRenamesFile) {
          fs.rmSync(autoRenamesFile, { force: true });
          autoRenamesFile = null;
        }
        if (autoNamesFile) {
          fs.rmSync(autoNamesFile, { force: true });
          autoNamesFile = null;
        }
        break;
      case "prettier":
        await stagePrettier(dir, allFiles);
        break;
    }

    const elapsed = ((Date.now() - stageStart) / 1000).toFixed(1);
    console.log(`  (${elapsed}s)`);
  }

  // Final cleanup in case rename was skipped but extract ran
  if (autoRenamesFile && fs.existsSync(autoRenamesFile)) {
    fs.rmSync(autoRenamesFile, { force: true });
  }
  if (autoNamesFile && fs.existsSync(autoNamesFile)) {
    fs.rmSync(autoNamesFile, { force: true });
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nPipeline complete in ${totalElapsed}s`);
}

main().catch((err) => {
  console.error("Pipeline failed:", err);
  process.exit(1);
});
