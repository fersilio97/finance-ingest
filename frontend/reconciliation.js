// Two API base paths live on this page (feature 013): the reconciliation
// endpoint is mounted under insights.py's router, balance-entries/sources
// under routes.py's plain "/api" router. Renamed from this file's original
// single `API` constant so both can coexist — see docs/features/013 for why
// a naive line-for-line copy of the balance-entries code would have collided.
const INSIGHTS_API = "/api/insights";
const API = "/api";

// jsonFetch() upgraded from GET-only to app.js's fuller version (feature
// 013) — the moved balance-entries code needs POST/DELETE and server-side
// JSON `detail` extraction on error. Backward-compatible with the one
// pre-existing caller below (renderReconciliationList(), no second arg).
async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      /* not JSON, keep statusText */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? res.json() : null;
}

function skeletonRows(tbody, cols, rows = 3) {
  tbody.innerHTML = Array.from({ length: rows })
    .map(() => `<tr>${`<td><div class="skeleton"></div></td>`.repeat(cols)}</tr>`)
    .join("");
}

function setEmpty(el, show, text) {
  el.hidden = !show;
  if (show) el.textContent = text;
}

// "2025-01-21T12:00:00" -> "2025-01-21 12:00" for compact display; the raw
// value is still available via the caller's own `title`. Duplicated from
// app.js/insights.js on purpose (see feature 008's implementation notes) —
// this is a classic script, not a module, and this is 4 lines.
function formatRecordedAt(iso) {
  const [datePart, timePart = ""] = iso.split("T");
  const hhmm = timePart.slice(0, 5);
  return hhmm ? `${datePart} ${hhmm}` : datePart;
}

/* ==========================================================================
   Reconciliation — spec 003's tri-state visual language, per-entry (008)
   ========================================================================== */

const STATE_LABEL = { not_checked: "Not checked", balanced: "Balanced", off: "Off by" };
const STATE_ORDER = { off: 0, not_checked: 1, balanced: 2 }; // differences first, then unknowns, then the quiet green tail

function money(v) {
  return v != null ? v.toFixed(2) : "—";
}

function reconciliationSummary(rows) {
  const summaryEl = document.getElementById("reconciliation-summary");
  const offCount = rows.filter((r) => r.status === "off").length;
  const checkedCount = rows.filter((r) => r.status !== "not_checked").length;

  summaryEl.className = "calc-summary";
  if (offCount > 0) {
    summaryEl.classList.add("negative");
    summaryEl.textContent = `${offCount} of ${rows.length} recorded balance${rows.length === 1 ? "" : "s"} ${offCount === 1 ? "is" : "are"} off.`;
  } else if (checkedCount === 0) {
    summaryEl.classList.add("muted");
    summaryEl.textContent = `${rows.length} recorded balance${rows.length === 1 ? "" : "s"} can't be checked yet — no transaction data covers them.`;
  } else if (checkedCount === rows.length) {
    summaryEl.classList.add("positive");
    summaryEl.textContent = `All ${checkedCount} recorded balance${checkedCount === 1 ? "" : "s"} reconcile.`;
  } else {
    const notChecked = rows.length - checkedCount;
    summaryEl.classList.add("positive");
    summaryEl.textContent = `All ${checkedCount} checked balances reconcile (${notChecked} not yet checkable).`;
  }
}

function buildReconciliationCard(r) {
  const card = document.createElement("div");
  card.className = `calc-card calc-state-${r.status}`;

  const identity = document.createElement("div");
  identity.className = "calc-identity";
  const when = formatRecordedAt(r.recorded_at);
  identity.textContent = `${r.account} · ${when}`;
  identity.title = `${r.account} · ${r.recorded_at}`;

  const detail = document.createElement("div");
  detail.className = "calc-detail";

  const derivedEl = document.createElement("span");
  derivedEl.className = r.derived_balance == null ? "calc-money muted" : "calc-money";
  derivedEl.textContent = money(r.derived_balance);
  derivedEl.title = "Derived from transactions, as of this entry's date";

  const recordedEl = document.createElement("span");
  recordedEl.className = "calc-money";
  recordedEl.textContent = money(r.recorded_balance);
  recordedEl.title = "What you recorded";

  const statusEl = document.createElement("span");
  statusEl.className = "calc-status";
  if (r.status === "off") {
    const sign = r.diff > 0 ? "+" : "";
    statusEl.textContent = `Off by ${sign}${r.diff.toFixed(2)}`;
  } else {
    statusEl.textContent = STATE_LABEL[r.status];
    if (r.status === "not_checked") {
      statusEl.title = "No transaction data covers this account on or before this date yet.";
    }
  }

  detail.append(derivedEl, recordedEl, statusEl);

  if (r.status === "not_checked") {
    const remedy = document.createElement("a");
    remedy.className = "calc-remedy";
    // Same-page target as of feature 013 — Balance Entries now lives below
    // this panel on reconciliation.html, not on index.html.
    remedy.href = `reconciliation.html?account=${encodeURIComponent(r.account)}#balances-section`;
    remedy.textContent = "Review in Balances →";
    detail.appendChild(remedy);
  }

  card.append(identity, detail);
  return card;
}

async function renderReconciliationList() {
  const container = document.getElementById("reconciliation-list");
  const emptyEl = document.getElementById("reconciliation-empty");
  const errorEl = document.getElementById("reconciliation-error");
  const summaryEl = document.getElementById("reconciliation-summary");

  errorEl.hidden = true;
  let rows;
  try {
    rows = await jsonFetch(`${INSIGHTS_API}/reconciliation`);
  } catch (err) {
    container.innerHTML = "";
    summaryEl.textContent = "";
    emptyEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load reconciliation — ${err.message}.`;
    return;
  }

  container.innerHTML = "";
  summaryEl.textContent = "";
  if (rows.length === 0) {
    emptyEl.hidden = false;
    emptyEl.innerHTML = "";
    const text = document.createElement("span");
    text.textContent = "No balances recorded yet — ";
    const link = document.createElement("a");
    link.className = "calc-remedy";
    // Same-page anchor as of feature 013 — no account param to preserve, and
    // the target now lives on this page, so a cross-page link isn't needed.
    link.href = "#balances-section";
    link.textContent = "record one to start reconciling.";
    emptyEl.append(text, link);
    return;
  }
  emptyEl.hidden = true;

  reconciliationSummary(rows);

  const sorted = rows.slice().sort((a, b) => STATE_ORDER[a.status] - STATE_ORDER[b.status]);
  for (const r of sorted) {
    container.appendChild(buildReconciliationCard(r));
  }
}

/* ==========================================================================
   Balance Entries (spec 008, relocated here by feature 013) — supersedes
   the minimal disclosed patch spec 007 left here. Feature 005 (backend,
   Session 2) replaced the old UNIQUE(account, month) manual_balances table
   with balance_entries, keyed by an exact ISO-8601 datetime instead of a
   month — more than one entry per account per month is legitimate (e.g.
   "checked it twice this week"). This is the full UI 005's handoff note
   asked for: a datetime-local input, an account dropdown (see
   renderAccountSelect() below for why dropdown over free text), and
   per-entry delete (there is no PUT — editing is delete-then-recreate, per
   005's own handoff note).
   ========================================================================== */

let SOURCES = [];

// Narrow, page-local loadSources() — unlike app.js's version, this page only
// needs the account dropdown populated, not drop-zones or a Rules source
// select. See docs/features/013 for why a shared loadSources() wasn't used.
async function loadSources() {
  SOURCES = await jsonFetch(`${API}/sources`);
  renderAccountSelect();
}

// Dropdown, not free text (feature 005's handoff left this an open choice —
// the API only rejects blank/whitespace account names, nothing checks the
// value against known accounts). A dropdown constrained to GET /api/sources'
// account field closes that gap client-side: a typo'd account name would
// silently create an orphan that no transaction's `account` will ever match,
// so its reconciliation row would sit at `not_checked` forever with no way
// to tell "genuinely unreconcilable" apart from "user fat-fingered the name".
function renderAccountSelect() {
  const select = document.getElementById("balance-account");
  select.innerHTML =
    `<option value="" selected disabled>Select account…</option>` +
    SOURCES.map((s) => `<option value="${s.account}">${s.account}</option>`).join("");
}

async function loadBalances() {
  const table = document.getElementById("balances-table");
  const tbody = table.querySelector("tbody");
  const emptyEl = document.getElementById("balances-empty");
  const errorEl = document.getElementById("balances-error");

  errorEl.hidden = true;
  emptyEl.hidden = true;
  table.hidden = false;
  skeletonRows(tbody, 4);

  let entries;
  try {
    entries = await jsonFetch(`${API}/balance-entries`);
  } catch (err) {
    tbody.innerHTML = "";
    table.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load balance entries — ${err.message}.`;
    return;
  }

  tbody.innerHTML = "";
  if (entries.length === 0) {
    table.hidden = true;
    // Copy fix, feature 013: the old text pointed at "the Insights page" —
    // stale even before this move (Reconciliation left Insights in feature
    // 012) and doubly wrong now that this panel sits directly under
    // Reconciliation on the same page.
    setEmpty(emptyEl, true, "No balance entries recorded yet — record one below.");
    return;
  }

  // Most-recently-recorded first — with multiple entries per account per
  // month now legitimate (the whole point of 005), a plain API-order list
  // (account, then recorded_at ascending) buries what the user just added
  // at the bottom every time.
  const sorted = entries.slice().sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
  for (const b of sorted) {
    tbody.appendChild(renderBalanceRow(b));
  }
}

function renderBalanceRow(entry) {
  const tr = document.createElement("tr");
  tr.innerHTML =
    `<td data-cell="account"></td><td data-cell="recorded"></td>` +
    `<td class="num" data-cell="balance"></td><td data-cell="actions"></td>`;
  tr.querySelector('[data-cell="account"]').textContent = entry.account;
  const recordedCell = tr.querySelector('[data-cell="recorded"]');
  recordedCell.textContent = formatRecordedAt(entry.recorded_at);
  recordedCell.title = entry.recorded_at;
  tr.querySelector('[data-cell="balance"]').textContent = entry.balance.toFixed(2);

  const actionsCell = tr.querySelector('[data-cell="actions"]');
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "ghost";
  delBtn.textContent = "Delete";
  const rowErrorEl = document.createElement("div");
  rowErrorEl.className = "field-error";
  delBtn.addEventListener("click", async () => {
    delBtn.disabled = true;
    rowErrorEl.textContent = "";
    try {
      await jsonFetch(`${API}/balance-entries/${entry.id}`, { method: "DELETE" });
      await loadBalances();
    } catch (err) {
      rowErrorEl.textContent = err.message;
      delBtn.disabled = false;
    }
  });
  actionsCell.append(delBtn, rowErrorEl);

  return tr;
}

document.getElementById("balance-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const errorEl = document.getElementById("balance-error");
  errorEl.textContent = "";

  const account = form.account.value;
  const recordedRaw = form.recorded_at.value; // datetime-local: "YYYY-MM-DDTHH:MM"
  if (!account) {
    errorEl.textContent = "Pick an account.";
    return;
  }
  if (!recordedRaw) {
    errorEl.textContent = "Pick a date and time.";
    return;
  }
  // The server stores recorded_at verbatim and does not normalize it (005's
  // handoff note) — a no-seconds datetime-local value would otherwise be
  // stored as e.g. "...T12:00" alongside other entries stored with ":00"
  // seconds, which is harmless to the API but needlessly inconsistent to
  // look at in the list above. Normalize on the way in instead.
  const recordedAt = recordedRaw.length === 16 ? `${recordedRaw}:00` : recordedRaw;

  const body = {
    account,
    recorded_at: recordedAt,
    balance: Number(form.balance.value),
  };
  try {
    await jsonFetch(`${API}/balance-entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    form.reset();
    loadBalances();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// The Reconciliation panel's remedy link (spec 008, replacing spec 003's
// month-scoped version) jumps here with ?account=... — entries are
// timestamped, not month-keyed, so there is no single "the month" left to
// prefill; only the account carries over. Selects that account in the form
// and focuses the datetime field so recording a fresh entry for it is one
// date-pick away, whether that's because nothing has been recorded for this
// account yet or because an existing entry couldn't be reconciled and the
// user wants to add a corrected one (delete-then-recreate — see the
// balance-entries table's own Delete action above).
function prefillBalanceFormFromQuery() {
  const params = new URLSearchParams(location.search);
  const account = params.get("account");
  if (!account) return;
  const accountSelect = document.getElementById("balance-account");
  const recordedInput = document.getElementById("balance-recorded-at");
  const hasOption = Array.from(accountSelect.options).some((o) => o.value === account);
  if (hasOption) accountSelect.value = account;
  document.getElementById("balances-section")?.scrollIntoView({ block: "start" });
  recordedInput.focus();
}

(async function init() {
  await Promise.all([renderReconciliationList(), loadSources(), loadBalances()]);
  prefillBalanceFormFromQuery();
})();
