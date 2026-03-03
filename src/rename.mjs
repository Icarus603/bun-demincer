#!/usr/bin/env node
/**
 * AST-Aware Rename Tool for Bun Bundle Chunks
 *
 * Renames minified identifiers across split JS files using Babel AST traversal.
 * Correctly handles: variable declarations, references, function calls, assignments.
 * Correctly skips: string literals, comments, property keys, member expressions.
 *
 * Usage:
 *   node rename.mjs W9 getFeatureFlag --dir ./decoded/
 *   node rename.mjs --batch renames.json --dir ./decoded/
 *   node rename.mjs W9 getFeatureFlag --dir ./decoded/ --dry-run
 */

import fs from "fs";
import path from "path";
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import _traverse from "@babel/traverse";

// Handle ESM default export quirk
const traverse = _traverse.default || _traverse;

// Custom parser adapter for recast that uses Babel with our options
const recastParser = {
  parse(source) {
    return babelParse(source, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: true,
      plugins: ["jsx"],
      tokens: true, // recast needs tokens for format preservation
    });
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batch: null,
    dir: ".",
    manifest: null, // path to manifest.json for collision resolution
    dryRun: false,
    renames: {},
  };

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--batch") {
      opts.batch = args[++i];
      i++;
    } else if (args[i] === "--dir") {
      opts.dir = args[++i];
      i++;
    } else if (args[i] === "--manifest") {
      opts.manifest = args[++i];
      i++;
    } else if (args[i] === "--dry-run") {
      opts.dryRun = true;
      i++;
    } else if (!args[i].startsWith("--")) {
      // positional: oldName newName
      const oldName = args[i];
      const newName = args[i + 1];
      if (!newName) {
        console.error(`Error: missing new name for "${oldName}"`);
        process.exit(1);
      }
      opts.renames[oldName] = newName;
      i += 2;
    } else {
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
    }
  }

  if (opts.batch) {
    const batchPath = path.resolve(opts.batch);
    const batchData = JSON.parse(fs.readFileSync(batchPath, "utf-8"));
    Object.assign(opts.renames, batchData);
  }

  // Auto-detect manifest.json in --dir if not explicitly provided
  if (!opts.manifest) {
    const autoManifest = path.join(path.resolve(opts.dir), "manifest.json");
    if (fs.existsSync(autoManifest)) {
      opts.manifest = autoManifest;
    }
  }

  if (Object.keys(opts.renames).length === 0) {
    console.error(
      "Usage:\n" +
        "  node rename.mjs OldName NewName --dir ./decoded/\n" +
        "  node rename.mjs --batch renames.json --dir ./decoded/\n" +
        "  node rename.mjs OldName NewName --dir ./decoded/ --dry-run"
    );
    process.exit(1);
  }

  return opts;
}

function shouldRenameIdentifier(nodePath) {
  const parent = nodePath.parent;
  const key = nodePath.key;

  // SKIP: non-computed property keys in object expressions: { W9: val }
  if (parent.type === "ObjectProperty" && key === "key" && !parent.computed) {
    return false;
  }

  // SKIP: non-computed member expression property: obj.W9
  if (
    parent.type === "MemberExpression" &&
    key === "property" &&
    !parent.computed
  ) {
    return false;
  }

  // SKIP: non-computed method definition key: class { W9() {} }
  if (
    (parent.type === "ClassMethod" || parent.type === "ObjectMethod") &&
    key === "key" &&
    !parent.computed
  ) {
    return false;
  }

  // SKIP: non-computed class property key
  if (parent.type === "ClassProperty" && key === "key" && !parent.computed) {
    return false;
  }

  // SKIP: import/export specifiers (not relevant for bundle chunks, but safe)
  if (
    parent.type === "ImportSpecifier" ||
    parent.type === "ExportSpecifier"
  ) {
    return false;
  }

  // SKIP: label identifiers (for break/continue labels)
  if (parent.type === "LabeledStatement" && key === "label") {
    return false;
  }
  if (
    (parent.type === "BreakStatement" || parent.type === "ContinueStatement") &&
    key === "label"
  ) {
    return false;
  }

  // RENAME everything else: declarations, references, calls, assignments, etc.
  return true;
}

function processFile(filePath, renames, dryRun) {
  const code = fs.readFileSync(filePath, "utf-8");
  const renameEntries = Object.entries(renames);

  // Quick regex pre-filter: skip files that don't contain any of the old names
  const hasAny = renameEntries.some(([oldName]) => {
    const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    return re.test(code);
  });
  if (!hasAny) return { changed: false, counts: {} };

  // Parse with recast (preserves original source positions for format-preserving print)
  let ast;
  try {
    ast = recast.parse(code, { parser: recastParser });
  } catch (err) {
    console.error(`  Parse error in ${filePath}: ${err.message}`);
    return { changed: false, counts: {} };
  }

  // Check for collisions: warn if any newName already exists as identifier
  let existingIds;
  try {
    existingIds = new Set();
    traverse(ast, {
      Identifier(p) {
        existingIds.add(p.node.name);
      },
    });
  } catch (err) {
    console.error(`  Traverse error in ${path.basename(filePath)}: ${err.message} (skipping)`);
    return { changed: false, counts: {} };
  }

  // Filter out collisions: skip renames where newName already exists in this file
  const safeEntries = [];
  for (const [oldName, newName] of renameEntries) {
    if (existingIds.has(newName) && existingIds.has(oldName)) {
      console.warn(
        `  Skipping collision: "${newName}" already exists in ${path.basename(filePath)} (rename ${oldName} → ${newName})`
      );
    } else {
      safeEntries.push([oldName, newName]);
    }
  }
  if (safeEntries.length === 0) return { changed: false, counts: {} };

  // Build lookup set for fast checking
  const oldNameSet = new Set(safeEntries.map(([o]) => o));
  const renameMap = new Map(safeEntries);
  const counts = {};
  for (const [o] of renameEntries) counts[o] = 0;

  // Traverse and rename (recast tracks mutations for format-preserving print)
  let modified = false;

  try {
    traverse(ast, {
      Identifier(p) {
        const name = p.node.name;
        if (!oldNameSet.has(name)) return;
        if (!shouldRenameIdentifier(p)) return;

        const newName = renameMap.get(name);

        // Handle shorthand property: { W9 } → { W9: getFeatureFlag }
        if (
          p.parent.type === "ObjectProperty" &&
          p.parent.shorthand &&
          p.key === "value"
        ) {
          p.parent.shorthand = false;
          // The key stays as old name, value gets renamed
        }

        p.node.name = newName;
        counts[name]++;
        modified = true;
      },
    });
  } catch (err) {
    console.error(`  Rename traverse error in ${path.basename(filePath)}: ${err.message} (skipping)`);
    return { changed: false, counts: {} };
  }

  if (!modified) return { changed: false, counts };

  // Print with recast — only modified nodes are regenerated, everything else
  // is emitted as original source text (format-preserving)
  const output = recast.print(ast);

  if (!dryRun) {
    fs.writeFileSync(filePath, output.code, "utf-8");
  }

  return { changed: true, counts };
}

// JS reserved words that cannot be used as identifiers
const RESERVED_WORDS = new Set([
  "break","case","catch","continue","debugger","default","delete","do","else",
  "enum","export","extends","false","finally","for","function","if","import",
  "in","instanceof","new","null","return","super","switch","this","throw",
  "true","try","typeof","var","void","while","with","yield","await","class",
  "const","let","static","implements","interface","package","private",
  "protected","public","undefined","NaN","Infinity","arguments",
]);

/**
 * Recursively find all .js files in dir (including vendor/ subdirs).
 * Returns paths relative to dir.
 */
function findAllJsFiles(dir) {
  const results = [];
  function walk(currentDir, prefix) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  walk(dir, "");
  return results.sort();
}

/**
 * Extract the file number from a filename like "0149.js" or "0149_someFunc.js"
 * or "vendor/react/0001.js". Returns the number string (zero-padded preserved).
 */
function extractFileNumber(filePath) {
  const base = path.basename(filePath, ".js");
  const match = base.match(/^(\d+)/);
  return match ? match[1] : null;
}

/**
 * Resolve rename collisions using manifest data.
 *
 * Scans each file for file-level declarations (var, let, const, function, class)
 * and maps old→new names. When multiple files would declare the same name at
 * file level after renames, suffixes them with the file number.
 *
 * This is critical because when modules are reassembled into a single bundle,
 * all file-level declarations share the same scope. Duplicate `var` is fine,
 * but duplicate function/class/let/const causes SyntaxError.
 */
function resolveCollisions(renames, manifestPath, dir) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

  // Build var → file map from manifest
  const varToFile = new Map();
  for (const entry of manifest.sourceOrder) {
    if (entry.type === "module") {
      varToFile.set(entry.name, entry.file);
    }
  }

  // Scan each app file for file-level declarations
  // These are declarations at the top level of the file (line starts with keyword)
  const fileLevelDecls = new Map(); // oldName → [{file, kind}]
  const appFiles = fs.readdirSync(dir).filter(f => f.endsWith(".js")).sort();

  // Match declarations anywhere in file (not just line-start) because after wakaru
  // but before prettier, statements may still be on the same line.
  // Use word boundary + lookbehind for semicolon/brace/line-start to avoid matching
  // inside strings, but this is a best-effort heuristic.
  const varRe = /(?:^|[;{}])\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm;
  const funcRe = /(?:^|[;{}])\s*function\s+([A-Za-z_$][\w$]*)/gm;
  const classRe = /(?:^|[;{}])\s*class\s+([A-Za-z_$][\w$]*)/gm;

  for (const f of appFiles) {
    const code = fs.readFileSync(path.join(dir, f), "utf-8");
    let m;
    varRe.lastIndex = 0;
    funcRe.lastIndex = 0;
    classRe.lastIndex = 0;
    while ((m = varRe.exec(code)) !== null) {
      if (!fileLevelDecls.has(m[1])) fileLevelDecls.set(m[1], []);
      fileLevelDecls.get(m[1]).push({ file: f, kind: "var" });
    }
    while ((m = funcRe.exec(code)) !== null) {
      if (!fileLevelDecls.has(m[1])) fileLevelDecls.set(m[1], []);
      fileLevelDecls.get(m[1]).push({ file: f, kind: "function" });
    }
    while ((m = classRe.exec(code)) !== null) {
      if (!fileLevelDecls.has(m[1])) fileLevelDecls.set(m[1], []);
      fileLevelDecls.get(m[1]).push({ file: f, kind: "class" });
    }
  }

  // Build reverse map: for each oldName being renamed, which file(s) declare it
  const oldNameToFiles = new Map(); // oldName → [file]
  for (const [name, entries] of fileLevelDecls) {
    if (name in renames) {
      oldNameToFiles.set(name, entries.map(e => e.file));
    }
  }

  // Group all renames by target name, tracking which files they come from
  const targetGroups = new Map(); // targetName → [{oldName, files: [file]}]
  for (const [oldName, newName] of Object.entries(renames)) {
    const files = oldNameToFiles.get(oldName) || (varToFile.has(oldName) ? [varToFile.get(oldName)] : []);
    if (files.length === 0) continue; // not a file-level decl
    if (!targetGroups.has(newName)) targetGroups.set(newName, []);
    targetGroups.get(newName).push({ oldName, files });
  }

  // Also collect all file-level names that are NOT being renamed (for unrenamed collision check)
  const unrenamedNames = new Set();
  for (const [name] of fileLevelDecls) {
    if (!(name in renames)) {
      unrenamedNames.add(name);
    }
  }

  let collisionsSuffixed = 0;
  let collisionsSkipped = 0;

  for (const [targetName, members] of targetGroups) {
    // Check if target collides with an unrenamed file-level name
    if (unrenamedNames.has(targetName)) {
      for (const { oldName } of members) {
        delete renames[oldName];
        collisionsSkipped++;
      }
      continue;
    }

    // Count total unique files across all members
    const allFiles = new Set();
    for (const { files } of members) {
      for (const f of files) allFiles.add(f);
    }
    if (allFiles.size < 2) continue; // only one file — no cross-file collision

    // Multiple files → same target: suffix each with its file number
    for (const { oldName, files } of members) {
      const file = files[0] || varToFile.get(oldName);
      if (!file) continue;
      const num = extractFileNumber(file);
      if (num) {
        renames[oldName] = `${targetName}_${num}`;
        collisionsSuffixed++;
      }
    }
  }

  if (collisionsSuffixed > 0 || collisionsSkipped > 0) {
    console.log(`  Collision resolution: ${collisionsSuffixed} suffixed, ${collisionsSkipped} skipped`);
  }

  return renames;
}

function main() {
  const opts = parseArgs();
  const dir = path.resolve(opts.dir);

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  // Filter out renames to reserved words (would cause syntax errors)
  const skippedReserved = [];
  for (const [oldName, newName] of Object.entries(opts.renames)) {
    if (RESERVED_WORDS.has(newName)) {
      skippedReserved.push(`${oldName} → ${newName}`);
      delete opts.renames[oldName];
    }
  }
  if (skippedReserved.length > 0) {
    console.warn(`Skipped ${skippedReserved.length} rename(s) to reserved words: ${skippedReserved.join(", ")}`);
  }

  // Resolve collisions using manifest if available
  if (opts.manifest) {
    const manifestPath = path.resolve(opts.manifest);
    if (fs.existsSync(manifestPath)) {
      console.log(`Using manifest for collision resolution: ${manifestPath}`);
      resolveCollisions(opts.renames, manifestPath, dir);
    } else {
      console.warn(`Warning: manifest not found: ${manifestPath}`);
    }
  }

  // When manifest is provided, scan recursively (including vendor/ subdirs)
  // so renames propagate to any file referencing a top-level var
  const files = opts.manifest
    ? findAllJsFiles(dir)
    : fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();

  console.log(
    `${opts.dryRun ? "[DRY RUN] " : ""}Renaming ${Object.keys(opts.renames).length} identifier(s) across ${files.length} file(s) in ${dir}\n`
  );

  const totalCounts = {};
  for (const oldName of Object.keys(opts.renames)) {
    totalCounts[oldName] = 0;
  }

  let filesModified = 0;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const { changed, counts } = processFile(filePath, opts.renames, opts.dryRun);

    if (changed) {
      filesModified++;
      const summary = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([o, n]) => `${o}→${opts.renames[o]}(${n})`)
        .join(", ");
      console.log(`  ${file}: ${summary}`);

      for (const [o, n] of Object.entries(counts)) {
        totalCounts[o] += n;
      }
    }
  }

  console.log(`\n${opts.dryRun ? "[DRY RUN] " : ""}Summary:`);
  console.log(`  Files modified: ${filesModified}/${files.length}`);
  const activeRenames = Object.entries(opts.renames).filter(([o]) => totalCounts[o] > 0);
  const inactiveRenames = Object.entries(opts.renames).filter(([o]) => !totalCounts[o]);
  for (const [oldName, newName] of activeRenames) {
    console.log(`  ${oldName} → ${newName}: ${totalCounts[oldName]} rename(s)`);
  }
  if (inactiveRenames.length > 0) {
    console.log(`  (${inactiveRenames.length} rename(s) not found in any file)`);
  }
}

main();
