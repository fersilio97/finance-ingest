# 016 — Sticky, more prominent top nav
Status: Shipped
Iteration: 8

Frontend-only. No spec discovery, no architecture stage — per the feature-loop skill's
entry-point table, a presentation-only change with no API involvement goes straight to
`fintech-frontend`. This doc stands in for the usual three-agent doc split; it's written
entirely by the frontend engineer.

## Problem / request

User's verbatim request: the 4 tabs — Upload & Review, All Transactions, Insights,
Reconciliation — "must have more presence and be at the top of the screen always static."

Two asks, both real defects against the existing nav (`.top-bar nav a` in
`frontend/styles.css`, shared markup across `index.html`, `transactions.html`,
`insights.html`, `reconciliation.html` — confirmed by reading all four; each has the same
`<div class="page"><header class="top-bar"><h1>…</h1><nav>4 links, current page marked
`aria-current="page"`</nav></header>` structure, so no markup change was needed, only
CSS):

1. **No visual weight.** Nav items were muted-color plain text links, distinguished from
   body copy only by an underline on `:hover`/`aria-current`. Easy to miss as navigation
   at all against the serif-heading, hairline-divider design system.
2. **Scrolls away.** `.top-bar` had no `position` set, so on any page with content taller
   than the viewport (all four, to varying degrees — see `ui-check.mjs`'s own height
   report below) the nav disappears the moment you scroll, forcing a scroll-to-top to
   switch tabs. On `index.html` specifically (currently 6.7–8.2x the viewport tall) this
   is a real, frequent cost, not a nitpick.

## Design decisions

### Visual weight: segmented-tab pill, not a bigger underline

Turned `.top-bar nav` into a sunken pill "track" (`background: var(--surface-sunken);
padding: var(--space-1); border-radius: 999px;`) holding pill-shaped `<a>` children
(`padding`, `border-radius: 999px`). The active page gets a filled state
(`background: var(--accent-soft); color: var(--accent); font-weight: 600`) instead of
just an underline; hover gets a lighter `var(--surface)` fill; `:active` darkens toward
the accent-soft/accent pair; `:focus-visible` keeps a real accent-colored outline ring
(now radius-matched to the pill instead of the old 2px-square one).

Reasoning: this is a segmented-control pattern already implicit in the design system's
own vocabulary (pills exist elsewhere — `.pill.ok`/`.pill.mismatch` status badges) and it
reuses exactly the CSS custom properties already in the palette (`--surface-sunken`,
`--surface`, `--accent`, `--accent-soft`, `--text`, `--text-muted`) — no new colors, works
unmodified in both `prefers-color-scheme` themes since those tokens are already themed.
It reads as "tabs" (matching what they semantically are) without a drop shadow or a
border-heavy card treatment, consistent with "hairline dividers instead of card borders."

**Judgment call the user may want to weigh in on:** I chose a filled pill-tab look over
alternatives like a bolder underline or a colored top border per item (mirroring
`.tile`'s `border-top: 2px solid var(--accent)` treatment). The pill felt like the
clearest "these are the same four screens as tabs" signal and mirrors patterns already in
the codebase (status pills); a more minimal option (e.g. just heavier text weight + a
thicker underline) would have been less of a design lift but also less of the "more
presence" the user explicitly asked for.

### Sticky, not fixed

`.top-bar { position: sticky; top: 0; z-index: 20; background: var(--surface); }` — the
approach flagged as "almost certainly right" going in, confirmed:

- No manual `padding-top` offset needed on the page body, unlike `position: fixed`.
- Content can never slide underneath and be visually clipped by it, unlike getting the
  fixed-offset math wrong.
- `z-index: 20` is comfortably above the only other z-indexed element in the app
  (`.chart-tooltip { z-index: 5; }` on the Insights balance chart) and anything else that
  might later need to float above normal content.
- Needed an opaque `background: var(--surface)` once sticky — content now visibly
  scrolls underneath the bar, so transparent would double-expose text. `--surface`
  (rather than the page's own `--bg`) was chosen specifically so the bar reads as a
  raised, distinct surface — reusing the same "surface fill instead of a shadow" language
  `.panel`/`.tile` already use for elevation in this design system.
- **Skipped:** a scroll-triggered shadow/extra border that only appears once content is
  scrolled under the bar. The existing `border-bottom: 1px solid var(--border)` is always
  present and already gives a clean separation line in both scrolled and unscrolled
  states; adding a JS scroll listener (across four separate page-entry JS files) to toggle
  an extra shadow class only for a marginal, hard-to-notice-in-this-monochrome-palette
  effect wasn't worth the added surface area. Noted per the spec's own "skip if it adds
  real complexity for little payoff" allowance.
- **Judgment call the user may want to weigh in on:** the sticky bar's width tracks
  `.page`'s own centered, max-width column (`clamp(1180px, 92vw, 1680px)` per feature
  011) — it does **not** go edge-to-edge across the full browser window at wide
  viewports; on the sides outside `.page`'s width, the plain page background remains
  visible while scrolled. A true full-bleed sticky bar would require pulling `.top-bar`
  out of `.page` into its own wrapper (a markup change), which the task description
  flagged as "likely not needed" — I agree with that call for a first pass, but it's
  worth naming explicitly since a full-bleed bar is a materially different (and, on very
  wide monitors, probably more expected) visual than what shipped.

### A real bug found and fixed along the way: `overflow-x: hidden` on `body` silently broke `position: sticky`

`html, body { max-width: 100%; overflow-x: hidden; }` (the pre-existing "body never
scrolls horizontally" safety net) turned out to fully disable sticky positioning for
every page. Root cause, confirmed live via a throwaway Playwright probe (scrolled each
page, measured `.top-bar`'s `getBoundingClientRect()` before/after): the bar tracked the
scroll offset 1:1 instead of pinning at `top: 0` — i.e. it behaved exactly like
`position: static`.

Why: per the CSS Overflow Module's propagation rule, when one of `overflow-x`/`overflow-y`
is non-`visible` and the other isn't explicitly set, the unset one is computed as `auto`
to stay consistent. `html`'s `overflow-x: hidden` is the one the browser propagates to
the *viewport* (this alone is sufficient to stop horizontal page scroll — confirmed by
`ui-check.mjs`'s own `scrollWidth`/`clientWidth` check still passing after the fix).
`body`'s **duplicate** `overflow-x: hidden`, however, isn't propagated anywhere — it just
makes `body` itself an independent, overflow-hidden scroll container, distinct from the
viewport. `position: sticky` computes against the nearest ancestor scroll container; once
that became `body` — which never has its own internal scroll offset, since it's the
*viewport* that actually scrolls here — the sticky calculation had nothing to react to.

Fix: moved `overflow-x: hidden` onto `html` only; `body` keeps `max-width: 100%` (harmless,
no overflow effect) but no longer sets its own `overflow-x`. Re-verified: `ui-check.mjs`
still reports 0 horizontal-overflow problems on all 4 pages × 2 widths × 2 themes, and the
sticky-nav probe (below) now shows the bar pinning correctly everywhere it has room to.

This is exactly the kind of thing the spec anticipated by saying "confirm live rather
than trusting the doc" — `position: sticky; top: 0;` was the right call, but it silently
did nothing until this ancestor rule was found and fixed. Flagging clearly since it's a
change to a *shared, global* rule (`html`/`body`), not scoped to the nav itself — it could
in principle affect anything else relying on `body`'s overflow behavior, though nothing
else in `styles.css` referenced it and the harness's own overflow check (which exists
specifically to catch this class of regression) stayed green after the change.

### Narrow-width nav wrapping (found during visual review, not in the original ask)

At 480px, four nav items plus the page title don't fit on one row even in the old
plain-text nav — but with the new pill treatment's added padding, the overflow became
visually obvious rather than being clipped invisibly: the fourth item ("Reconciliation")
was cut off entirely, unreachable, at the edge of the viewport in the first render I
looked at. Fixed by adding `flex-wrap: wrap` to both `.top-bar` (so the nav drops to its
own row under the title) and `.top-bar nav` (so the pill track itself can wrap its own
children if needed) — no media query required, since it only engages when content
actually doesn't fit. Re-verified with screenshots at 480px on all four pages: nav wraps
to a second line under the title in both themes, all four pills fully visible and
clickable, no page-level horizontal overflow.

## Implementation

`frontend/styles.css` only — no HTML changes (markup already identical and correct
across all four pages), no JS, no backend involvement of any kind, no DB reads/writes
needed to build or verify this.

- `html`/`body` overflow-x split (see above).
- `.top-bar`: added `position: sticky; top: 0; z-index: 20; background: var(--surface);
  flex-wrap: wrap;`, adjusted `gap`/`padding` slightly for the wrap case.
- `.top-bar nav`: pill track (`background: var(--surface-sunken); padding: var(--space-1);
  border-radius: 999px; flex-wrap: wrap;`).
- `.top-bar nav a`: pill items with `padding`, `border-radius: 999px`, `font-weight: 500`,
  `:hover`/`:active`/`[aria-current="page"]`/`:focus-visible` states per the design system
  tokens listed above.

## Verification evidence

Ran `node scripts/ui-check.mjs` (all 4 pages × 2 viewports × 2 themes = 16 screenshots) —
clean: 0 console errors, 0 failed requests, 0 horizontal overflow, all page heights
unchanged from before this change (confirming no layout regression elsewhere).

**Opened and visually reviewed every one of the 16 screenshots with the Read tool**
(not just spot-checked): `index`, `transactions`, `insights`, `reconciliation` ×
desktop (1440px) / narrow (480px) × light / dark. Confirmed:
- Pill nav renders correctly in both themes — filled amber-accent active state, sunken
  track background, all readable against both light and dark surface colors.
- At 480px, nav wraps cleanly onto its own row below the (sometimes 2–3-line) `<h1>`,
  all four pills fully visible — the clipped-"Reconciliation" bug (found in the first
  pass, before the `flex-wrap` fix) is resolved.
- No horizontal scroll or layout breakage introduced on any of the four pages' headers.

**Stickiness itself — actually scrolled, not just screenshotted at position 0,** per the
explicit instruction that a scroll-position-0 screenshot proves nothing. Wrote a
throwaway Playwright script (`scripts/_scratch-sticky-check.mjs`, deleted after use, not
part of the permanent suite), which for every page × viewport × theme combination:
scrolled to `window.scrollTo(0, 900)` (or as far as the page allows), then measured
`.top-bar`'s `getBoundingClientRect().top` and screenshotted the scrolled state.

First run (before the `overflow-x` fix) showed the bug clearly: `.top-bar`'s `top`
tracked the scroll offset exactly (e.g. `scrollY: 900` → `top: -868`), i.e. it was not
sticking at all. After moving `overflow-x: hidden` off `body`, the same script reported
`top: 0` (pinned) on every page/viewport/theme combination that had enough content to
scroll:

| Page | Viewport | Result |
| --- | --- | --- |
| index | desktop + narrow, light + dark | pinned (`top: 0`) after scrolling to 900px |
| transactions | desktop + narrow, light + dark | pinned after scrolling to 900px |
| insights | desktop (scrolled 830px, page's own max) + narrow (900px) | pinned |
| reconciliation | narrow (scrolled 127px, page's own max at this width) | pinned |
| reconciliation | desktop, light + dark | **not scrollable** — page height ≈ viewport height in the current empty-balance-data state, so there was nothing to scroll past; not a failure, just no content to test stickiness against at that specific viewport |

Visually confirmed via the scrolled screenshots (opened with the Read tool, not just the
numeric check) on `index-desktop-light`, `transactions-desktop-dark`,
`insights-narrow-light`, `reconciliation-narrow-dark`, and `reconciliation-desktop-light`
(the un-scrollable case, to confirm it renders normally, not broken): in every scrollable
case the nav bar sits fixed at the very top of the viewport with table/panel content
visibly scrolled up underneath it, no overlap, no clipped text, background opaque in both
themes.

### What was NOT verified

- Reconciliation's desktop-width stickiness specifically, because the page currently has
  no recorded balances (empty state) and isn't tall enough to scroll at 1440×900/1000. The
  CSS rule is identical to the other three pages' `.top-bar` (same class, same stylesheet),
  and the same page *does* stick correctly at the narrow viewport once content pushes it
  past viewport height, so there's no structural reason to expect it'd behave differently
  once real balance data makes the page taller — but this exact combination wasn't
  observed directly.
- Cross-browser: only Chromium via Playwright, consistent with `ui-check.mjs`'s existing
  scope.
- Keyboard-only tab-through-the-nav focus ring was not separately screenshotted (only
  hover/active/aria-current states were visually confirmed via normal rendering); the
  `:focus-visible` CSS rule itself was written and reviewed by eye in the stylesheet but
  its rendered appearance wasn't captured in a screenshot.
- No mutating interaction was needed or performed — this feature never touches the API or
  `data/finance.db`.
