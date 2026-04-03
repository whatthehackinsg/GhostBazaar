# Frontend Dark Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready dark mode across the Ghost Bazaar frontend that works for landing, dashboard, and admin without breaking the current terminal/editorial aesthetic.

**Architecture:** Build dark mode on top of the existing CSS variable system in `frontend/src/globals.css`, then route all component colors through semantic theme tokens instead of hardcoded white/black values. Use a small client-side theme controller with persisted user preference and `prefers-color-scheme` fallback, then do a pass on special cases such as canvas rendering, overlays, hover states, and role colors.

**Tech Stack:** Vite, React 19, TypeScript, inline styles + global CSS variables

---

## File Map

- Modify: `frontend/src/globals.css`
  - Add semantic light/dark tokens and theme attribute selectors.
- Create: `frontend/src/hooks/useTheme.ts`
  - Manage `light | dark | system` preference and `document.documentElement` theme sync.
- Create: `frontend/src/components/ThemeToggle.tsx`
  - Small mono-styled toggle for switching themes.
- Modify: `frontend/src/main.tsx`
  - Initialize theme controller near app bootstrap.
- Modify: `frontend/src/pages/LandingPage.tsx`
  - Mount theme toggle in a stable place for landing.
- Modify: `frontend/src/pages/DashboardPage.tsx`
  - Mount theme toggle in dashboard header.
- Modify: `frontend/src/pages/AdminPage.tsx`
  - Mount theme toggle in admin header/login state.
- Modify: `frontend/src/components/LandingSideNav.tsx`
  - Replace white glass panel assumptions with tokenized panel background.
- Modify: `frontend/src/components/NavOverlay.tsx`
  - Replace hardcoded light overlay colors.
- Modify: `frontend/src/components/AsciiCanvas.tsx`
  - Add theme-aware draw colors for lens, glyphs, and linework.
- Modify: `frontend/src/components/dashboard/LiveFeed.tsx`
  - Replace hardcoded `#111/#fff` role and hover colors.
- Modify: `frontend/src/components/dashboard/DemoMetrics.tsx`
  - Verify highlight colors still read well on dark backgrounds.
- Modify: `frontend/src/components/dashboard/StatsCards.tsx`
- Modify: `frontend/src/components/dashboard/ActivityChart.tsx`
- Modify: `frontend/src/components/dashboard/EngineStatus.tsx`
  - Audit border/surface contrast on dark tokens.
- Modify: `frontend/index.html`
  - Optional: add `meta name="theme-color"` handling or dark default notes if needed.

---

## Chunk 1: Theme Contract

### Task 1: Define semantic theme tokens

**Files:**
- Modify: `frontend/src/globals.css`

- [ ] **Step 1: Add dark-mode token groups**
  - Define semantic variables instead of relying only on `--bg-color` / `--text-color`.
  - Minimum token set:
    - `--bg-color`
    - `--bg-elevated`
    - `--bg-overlay`
    - `--text-color`
    - `--secondary-color`
    - `--hairline`
    - `--accent`
    - `--selection-bg`
    - `--selection-text`
    - `--role-buyer`
    - `--role-seller`
    - `--role-system`

- [ ] **Step 2: Add theme selectors**
  - Keep light mode in `:root`.
  - Add `[data-theme="dark"]` overrides.
  - Add a `@media (prefers-color-scheme: dark)` block only for the `system` case if needed.

- [ ] **Step 3: Route selection through tokens**
  - Change `::selection` and `::-moz-selection` to use semantic selection tokens.

- [ ] **Step 4: Run build**

Run: `pnpm --dir frontend build`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/globals.css
git commit -m "feat(frontend): add dark mode theme tokens"
```

---

## Chunk 2: Theme Runtime

### Task 2: Add a theme controller hook

**Files:**
- Create: `frontend/src/hooks/useTheme.ts`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Write the hook contract**
  - `themePreference: "light" | "dark" | "system"`
  - `resolvedTheme: "light" | "dark"`
  - `setThemePreference(next)`

- [ ] **Step 2: Implement persistence**
  - Store user choice in `localStorage`.
  - Use `system` as the default when no stored choice exists.
  - Sync `document.documentElement.dataset.theme`.

- [ ] **Step 3: Subscribe to system changes**
  - If preference is `system`, react to `matchMedia("(prefers-color-scheme: dark)")`.

- [ ] **Step 4: Bootstrap in `main.tsx`**
  - Ensure the theme is applied before the app visually settles.

- [ ] **Step 5: Run build**

Run: `pnpm --dir frontend build`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useTheme.ts frontend/src/main.tsx
git commit -m "feat(frontend): add theme preference controller"
```

---

## Chunk 3: Toggle UI

### Task 3: Add a reusable theme toggle

**Files:**
- Create: `frontend/src/components/ThemeToggle.tsx`
- Modify: `frontend/src/pages/LandingPage.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Modify: `frontend/src/pages/AdminPage.tsx`

- [ ] **Step 1: Build a compact toggle**
  - Mono-styled, text-first, fits the current Ghost Bazaar aesthetic.
  - Avoid emoji; use labels like `LIGHT`, `DARK`, `SYSTEM`.

- [ ] **Step 2: Place it on landing**
  - Put it in a stable top-corner/header area that does not fight the left nav.

- [ ] **Step 3: Place it on dashboard and admin**
  - Use the same component and interaction model.

- [ ] **Step 4: Manual verification**
  - Toggle through all three modes.
  - Refresh the page and confirm persistence.

- [ ] **Step 5: Run build**

Run: `pnpm --dir frontend build`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ThemeToggle.tsx frontend/src/pages/LandingPage.tsx frontend/src/pages/DashboardPage.tsx frontend/src/pages/AdminPage.tsx
git commit -m "feat(frontend): add theme toggle"
```

---

## Chunk 4: Hardcoded Surface Cleanup

### Task 4: Replace light-only hardcoded colors

**Files:**
- Modify: `frontend/src/components/LandingSideNav.tsx`
- Modify: `frontend/src/components/NavOverlay.tsx`
- Modify: `frontend/src/components/dashboard/LiveFeed.tsx`
- Modify: `frontend/src/components/dashboard/DemoMetrics.tsx`
- Modify: `frontend/src/components/dashboard/StatsCards.tsx`
- Modify: `frontend/src/components/dashboard/ActivityChart.tsx`
- Modify: `frontend/src/components/dashboard/EngineStatus.tsx`

- [ ] **Step 1: Replace white overlay assumptions**
  - `rgba(255,255,255,...)` surfaces should become token-driven.

- [ ] **Step 2: Replace hardcoded role colors**
  - `#111`, `#fff`, and hover inversions in `LiveFeed.tsx` must use semantic role/surface tokens.

- [ ] **Step 3: Verify cards and borders**
  - Make sure border contrast survives on dark backgrounds.

- [ ] **Step 4: Run build**

Run: `pnpm --dir frontend build`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LandingSideNav.tsx frontend/src/components/NavOverlay.tsx frontend/src/components/dashboard/LiveFeed.tsx frontend/src/components/dashboard/DemoMetrics.tsx frontend/src/components/dashboard/StatsCards.tsx frontend/src/components/dashboard/ActivityChart.tsx frontend/src/components/dashboard/EngineStatus.tsx
git commit -m "fix(frontend): tokenize dark mode component surfaces"
```

---

## Chunk 5: Canvas And Motion

### Task 5: Make hero canvas theme-aware

**Files:**
- Modify: `frontend/src/components/AsciiCanvas.tsx`

- [ ] **Step 1: Identify current hardcoded draw colors**
  - Lens overlay
  - Glyph fill
  - Grid/line accents

- [ ] **Step 2: Pass resolved theme into canvas drawing**
  - Either via CSS variables sampled once per frame batch or a prop derived from the theme hook.

- [ ] **Step 3: Tune contrast for dark mode**
  - Dark mode should still feel Ghost Bazaar, not generic neon hacker wallpaper.
  - Keep white/gray editorial restraint unless a stronger accent is deliberately chosen.

- [ ] **Step 4: Manual verification**
  - Hero must remain legible in both themes.
  - Split reveal animation should still look intentional.

- [ ] **Step 5: Run build**

Run: `pnpm --dir frontend build`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AsciiCanvas.tsx
git commit -m "feat(frontend): add theme-aware hero canvas"
```

---

## Chunk 6: Visual QA And Regression Pass

### Task 6: Verify light and dark mode parity

**Files:**
- Modify as needed based on QA findings

- [ ] **Step 1: Landing QA**
  - Check hero, left nav, protocol section, privacy table, comparison table, CTA buttons.

- [ ] **Step 2: Dashboard QA**
  - Check stats cards, activity chart, live feed, demo metrics, engine status.

- [ ] **Step 3: Admin QA**
  - Check login form, session list, session detail state.

- [ ] **Step 4: Accessibility sanity check**
  - Text contrast
  - Focus visibility
  - Selection visibility
  - Hover-only interactions still readable

- [ ] **Step 5: Final build**

Run: `pnpm --dir frontend build`  
Expected: PASS

- [ ] **Step 6: Capture screenshots / notes for PR**

- [ ] **Step 7: Commit**

```bash
git add frontend
git commit -m "fix(frontend): polish dark mode contrast and qa"
```

---

## Dark Mode Design Notes

- Do not default to pure black backgrounds everywhere. Keep the current editorial feel by using layered dark neutrals:
  - background near charcoal
  - elevated panels slightly lighter
  - hairlines soft, not silver-bright
- Keep the mono/text-first identity. Dark mode should feel like the same product, not a separate theme pack.
- Avoid random cyan/purple accents. If accent expansion is needed, use one restrained family only.
- Preserve current interaction density and spacing. This phase is visual theming, not a layout redesign.

---

## Verification Commands

```bash
pnpm --dir frontend build
```

Optional manual preview:

```bash
cd frontend && pnpm preview --host 127.0.0.1 --port 4173
```

Check:
- landing in light mode
- landing in dark mode
- dashboard in light mode
- dashboard in dark mode
- admin in light mode
- admin in dark mode
- persisted theme on refresh
- `system` follows OS theme

---

Plan complete and saved to `docs/superpowers/plans/2026-03-22-frontend-dark-mode.md`. Ready to execute?
