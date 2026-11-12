# opurom-web

OPUROM R8 web DOM/Canvas hybrid: a zero-dependency Node project that compiles
IR JSON into a real standalone `index.html` — semantic DOM for structure and
accessibility, a `<canvas>` for deterministic gradient/effect painting — and
verifies the rendered page against an independent Node CPU reference. The
single-engine `verify` uses headless Chromium; `verify --matrix` measures the
same page in Chromium and real WebKit on one macOS host.

- Zero npm dependencies: Node builtins only (`node:fs`, `node:path`,
  `node:child_process`, `node:url`, `node:test`).
- The WebKit driver is a short Swift source compiled with the macOS SDK through
  `xcrun`; it uses real `WKWebView`, not a simulated browser.
- No runtime IR interpreter: all IR interpretation happens at emit time in
  Node. The page contains compiled constants (gradient spec, static semantic
  HTML, inline CSS/JS) and never parses IR JSON.
- One file in, one file out: `emit` writes exactly `index.html` into the
  out-dir.

## Usage

```sh
node bin/opurom-web.mjs emit <ir.json> <out-dir>
node bin/opurom-web.mjs verify <ir.json> <out-dir>
node bin/opurom-web.mjs verify --matrix <ir.json> <out-dir>
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

Example (this repository, Microsoft Edge on the macOS R8 host):

```text
emit: /tmp/.../index.html (5936 bytes)
cpu-digest: c02e6eee1be35749
browser: /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
canvas-digest: c02e6eee1be35749
PASS: verified canvas digest c02e6eee1be35749 equals independent Node CPU reference; 5 roles and 6 computed styles match
```

The single-engine `verify` command and its output are unchanged in R8.

### verify --matrix

`verify --matrix` emits the page once, then runs both engines in parallel:

- **Chromium** — headless Microsoft Edge uses `--dump-dom` on the emitted file,
  exactly as single-engine `verify` does.
- **WebKit** — a compiled Swift helper opens a real `WKWebView`, loads the
  same generated `index.html` contents with `loadHTMLString`, then evaluates
  JavaScript that calls `getImageData`, hashes those pixels and reads DOM roles
  and computed styles from the live page. This is WebKit/Safari's engine, not
  the Safari application or a browser simulator.

Both engine digests and equality flags are reported individually. A single
measured mismatch or DOM-fact failure produces `FAIL` and exit **1**; there is
no averaging and no partial mismatch pass. On non-macOS hosts, or when an
engine binary/`xcrun`/`WebKit.framework` is missing, the report prints
`SKIP <engine>: <concrete reason>` and `digest=unmeasured`; the other engine's
real result is retained. If no engine is available, the matrix exits **0**
with a documented SKIP. Each Swift helper and WebKit process group has one
bounded <=30 s budget, is SIGKILLed at its deadline, and has its temporary
compiled-helper/profile directory removed.

Example measured on this macOS arm64 host:

```text
emit: /tmp/.../index.html (5936 bytes)
cpu-digest: c02e6eee1be35749
chromium: digest=c02e6eee1be35749 equals-cpu-reference=true roles=5 styles=6
webkit: digest=c02e6eee1be35749 equals-cpu-reference=true roles=5 styles=6
PASS: Chromium and WebKit measured digests both equal independent Node CPU reference c02e6eee1be35749
```

## Tests

```sh
node --test          # 55 tests
npm run check        # node --check on every .mjs
```

- On the macOS host with both engines: 55 pass, 0 skipped; the real two-engine
  CLI test measures both engines.
- On a host missing an engine, the affected real-browser tests skip with a
  concrete reason; every other test still runs and must pass.
- `test/verify.test.mjs` also exercises the single-engine SKIP path
  deterministically on any host by setting `OPUROM_BROWSER` to a nonexistent
  path; `test/matrix.test.mjs` does the same for engine SKIPs with injected
  runners.

Test files (counts are `node --test <file>` totals):

| File | Tests | Covers |
| --- | --- | --- |
| `test/emit.test.mjs` | 9 | structure, escaping, determinism, no-IR markers, CLI emit |
| `test/aria.test.mjs` | 6 | R3 role table, labels, bound controls, `when` |
| `test/digest.test.mjs` | 6 | FNV vectors, page-vs-CPU byte equality, pinned golden |
| `test/verify.test.mjs` | 6 | fact parsing, mismatch detection, real browser, SKIP |
| `test/matrix.test.mjs` | 7 | report shape, real two-engine equality, single mismatch FAIL, SKIP, timeout/cleanup |
| `test/invalid-ir.test.mjs` | 21 | 16 IR rejection cases, out-dir/traversal, CLI usage |

## Honest scope

Verified in this repository, by tests in this repository:

- Two real desktop engines on one macOS arm64 host: headless Microsoft Edge
  (Chromium) and real `WKWebView` (WebKit, Safari's engine). `verify --matrix`
  loads the same emitted `index.html` in both, measures each `getImageData`
  digest and DOM roles/computed styles, and compares each digest with the
  independent Node CPU reference. The single-engine `verify` remains Chromium.
- Semantic DOM emission with the R3 a11y contract's roles, labels and
  initial-state binding, HTML-escaped end to end.
- Deterministic integer canvas gradient (accent -> surface, band, border,
  rounded corners) with a pinned FNV-1a 64 golden digest and a byte-equality
  test between the page painter and the Node reference.
- Graceful per-engine `SKIP <engine>: <concrete reason>` with `digest=unmeasured`
  when a binary, macOS or WebKit.framework is unavailable; no engine SKIP is
  reported as a PASS. A single measured mismatch is FAIL with exit 1. Every
  helper has a bounded <=30 s timeout, is SIGKILLed as a process group, and
  has its temporary profile removed.

Not implemented / not measured — R9+:

- No Firefox, no mobile browsers, no device matrix, no OS screen-reader
  integration: the ARIA output is markup-level only and is not validated
  against a real assistive technology. R9+.
- No Chromium/WebKit version matrix, no Safari application automation and no
  second OS host. R9+.
- No automated visual regression against Flutter/React Native or any
  competitor, no screenshot diffing, no fps/performance claim. R9+.
- No animation, no event-to-patch runtime in the emitted page (buttons are
  semantic and accessible but inert: the page is a compiled snapshot of
  initial state), no image decoding, no network requests. R9+.
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
- `shortcut: two desktop engines on one macOS host, upgrade to a
  Firefox/mobile/device matrix, OS accessibility integration and a version
  matrix when runners are available`.
- `shortcut: the WKWebView Swift helper is compiled on each matrix run, cache
  it only when the macOS SDK and toolchain versions are pinned`.
