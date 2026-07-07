# UI Improvement Roadmap

Status: proposed
Scope: frontend UX/UI only. Secure login is intentionally parked for a later phase.

## Current UI Snapshot

The application has a small Angular frontend with four visible areas:

- Login
- Main layout with sidebar/header
- Dashboard
- Emails
- Customers

The backend already exposes more operational capabilities than the UI currently surfaces:

- imports: CSV, JSON pages, WooCommerce, import jobs
- verification: start, start by selected IDs, queue stats, pause, resume, clear completed, recent verification history
- Gmail: OAuth status, scan variants, queue jobs, scan progress
- emails/customers: analytics, pagination, filtering, detail endpoints

This means the UI should evolve from "lists plus analytics" into an operational console.

## What Is Good

- The app is compact and understandable. There are few frontend modules, so larger UI improvements are still cheap to make.
- Main flows already have server-side pagination and filters, which is the right base for large datasets.
- Emails and Customers pages already expose useful analytics and status metrics.
- The Emails table has sticky headers and horizontal overflow, useful for dense operational data.
- Gmail scan progress already exists as a live SSE component.
- Auth guard and API interceptor are in place, so protected pages already have a common access boundary.

## Main UI Problems

### 1. The Dashboard Is Not Yet A Workbench

Current dashboard shows only total/status cards. It does not answer:

- What needs my attention now?
- Are imports or scans running?
- Is the verification queue healthy?
- What failed recently?
- Which action should I take next?

Recommendation: rebuild dashboard as an operations cockpit with:

- queue health: waiting, active, completed, failed
- pending verification count and quick action to start verification
- recent import jobs with status
- Gmail connection and scan status
- recent verification failures
- deliverability snapshot
- top action cards: Import, Verify Pending, Scan Gmail, Review Risky

### 2. Emails Page Is Too Dense

Emails currently combines:

- analytics overview
- status breakdown
- top domains
- quality distribution
- providers
- risk assessment
- deliverability
- filters
- table
- row actions

All of this lives in one long page. It is useful data, but the hierarchy is weak.

Recommendation: split Emails into a tabbed workspace:

- List: table, filters, bulk selection, row actions
- Analytics: status, quality, providers, deliverability
- Risk Review: risky/disposable/role-based/unsubscribed segments
- Jobs: verification jobs and Gmail scan jobs related to emails

### 3. Customers Page Duplicates Emails Patterns

Customers repeats a lot of Emails UI and CSS. It has analytics, filters, table, pagination, but no customer detail workflow.

Recommendation:

- Add customer detail drawer or page.
- Show linked domains and related emails from existing endpoints.
- Add domain/country/city filters consistently.
- Add "data completeness" as a triage workflow, not just metrics.

### 4. Import And Verification Routes Are Placeholders

The sidebar shows Import and Verification, but both routes currently point to Dashboard.

This is a product gap because backend functionality already exists.

Recommendation:

- Build Import page:
  - start CSV import
  - start JSON pages import
  - start WooCommerce import
  - show import jobs table
  - show progress, result counts, errors
- Build Verification page:
  - start pending verification
  - test single email
  - verify selected emails
  - queue stats
  - pause/resume/clear queue
  - recent verification history

### 5. No Shared Design System

The UI currently mixes:

- Tailwind utility classes in Login and Gmail progress
- large per-page SCSS files elsewhere
- duplicated page headers, cards, filters, tables, pagination, loading and empty states
- repeated color values and gradients

This increases bundle size and makes visual consistency fragile.

Recommendation: create shared UI primitives:

- `PageHeader`
- `MetricCard`
- `StatusBadge`
- `Toolbar`
- `FilterField`
- `DataTable`
- `Pagination`
- `EmptyState`
- `LoadingState`
- `ConfirmDialog`
- `Toast`

Also introduce design tokens in global styles:

- colors
- spacing
- radius
- shadows
- focus rings
- status colors

### 6. Tables Need Operational Features

Current tables show data but do not support serious workflows.

Recommendation:

- Add row selection.
- Add bulk actions: verify selected, mark risky, unsubscribe.
- Add persisted table density: compact/comfortable.
- Add sortable columns on Emails too, not only Customers.
- Add visible active filter chips and a clear filters action.
- Add copy email/domain/customer ID actions.
- Add detail drawer for quick inspection without losing table position.

### 7. Error And Empty States Are Too Thin

Errors mostly go to `console.error`. Users only see generic loading/empty states.

Recommendation:

- Show inline error banners for failed API calls.
- Add retry actions.
- Distinguish "no data yet" from "no results for filters".
- Use toasts for successful actions.
- Replace browser `confirm()` and `alert()` with app dialogs/toasts.

### 8. Accessibility Needs A Pass

Current gaps:

- icon buttons without `aria-label`
- clickable table headers should be buttons or have keyboard semantics
- live Gmail progress should use an accessible live region
- focus states are inconsistent
- some status is communicated by color/symbol only
- custom controls lack consistent labels

Recommendation:

- Add labels and keyboard support.
- Use `aria-live` for long-running scan/progress updates.
- Add visible focus states to all interactive elements.
- Ensure status badges include text and not only color.

### 9. Responsive UI Is Basic

Mobile CSS exists, but dense tables remain difficult to use.

Recommendation:

- Keep desktop as dense table.
- On mobile/tablet, switch rows to compact record cards or a horizontal table with frozen primary column.
- Make sidebar an overlay drawer on small screens.
- Collapse analytics into sections/tabs instead of one vertical stack.

### 10. Frontend Performance And Maintainability

Known issue: production build warns that `emails.component.scss` exceeds the 10 kB component style budget.

Root causes:

- analytics, table, badges, filters, pagination, responsive styles all live in one component stylesheet
- duplicated CSS between Emails and Customers
- gradients/shadows/hover effects are repeated heavily

Recommendation:

- Extract shared table/card/filter styles.
- Remove decorative hover transforms from dense tables.
- Use shared status classes.
- Add `trackBy` functions for large `ngFor` lists.
- Consider OnPush change detection for data-heavy pages after shared state is cleaner.

## Proposed Implementation Phases

### Phase 1: UI Foundation

Goal: create consistency and reduce CSS duplication before adding more screens.

- Add design tokens in `styles.scss`.
- Create shared primitives for page header, metric cards, badges, loading, empty, pagination and table shell.
- Refactor Emails and Customers to use shared styles.
- Fix CSS budget warning.
- Add app-level toast and confirm dialog patterns.

Expected impact:

- More consistent UI
- Smaller component styles
- Easier future feature work
- Better action feedback

### Phase 2: Emails Workspace

Goal: turn Emails into the main triage area.

- Split page into tabs: List, Analytics, Risk Review, Jobs.
- Add row selection and bulk actions.
- Add active filter chips and clear filters.
- Add email detail drawer.
- Add sortable columns and score filters.
- Replace `confirm()`/`alert()` with dialog/toast.

Expected impact:

- Faster review workflows
- Less cognitive load
- Safer destructive/status-changing actions

### Phase 3: Operational Pages

Goal: expose existing backend capabilities.

- Build Import page from existing import endpoints.
- Build Verification page from existing verification endpoints.
- Replace sidebar placeholder routes.
- Add queue controls and job history.
- Connect Gmail status/scan jobs into a visible operations area.

Expected impact:

- Admin can operate the system without manual API calls
- Backend capabilities become product features
- Fewer blind spots during imports/scans/verifications

### Phase 4: Customers CRM View

Goal: make Customers useful for review, not only listing.

- Add customer detail drawer/page.
- Show related domains and related emails.
- Add domain/country/city filters.
- Add completeness review mode.
- Add quick copy/contact actions.

Expected impact:

- Customers page becomes a lightweight CRM console
- Easier investigation of email/customer linkage quality

### Phase 5: Polish, Accessibility, Responsive

Goal: make the app feel robust under real daily use.

- Full keyboard/focus pass.
- Accessible live regions for progress.
- Mobile sidebar overlay.
- Mobile record-card tables where needed.
- More useful empty/error states.
- Loading skeletons for data-heavy views.

## Recommended Next Step

Start with Phase 1.

Do not build new Import/Verification screens before the UI foundation, because those screens would otherwise duplicate the same table/card/filter/loading patterns again.

Suggested first implementation batch:

1. Add global design tokens and shared utility classes.
2. Refactor Emails and Customers CSS into common page/table/card/filter primitives.
3. Add reusable toast/confirm UI.
4. Replace `confirm()` and `alert()` in Emails.
5. Rebuild the page headers and analytics cards consistently.
6. Verify build and ensure the component CSS warning is gone or materially reduced.
