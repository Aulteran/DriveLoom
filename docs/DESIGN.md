# Web client design system: Loom HUD

The `apps/web` client uses one visual system, "Loom HUD": a dense, console-style dashboard on frosted glass surfaces, with an indigo accent and a cyan secondary for data. It lives entirely in [`apps/web/styles.css`](../apps/web/styles.css) and [`apps/web/js/icons.js`](../apps/web/js/icons.js). There is no build step, no framework and no third-party request.

Before and after screenshots of the revamp (2026-11-12) are in [`docs/design/`](design/).

## Principles

- **Dashboard first.** Signing in opens a dashboard for the selected vehicle: a strip of headline figures, the economy trend, monthly reports and recent fill-ups. The layout is dense and orderly, in the manner of an operations console: a fixed sidebar, flat sections with plain titles, thin dividers and tabular figures.
- **Frosted glass over quiet colour.** Panels, the metric strip, the sidebar and tooltips are translucent with a strong backdrop blur over soft, static colour fields (indigo, cyan and a touch of pink). There are no glows, sheens or gradient hairlines; the gradient is kept for the chart line.
- **Private by construction.** Fonts are self-hosted under `apps/web/fonts/` (SIL OFL 1.1, licence files alongside). The CSP (`default-src 'self'`, no inline scripts or style attributes) is unchanged.
- **Accessible by default.** WCAG 2.2 AA contrast in both themes and both forced themes, visible focus rings, 40 px controls, a data table behind every chart, and every motion stops under `prefers-reduced-motion`.

## Tokens

All colours are CSS custom properties on `:root`. Dark values apply under `prefers-color-scheme: dark` unless `<html data-theme="light">` is set, and always under `data-theme="dark"`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#eef0f6` | `#08090f` | Page background, under the colour fields |
| `--surface` | white 54 % | `#161924` 50 % | Frosted panels, metric strip, sidebar (with `--glass-blur`) |
| `--surface-solid` | `#ffffff` | `#141722` | Dialogs, drawer, active segments |
| `--text` / `--muted` | `#0f172a` / `#4b5568` | `#e8eaf2` / `#9aa1b5` | Body and secondary text |
| `--accent` | `#4f46e5` | `#818cf8` | Primary buttons, active navigation, focus |
| `--accent-ink` | `#4338ca` | `#a5b4fc` | Links, highlighted values |
| `--data` / `--data-2` | `#4f46e5` / `#0891b2` | `#818cf8` / `#22d3ee` | Chart marks; hover and line gradient end |
| `--good` / `--bad` / `--warn` | `#047857` / `#be123c` / `#92400e` | `#34d399` / `#fb7185` / `#fbbf24` | Status |

Radii are 12 px (panels, cards), 8 px (controls) and 6 px (small chips).

## Typography

| Role | Face | Notes |
| --- | --- | --- |
| Page titles (`h1`), brand | Space Grotesk (variable, latin + latin-ext) | Tight tracking |
| Everything else, including figures | System UI stack | Tabular figures for numbers |
| Code, secrets | JetBrains Mono (variable, latin + latin-ext) | |

## Components

- **App shell:** a sticky frosted sidebar (272 px) holds the brand, the **vehicle switcher** (a labelled native `<select>`), the vehicle sections (Dashboard, Fuel log, Members, Import & export, Vehicle settings), the account pages (Garage, Friends, Settings, Administration), the theme toggle and the signed-in user with sign out. At 900 px and below it becomes a modal drawer opened from a top bar; the page behind is inert, and Escape, the scrim and navigation close it.
- **Routing:** `#/` opens the vehicle last viewed (stored per account in `localStorage`, falling back to the first active vehicle), or the welcome screen when there is none. `#/vehicles/:id` is the dashboard; `#/vehicles/:id/stats` still works and opens it. The vehicle list with add, import and archived vehicles is `#/garage`.
- **Dashboard:** a page heading with a period selector and "Add fill-up"; a metric strip (average economy, spent, distance, fuel, cost per distance, fill-ups) compared with the previous equal period when it has data, where the economy direction is stated in words and an arrow as well as colour; the economy line chart; an "At a glance" list; bar charts of spending, distance and fuel for the last 12 calendar months (one `/stats?from&to` call per month, so every printed figure is the server's decimal string); and recent fill-ups.
- **Charts:** dependency-free SVG with per-chart gradient ids, hover tooltips on enlarged hit targets, a `role="img"` description, and a collapsed "Show data" table with the exact values.
- **Theme toggle:** System / Light / Dark segmented control in the sidebar and on the sign-in screens. The choice is a per-device convenience in `localStorage`, applied before first paint by the external `js/theme-boot.js`, and it updates the `theme-color` metas.
- **Panels, metric strip, tabs, cards, badges, tables, notices, toasts, dialogs:** flat frosted surfaces with a 1 px edge and a soft shadow; sentence-case labels.
- **Icons:** 24 px stroke icons drawn for DriveLoom in `icons.js`, always `aria-hidden` next to a visible label.

## Motion

Views rise 10 px on mount, chart lines draw in, bars grow, cards lift 2 px and the backdrop drifts slowly. Colours never transition, so a theme switch is instant. `prefers-reduced-motion: reduce` removes every animation and transition.

## Checking changes

From `apps/api` with `DATABASE_URL` set, `npm run test:browser` exercises every screen and runs axe WCAG 2.2 AA checks in light and dark, with each theme forced against the opposite system setting, plus phone-width overflow and drawer checks. Look at changes at 1280 px and 390 px wide in both colour schemes.

## Follow-ups

- The marketing site in `apps/marketing` was restyled on 2026-11-12 with the previous tokens (cyan/violet, glows) and fonts; its interactive tour reuses the panel, tab, statistics, table and chart components.
- The theme choice is per device. Syncing it across devices would need a server preference.
- The marketing site's interactive tour (`apps/marketing`) still shows the previous top-bar layout and cyan/violet glow styling; it should be brought in line.
