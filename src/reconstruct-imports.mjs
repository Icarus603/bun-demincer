#!/usr/bin/env node
/**
 * Reconstruct Import/Export Statements
 *
 * Converts Bun's lazy init pattern (markName/exportRegexes) into standard
 * ES import/export statements for IDE navigation (go-to-definition, find-refs).
 *
 * Usage:
 *   node reconstruct-imports.mjs <organized-dir> [options]
 *
 * Options:
 *   --dry-run       Preview changes without writing
 *   --stats         Print transformation statistics
 *   --module <id>   Process only one module (debugging)
 *   --no-imports    Skip import generation
 *   --no-exports    Skip export conversion
 *   --no-unwrap     Skip markName unwrapping
 */

import fs from "fs";
import path from "path";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    inputDir: null,
    dryRun: false,
    stats: false,
    moduleId: null,
    doImports: true,
    doExports: true,
    doUnwrap: true,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--dry-run":
        opts.dryRun = true;
        i++;
        break;
      case "--stats":
        opts.stats = true;
        i++;
        break;
      case "--module":
        opts.moduleId = args[++i];
        i++;
        break;
      case "--no-imports":
        opts.doImports = false;
        i++;
        break;
      case "--no-exports":
        opts.doExports = false;
        i++;
        break;
      case "--no-unwrap":
        opts.doUnwrap = false;
        i++;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: node reconstruct-imports.mjs <organized-dir> [options]

Converts Bun's markName/exportRegexes patterns into ES import/export statements.

Options:
  --dry-run       Preview changes without writing
  --stats         Print transformation statistics
  --module <id>   Process only one module (debugging)
  --no-imports    Skip import generation
  --no-exports    Skip export conversion
  --no-unwrap     Skip markName unwrapping`);
        process.exit(0);
      default:
        if (!args[i].startsWith("--")) {
          opts.inputDir = args[i];
          i++;
        } else {
          console.error(`Unknown option: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  if (!opts.inputDir) {
    console.error("Error: input directory is required");
    process.exit(1);
  }
  return opts;
}

/**
 * Build a map: moduleId -> init function name (the const/var name in markName/h call)
 * Also handles both `markName(` and `h(` patterns.
 */
function buildInitCallMap(modules, baseDir) {
  const map = new Map(); // moduleId -> initFnName
  for (const [id, info] of Object.entries(modules)) {
    if (info.type !== "esm") continue;
    const filePath = path.join(baseDir, info.file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const match = content.match(/^(?:const|var) ([\w$]+) = (?:markName|h)\(/m);
    if (match) {
      map.set(id, match[1]);
    }
  }
  return map;
}

/**
 * Find the closing brace that matches an opening brace at startIdx.
 * startIdx should point to the character AFTER the opening '{'.
 */
function findMatchingBrace(content, startIdx) {
  let depth = 1;
  let i = startIdx;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return depth === 0 ? i : -1;
}

/**
 * Generate import statements for a module's deps.
 */
function generateImports(moduleInfo, currentFile, modules, baseDir) {
  if (!moduleInfo.deps || moduleInfo.deps.length === 0) return [];
  const imports = [];
  const currentDir = path.dirname(path.join(baseDir, currentFile));

  for (const depId of moduleInfo.deps) {
    const depInfo = modules[depId];
    if (!depInfo) {
      imports.push(`// import '???'; // ${depId} (not found in manifest)`);
      continue;
    }
    const depAbsPath = path.join(baseDir, depInfo.file);
    let relPath = path.relative(currentDir, depAbsPath);
    // Ensure it starts with ./ or ../
    if (!relPath.startsWith(".")) relPath = "./" + relPath;
    // Use forward slashes
    relPath = relPath.replace(/\\/g, "/");
    imports.push(`import '${relPath}'; // ${depId}`);
  }
  return imports;
}

/**
 * Extract and unwrap the markName/h body.
 * Returns { initCode, depCallLines, fullMatchStart, fullMatchEnd } or null.
 */
function extractMarkNameBody(content, depCallNames) {
  // Match: const/var <name> = markName/h(() => {
  const re = /^(?:const|var) [\w$]+ = (?:markName|h)\(\(\) => \{/m;
  const match = re.exec(content);
  if (!match) return null;

  const bodyStart = match.index + match[0].length;
  const closingIdx = findMatchingBrace(content, bodyStart);
  if (closingIdx === -1) return null;

  // After closing }, expect ");", possibly with trailing whitespace/newline
  // Pattern: }); possibly followed by newline
  const afterBrace = content.substring(closingIdx);
  const endMatch = afterBrace.match(/^\);\s*\n?/);
  if (!endMatch) return null;

  const fullMatchEnd = closingIdx + endMatch[0].length;
  const body = content.substring(bodyStart, closingIdx - 1); // -1 to exclude the closing }

  // Partition body lines: dep init calls vs init code
  const lines = body.split("\n");
  const initCode = [];
  const depCallLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Check if this line is a dep init call: fnName(); or init_fnName();
    const callMatch = trimmed.match(/^([\w$]+)\(\);?$/);
    if (callMatch && depCallNames.has(callMatch[1])) {
      depCallLines.push(trimmed);
    } else {
      initCode.push(line);
    }
  }

  return {
    initCode,
    depCallLines,
    fullMatchStart: match.index,
    fullMatchEnd,
  };
}

/**
 * Extract exportRegexes pattern and generate export statement.
 * Pattern: const <obj> = {};\nexportRegexes(<obj>, { name: () => impl, ... });
 * Returns { exportStatement, removeRanges } or null.
 */
function extractExportRegexes(content) {
  // Find exportRegexes call
  const erRe = /^exportRegexes\(([\w$]+),\s*\{/m;
  const erMatch = erRe.exec(content);
  if (!erMatch) return null;

  const objName = erMatch[1];

  // Find the body of the exportRegexes call
  const bodyStart = erMatch.index + erMatch[0].length;
  const closingBrace = findMatchingBrace(content, bodyStart);
  if (closingBrace === -1) return null;

  // After }, expect ");", possibly with whitespace/newline
  const afterBrace = content.substring(closingBrace);
  const endMatch = afterBrace.match(/^\);\s*\n?/);
  if (!endMatch) return null;

  const erEnd = closingBrace + endMatch[0].length;
  const body = content.substring(bodyStart, closingBrace - 1);

  // Extract pairs: exportName: () => implName
  const pairs = [];
  const pairRe = /([\w$]+):\s*\(\)\s*=>\s*([\w$]+)/g;
  let pairMatch;
  while ((pairMatch = pairRe.exec(body)) !== null) {
    pairs.push({ exportName: pairMatch[1], implName: pairMatch[2] });
  }

  if (pairs.length === 0) return null;

  // Build export statement
  const specifiers = pairs.map(({ exportName, implName }) =>
    exportName === implName ? implName : `${implName} as ${exportName}`
  );
  const exportStatement = `export { ${specifiers.join(", ")} };`;

  // Find the const <obj> = {}; declaration before exportRegexes
  const objDeclRe = new RegExp(
    `^const ${escapeRegex(objName)} = \\{\\};\\s*\\n`,
    "m"
  );
  const objDeclMatch = objDeclRe.exec(content);

  const removeRanges = [];
  if (objDeclMatch) {
    removeRanges.push({
      start: objDeclMatch.index,
      end: objDeclMatch.index + objDeclMatch[0].length,
    });
  }
  removeRanges.push({ start: erMatch.index, end: erEnd });

  return { exportStatement, removeRanges, pairs };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Transform a single ESM module file.
 */
function transformModule(moduleId, moduleInfo, modules, baseDir, initCallMap, opts) {
  const filePath = path.join(baseDir, moduleInfo.file);
  if (!fs.existsSync(filePath)) return null;

  let content = fs.readFileSync(filePath, "utf8");
  const originalContent = content;

  // Build set of dep call names for this module
  // Deps can be called by: initFnName(), moduleId(), init_moduleId(), init_initFnName()
  const depCallNames = new Set();
  if (moduleInfo.deps) {
    for (const depId of moduleInfo.deps) {
      const initFn = initCallMap.get(depId);
      if (initFn) depCallNames.add(initFn);
      depCallNames.add(depId);
      // AI rename sometimes prefixes with init_
      depCallNames.add(`init_${depId}`);
      if (initFn) depCallNames.add(`init_${initFn}`);
    }
  }

  // --- Step A: Generate imports ---
  let importLines = [];
  if (opts.doImports && moduleInfo.deps && moduleInfo.deps.length > 0) {
    importLines = generateImports(moduleInfo, moduleInfo.file, modules, baseDir);
  }

  // --- Step B: Unwrap markName body ---
  let initCodeLines = [];
  let markNameResult = null;
  if (opts.doUnwrap) {
    markNameResult = extractMarkNameBody(content, depCallNames);
  }

  // --- Step C: Convert exports ---
  let exportResult = null;
  if (opts.doExports) {
    exportResult = extractExportRegexes(content);
  }

  // Now reconstruct the file
  // Strategy: build the new content from parts

  // Extract the header comment (first line starting with //)
  const lines = content.split("\n");
  let headerEnd = 0;
  while (headerEnd < lines.length && lines[headerEnd].startsWith("//")) {
    headerEnd++;
  }
  const headerLines = lines.slice(0, headerEnd);

  // If we have a markName result, remove it from content and get the rest
  let restContent = content;

  if (markNameResult) {
    // Remove the markName block
    restContent =
      content.substring(0, markNameResult.fullMatchStart) +
      content.substring(markNameResult.fullMatchEnd);
    initCodeLines = markNameResult.initCode;
  }

  // Remove header from restContent
  const restLines = restContent.split("\n");
  let restHeaderEnd = 0;
  while (restHeaderEnd < restLines.length && restLines[restHeaderEnd].startsWith("//")) {
    restHeaderEnd++;
  }
  // Skip blank lines after header
  while (restHeaderEnd < restLines.length && restLines[restHeaderEnd].trim() === "") {
    restHeaderEnd++;
  }
  let bodyContent = restLines.slice(restHeaderEnd).join("\n");

  // Remove exportRegexes from bodyContent
  let exportStatement = null;
  if (exportResult) {
    // Sort ranges in reverse order for safe removal
    const ranges = [...exportResult.removeRanges].sort((a, b) => b.start - a.start);

    // But we need to adjust indices since bodyContent is a substring
    // Re-extract from bodyContent
    const erResult = extractExportRegexes(bodyContent);
    if (erResult) {
      exportStatement = erResult.exportStatement;
      const ranges = [...erResult.removeRanges].sort((a, b) => b.start - a.start);
      for (const range of ranges) {
        bodyContent =
          bodyContent.substring(0, range.start) + bodyContent.substring(range.end);
      }
    }
  } else if (exportResult) {
    exportStatement = exportResult.exportStatement;
  }

  // Trim leading/trailing blank lines from bodyContent
  bodyContent = bodyContent.replace(/^\n+/, "").replace(/\n+$/, "");

  // Split bodyContent into main code and trailing var declarations
  const bodyLines = bodyContent.split("\n");
  let trailingVarStart = bodyLines.length;
  // Walk backwards to find trailing var declarations
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    if (bodyLines[i].match(/^var /)) {
      trailingVarStart = i;
    } else {
      break;
    }
  }
  const mainCodeLines = bodyLines.slice(0, trailingVarStart);
  const trailingVarLines = bodyLines.slice(trailingVarStart);

  // Assemble the new file
  const parts = [];

  // 1. Header comment
  if (headerLines.length > 0) {
    parts.push(headerLines.join("\n"));
  }

  // 2. Import statements
  if (importLines.length > 0) {
    parts.push(importLines.join("\n"));
  }

  // 3. Init code (from markName body, minus dep calls)
  if (initCodeLines.length > 0) {
    // Dedent init code by removing common leading whitespace
    const nonEmpty = initCodeLines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length > 0) {
      const minIndent = Math.min(
        ...nonEmpty.map((l) => l.match(/^(\s*)/)[1].length)
      );
      const dedented = initCodeLines.map((l) =>
        l.length > minIndent ? l.substring(minIndent) : l
      );
      parts.push(dedented.join("\n"));
    }
  }

  // 4. Main code
  if (mainCodeLines.length > 0) {
    const mainCode = mainCodeLines.join("\n").trim();
    if (mainCode) parts.push(mainCode);
  }

  // 5. Export statement
  if (exportStatement) {
    parts.push(exportStatement);
  }

  // 6. Trailing var declarations
  if (trailingVarLines.length > 0) {
    const vars = trailingVarLines.join("\n").trim();
    if (vars) parts.push(vars);
  }

  const newContent = parts.join("\n\n") + "\n";

  if (newContent === originalContent) return null;

  return {
    filePath,
    newContent,
    hadImports: importLines.length > 0,
    hadUnwrap: markNameResult !== null,
    hadExports: exportStatement !== null,
    numImports: importLines.length,
    numExports: exportResult ? exportResult.pairs.length : 0,
  };
}

function main() {
  const opts = parseArgs();
  const baseDir = opts.inputDir;

  if (!fs.existsSync(baseDir)) {
    console.error(`Error: directory not found: ${baseDir}`);
    process.exit(1);
  }

  // Load manifest
  const manifestPath = path.join(baseDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`Error: manifest.json not found in ${baseDir}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const modules = manifest.modules;

  console.error("Building init call map...");
  const initCallMap = buildInitCallMap(modules, baseDir);
  console.error(`  ${initCallMap.size} modules with markName/h init functions`);

  // Collect app ESM modules to process
  const toProcess = [];
  for (const [id, info] of Object.entries(modules)) {
    if (info.type !== "esm" || info.vendor) continue;
    if (info.file.startsWith("bundler-artifacts/")) continue;
    if (opts.moduleId && id !== opts.moduleId) continue;
    toProcess.push([id, info]);
  }
  console.error(`Processing ${toProcess.length} app ESM modules...`);

  // Stats
  let processed = 0,
    changed = 0,
    withImports = 0,
    withUnwrap = 0,
    withExports = 0;
  let totalImports = 0,
    totalExportPairs = 0;

  for (const [id, info] of toProcess) {
    const result = transformModule(id, info, modules, baseDir, initCallMap, opts);
    processed++;

    if (!result) continue;
    changed++;
    if (result.hadImports) {
      withImports++;
      totalImports += result.numImports;
    }
    if (result.hadUnwrap) withUnwrap++;
    if (result.hadExports) {
      withExports++;
      totalExportPairs += result.numExports;
    }

    if (opts.dryRun) {
      if (opts.moduleId) {
        // Show full diff for single module
        console.log(`=== ${id} (${info.file}) ===`);
        console.log(result.newContent);
      } else {
        console.log(`  ${id}: ${info.file} (imports: ${result.numImports}, exports: ${result.numExports}, unwrap: ${result.hadUnwrap})`);
      }
    } else {
      fs.writeFileSync(result.filePath, result.newContent, "utf8");
    }
  }

  // Print stats
  if (opts.stats || true) {
    console.error("\n--- Reconstruction Stats ---");
    console.error(`  Modules processed:    ${processed}`);
    console.error(`  Modules changed:      ${changed}`);
    console.error(`  With imports:         ${withImports} (${totalImports} total import lines)`);
    console.error(`  With markName unwrap: ${withUnwrap}`);
    console.error(`  With exports:         ${withExports} (${totalExportPairs} total export pairs)`);
    console.error(`  ${opts.dryRun ? "(dry run — no files written)" : `${changed} files written`}`);
    console.error("----------------------------");
  }
}

main();
