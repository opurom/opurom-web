# opurom-web

OPUROM R6 web DOM/Canvas hybrid: a zero-dependency Node project that compiles
IR JSON into a real standalone `index.html` — semantic DOM for structure and
accessibility, a `<canvas>` for deterministic gradient/effect painting — and a
`verify` command that checks the rendered page in a real headless browser
against an independent Node CPU reference.

- Zero npm dependencies: Node builtins only (`node:fs`, `node:path`,
  `node:child_process`, `node:url`, `node:test`).
- No runtime IR interpreter: all IR interpretation happens at emit time in
  Node. The page contains compiled constants (gradient spec, static semantic
  HTML, inline CSS/JS) and never parses IR JSON.
- One file in, one file out: `emit` writes exactly `index.html` into the
  out-dir.

## Usage

```sh
node bin/opurom-web.mjs emit <ir.json> <out-dir>
node bin/opurom-web.mjs verify <ir.json> <out-dir>
```

From the umbrella workspace root:

```sh
node opurom-web/bin/opurom-web.mjs emit opurom-spec/counter.opuir.json <out-dir>
node opurom-web/bin/opurom-web.mjs verify opurom-spec/counter.opuir.json <tmp-dir>
```

Exit codes: `0` = success or documented SKIP, `1` = validation/verification
failure, `2` = CLI usage error.

### emit

Validates IR v0.1 (plus the additive R2/R3 fields this project consumes),
applies the R3 accessibility contract, resolves `{state}` interpolation and
`when` guards against initial state, then writes a standalone `index.html`:

- **Semantic DOM** — `<header>` with the app `<h1>`, `<main>` containing the
  IR tree, `<button>` for buttons, `<h2>`/`<p>` for text, `<input>` for
  Slider/Input, `<div>` containers with flex styles from layout props.
- **ARIA roles from the a11y contract** — every IR node element carries its
  resolved R3 role (`button`, `text`, `image`, `checkbox`, `slider`,
  `heading`, `none`): explicit `props.role` wins (including `none`), else the
  R3 default table applies (`Text` becomes `heading` at effective size
  >= 24, i.e. `size * fontScale`). Bound controls expose `aria-checked` /
  `value` from initial state; non-text nodes get `aria-label` from the R3
  label chain; headings get `aria-level`.
- **Canvas** — a `<canvas width="480" height="270">` painted by an inline,
  dependency-free integer pixel routine: a two-stop vertical gradient from the
  theme accent to the mode surface, a fixed highlight band, a 2 px border and
  rounded corners from `theme.radius`. Deterministic, no floats in pixel
  math, no host font or clock involved.
- **Escaping** — all IR-derived text and attributes are HTML-escaped, so
  hostile IR content cannot inject markup or traverse out of the out-dir.

### verify

1. Emits the page (same code path as `emit`).
2. Computes the **independent Node CPU reference** digest
   (`lib/cpu-reference.mjs`, a separate implementation of the gradient
   recipe) over the same deterministic RGBA bytes — FNV-1a 64.
3. Detects a browser: `OPUROM_BROWSER` override, well-known macOS app paths
   (Edge/Chrome/Chromium), then a PATH scan for common binary names.
4. If no browser is found, prints
   `SKIP: headless browser unavailable (reason)` and exits **0**.
5. Otherwise launches headless Chromium with a **fresh profile under `/tmp`**
   and `--dump-dom`, under a hard 30 s timeout (the child is SIGKILLed on
   expiry and the profile is removed — the command can never hang and leaves
   no browser process behind).
6. The page's own JS paints the canvas, reads it back with `getImageData`,
   computes the FNV-1a 64 digest, collects DOM roles and computed styles, and
   writes them base64-encoded into `<meta id="opurom-verify">`.
7. `verify` parses those facts from the dump and asserts: browser digest
   **equals the Node CPU reference**, plus every ARIA role and computed style
   (header/main/canvas `display`, button display and background, heading font
   size) against IR-derived expectations.

Example (this repository, Microsoft Edge on the R6 host):

```text
emit: /tmp/.../index.html (5936 bytes)
cpu-digest: c02e6eee1be35749
browser: /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
canvas-digest: c02e6eee1be35749
PASS: verified canvas digest c02e6eee1be35749 equals independent Node CPU reference; 5 roles and 6 computed styles match
```

## Tests

```sh
node --test          # 48 tests
npm run check        # node --check on every .mjs
```

- With a browser: 48 pass, 0 skipped (browser verify runs for real).
- Without a browser (e.g. Linux CI): 47 pass, 1 skipped — the browser test
  skips with the reason; every other test still runs and must pass.
- `test/verify.test.mjs` also exercises the SKIP path deterministically on
  any host by setting `OPUROM_BROWSER` to a nonexistent path.

Test files (counts are `node --test <file>` totals):

| File | Tests | Covers |
| --- | --- | --- |
| `test/emit.test.mjs` | 9 | structure, escaping, determinism, no-IR markers, CLI emit |
| `test/aria.test.mjs` | 6 | R3 role table, labels, bound controls, `when` |
| `test/digest.test.mjs` | 6 | FNV vectors, page-vs-CPU byte equality, pinned golden |
| `test/verify.test.mjs` | 6 | fact parsing, mismatch detection, real browser, SKIP |
| `test/invalid-ir.test.mjs` | 21 | 16 IR rejection cases, out-dir/traversal, CLI usage |

## Honest scope

Verified in this repository, by tests in this repository:

- One browser engine on one host: headless Microsoft Edge (Chromium) on the
  macOS R6 host. `verify` checks that this engine's `getImageData` bytes and
  DOM facts match an independent Node CPU reference.
- Semantic DOM emission with the R3 a11y contract's roles, labels and
  initial-state binding, HTML-escaped end to end.
- Deterministic integer canvas gradient (accent -> surface, band, border,
  rounded corners) with a pinned FNV-1a 64 golden digest and a byte-equality
  test between the page painter and the Node reference.
- Graceful, documented `SKIP: headless browser unavailable (...)` with exit 0
  when no browser exists; bounded timeouts and profile cleanup.

Not implemented / not measured — later rounds:

- No cross-browser matrix (no Firefox/WebKit, no version matrix within
  Chromium). R7+.
- No real device, no mobile browser, no OS screen-reader integration: the
  ARIA output is markup-level only and is not validated against a real
  assistive technology. R7+.
- No automated visual regression against Flutter/React Native or any
  competitor, no screenshot diffing, no fps/performance claim. R7+.
- No animation, no event-to-patch runtime in the emitted page (buttons are
  semantic and accessible but inert: the page is a compiled snapshot of
  initial state), no image decoding, no network requests. R7+.
- `system` theme resolves to `light` without querying the host, matching
  `opurom-render`'s determinism rule.
- The independent CPU reference shares only the documented recipe (spec
  module) with the page painter; the implementations are separate code, but
  both were written by this project, not by a third-party oracle.

## Gaps / known limits

- `shortcut: canvas covers a fixed 480x270 panel, upgrade to layout-driven
  sizing when the IR carries viewport geometry`.
- `shortcut: page JS is a compiled snapshot with inert controls, upgrade to
  compiled event handlers when a patch runtime exists for the web target`.
- `shortcut: one Chromium-family engine on one host, upgrade to a
  cross-browser matrix when Firefox/WebKit runners are available`.
