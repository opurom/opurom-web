#!/usr/bin/env node
/* OPUROM web toolchain CLI.
 *
 *   opurom-web emit   <ir.json> <out-dir>   compile IR to standalone index.html
 *   opurom-web verify <ir.json> <out-dir>   emit, then check the page in a
 *                                           real headless Chromium and assert
 *                                           the canvas digest against an
 *                                           independent Node CPU reference
 *   opurom-web verify --matrix              emit once, then measure the same
 *                     <ir.json> <out-dir>  page in Chromium and real WebKit
 *
 * Exit codes: 0 = success or documented SKIP, 1 = failure, 2 = usage error.
 * English-only messages; no dependencies beyond Node builtins. */

import process from 'node:process';

import { emitFromIr } from '../lib/emit.mjs';
import { loadIr } from '../lib/ir.mjs';
import { verifyMatrix } from '../lib/matrix.mjs';
import { verify } from '../lib/verify.mjs';

const USAGE = [
  'usage: opurom-web emit <ir.json> <out-dir>',
  '       opurom-web verify <ir.json> <out-dir>',
  '       opurom-web verify --matrix <ir.json> <out-dir>',
].join('\n');

function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== 'emit' && command !== 'verify') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const matrix = command === 'verify' && argv[1] === '--matrix';
  const [irPath, outDir, ...extra] = matrix ? argv.slice(2) : argv.slice(1);
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

  const log = (line) => process.stdout.write(`${line}\n`);
  const result = matrix
    ? await verifyMatrix(irPath, outDir, { log })
    : await verify(irPath, outDir, { log });
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
