# Settings UI Guide

Reference: Users & Permissions redesign, source inspected on 2026-09-15.

## Purpose and scope

Use the current Users & Permissions interface as the reference when updating other DeployerX settings pages. Keep the established application theme, navigation, controls, and interaction patterns. This is a reusable implementation guide, not a request to redesign every settings page immediately.

This document describes the current source implementation and identifies checks required when applying it elsewhere. It does not certify the installed application's appearance, production permissions, email delivery, or backend behavior.

## Source of truth

Paths below are relative to the project root. Search for the named selectors or functions rather than relying on line numbers.

| Source | Reference to inspect |
| --- | --- |
| `src/renderer/index.html` | `#settingsMembersPanel`, `#workspaceInvitesModal`, `#addWorkspaceUserModal` |
| `src/renderer/styles.css` | `.workspace-users-table-card`, `.workspace-table-heading`, `.workspace-user-modal-*`, `.workspace-user-fields`, `.workspace-access-editor-*` |
| `src/renderer/renderer.js` | Member table rendering; `openWorkspaceInvitesModal`, `setWorkspaceInvitesTab`, `openAddWorkspaceUserModal`, `setAddWorkspaceUserStep`, `bindMemberAccessTabs`, `updateMemberAccess` |
| `scripts/check-workspace-access-ui.cjs` | Isolated rendering and interaction checks for the member editor |

The implementation is Electron with HTML, CSS, and JavaScript. Do not introduce a component framework, new icon library, or token-generation tool just to reproduce this design.

## 1. Page structure

Keep the settings sidebar and existing application header unchanged. Inside the selected settings panel, use this hierarchy:

```text
Page header: title + optional short description       Secondary action / Primary action
Conditional access or error notice
Main table card
  Compact heading: table title                                      Count badge
  Column headings
  Data rows and contextual row editor
  Remaining table surface

Secondary lists: opened in a dialog, not permanently stacked around the table
```

- Put one primary action at the upper right. Users & Permissions uses **Add User**.
- Put related secondary actions beside it. **Invites** is an outline button with a count badge.
- Keep page title and description margins at zero, with a 4px gap before the description.
- Page header actions use an 8px gap and wrap when needed; the header uses a 16px gap.
- Show access notices only when relevant. Hidden notices must not leave empty spacing.
- Preserve the login gate and permission-based availability of controls.
- Use a full-height table pattern for list-management pages. Do not force a simple settings form into a table merely for consistency.

## 2. Compact table heading and full-height body

The table card must fill the available page area without stretching its title, column headings, or data rows.

Current reference rules:

```css
.workspace-users-table-card {
  display: grid;
  min-height: 420px;
  flex: 1;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 0;
  overflow: hidden;
  padding: 0;
}

.workspace-table-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}

.workspace-table-heading h2 {
  margin: 0;
}

.workspace-users-table-wrap {
  min-height: 0;
  overflow: auto;
  border-top: 1px solid var(--line);
}
```

Important distinction: **blank space below the rows is intentional; extra space below the table title is not.**

- The table heading contains only the title and count badge. Do not restore “Manage roles and access from one place.”
- Remove inherited card padding and grid gaps. Do not compensate with negative margins or arbitrary spacer elements.
- Keep equal 12px top and bottom heading padding. Center the title and badge vertically.
- Keep table rows at their normal content height. Never set the table itself to `height: 100%` to fill the card.
- Reuse the existing `.uptime-table` visual treatment for column headings, dividers, and rows.
- Allow horizontal scrolling inside the table wrapper when columns genuinely need it; do not cause the whole settings page to overflow.
- The users table currently has a 1120px minimum width. Adapt column widths to the target page rather than copying six user columns blindly.
- The users panel uses `min-height: calc(100vh - var(--app-header-height) - 76px)` and a flex column. Preserve the height chain when adapting it; do not assume every settings panel has identical offsets.

## 3. Table rows and actions

The reference columns are User, Role, Modules, Servers, Status, and Actions.

- Primary identity appears above secondary text, with a 2px gap. Example: name above email.
- Use existing pills for roles and counts. Status must include text, not color alone.
- Keep action controls together with 8px gaps and consistent heights. Current compact row buttons have a minimum height of 32px.
- Keep action order consistent: **Edit, Suspend/Resume, Reset, Delete** where applicable.
- Edit and Reset use outline styling; Suspend uses warning styling; Resume uses success styling; Delete uses danger styling.
- Do not display unavailable operations as usable controls. Explain protected rows with labels such as “Owner protected”, “Your account”, or “No actions allowed”.
- Preserve existing authorization, confirmation, and loading behavior. A visual change must not change who can perform an action.
- For users, Delete removes workspace membership; do not silently reinterpret it as deleting the global authentication account.
- Provide meaningful empty and error states instead of an unexplained blank list.

## 4. Secondary lists belong in a dialog

Incoming and outgoing invitations no longer occupy separate cards above and below the users table.

The **Invites** button opens one dialog with:

- A title, brief context, and a close control.
- Two tabs: **Sent to me** and **You sent**.
- One visible panel at a time, each with its own empty state and permitted actions.
- A footer with **Done**.

Reference dimensions: width `min(720px, calc(100vw - 32px))`; minimum height `min(520px, calc(100vh - 48px))`. The layout separates header, tabs, scrollable content, and footer.

Use the same pattern for secondary history, requests, or related records on other settings pages. Rename the tabs to match the feature. Do not add an empty dialog merely to imitate Invites.

## 5. Add/create flow: multi-step dialog

Use a wizard when setup contains genuinely separate decisions. Keep short forms as a single step.

The Add User flow is:

| Step | Content | Reusable principle |
| --- | --- | --- |
| Method | Invite user or Create user selection cards | Choose the workflow before showing conditional fields |
| Details | Email; name and temporary password for Create user | Show only fields relevant to the chosen method |
| Access | Role, permissions, module scope, server scope, blocked commands | Group related configuration and retain safety explanations |
| Review | Method, identity, role, permission count, module/server summary | Confirm the result before submitting; never display passwords |

Dialog shell:

- Width: `min(940px, calc(100vw - 32px))`.
- Height: `min(680px, calc(100vh - 48px))`.
- Grid rows: header, shrinkable main content, footer.
- Desktop main columns: 220px step rail and `minmax(0, 1fr)` content.
- Header: 42px icon tile, title area, 36px close control; 12px gap and `18px 20px` padding.
- Main content: `28px 30px 32px` padding; scroll the content, not the footer.
- Step content: maximum width 650px, 22px section gap.
- Footer: minimum height 66px, `12px 20px` padding; buttons at least 40px high.
- Cancel stays left. Back and Continue stay right. The final step replaces Continue with the specific submit action, such as Create User or Send Invite.

Keep the shell stable when changing steps. Preserve entered values during Back/Continue navigation. Validate before advancing and keep the dialog open on submission failure. Show loading feedback and prevent duplicate submissions.

## 6. Form alignment: do not regress

The Name and Temporary password misalignment came from field layout behavior when only one field had helper text. Do not fix this by adding blank helper text to the other field.

Reuse the structural fix:

```css
.workspace-user-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.workspace-user-fields > .field {
  align-self: start;
  align-content: start;
}

.workspace-user-email-field {
  grid-column: 1 / -1;
}
```

- Put each label, input, and optional helper inside the same `.field` container.
- Top-align field contents, even when neighboring helpers wrap onto different numbers of lines.
- Keep control heights and label-to-input gaps consistent by reusing shared input styles.
- Use `minmax(0, 1fr)` and `min-width: 0` where content must shrink.
- Apply `align-content: start` to fieldsets and grouped options too; do not distribute short content through an oversized grid.
- Check every wizard step, including validation errors, long labels, and conditional fields. Checking Details alone is insufficient.

## 7. Edit flow: bounded tabbed editor

The member editor remains contextual to its table row, but no longer presents every access control in one giant uninterrupted form.

- Open only one row editor at a time.
- Header: “User access”, the target name, and a role selector.
- Tabs: **Permissions**, **Modules & servers**, **Command restrictions**.
- Scrollable body: 340px height, 20px padding, stable scrollbar gutter.
- Footer outside the scrolling body: “Changes apply after saving”, Cancel, Save changes; `12px 20px` padding.
- Cancel discards the draft, closes the editor, and restores focus to Edit.
- Changing tabs must not reset values. Saving must read controls from all panels, including currently hidden panels.

Permissions use four bordered cards on wide containers, two at a container width of 1000px or less, and one at 540px or less. Cards stretch to equal height while their contents stay top-aligned.

Modules and servers use two matched fieldsets. Each has an All option and a bounded selection list. In the editor, lists are 170px high. Preserve the distinction between all items, selected items, and no items; an empty selection must not become unrestricted access.

The command textarea is 132px high with a 96px minimum and monospace text. Keep the exact-match and interactive-shell warning. Do not present a saved-command block list as a complete shell security boundary.

## 8. Theme and component reuse

Reuse existing semantic CSS variables instead of copying screenshot colors:

| Purpose | Existing variables |
| --- | --- |
| Page and surfaces | `--bg`, `--surface`, `--surface-subtle`, `--control-bg` |
| Text and dividers | `--ink`, `--muted`, `--line` |
| Selection and focus | `--accent`, `--primary-soft`, `--focus` |
| Status | `--success`, `--warning`, `--danger` |
| Fonts and layout | `--font-sans`, `--font-mono` where available, `--app-header-height` |

The application uses DM Sans. Preserve its existing typography hierarchy and SVG icon system. Reuse `.button`, `.icon-button`, `.field`, `.field-note`, `.modal`, and `.modal-card` before adding feature-specific rules.

Common reference measurements: 8px action gaps; 12px scope/card gaps; 16px field gaps; 8px control/fieldset corners; 12px editor and selection-card corners. These are existing component values, not a requirement to rebuild the token architecture.

Keep styles scoped. Users-specific selectors are references, not universal bindings: do not duplicate IDs or reuse handlers tied to member records on unrelated settings pages. Extract shared styling only when an actual second use needs it.

## 9. Responsive behavior and accessibility

Current responsive behavior:

- At 760px viewport width or less, the wizard step rail becomes a horizontal four-step strip; field, method, and scope grids become one column.
- The page header stacks and header action buttons share available width.
- At 520px or less, the wizard header icon and step descriptions/labels are visually removed to save space; retain the visible step heading and accessible progress context.
- The row editor uses its own container breakpoints, separate from viewport breakpoints.

Required checks when reusing these patterns:

- Dialogs have accessible names, modal semantics, keyboard containment, a close path, and focus restoration.
- Tabs expose `tablist`, `tab`, `tabpanel`, `aria-selected`, and matching IDs. Support arrow keys and Home/End as in `bindMemberAccessTabs`.
- Inputs have real labels. Errors remain understandable and focusable; never rely solely on a transient toast.
- Icon-only controls have accessible names; decorative SVGs are hidden from assistive technology.
- Focus indicators remain visible. Selection, disabled, pending, and error states are distinguishable without color alone.
- Check actual theme contrast, text scaling, long content, and short windows. Do not assume existing CSS proves accessibility compliance.

## 10. Applying this guide to another settings page

1. Read the target panel and its immediate event handlers. Identify which patterns it needs: list, simple form, wizard, secondary dialog, or contextual editor.
2. Preserve its data model, authorization, validation, and save behavior.
3. Apply the compact header and consistent action placement. Remove redundant table descriptions and inherited spacing.
4. Reuse existing controls and theme tokens. Add only scoped differences required by the feature.
5. Give long content a deliberate scrolling region. Keep essential actions reachable.
6. Verify visual and interaction states below before calling the page complete.

### Acceptance checklist

- [ ] Title and badge are vertically centered with equal top/bottom heading padding.
- [ ] No redundant table description or unexplained gap before column headings.
- [ ] The card fills available height without stretching rows.
- [ ] Empty, one-row, many-row, loading, and error states remain usable.
- [ ] Long names, emails, labels, and validation messages do not break alignment.
- [ ] Every wizard step and both workflow variants have been inspected.
- [ ] Tab changes retain draft values; Back retains inputs; Cancel restores saved state.
- [ ] Submit includes inactive-panel values and prevents duplicate requests.
- [ ] Footer actions remain reachable at shorter window heights and increased text scale.
- [ ] Permission-restricted and protected records cannot invoke unauthorized operations.
- [ ] Keyboard interaction, focus restoration, and theme contrast have been checked.
- [ ] Screenshots come from the current source/runtime, not an older running application.

The existing `scripts/check-workspace-access-ui.cjs` checks the actual member editor at 1600px and 1200px widths with an isolated renderer. It covers tab visibility, layout overflow, footer placement, and editing interactions. It does not validate every settings page, every wizard step, or live backend permissions. Extend focused checks for the target feature as needed.

Do not run Python, development servers, or build commands for this workflow. Use permitted targeted checks and inspect the actual rendered result. Source edits, isolated UI tests, and a running installed application are separate verification stages.

### Settings rollout reference

The nine additional settings pages now opt into shared styling through `.settings-guide` in `index.html` and the shared settings section at the end of `styles.css`.

| Page | Applied pattern |
| --- | --- |
| Groups | Full-height list card with Server groups / Monitor groups tabs and contextual create actions |
| Workspace | Page-level create action, aligned details grid, separate danger section |
| Notifications | Full-height destination card; delivery history opens in a dialog |
| Monitoring | Compact service heading, grouped controls/retention, separate save footer |
| Backup & Restore | Grouped operation rows; account history opens in a dialog |
| Templates | Compact list/editor headings, bounded scrolling, persistent editor footer |
| Integrations | Consistent connection sections and expandable documentation |
| Theme | Separate page header, compact Appearance heading, responsive selection cards |
| About | Consistent product, update, and company sections |

`src/renderer/settings-ui.js` contains only presentation behavior for group tabs and history dialogs. Existing data operations stay in `renderer.js`. `scripts/check-settings-ui.cjs` renders current markup/styles with synthetic data in hidden, isolated Electron windows. It does not start the application backend or make network requests.

Run `node scripts/check-settings-ui.cjs all` for the complete UI check, or replace `all` with a page key from the table (`backup` for Backup & Restore). Screenshots are written under the system temporary directory in `deployerx-settings-ui-preview`. The check covers three viewport widths, two themes, original control IDs, group tabs, history dialogs, relevant form layouts, notification channels, and theme selection. It is not an end-to-end test of live account actions.

### Reusable implementation request

> Apply SETTINGS_UI_GUIDE.md to Settings > [page name]. Match the Users & Permissions compact table heading, action placement, theme, aligned fields, and appropriate dialog/editor pattern. Preserve existing behavior and permissions. Do not copy user-specific IDs or add unnecessary components. Check all relevant states and identify what was actually verified. Do not run Python, development servers, or build commands.
# Large workspace access pickers

- Reuse `renderWorkspaceScopeInputs` in add-user and edit-user flows. Show the full module catalog without an inner scroll, including Uptime and Backup Manager.
- Server selection uses name/ID search, a selected/total count, Select results, Clear selection, and a bounded scrollable results list. Search hides rows without rebuilding selections.
- All access includes future items (`['*']`). Explicit empty selection (`[]`) means no access. Keep module visibility separate from operation permissions.
- Preserve assigned IDs missing from the current catalog and label them unavailable; never silently remove access while saving unrelated changes.
- Verify with `node scripts/check-workspace-scope-ui.cjs`. This uses 100 fixture servers and real UI helpers without starting the application backend or contacting cloud services.
