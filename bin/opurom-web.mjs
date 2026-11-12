#!/usr/bin/env node
/* OPUROM web toolchain CLI.
 *
 *   opurom-web emit   <ir.json> <out-dir>   compile IR to standalone index.html
 *   opurom-web verify <ir.json> <out-dir>   emit, then check the page in a
 *                                           real headless Chromium and assert
 *                                           the canvas digest against an
 *                                           independent Node CPU reference
 *
 * Exit codes: 0 = success or documented SKIP, 1 = failure, 2 = usage error.
 * English-only messages; no dependencies beyond Node builtins. */

import process from 'node:process';

import { emitFromIr } from '../lib/emit.mjs';
import { loadIr } from '../lib/ir.mjs';
import { verify } from '../lib/verify.mjs';

const USAGE = [
  'usage: opurom-web emit <ir.json> <out-dir>',
  '       opurom-web verify <ir.json> <out-dir>',
].join('\n');

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function main() {
  const [command, irPath, outDir, ...extra] = process.argv.slice(2);
  if (command !== 'emit' && command !== 'verify') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  if (irPath === undefined || outDir === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  if (extra.length > 0) {
    fail(`unexpected argument: ${extra[0]}\n${USAGE}`, 2);
  }

  if (command === 'emit') {
    const ir = loadIr(irPath);
    const result = emitFromIr(ir, outDir);
    process.stdout.write(`emit: ${result.indexPath} (${result.bytes} bytes)\n`);
    return 0;
  }

  const result = await verify(irPath, outDir, { log: (line) => process.stdout.write(`${line}\n`) });
  return result.code;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
