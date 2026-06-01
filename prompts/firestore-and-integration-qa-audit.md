# Firestore & Integration QA Audit Prompt

Copy everything below the line into Cursor (Agent mode) when you want a ruthless pass over the gym management codebase. Use after new features ship, before thesis defense, or when something "looks fine" but data doesn't load.

---

## PROMPT (copy from here)

Act as a **Principal Firebase Architect** and **senior QA engineer** auditing a live gym management system (HTML dashboards + vanilla JS + Firestore). Your job is to find bugs that **static code review misses** — especially failures that only appear against a real Firebase project.

**Do not give generic advice.** Scan the actual codebase, cite file paths and line numbers, and produce a findings table with severity (Critical / High / Medium / Low). For each finding: what's broken, why QA would miss it, and the exact fix.

---

### 1. FIRESTORE QUERY & INDEX FAILURES (highest priority)

Hunt every `query()`, `getDocs()`, `getDoc()`, and `onSnapshot()` call in `js/**/*.js`.

Flag any compound query that combines:
- `where()` on field A **and** `orderBy()` on field B (different fields)
- Multiple inequality/range filters on different fields
- Subcollection queries with multiple filters + sort

For each flagged query, report:
- Collection name
- Whether `firestore.indexes.json` exists and defines the index (this repo may not have one — treat missing index config as **High** risk)
- Whether the code has a **client-side sort fallback** if the index is missing
- Whether errors surface a useful message (e.g. "index required" + console link) or a vague "Failed to load" that hides the root cause

**Mandatory live-test scenarios** (describe how to verify manually; flag if no automated test exists):
1. Open modal/panel → data list loads (not just summary stats from cache)
2. Save/write → **close → reopen** → persisted data still appears
3. Empty state vs error state are distinct (no records ≠ failed fetch)
4. Browser console shows no `failed-precondition` or "requires an index"

Known prior miss: `maintenanceLogs` used `where("equipmentId")` + `orderBy("timestamp")` — writes worked, reads failed. Always test the **read path** separately from the write path.

---

### 2. READ vs WRITE ASYMMETRY

For every feature with both create and list/load:

| Check | Pass criteria |
|-------|---------------|
| Write path | `addDoc` / `setDoc` / `updateDoc` succeeds |
| Read path | Separate query/listener succeeds **independently** |
| Reopen test | Data survives modal close + page refresh |
| Cache vs fetch | UI doesn't mark "pass" because cached `*Data` arrays show summary while Firestore fetch failed |

Flag any UI that shows partial success: header stats from local cache + failed list fetch in the body.

---

### 3. FIRESTORE TRANSACTION FATALITIES

Scan every `runTransaction()` in the codebase.

**Enforce read-before-write:**
- No `transaction.get()` after `transaction.set()` / `transaction.update()` / `transaction.delete()` in the same callback
- No `await` network calls inside the transaction (e.g. `syncServerTimeOffset`, fetch, setTimeout)
- All reads hoisted to Phase 1; all writes in Phase 2+

Report violations with function name and line number. Cross-reference `js/inventory-checkout.js` batch FEFO query — same index-risk pattern.

---

### 4. CONCURRENCY & DOUBLE-SUBMIT

Hunt for async handlers (form submit, delete, booking, POS checkout, RFID) missing:
- In-flight guard (`_xxxInFlight`, `btn.disabled`, early return)
- `finally` block that re-enables buttons on failure
- Idempotency on hardware paths (RFID double-scan)

Simulate: rapid double-click, two tabs editing same record, save while listener is updating.

---

### 5. SAD-PATH UI RECOVERY

For every `try/catch` around Firestore calls, verify:
- Button/spinner state restored in `finally`
- User sees actionable error (not silent console-only)
- Empty catch blocks or generic "Failed to load" without logging `err.code` / `err.message`

Search for: `Failed to load`, `mp-empty-state`, `.catch(()`, `catch (e) {` with no user feedback.

---

### 6. MODAL & PARTIAL-RENDER TRAPS

For every modal opened by `window.open*Modal` or `style.display = 'flex'`:
- Does it fetch async data after opening?
- Can QA falsely pass by checking only: modal visible, title correct, form present?
- List the **async region** (table, list, chart) that must be explicitly tested

Include: maintenance logbook, edit equipment, booking modals, POS, batch/inventory modals, chat/messages.

---

### 7. SECURITY & RBAC BYPASS

Functions exposed on `window.*` must re-check role inside the function, not rely on hidden UI buttons alone.

Search for: `window.delete`, `window.save`, `window.approve`, admin-only flows callable from console.

Verify `localStorage` role checks are consistent (case: admin vs Admin).

---

### 8. DATA INTEGRITY & ORPHAN RISK

- Deletes that don't cascade related docs (bookings, logs, batches, messages)
- Updates that desync two collections (e.g. equipment `maintenanceCount` vs `maintenanceLogs` entries)
- Missing validation on foreign keys (trainerId, memberId, equipmentId) inside transactions

---

### 9. AUTOMATED TEST COVERAGE GAPS

Review `test_member.js`, `test_member_dashboard.py`, and any other tests.

List critical user flows with **zero** automated coverage, prioritized:
1. Admin inventory + maintenance log
2. Firestore compound queries
3. POS / payments / void
4. Booking create / cancel / late-cancel credit rules
5. RFID check-in

Recommend minimal Puppeteer or integration test stubs for top 3 gaps (file + selector + assertion only — no full implementation unless asked).

---

### 10. OUTPUT FORMAT (required)

```markdown
## Executive summary
- X Critical, Y High, Z Medium findings
- Top 3 items that would fail in a live demo

## Findings

| ID | Severity | Area | Location | Issue | Why QA missed it | Fix |
|----|----------|------|----------|-------|------------------|-----|
| F-01 | Critical | Firestore index | js/script.js:1312 | ... | ... | ... |

## Live verification checklist
- [ ] Feature: ... Steps: ... Expected: ...

## Query audit table
| File | Collection | Filters | OrderBy | Index risk | Has fallback |
|------|------------|---------|---------|------------|--------------|

## Recommended patches (ordered by severity)
1. ...
```

After the report, **apply fixes for all Critical and High items** unless I say "report only."

---

## PROMPT (copy ends here)

---

## Quick use

| When | How |
|------|-----|
| New Firestore feature | Paste prompt + "Focus on `[feature name]` and related queries in `js/script.js`" |
| Pre-defense | Paste prompt + "Full codebase scan; report only first, then patch Critical/High" |
| Bug triage | Paste prompt + "Investigate `[modal/screen]` — user sees `[symptom]`" |

## Example follow-ups

- "Run section 1 and 6 only on maintenance log and inventory batches."
- "Run section 3 and produce a read-after-write violation script like the prior audit."
- "Add Puppeteer test for maintenance log reopen per section 9."
