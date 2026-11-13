# opurom-web

OPUROM web DOM/Canvas hybrid: a zero-dependency Node project that compiles
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

Validates IR v0.1 (plus the additive fields this project consumes),
applies the accessibility contract, resolves `{state}` interpolation and
`when` guards against initial state, then writes a standalone `index.html`:

- **Semantic DOM** — `<header>` with the app `<h1>`, `<main>` containing the
  IR tree, `<button>` for buttons, `<h2>`/`<p>` for text, `<input>` for
  Slider/Input, `<div>` containers with flex styles from layout props.
- **ARIA roles from the a11y contract** — every IR node element carries its
  resolved role (`button`, `text`, `image`, `checkbox`, `slider`,
  `heading`, `none`): explicit `props.role` wins (including `none`), else the
  contract's default table applies (`Text` becomes `heading` at effective size
  >= 24, i.e. `size * fontScale`). Bound controls expose `aria-checked` /
  `value` from initial state; non-text nodes get `aria-label` from the
  contract's label chain; headings get `aria-level`.
- **Canvas** — a `<canvas width="480" height="270">` painted by an inline,
  dependency-free integer pixel routine: a two-stop vertical gradient from the
  theme accent to the mode surface, a fixed highlight band, a 2 px border and
  rounded corners from `theme.radius`. Deterministic, no floats in pixel
  math, no host font or clock involved.
- **Theme token colors** — `theme.tokens.surface` and
  `theme.tokens.onSurface` replace the mode's surface and ink in the compiled
  gradient spec and in the page's `--surface` / `--ink` custom properties.
  Each field falls back to the mode palette when absent, so IR without tokens
  keeps the same canvas digest.
- **Escaping** — all IR-derived text and attributes are HTML-escaped, so
  hostile IR content cannot inject markup or traverse out of the out-dir.
- **State announcements** — a visually hidden `aria-live="polite"` region
  plus `window.opuromAnnounceState(name, value)`. The first change from the
  IR's initial value writes `<name>: <value>` as text exactly once; repeated
  identical values write nothing. Embedded IR values escape `<`, and
  announcements use `textContent`, never markup.

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
   computes the FNV-1a 64 digest, collects every node's role with its ARIA
   attributes (`aria-label`, `aria-level`, `aria-checked`, bound `value`),
   document facts (`lang`, `title`, `<h1>` text, canvas label) and computed
   styles, and writes them UTF-8-safe base64-encoded into
   `<meta id="opurom-verify">`.
7. `verify` parses those facts from the dump and asserts: browser digest
   **equals the Node CPU reference**, plus every ARIA attribute, document
   fact and computed style (header/main/canvas `display`, button display and
   background, heading font size, body background, canvas border radius)
   against IR-derived expectations.
8. Renders the same emitted page a **second time in a fresh browser session**
   and asserts the rerun facts against the same expectations, printing
   `rerun-canvas-digest: <digest>`. Because both runs are pinned to the CPU
   reference, equal rerun digests prove the render is deterministic; a
   diverging rerun is a FAIL. A rerun that cannot launch or times out keeps
   the documented SKIP wording and exits **0**.

The same run prints a `contrast:` line for the theme's declared
onSurface/surface pair (theme tokens, else the mode palette): the WCAG 2.x
contrast ratio computed in pure integer fixed point, compared against the
WCAG AA normal-text minimum of 4.5:1. The line reports the resolved colors,
the ratio, the threshold and whether the pair meets it; a pair below the
threshold is a reported fact, not a verification failure.

Example (this repository, Microsoft Edge on the macOS host, about 1.2 s wall
clock for the two Chromium sessions):

```text
emit: /tmp/.../index.html (6742 bytes)
cpu-digest: 2013651856b88d65
contrast: surface rgb(255, 255, 255) onSurface rgb(17, 24, 39) ratio 17.74:1, WCAG AA normal-text minimum 4.5:1 pass
browser: /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge
canvas-digest: 2013651856b88d65
rerun-canvas-digest: 2013651856b88d65
PASS: verified canvas digest 2013651856b88d65 equals independent Node CPU reference; 5 roles and 8 computed styles match
```

### verify --matrix

`verify --matrix` emits the page once, then runs both engines in parallel:

- **Chromium** — headless Microsoft Edge uses `--dump-dom` on the emitted file,
  exactly as single-engine `verify` does.
- **WebKit** — a compiled Swift helper opens a real `WKWebView`, loads the
  same generated `index.html` contents with `loadHTMLString`, then evaluates
  JavaScript that calls `getImageData`, hashes those pixels and reads DOM
  roles with their ARIA attributes, document facts and computed styles from
  the live page. This is WebKit/Safari's engine, not the Safari application
  or a browser simulator.

Both engine digests and equality flags are reported individually, and every
engine is pinned to the CPU reference before it may count as passed. When
both engines measure, the report also asserts **cross-engine agreement**:
the two digests must equal each other, and a disagreement adds
`cross-engine digest mismatch: chromium=... webkit=...; diverged from Node
reference: <engine>` naming the diverging engine. A single measured mismatch
or DOM-fact failure produces `FAIL` and exit **1**; there is no averaging and
no partial mismatch pass. On non-macOS hosts, or when an
engine binary/`xcrun`/`WebKit.framework` is missing, the report prints
`SKIP <engine>: <concrete reason>` and `digest=unmeasured`; the other engine's
real result is retained. If no engine is available, the matrix exits **0**
with a documented SKIP. Each Swift helper and WebKit process group has one
bounded <=30 s budget, is SIGKILLed at its deadline, and has its temporary
compiled-helper/profile directory removed.

Example measured on this macOS arm64 host (0.72 s wall clock):

```text
emit: /tmp/.../index.html (6742 bytes)
cpu-digest: 2013651856b88d65
chromium: digest=2013651856b88d65 equals-cpu-reference=true roles=5 styles=8
webkit: digest=2013651856b88d65 equals-cpu-reference=true roles=5 styles=8
cross-engine: chromium digest 2013651856b88d65 equals webkit digest 2013651856b88d65
PASS: Chromium and WebKit measured digests both equal independent Node CPU reference 2013651856b88d65
```

## Tests

```sh
node --test          # 71 tests
npm run check        # node --check on every .mjs
```

- On the macOS host with both engines: 71 pass, 0 skipped; the real two-engine
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
| `test/aria.test.mjs` | 7 | role table, labels, bound controls, `when`, expectedAria contract |
| `test/digest.test.mjs` | 6 | FNV vectors, page-vs-CPU byte equality, pinned golden |
| `test/verify.test.mjs` | 7 | fact parsing, mismatch detection, real browser, SKIP, rerun determinism, ARIA readback |
| `test/matrix.test.mjs` | 8 | report shape, real two-engine equality, cross-engine divergence, single mismatch FAIL, SKIP, timeout/cleanup |
| `test/invalid-ir.test.mjs` | 21 | 16 IR rejection cases, out-dir/traversal, CLI usage |
| `test/sub-op.test.mjs` | 2 | `sub` action validation |
| `test/live-region.test.mjs` | 3 | one announcement per change, repeat suppression, markup-safe text |
| `test/tokens.test.mjs` | 4 | token colors in the gradient spec, painter parity, emitted CSS, browser readback |
| `test/contrast.test.mjs` | 4 | WCAG contrast ratios: exact vectors, fixed-point/float parity, verify output line |

## What is verified here

Verified in this repository, by tests in this repository:

- Two real desktop engines on one macOS arm64 host: headless Microsoft Edge
  (Chromium) and real `WKWebView` (WebKit, Safari's engine). `verify --matrix`
  loads the same emitted `index.html` in both, measures each `getImageData`
  digest and DOM roles/ARIA/styles, compares each digest with the
  independent Node CPU reference, and asserts the two engine digests equal
  each other with the diverging engine named on disagreement. The
  single-engine `verify` remains Chromium.
- Render determinism: single-engine `verify` renders the same emitted page in
  two fresh browser sessions and requires identical facts, reported as
  `canvas-digest` plus `rerun-canvas-digest` before any PASS.
- The accessibility contract as read back from the live page, not just from
  emitted HTML: per-node `aria-label`, `aria-level`, `aria-checked` and bound
  slider `value`, plus document `lang`/`title`/`<h1>` text and the canvas
  label — including non-ASCII IR text round-tripped through the UTF-8 facts
  blob — and computed body background and canvas border radius alongside the
  existing display/font-size styles.
- Semantic DOM emission with the accessibility contract's roles, labels and
  initial-state binding, HTML-escaped end to end.
- Deterministic integer canvas gradient (accent -> surface, band, border,
  rounded corners) with a pinned FNV-1a 64 golden digest and a byte-equality
  test between the page painter and the Node reference.
- Theme token colors lower into one gradient spec consumed by the page painter
  and the independent Node CPU reference; tests assert byte-identical RGBA,
  emitted CSS colors, the computed body background expectation and the
  single-engine browser digest.
- WCAG 2.x contrast of the theme's declared onSurface/surface pair (tokens,
  else the mode palette), computed in pure integer fixed point and asserted
  against an independent floating-point implementation of the same formula
  across the full 8-bit gray range, with the ratio and the 4.5:1 WCAG AA
  normal-text minimum reported on every verify run.
- Graceful per-engine `SKIP <engine>: <concrete reason>` with `digest=unmeasured`
  when a binary, macOS or WebKit.framework is unavailable; no engine SKIP is
  reported as a PASS. A single measured mismatch is FAIL with exit 1. Every
  helper has a bounded <=30 s timeout, is SIGKILLed as a process group, and
  has its temporary profile removed.

## Design decisions

- `system` theme resolves to `light` without querying the host, matching
  `opurom-render`'s determinism rule.
- Theme token colors override the mode palette per field; absent fields keep
  the mode defaults, so the counter fixture keeps its golden digest.
- The independent CPU reference shares only the documented recipe (spec
  module) with the page painter; the implementations are separate code, but
  both were written by this project, not by a third-party oracle.
- The canvas paints a fixed 480x270 panel; the IR does not carry viewport
  geometry, so the panel size is a constant of this backend.
- The page script is a compiled snapshot: the DOM is rendered from IR and the
  controls are presentational. IR event actions are not executed at runtime;
  callers push state changes through `window.opuromAnnounceState(name, value)`.
- The browser matrix runs the desktop engines available on the host; each
  engine reports its own digest, the CPU reference decides each verdict, and
  two measured engines must also agree with each other.
- The WKWebView helper is compiled on each matrix run, so the helper always
  matches the macOS SDK and toolchain present on that host.
