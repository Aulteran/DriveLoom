# Web client design system: Loom HUD

The `apps/web` client uses one visual system, "Loom HUD": a calm instrument-panel look with glass surfaces, a cyan to violet signal gradient and monospaced readouts. It lives entirely in [`apps/web/styles.css`](../apps/web/styles.css) and [`apps/web/js/icons.js`](../apps/web/js/icons.js). There is no build step, no framework and no third-party request.

Before and after screenshots of the revamp (2026-11-12) are in [`docs/design/`](design/).

## Principles

- **Data first.** Numbers are the product, so readouts (statistics, table figures, axis labels) use a monospaced face with tabular figures, and the headline economy value is the brightest thing on the page.
- **Quiet ambience, loud signal.** The backdrop (two slow aurora glows over a fading grid) and glass panels stay low contrast. The gradient is reserved for primary actions, active navigation, panel heading markers and the chart.
- **Private by construction.** Fonts are self-hosted under `apps/web/fonts/` (SIL OFL 1.1, licence files alongside). The CSP (`default-src 'self'`, no inline style attributes) is unchanged.
- **Accessible by default.** WCAG 2.2 AA contrast in both themes, visible focus rings, 44 px minimum targets, and every motion stops under `prefers-reduced-motion`.

## Tokens

All colours are CSS custom properties on `:root`, redefined under `prefers-color-scheme: dark`. The theme follows the operating system.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#edf1f8` | `#05070e` | Page background |
| `--surface` | white 80 % | `#0d1321` 74 % | Glass panels, cards (with backdrop blur) |
| `--surface-solid` | `#ffffff` | `#0d1321` | Dialogs, active tab, menus |
| `--text` / `--muted` | `#0b1220` / `#4a566e` | `#e7eef8` / `#93a3bf` | Body and secondary text |
| `--accent` / `--accent-2` | `#0e7490` / `#6d28d9` | `#22d3ee` / `#a78bfa` | Signal gradient (`--grad`) |
| `--accent-ink` | `#0b6178` | `#67e8f9` | Links, highlighted values, accent badges |
| `--accent-text` | `#ffffff` | `#03111a` | Text on the gradient |
| `--good` / `--bad` / `--warn` | `#047857` / `#be123c` / `#92400e` | `#34d399` / `#fb7185` / `#fbbf24` | Status |

Radii are 16 px (panels, cards), 10 px (controls) and 8 px (small chips). Text on the gradient meets 4.5:1 against both of its end colours.

## Typography

| Role | Face | Notes |
| --- | --- | --- |
| Display: headings, brand, navigation, buttons | Space Grotesk (variable, latin + latin-ext, about 41 KB) | Tight tracking on `h1` |
| Body | System UI stack | Fast and native for long text |
| Readouts: numbers, table headers, stat labels, badges | JetBrains Mono (variable, latin + latin-ext, about 56 KB) | Uppercase micro-labels with wide tracking |

Only the latin Space Grotesk file is preloaded. Latin-ext files load only when a page uses those characters.

## Components

- **Top bar:** glass, sticky, with a gradient hairline. The active section is a glowing pill with a gradient tick. Below 640 px the main navigation becomes a fixed bottom dock with icon and label (the top bar drops its backdrop filter there, because a filter would trap the fixed dock).
- **Panels:** glass with a gradient hairline on the top edge; every `h2` inside gets a gradient marker bar. `.danger-zone` swaps the gradient for `--bad`.
- **Tabs:** a segmented control; the active segment is a raised solid chip with an accent icon.
- **Buttons:** primary is the gradient with a sheen sweep on hover; `secondary` is glass with an accent ring on hover; `ghost` and `danger` stay outlined or bare.
- **Cards:** vehicle cards lift and glow on hover; with no photo, a car icon floats over a gridded aurora.
- **Statistics:** tiles with a mono label above the value; the first tile (average economy) spans two columns and glows.
- **Chart:** gradient stroke drawn in on load, soft gradient area beneath, hollow points with the latest point filled.
- **Feedback:** notices and errors carry a glowing left edge; toasts slide up from the bottom (above the dock on phones); dialogs scale in over a blurred backdrop; loading shows a scanning bar.
- **Icons:** 24 px stroke icons drawn for DriveLoom in `icons.js`, always `aria-hidden` next to a visible label.

## Motion

Views rise 10 px on mount (transform only, so text is never mid-fade when read), cards lift, the chart draws, bars grow and the backdrop drifts over 40 s. Colours never transition, so a theme switch is instant. `prefers-reduced-motion: reduce` removes every animation and transition.

## Checking changes

From `apps/api` with `DATABASE_URL` set, `npm run test:browser` exercises every screen and runs axe WCAG 2.2 AA checks in light and dark, plus a phone-width overflow check. Look at changes at 1280 px and 390 px wide in both colour schemes.

## Follow-ups

- The marketing site in `apps/marketing` uses the same tokens and fonts (restyled 2026-11-12); its interactive tour reuses the panel, tab, statistics, table and chart components.
- A manual light/dark override (instead of following the OS) would need a small preference and is not built.
