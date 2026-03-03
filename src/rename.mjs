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
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

// Handle ESM default export quirk
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    batch: null,
    dir: ".",
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

  // Parse
  let ast;
  try {
    ast = parse(code, {
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: true,
      plugins: ["jsx"],
    });
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

  for (const [oldName, newName] of renameEntries) {
    if (existingIds.has(newName) && existingIds.has(oldName)) {
      console.warn(
        `  Warning: "${newName}" already exists in ${path.basename(filePath)} (collision with rename ${oldName} → ${newName})`
      );
    }
  }

  // Build lookup set for fast checking
  const oldNameSet = new Set(renameEntries.map(([o]) => o));
  const renameMap = new Map(renameEntries);
  const counts = {};
  for (const [o] of renameEntries) counts[o] = 0;

  // Traverse and rename
  let modified = false;

  // Re-parse for the rename pass (traverse mutates in place)
  const ast2 = parse(code, {
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    errorRecovery: true,
    plugins: ["jsx"],
  });

  try {
    traverse(ast2, {
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

  // Generate
  const output = generate(ast2, {
    retainLines: false,
    compact: true,
    comments: true,
    jsescOption: { minimal: true },
  });

  if (!dryRun) {
    fs.writeFileSync(filePath, output.code, "utf-8");
  }

  return { changed: true, counts };
}

function main() {
  const opts = parseArgs();
  const dir = path.resolve(opts.dir);

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort();

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
  for (const [oldName, newName] of Object.entries(opts.renames)) {
    const n = totalCounts[oldName];
    if (n > 0) {
      console.log(`  ${oldName} → ${newName}: ${n} rename(s)`);
    } else {
      console.log(`  ${oldName} → ${newName}: not found`);
    }
  }
}

main();
