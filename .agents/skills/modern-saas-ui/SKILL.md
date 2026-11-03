---
name: modern-saas-ui
description: Professional SaaS dashboard design system, UI/UX architecture, dark graphite palette, data tables, analytical charts, typography, and component states for modern web applications.
---

# Modern SaaS Dashboard Design System

Use this skill when designing, building, or refactoring modern web dashboards, analytics panels, and SaaS interfaces.

## 1. Aesthetic Identity & Design Principles

- **Style Grounding**: Modern Strategic Tech (Linear / Stripe / Vercel / Raycast).
- **Core Philosophy**: Clean typography, high information density with breathing room, subtle borders (1px), precision border-radii, restrained color accents, and zero "AI slop" (no neon cyan/magenta gradients, no oversized glassmorphism, no fake floating 3D objects).
- **Theme Foundation**: Deep Graphite & Dark Slate (`#0B0F19` canvas, `#111827` surface cards, `#1E293B` borders).

---

## 2. Design Tokens & Color Palette

### Dark Mode (Primary Palette)
```css
:root {
  /* Canvas & Surfaces */
  --bg-canvas: #090D16;        /* Deepest background */
  --bg-surface: #111827;       /* Primary card surface */
  --bg-surface-hover: #182234; /* Card hover / elevated */
  --bg-surface-active: #1F293D;
  --bg-input: #0D1321;         /* Input & select background */

  /* Borders & Dividers */
  --border-subtle: #1E293B;    /* 1px primary container borders */
  --border-muted: #172033;     /* Inner dividers / table row borders */
  --border-focus: #3B82F6;     /* Accent focus ring */

  /* Text & Hierarchy */
  --text-primary: #F8FAFC;     /* Headers & primary data (95% contrast) */
  --text-secondary: #94A3B8;   /* Labels, metadata, subheadings */
  --text-muted: #64748B;       /* Placeholders, disabled states */
  --text-inverse: #090D16;     /* Text on light accent badges */

  /* Functional Accents */
  --accent-primary: #3B82F6;   /* Sky/Royal Blue primary actions */
  --accent-primary-hover: #2563EB;
  --accent-success: #10B981;   /* Emerald - active shifts, positive revenue */
  --accent-success-bg: rgba(16, 185, 129, 0.12);
  --accent-warning: #F59E0B;   /* Amber - warnings, long running shifts */
  --accent-warning-bg: rgba(245, 158, 11, 0.12);
  --accent-danger: #EF4444;    /* Crimson - refunds, stop shift, delete */
  --accent-danger-bg: rgba(239, 68, 68, 0.12);
  --accent-indigo: #6366F1;    /* Violet/Indigo - special metrics / CRM */

  /* Geometry & Elevation */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 14px;
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-elevated: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
}
```

---

## 3. Typography Hierarchy

- **Font Family**: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif.
- **Monospace / Tabular Figures**: `font-feature-settings: "tnum" 1, "cv05" 1;` for all numeric metrics, amounts, timers, and tables.
- **Scale**:
  - **KPI Numbers**: `24px` to `28px`, `font-weight: 700`, line-height `1.1`.
  - **Section Headings**: `16px` to `18px`, `font-weight: 600`, line-height `1.3`.
  - **Card Titles & Headers**: `13px` to `14px`, `font-weight: 600`.
  - **Body Text**: `13px`, `font-weight: 400`, line-height `1.5`.
  - **Captions & Metadata**: `11px` to `12px`, `font-weight: 500`.

---

## 4. Component Patterns

### A. Metric / KPI Card
- Compact, high contrast, clean typography.
- Small uppercase or subdued label (`11px`, `--text-secondary`).
- Big bold value (`--text-primary`, tabular figures).
- Subtitle or pill badge with trend / count.

### B. High-Density Data Tables
- Sticky header with subtle background (`--bg-surface`).
- Border bottom (`1px solid --border-muted`).
- Row hover highlight (`--bg-surface-hover`).
- Action buttons grouped on the right in muted button pills.
- Status badges: 12px pill badges with 15% opacity background and vibrant solid text.

### C. Modals & Dialogs
- Backdrop: `rgba(0, 0, 0, 0.65)` with `backdrop-filter: blur(4px)`.
- Modal box: `--bg-surface`, border `1px solid --border-subtle`, rounded `--radius-xl`.
- Distinct header with title and close `×` button.
- Footer with secondary "Отмена" and primary action button.

### D. Empty & Loading States
- Never leave blank space or broken layouts.
- Show clean skeleton bars with subtle CSS animation during loading.
- For empty states, display a clear icon, informative 1-sentence explanation, and action button.
