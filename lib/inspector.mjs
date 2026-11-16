/* Inspector bundle assembly: copy the static sources into out-dir and fail if
 * any shipped file references a Node builtin — the page is pure browser JS
 * with zero dependencies. The CLI only hosts the assembled directory. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'inspector');
const SOURCES = ['index.html', 'app.js', 'views.js', 'style.css'];

/* A `require(...)` call or a `node:` module specifier anywhere in a shipped
 * file means the bundle drifted off the pure-browser constraint. */
const NODE_REFERENCE = /\brequire\s*\(|from\s*['"]node:|import\s*['"]node:/;

export function findNodeReference(text) {
  const match = NODE_REFERENCE.exec(text);
  return match === null ? null : match[0];
}

function resolveOutDir(outDir) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new Error('out-dir must be a non-empty path');
  }
  let stat = null;
  try {
    stat = fs.statSync(outDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat !== null && !stat.isDirectory()) {
    throw new Error(`out-dir exists and is not a directory: ${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  return path.resolve(outDir);
}

export function assembleInspector(outDir) {
  const resolved = resolveOutDir(outDir);
  for (const name of SOURCES) {
    const text = fs.readFileSync(path.join(SOURCE_DIR, name), 'utf8');
    const reference = findNodeReference(text);
    if (reference !== null) {
      throw new Error(
        `inspector source ${name} references a Node builtin (${reference}); the bundle must be pure browser JS`,
      );
    }
    fs.writeFileSync(path.join(resolved, name), text, 'utf8');
  }
  return { outDir: resolved, files: SOURCES };
}
