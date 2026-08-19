# DeployerX Landing Page: Reference Analysis and Build Plan

## 1. Scope and product truth

This document translates the design language and information architecture of
`https://www.open-wa.org/` into an original DeployerX landing page. The goal is
to reproduce the reference site's level of polish, hierarchy, density, and
interaction quality without copying its brand assets, illustrations, source
code, or WhatsApp-specific content.

The implementation will live entirely in this `landing-page/` folder and use
only semantic HTML, CSS, and browser-native JavaScript. No framework, bundler,
or runtime dependency is required.

Primary product sources:

- `../LANDING_PAGE_BRIEF.md` for the requested marketing position and copy.
- `../README.md` for current, verifiable product capabilities and URLs.
- `../assets/deployerx-logo.png` and
  `../assets/screenshots/deployerx-command-center.png` for authentic visuals.

Important accuracy correction: the current README states that this repository
does not contain a top-level project license and that source availability must
not be interpreted as permission to redistribute or create derivative works.
Before publishing claims such as "open source," "free forever," or a named
license, add an appropriate root `LICENSE` file. Until then, public copy should
say "source available" or use a clearly approved project claim.

## 2. Reference website audit

### 2.1 Overall experience

OpenWA uses a product-documentation hybrid rather than a conventional SaaS
landing page. It feels technical, credible, and unusually information-rich.
Its core design principles are:

- One strong product promise in the first viewport.
- A restrained near-black canvas with one luminous status/action color.
- Large typography and generous vertical rhythm, balanced by dense technical
  sections below the hero.
- Numbered sections that make a long page easy to navigate and remember.
- Real product facts: capabilities, architecture, comparison, install commands,
  stack, ecosystem, changelog, FAQ, and community.
- Mostly unframed layouts. Borders and panels appear only where data or a tool
  genuinely needs containment.
- Small, purposeful motion rather than continuous decorative animation.

The inspected desktop page is approximately 14,300px tall at a 1920x945
viewport. Its content container is 1,280px wide with 32px side padding. Major
sections use up to 160px vertical padding and are divided by subtle 1px
hairlines. On a 390px viewport, sections use roughly 80px vertical padding,
multi-column layouts stack, and the decorative hero visual is removed.

### 2.2 Header and navigation

The reference header is fixed, 76px tall on desktop and about 71px on mobile.
It uses a translucent dark background with blur, a compact logo at the left,
and three utilities at the right:

- Live GitHub star count badge.
- Icon-only light/dark theme toggle.
- `MENU` plus hamburger icon.

The menu opens a full-screen overlay containing numbered section links and
external project links. This keeps the default header quiet even though the
page contains ten sections. The current section is not shown as a permanent
desktop nav item.

DeployerX adaptation:

- Left: authentic DeployerX logo and wordmark.
- Right: GitHub badge, theme toggle, and menu button.
- Overlay: `01 Capabilities`, `02 Workflow`, `03 Workspaces`, `04 Quick Start`,
  `05 Technology`, `06 Local First`, `07 Releases`, `08 FAQ`, `09 Community`,
  plus GitHub, Releases, and Issues.
- Primary download remains accessible in the hero instead of overcrowding the
  header.

### 2.3 Hero

The reference hero fills roughly one desktop viewport. It has a subtle square
grid across the background and a low-opacity green illumination behind the
content. The two-column layout is approximately 720px text / 416px visual with
an 80px gap.

Visual hierarchy:

- Compact release badge linking to changelog.
- Large two-part H1. Desktop size is about 112px/0.95 line-height; mobile is
  about 43px/1.0.
- The product category/benefit line is rendered in the accent color.
- Supporting paragraph is 20px/32px with important phrases in bold.
- Solid primary pill button and outlined secondary pill button.
- Four small trust statements with icons below the CTAs.
- A product-specific radial diagram occupies the right side; it is hidden on
  narrow mobile screens.

DeployerX hero content:

- Release badge: `v0.1.6 available` / `See what's new`.
- Product signal above or within the H1: `DeployerX` must be visible in the
  first viewport, not only in the navigation.
- H1: `Open-source server operations, without the busywork.` after licensing is
  resolved; otherwise `Server operations, without the busywork.`
- Supporting copy: `Manage hosts, open SSH sessions, browse with SFTP, run
  repeatable deployments, monitor uptime, and protect backups from one
  local-first Windows workspace.`
- Primary CTA: `Download for Windows` linking to the latest release.
- Secondary CTA: `View on GitHub`.
- Trust row: `Local first`, `Windows 10/11`, `Source available` (or `Open
  source` after licensing), `Optional sync`.
- Hero visual: use the real command-center screenshot, cropped so fleet health,
  SSH, uptime, and backup states remain legible. Present it as an unframed
  product viewport with a subtle perspective/edge treatment, not as an abstract
  illustration.

### 2.4 Color, type, and visual tokens

Measured reference dark tokens:

- Page background: `#0a0f1d`.
- Primary text: `#eef2f8`.
- Secondary text: `#98a4ba`.
- Faint text: `#5a6781`.
- Surface: `#1a2540`.
- Elevated surface: `#243152`.
- Code background: `#070b16`.
- Accent: `#25d366`, with brighter `#4ff07f` details.
- Divider: white at roughly 6% opacity.
- Sans: Plus Jakarta Sans.
- Mono: JetBrains Mono.

DeployerX should preserve the contrast and hierarchy but use its own product
palette, derived from the actual application screenshot:

- Dark canvas: `#0b1118`.
- Navigation/surface: `#111821` and `#172130`.
- Primary text: `#f1f6fb`.
- Secondary text: `#9db0c8`.
- Brand accent: teal `#2ecfa6`.
- Supporting accent: blue `#4ea1ff`.
- Alert accents used sparingly: coral/red and amber only for real status data.
- Light theme: off-white canvas, white surfaces, ink text, and the same teal
  brand color with a darker accessible shade for text/links.

Use Plus Jakarta Sans and JetBrains Mono from a reputable font CDN with system
fallbacks. To make the page fully self-contained/offline later, download and
self-host WOFF2 files only if their licenses are bundled. Unlike the reference,
do not use negative letter spacing; project design rules require `0`.

Type scale:

- Hero H1: `clamp(2.75rem, 7vw, 7rem)`, max line length 10-12 words.
- Section H2: `clamp(2.25rem, 5vw, 3rem)`.
- Card/column H3: 20-24px.
- Body: 16px/1.6; lead copy: 18-20px/1.6.
- Labels/kickers: 12-13px uppercase, 700 weight.
- Code/data: 13-14px JetBrains Mono.

### 2.5 Sections and component patterns

The reference page uses the following sequence:

1. Capabilities: four unframed feature columns with icon-led lists.
2. Architecture: two wide explanatory columns with adapter/engine diagrams.
3. Comparison: a horizontally scrollable, highlighted comparison table.
4. Quick Start: segmented tabs, terminal panel, copy button, and endpoint facts.
5. Tech Stack: logo/name grid plus a compact technical footnote.
6. Ecosystem: three linked integration cards.
7. Plugins: split copy/diagram section showing extensibility.
8. Changelog: version rail with categorized release items.
9. FAQ: compact accordion list.
10. Community: contribution copy, GitHub calls to action, contributors, footer.

Reusable component characteristics:

- Section kicker: accent color, numbered, uppercase.
- Section title: wide but controlled to about 720px.
- Lead paragraph: muted, maximum width around 600px.
- Feature grid: four desktop columns; no decorative outer cards.
- Split sections: two columns with 64-80px gap.
- Data panels: 1px border, dark surface, 6-8px radius.
- Buttons: pill shape is appropriate for high-level hero calls to action;
  compact tool actions use icons and 6-8px radii.
- Icons: simple stroke icons. Use Lucide via a local icon sprite or inline
  accessible SVG markup prepared specifically for this page.

### 2.6 Interaction and behavior audit

The useful reference behaviors are:

- Fixed, translucent header that gains a stronger border/surface after scroll.
- Full-screen menu overlay with numbered anchors and Escape/close behavior.
- Dark/light theme toggle persisted in `localStorage`, with system preference as
  the first-visit default.
- Smooth anchor navigation that accounts for the fixed header.
- IntersectionObserver reveal animation for section headings, columns, and
  panels. Animation should be disabled under `prefers-reduced-motion`.
- Quick-start segmented control that swaps command blocks.
- Copy button that writes a command and briefly changes to a success state.
- FAQ disclosure rows with `aria-expanded`, keyboard access, and animated height.
- Horizontal overflow wrapper around wide tables on small screens.
- External links have clear accessible labels and safe `rel` attributes.

DeployerX should implement all of these except a competitor comparison. A
comparison table would require verified competitor research and creates little
value for this desktop operations product. Replace it with a truthful workspace
matrix showing what DeployerX brings together.

## 3. DeployerX page architecture and copy plan

### 00. Fixed header and menu overlay

Purpose: persistent brand and navigation without competing with the hero.

- Logo links to `#top`.
- GitHub badge links to `https://github.com/me-devms/DeployerX`.
- Theme icon button has a tooltip and visible focus ring.
- Menu button opens the numbered full-screen navigation.
- Overlay traps focus, closes on Escape, closes after an anchor is selected,
  and restores focus to the menu button.

### Hero: DeployerX command center

Purpose: state the product, platform, and benefit within five seconds.

- Release badge, product name, headline, verified supporting copy.
- `Download for Windows` and `View on GitHub` CTAs.
- Four trust markers.
- Authentic command-center screenshot with descriptive alt text.
- Grid background can include subtle server-coordinate ticks or terminal prompt
  marks, but must remain quiet and CSS-only.

### 01. Capabilities: `One workspace for infrastructure work.`

Use four unframed columns, each containing an icon and short checklist:

- Command Center: fleet health, quick navigation, active operations, emergency
  stop.
- Access: SSH terminal, multi-user sessions, SFTP browser, VNC for compatible
  Windows hosts.
- Observability: CPU/memory/disk/network, processes/services, HTTP/TCP/TLS
  uptime, incidents and maintenance windows.
- Protection: deployment commands, reusable host workflows, backup jobs,
  recovery points and retention.

This section replaces generic feature cards with scannable, concrete product
capabilities, matching the reference's strongest pattern.

### 02. Workflow: `From registered host to repeatable operation.`

Use a three-step horizontal sequence on desktop and vertical sequence on mobile:

1. `Register once` - save and organize Linux or Windows hosts in groups and
   favorites.
2. `Work from one place` - connect through SSH/SFTP, save commands, and inspect
   live health.
3. `Operate with confidence` - run deployments, watch uptime, verify backups,
   and interrupt active work from Emergency Stop.

Alongside the steps, show a small interactive product diagram made from HTML
elements: host -> secure session -> command/monitor/backup results. Do not
invent a protocol or claim automatic deployments that the app does not offer.

### 03. Workspaces: `The tools are connected. The data stays coherent.`

Replace OpenWA's competitor table with a DeployerX workspace matrix. Columns:
`Workspace`, `Connect`, `Operate`, `Observe`, `Protect`.

Rows:

- Hosts.
- SSH and SFTP.
- Real-Time Monitor.
- Uptime.
- Backup Manager.
- Command Center.

Use check marks only for verified relationships. On mobile, retain a semantic
table inside a labeled horizontal scroll region; do not convert it into a set
of nested cards.

### 04. Quick Start: `Choose local. Add cloud only when it helps.`

Use a segmented control with two modes:

- `Install`: latest Windows setup and portable download links plus a short
  SmartScreen verification note.
- `Run from source`: PowerShell clone/install/start commands taken directly
  from README.

Below the code/download panel, display three operational facts:

- `Windows 10 / 11`.
- `Local Workspace needs no hosted backend`.
- `Cloud workspace is optional`.

The copy action should copy only the source command block. Download buttons
should link directly to the latest release page unless release asset names are
kept current automatically.

### 05. Technology: `Built from tools infrastructure teams already know.`

Use an 8-item logo/name grid based only on verified dependencies:

- Electron.
- Node.js.
- xterm.js.
- ssh2.
- SQLite.
- noVNC.
- Monaco Editor.
- Firebase (clearly labeled optional workspace integration).

Add one muted technical sentence about the local main-process security boundary
and the loopback-only authenticated MCP endpoint. Do not turn the section into
a dependency dump.

### 06. Local first: `Your workspace starts on your machine.`

Use three linked, unframed columns:

- Local Workspace: no account or hosted backend required.
- Optional team sync: Firebase workspace for membership and synchronized data.
- Security boundaries: credentials resolved in the main process, encrypted
  cloud secrets, loopback MCP, host-key support.

Add a small visual status strip: `Local data`, `Optional encrypted sync`,
`127.0.0.1 MCP`. Avoid implying absolute security; include a link to the
README security model.

### 07. Releases: `Shipping in public.`

Use a concise version rail inspired by the reference, not its extremely long
changelog rendering:

- Current version header and release date fetched from a static `site-data.js`
  object during this vanilla phase.
- 4-6 highlighted changes from v0.1.6.
- Categories such as Added, Improved, Fixed.
- Link to the complete GitHub release and all releases.

Static data avoids a runtime API dependency. A future enhancement can fetch the
GitHub releases API with a cached fallback.

### 08. FAQ: `Questions before you connect a server.`

Accordion questions:

- Does DeployerX require an account?
- Which operating systems can run DeployerX?
- Can it manage both Linux and Windows hosts?
- Is cloud sync required?
- How are synchronized secrets protected?
- What is the difference between the setup and portable downloads?
- Why might Windows SmartScreen show a warning?
- Is DeployerX open source? (Answer must reflect the actual license state at
  publication time.)

Only one answer needs to be open at a time. Use buttons and associated answer
regions; preserve content without JavaScript by keeping answers readable when
the `js` class is absent.

### 09. Community and open development: `Built in the open.`

This section must use the legal status current at publication time.

- Explain how to file focused bug reports and feature requests.
- Provide `View source`, `Report an issue`, and `Read contributing guide` links.
- Use a compact contribution panel for code, documentation, testing, and issue
  reports.
- Do not claim an MIT license or unrestricted redistribution until the project
  has an actual license.

### Final CTA and footer

Final CTA:

- Headline: `Bring daily server operations into one workspace.`
- Copy: `Download DeployerX for Windows, or inspect and run the project from
  source.`
- Buttons: `Download latest` and `View on GitHub`.

Footer columns:

- Product: Releases, README, Run from source.
- Project: GitHub, Issues, Contributing.
- Legal: License (only when available), third-party notices, security note.
- Attribution: `Created and maintained by Manish K.`

## 4. Responsive specification

Use content-driven CSS breakpoints rather than device names:

- Above 1200px: 1,280px maximum container, two-column hero, four capability
  columns, full workspace table.
- 900-1199px: reduce hero type, use a 55/45 hero split, capability grid becomes
  2x2, technology grid becomes four columns.
- 640-899px: single-column hero with screenshot below copy, two-column secondary
  grids, compact menu utilities.
- Below 640px: 20px page gutters, 71px header, stacked CTAs, one-column lists,
  hidden nonessential hero decoration, horizontally scrollable matrix, 44px
  minimum interactive targets.

Fixed-format UI must not shift as content changes:

- Theme/menu icon buttons: 40x40px.
- Status icons: 32x32px.
- Segmented tabs: stable minimum widths.
- Hero screenshot: fixed 16:9 aspect ratio with `object-fit: cover` and a
  deliberate `object-position`.
- Tables and code blocks: explicit overflow behavior.

Test at minimum: 390x844, 768x1024, 1280x800, and 1920x1080. Verify that no
text overlaps, no focus ring is clipped, and the screenshot remains meaningful.

## 5. Vanilla implementation structure

Planned files:

```text
landing-page/
|-- PLAN.md
|-- index.html
|-- css/
|   |-- tokens.css       Theme variables, type scale, spacing
|   |-- base.css         Reset, semantics, typography, accessibility
|   |-- components.css   Header, buttons, panels, table, accordion
|   `-- responsive.css   Content-driven breakpoint overrides
|-- js/
|   |-- site-data.js     Release, capabilities, FAQ, and URLs
|   `-- main.js          Menu, theme, tabs, copy, reveal, accordion
`-- assets/
    |-- deployerx-logo.png
    `-- deployerx-command-center.png
```

Asset files should be copied from the existing project assets when
implementation begins, so the landing page folder can be deployed independently.
Do not hotlink application screenshots or use OpenWA imagery.

JavaScript responsibilities:

- Add `.js` to the root early so progressive-enhancement states are safe.
- Theme preference: `localStorage` -> system preference -> dark default.
- Menu focus trap, Escape close, click-outside close, and scroll lock.
- Segmented control with `role=tablist`, arrow-key navigation, and associated
  panels.
- Clipboard copy with a live-region success message and fallback selection.
- Accordion state and ARIA synchronization.
- IntersectionObserver reveals; immediate rendering without observer support.
- Optional header scrolled state via a passive scroll listener.

## 6. Accessibility, performance, and SEO

Accessibility acceptance criteria:

- Skip link, landmark elements, one H1, sequential headings.
- All icon buttons have names and tooltips.
- Visible `:focus-visible` styles with at least 3:1 contrast.
- Text contrast meets WCAG AA in both themes.
- Menu, tabs, table, copy control, and accordions work with keyboard only.
- `prefers-reduced-motion` removes transforms and smooth scrolling.
- Screenshot alt text describes the visible product state; decorative grid and
  embellishments are hidden from assistive technology.
- Status is never communicated by color alone.

Performance acceptance criteria:

- No framework or client-side rendering dependency.
- CSS and JS loaded as static files; JS uses `defer`.
- Hero screenshot exported as responsive WebP/AVIF plus PNG fallback during
  implementation.
- Explicit image dimensions prevent layout shift.
- Only the hero image is eager/high priority; below-fold visuals are lazy.
- Target Lighthouse scores: Performance >= 90, Accessibility >= 95, Best
  Practices >= 95, SEO >= 95 on a production-like static server.

SEO metadata:

- Title: `DeployerX - Server Operations, Deployment and Monitoring`.
- Description: `A local-first Windows workspace for SSH, SFTP, deployments,
  uptime monitoring, backups, and remote server administration.`
- Canonical URL set only when the deployment domain is known.
- Open Graph/Twitter image should be a purpose-cropped command-center preview.
- Add `SoftwareApplication` JSON-LD with Windows as the operating system; use
  accurate license and price fields only after they are legally established.

## 7. Implementation sequence

1. Resolve publication facts: license wording, canonical domain, and whether the
   latest release or a specific asset is the primary CTA.
2. Copy and optimize authentic logo/screenshot assets into `landing-page/assets`.
3. Build semantic `index.html` with all content visible without JavaScript.
4. Establish dark/light tokens and base typography, then build the header and
   hero to match the reference's hierarchy.
5. Implement numbered content sections using unframed grids and only the
   necessary data panels.
6. Add menu, theme, tabs, copy, reveal, and FAQ behavior in `main.js`.
7. Complete responsive rules and test the four target viewports.
8. Run HTML/CSS validation, keyboard testing, console checks, link checks, and
   Lighthouse/accessibility audits.
9. Compare screenshots at desktop and mobile against this specification and
   correct spacing, overflow, contrast, and interaction regressions.

## 8. Definition of done

The landing page is complete when:

- The first viewport clearly communicates DeployerX, Windows, local-first
  operation, and its main server workflows.
- Every product claim is traceable to the README or an approved project source.
- The visual quality and information density are comparable to OpenWA while the
  result is unmistakably DeployerX.
- All requested capabilities are represented: multiple hosts, saved deployment
  commands/templates where supported, SSH/SFTP, monitoring, uptime, backups,
  optional sync, and source availability/open-source status.
- It runs as a static HTML/CSS/JS site with no framework.
- It works across the specified viewports, both themes, keyboard navigation,
  reduced motion, and JavaScript-disabled fallback.
- The implementation remains isolated inside `landing-page/`.
