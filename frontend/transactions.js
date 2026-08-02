// All Transactions (spec 014) — browse, filter, and correct every
// transaction's category, not just the needs_review queue. Classic script
// (no `type="module"`), matching reconciliation.js/insights.js's convention
// rather than app.js's ES-module one — this page needs neither
// merchant-key.js nor rule-keyword.js.
//
// Architecture (see docs/features/014-all-transactions-view.md §F): fetch
// the full unfiltered `GET /api/transactions` once — 1,020 rows / ~390KB,
// sub-100ms on localhost — then filter, sort, and paginate entirely
// client-side. The render cost, not the fetch cost, is what breaks at this
// row count (002's own measurement: 862 un-grouped rows -> 113,746px / 39,169
// DOM nodes), so only one page of rows (100) is ever in the DOM at a time.

const API = "/api";

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

function skeletonRows(tbody, cols, rows = 8) {
  tbody.innerHTML = Array.from({ length: rows })
    .map(() => `<tr>${`<td><div class="skeleton"></div></td>`.repeat(cols)}</tr>`)
    .join("");
}

function setEmpty(el, show, text) {
  el.hidden = !show;
  if (show) el.textContent = text;
}

const COLUMN_COUNT = 7; // Date, Account, Description, Amount, Status, Category, Matched rule
const PAGE_SIZE = 100; // spec §F
const STATUS_LABEL = { needs_review: "Needs review", classified: "Classified" };

const COLUMNS = [
  { key: "date", label: "Date" },
  { key: "account", label: "Account" },
  { key: "description", label: "Description" },
  { key: "amount", label: "Amount", numeric: true },
  { key: "status", label: "Status" },
  { key: "category", label: "Category" },
  { key: "rule", label: "Matched rule" },
];

let ALL = null; // null = not loaded yet / load failed; [] = loaded, genuinely empty
let SOURCES = [];
let CATEGORIES = [];
let RULES_BY_ID = new Map(); // id -> rule, per spec §3's client-side match_text lookup

const filters = { dateFrom: "", dateTo: "", account: "", description: "", category: "", status: "" };
let sort = { col: "date", dir: "desc" }; // spec §D default
let page = 1;

/* ==========================================================================
   Load
   ========================================================================== */

async function loadSources() {
  SOURCES = await jsonFetch(`${API}/sources`);
  const select = document.getElementById("filter-account");
  for (const s of SOURCES) {
    const opt = document.createElement("option");
    opt.value = s.account;
    opt.textContent = s.account;
    select.appendChild(opt);
  }
}

async function loadCategories() {
  CATEGORIES = await jsonFetch(`${API}/categories`);
  const select = document.getElementById("filter-category");
  for (const c of CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    select.appendChild(opt);
  }
  // Appended after the 21 real categories, not alphabetized in — it's the
  // catch-all bucket, not a real category (categories.py never returns it).
  const uncategorized = document.createElement("option");
  uncategorized.value = "Uncategorized";
  uncategorized.textContent = "Uncategorized";
  select.appendChild(uncategorized);
}

async function loadRules() {
  const rules = await jsonFetch(`${API}/rules`);
  RULES_BY_ID = new Map(rules.map((r) => [r.id, r]));
}

async function loadTransactions() {
  const table = document.getElementById("transactions-table");
  const tbody = table.querySelector("tbody");
  const emptyEl = document.getElementById("transactions-empty");
  const errorEl = document.getElementById("transactions-error");
  const paginationEl = document.getElementById("transactions-pagination");

  errorEl.hidden = true;
  emptyEl.hidden = true;
  paginationEl.hidden = true;
  table.hidden = false;
  skeletonRows(tbody, COLUMN_COUNT);

  try {
    ALL = await jsonFetch(`${API}/transactions`); // no status param — every row, spec §A
  } catch (err) {
    ALL = null;
    tbody.innerHTML = "";
    table.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load transactions — ${err.message}.`;
    return;
  }

  render();
}

/* ==========================================================================
   Filter / sort / paginate — all in-memory over ALL (spec §F)
   ========================================================================== */

function applyFilters(rows) {
  return rows.filter((t) => {
    if (filters.dateFrom && t.date < filters.dateFrom) return false;
    if (filters.dateTo && t.date > filters.dateTo) return false;
    if (filters.account && t.account !== filters.account) return false;
    if (filters.description && !t.description.toLowerCase().includes(filters.description)) return false;
    if (filters.category && (t.category || "Uncategorized") !== filters.category) return false;
    if (filters.status && t.status !== filters.status) return false;
    return true;
  });
}

// Text shown in the Matched-rule column, per the architect's handoff logic:
// needs_review or no rule_id -> "—"; rule_id set but the rule's since been
// deleted (possible now that 014's fix stops nulling rule_id on manual
// correction) -> "rule removed"; otherwise the rule's match_text, suffixed
// "(edited)" when overridden_at is non-null so a manually-corrected row
// doesn't read as still actively governed by that rule.
function matchedRuleInfo(t) {
  if (t.status === "needs_review" || !t.rule_id) {
    return { text: "—", title: "", muted: true };
  }
  const rule = RULES_BY_ID.get(t.rule_id);
  if (!rule) {
    return { text: "rule removed", title: `Rule #${t.rule_id} no longer exists.`, muted: true };
  }
  if (t.overridden_at) {
    return {
      text: `${rule.match_text} (edited)`,
      title: `Originally matched "${rule.match_text}", manually corrected ${t.overridden_at}.`,
      muted: false,
    };
  }
  return { text: rule.match_text, title: `Matched by rule: "${rule.match_text}".`, muted: false };
}

function sortValue(t, col) {
  switch (col) {
    case "amount":
      return t.amount;
    case "status":
      return STATUS_LABEL[t.status] || t.status;
    case "category":
      return t.category || "Uncategorized";
    case "rule":
      return matchedRuleInfo(t).text;
    default:
      return t[col];
  }
}

function sortRows(rows) {
  const mul = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const av = sortValue(a, sort.col);
    const bv = sortValue(b, sort.col);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return cmp * mul;
  });
}

/* ==========================================================================
   Render
   ========================================================================== */

function renderHead() {
  const thead = document.querySelector("#transactions-table thead");
  thead.innerHTML = "";
  const tr = document.createElement("tr");
  for (const col of COLUMNS) {
    const th = document.createElement("th");
    if (col.numeric) th.classList.add("num");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "th-sort";
    btn.textContent = col.label;

    if (sort.col === col.key) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = sort.dir === "asc" ? "▲" : "▼";
      btn.appendChild(arrow);
      th.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
    }

    btn.addEventListener("click", () => {
      if (sort.col === col.key) {
        sort = { col: col.key, dir: sort.dir === "asc" ? "desc" : "asc" };
      } else {
        // Amount defaults to descending on first click (biggest first is the
        // more useful reading direction for money); everything else follows
        // the table's own default-ascending convention (009's category table).
        sort = { col: col.key, dir: col.key === "amount" ? "desc" : "asc" };
      }
      page = 1;
      render();
    });

    th.appendChild(btn);
    tr.appendChild(th);
  }
  thead.appendChild(tr);
}

function buildRow(t) {
  const tr = document.createElement("tr");
  tr.dataset.id = t.id;
  tr.innerHTML =
    `<td data-cell="date"></td><td data-cell="account"></td>` +
    `<td class="truncate" data-cell="description"></td><td class="num" data-cell="amount"></td>` +
    `<td data-cell="status"></td><td data-cell="category"></td><td data-cell="rule"></td>`;

  tr.querySelector('[data-cell="date"]').textContent = t.date;
  tr.querySelector('[data-cell="account"]').textContent = t.account;
  const descCell = tr.querySelector('[data-cell="description"]');
  descCell.textContent = t.description;
  descCell.title = t.description;
  tr.querySelector('[data-cell="amount"]').textContent = t.amount.toFixed(2);

  renderStatusCell(tr, t);
  renderCategoryCell(tr, t);
  renderMatchedRuleCell(tr, t);
  return tr;
}

function renderStatusCell(tr, t) {
  const td = tr.querySelector('[data-cell="status"]');
  td.innerHTML = "";
  const span = document.createElement("span");
  span.className = `pill ${t.status === "classified" ? "ok" : "pending"}`;
  span.textContent = STATUS_LABEL[t.status] || t.status;
  td.appendChild(span);
}

function renderMatchedRuleCell(tr, t) {
  const td = tr.querySelector('[data-cell="rule"]');
  const info = matchedRuleInfo(t);
  td.textContent = info.text;
  td.title = info.title;
  td.classList.toggle("muted", info.muted);
}

// Inline edit, click-to-reveal (spec §E) — a plain button that swaps itself
// for the same category <select> Needs Review uses, rather than a modal or a
// separate page. `null` category renders as "Uncategorized", never blank.
function renderCategoryCell(tr, t) {
  const td = tr.querySelector('[data-cell="category"]');
  renderCategoryDisplay(td, tr, t);
}

function renderCategoryDisplay(td, tr, t) {
  td.innerHTML = "";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cat-edit-trigger truncate";
  btn.textContent = t.category || "Uncategorized";
  btn.title = "Click to change category";
  if (!t.category) btn.classList.add("muted");
  btn.addEventListener("click", () => renderCategoryEditor(td, tr, t));
  td.appendChild(btn);
}

function renderCategoryEditor(td, tr, t) {
  td.innerHTML = "";
  const select = document.createElement("select");
  select.innerHTML =
    `<option value="" ${t.category ? "" : "selected"} disabled>Select…</option>` +
    CATEGORIES.map((c) => `<option value="${c}" ${c === t.category ? "selected" : ""}>${c}</option>`).join("");
  const errorEl = document.createElement("div");
  errorEl.className = "field-error";

  // Losing focus without picking anything (Escape, click elsewhere) cancels
  // back to display mode. The `select.disabled` check keeps this from firing
  // mid-save (disabling a focused <select> blurs it as a side effect).
  select.addEventListener("blur", () => {
    setTimeout(() => {
      if (!select.disabled && td.contains(select)) renderCategoryDisplay(td, tr, t);
    }, 150);
  });

  select.addEventListener("change", async () => {
    const category = select.value;
    if (!category) return;
    select.disabled = true; // spec §E point 1: disabled-select is this screen's "saving" treatment
    errorEl.textContent = "";
    try {
      const res = await jsonFetch(`${API}/transactions/${t.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      // Patch in place from the response's `transaction` field (014's new
      // response field) rather than re-fetching all ~1,020 rows. `t` is the
      // same object reference held in `ALL`, so this also keeps future
      // filter/sort/page renders in sync without a manual re-fetch.
      Object.assign(t, res.transaction);
      renderCategoryDisplay(td, tr, t);
      renderStatusCell(tr, t); // a first-time classify of a needs_review row flips this badge
      renderMatchedRuleCell(tr, t); // overridden_at may have just been stamped
    } catch (err) {
      // Spec §E point 3: revert and show a row-local error, don't lose the
      // user's place in a filtered/sorted table with a page-level toast.
      select.disabled = false;
      errorEl.textContent = err.message;
    }
  });

  td.append(select, errorEl);
  select.focus();
}

function showEmptyFiltered() {
  const emptyEl = document.getElementById("transactions-empty");
  emptyEl.hidden = false;
  emptyEl.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = "No transactions match these filters. ";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "ghost";
  clearBtn.textContent = "Clear filters";
  clearBtn.addEventListener("click", clearFilters);
  emptyEl.append(text, clearBtn);
}

function render() {
  const table = document.getElementById("transactions-table");
  const tbody = table.querySelector("tbody");
  const emptyEl = document.getElementById("transactions-empty");
  const paginationEl = document.getElementById("transactions-pagination");

  if (ALL === null) return; // load failed — error state already shown by loadTransactions()

  renderHead();

  if (ALL.length === 0) {
    tbody.innerHTML = "";
    table.hidden = true;
    paginationEl.hidden = true;
    setEmpty(emptyEl, true, "No transactions yet — upload and run the pipeline first.");
    return;
  }

  const filtered = applyFilters(ALL);
  const sorted = sortRows(filtered);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = sorted.slice(start, start + PAGE_SIZE);

  if (pageRows.length === 0) {
    tbody.innerHTML = "";
    table.hidden = true;
    paginationEl.hidden = true;
    showEmptyFiltered();
    return;
  }

  emptyEl.hidden = true;
  table.hidden = false;
  tbody.innerHTML = "";
  for (const t of pageRows) tbody.appendChild(buildRow(t));

  paginationEl.hidden = false;
  const rangeLabel =
    sorted.length === ALL.length
      ? `Showing ${start + 1}–${start + pageRows.length} of ${sorted.length}`
      : `Showing ${start + 1}–${start + pageRows.length} of ${sorted.length} (filtered from ${ALL.length})`;
  document.getElementById("page-info").textContent = `${rangeLabel} — page ${page} of ${totalPages}`;
  document.getElementById("page-prev").disabled = page <= 1;
  document.getElementById("page-next").disabled = page >= totalPages;
}

/* ==========================================================================
   Filter wiring
   ========================================================================== */

function clearFilters() {
  filters.dateFrom = "";
  filters.dateTo = "";
  filters.account = "";
  filters.description = "";
  filters.category = "";
  filters.status = "";
  document.getElementById("filter-date-from").value = "";
  document.getElementById("filter-date-to").value = "";
  document.getElementById("filter-account").value = "";
  document.getElementById("filter-description").value = "";
  document.getElementById("filter-category").value = "";
  document.getElementById("filter-status").value = "";
  page = 1;
  render();
}

function wireFilters() {
  document.getElementById("filter-date-from").addEventListener("input", (e) => {
    filters.dateFrom = e.target.value;
    page = 1;
    render();
  });
  document.getElementById("filter-date-to").addEventListener("input", (e) => {
    filters.dateTo = e.target.value;
    page = 1;
    render();
  });
  document.getElementById("filter-account").addEventListener("change", (e) => {
    filters.account = e.target.value;
    page = 1;
    render();
  });
  document.getElementById("filter-description").addEventListener("input", (e) => {
    filters.description = e.target.value.trim().toLowerCase();
    page = 1;
    render();
  });
  document.getElementById("filter-category").addEventListener("change", (e) => {
    filters.category = e.target.value;
    page = 1;
    render();
  });
  document.getElementById("filter-status").addEventListener("change", (e) => {
    filters.status = e.target.value;
    page = 1;
    render();
  });
  document.getElementById("filter-clear").addEventListener("click", clearFilters);

  document.getElementById("page-prev").addEventListener("click", () => {
    if (page > 1) {
      page -= 1;
      render();
    }
  });
  document.getElementById("page-next").addEventListener("click", () => {
    page += 1; // render() clamps to the real last page
    render();
  });
}

(async function init() {
  wireFilters();
  await Promise.all([loadSources(), loadCategories(), loadRules()]);
  await loadTransactions();
})();
