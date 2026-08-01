const API = "/api/insights";

async function jsonFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setEmpty(el, show, text) {
  el.hidden = !show;
  if (show) el.textContent = text;
}

// "2025-01-21T12:00:00" -> "2025-01-21 12:00" for compact display; the raw
// value is still available via the caller's own `title`. Duplicated from
// app.js on purpose (see feature 008's implementation notes) — insights.js is
// a classic script, not a module, and this is 4 lines.
function formatRecordedAt(iso) {
  const [datePart, timePart = ""] = iso.split("T");
  const hhmm = timePart.slice(0, 5);
  return hhmm ? `${datePart} ${hhmm}` : datePart;
}

/* ==========================================================================
   Category totals by month — sortable columns + click-to-drilldown (Part B)
   ========================================================================== */

let categoryRows = [];
let categorySort = { col: "month", dir: "asc" };
// Tracks the single open drill-down panel (at most one at a time — see the
// feature doc's judgment-call section for why this is intentionally not a
// multi-expand model like the review queue's merchant groups).
let openDrilldown = null; // { rowEl, category, month }

async function renderCategoryTable() {
  const table = document.getElementById("category-table");
  const emptyEl = document.getElementById("category-empty");
  const errorEl = document.getElementById("category-error");
  errorEl.hidden = true;

  let rows;
  try {
    rows = await jsonFetch(`${API}/category-monthly`);
  } catch (err) {
    table.hidden = true;
    emptyEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load category totals — ${err.message}.`;
    return;
  }

  categoryRows = rows;
  setEmpty(emptyEl, rows.length === 0, "No data yet — upload files and run the pipeline.");
  table.hidden = rows.length === 0;
  if (rows.length === 0) return;

  openDrilldown = null;
  renderCategoryTableBody();
}

function sortComparator(col, dir) {
  const mul = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = a[col];
    const bv = b[col];
    const cmp = typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
    return cmp * mul;
  };
}

function renderCategoryTableBody() {
  const table = document.getElementById("category-table");
  const columns = Object.keys(categoryRows[0]);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    if (col !== "month") th.classList.add("num");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "th-sort";
    btn.textContent = col;

    if (categorySort.col === col) {
      const arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      arrow.textContent = categorySort.dir === "asc" ? "▲" : "▼";
      btn.appendChild(arrow);
      th.setAttribute("aria-sort", categorySort.dir === "asc" ? "ascending" : "descending");
    }

    btn.addEventListener("click", () => {
      if (categorySort.col === col) {
        categorySort = { col, dir: categorySort.dir === "asc" ? "desc" : "asc" };
      } else {
        categorySort = { col, dir: "asc" };
      }
      // Row order is about to change under any open panel's feet — close it
      // rather than let it silently point at the wrong row after re-sort.
      openDrilldown = null;
      renderCategoryTableBody();
    });

    th.appendChild(btn);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const sorted = categoryRows.slice().sort(sortComparator(categorySort.col, categorySort.dir));

  const tbody = document.createElement("tbody");
  for (const r of sorted) {
    const tr = document.createElement("tr");
    for (const col of columns) {
      const td = document.createElement("td");
      const val = r[col];
      if (typeof val === "number") {
        td.classList.add("num");
        const formatted = val.toFixed(2);
        // "Total" is a derived sum across categories, not a real category —
        // /api/transactions?category=Total would just match zero rows.
        // "month" never reaches here (it's a string). Every real category
        // column, including exact-0.00 cells, stays clickable: a 0.00 total
        // can still hide two offsetting transactions worth seeing.
        if (col !== "Total") {
          const cellBtn = document.createElement("button");
          cellBtn.type = "button";
          cellBtn.className = "cell-link";
          cellBtn.textContent = formatted;
          cellBtn.title = `View ${col} transactions for ${r.month}`;
          cellBtn.addEventListener("click", () => toggleDrilldown(tr, col, r.month, columns.length, cellBtn));
          td.appendChild(cellBtn);
        } else {
          td.textContent = formatted;
        }
      } else {
        td.textContent = val;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.innerHTML = "";
  table.append(thead, tbody);
}

async function toggleDrilldown(rowEl, category, month, colspan, triggerBtn) {
  const reopeningSameCell = openDrilldown
    && openDrilldown.rowEl === rowEl
    && openDrilldown.category === category
    && openDrilldown.month === month;

  if (openDrilldown) {
    openDrilldown.rowEl.nextElementSibling?.remove();
    openDrilldown = null;
  }
  if (reopeningSameCell) return; // second click on the same cell just closes it

  const dTr = document.createElement("tr");
  dTr.className = "drilldown-row";
  const dTd = document.createElement("td");
  dTd.colSpan = colspan;
  dTr.appendChild(dTd);
  rowEl.after(dTr);
  openDrilldown = { rowEl, category, month };

  renderDrilldownLoading(dTd, category, month);
  ensureDrilldownHeaderVisible(dTd);
  triggerBtn.disabled = true;
  try {
    const txns = await jsonFetch(`/api/transactions?category=${encodeURIComponent(category)}&month=${encodeURIComponent(month)}`);
    // The panel may have been closed/replaced while this request was in
    // flight (user clicked a different cell fast) — only render if it's
    // still the one this response belongs to.
    if (openDrilldown && openDrilldown.rowEl === rowEl && openDrilldown.category === category && openDrilldown.month === month) {
      renderDrilldownContent(dTd, category, month, txns);
      ensureDrilldownHeaderVisible(dTd);
    }
  } catch (err) {
    if (openDrilldown && openDrilldown.rowEl === rowEl && openDrilldown.category === category && openDrilldown.month === month) {
      renderDrilldownError(dTd, category, month, err);
      ensureDrilldownHeaderVisible(dTd);
    }
  } finally {
    triggerBtn.disabled = false;
  }
}

// Feature 011: the drill-down <td> spans all 24 columns, so its own bounding
// rect always overlaps part of .table-scroll's visible window at any
// scrollLeft — checking/scrolling based on the <td> would silently no-op.
// Target .drilldown-header instead (the first child in all three render
// states, positioned at the <td>'s left edge with its own natural width).
// header.closest(".table-scroll") — not the nested transaction-table's own
// .table-scroll wrapper appended later in renderDrilldownContent, which is a
// sibling, not an ancestor, of the header — resolves to the outer
// category-table scroll container that actually needs scrolling.
// scrollIntoView({ inline: "nearest" }) natively no-ops when the header is
// already fully visible, satisfying "no unnecessary scroll jump" without
// hand-rolled geometry math, and handles a column scrolled off-screen either
// left or right uniformly.
// Known limitation (accepted per spec): this is an open-time-only check — a
// window resize while a panel is open does not re-run it.
function ensureDrilldownHeaderVisible(dTd) {
  const header = dTd.querySelector(".drilldown-header");
  const scrollEl = header?.closest(".table-scroll");
  if (!header || !scrollEl) return;
  header.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderDrilldownHeader(container, category, month, countText) {
  const header = document.createElement("div");
  header.className = "drilldown-header";
  const title = document.createElement("span");
  title.textContent = countText ? `${category} · ${month} · ${countText}` : `${category} · ${month}`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ghost";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => {
    container.closest("tr")?.remove();
    openDrilldown = null;
  });
  header.append(title, closeBtn);
  container.appendChild(header);
}

function renderDrilldownLoading(container, category, month) {
  container.innerHTML = "";
  renderDrilldownHeader(container, category, month, null);
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("div");
    s.className = "skeleton";
    container.appendChild(s);
  }
}

function renderDrilldownContent(container, category, month, txns) {
  container.innerHTML = "";
  renderDrilldownHeader(container, category, month, `${txns.length} transaction${txns.length === 1 ? "" : "s"}`);

  if (txns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No transactions matched this cell — it may be a rounding artifact.";
    container.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "drilldown-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const [label, num] of [["Date", false], ["Description", false], ["Account", false], ["Amount", true]]) {
    const th = document.createElement("th");
    th.textContent = label;
    if (num) th.classList.add("num");
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  for (const t of txns) {
    const tr = document.createElement("tr");

    const dateTd = document.createElement("td");
    dateTd.textContent = t.date;

    const descTd = document.createElement("td");
    descTd.className = "truncate";
    descTd.textContent = t.description;
    descTd.title = t.description;

    const acctTd = document.createElement("td");
    acctTd.textContent = t.account;

    const amtTd = document.createElement("td");
    amtTd.className = "num";
    amtTd.textContent = t.amount.toFixed(2);

    tr.append(dateTd, descTd, acctTd, amtTd);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);

  const scrollWrap = document.createElement("div");
  scrollWrap.className = "table-scroll";
  scrollWrap.appendChild(table);
  container.appendChild(scrollWrap);
}

function renderDrilldownError(container, category, month, err) {
  container.innerHTML = "";
  renderDrilldownHeader(container, category, month, null);
  const errEl = document.createElement("div");
  errEl.className = "field-error";
  errEl.textContent = `Couldn't load transactions — ${err.message}.`;
  container.appendChild(errEl);
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
    remedy.href = `index.html?account=${encodeURIComponent(r.account)}#balances-section`;
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
    rows = await jsonFetch(`${API}/reconciliation`);
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
    link.href = "index.html#balances-section";
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
   Balance trend chart + account-balance strip (Part A + Part C)

   Both consume one shared GET /api/insights/balance-trend response —
   fetched once in loadAndRenderBalance() and handed to both renderers, per
   feature 006's handoff note that the frontend should not double-fetch.
   ========================================================================== */

// Per-account line color: 4 real theme colors, extended to 6 with a second,
// lower-opacity pass over 2 of them via color-mix() rather than introducing
// new hardcoded hex values. `kind` (native/derived) is carried separately as
// a dash pattern, not folded into this palette, so color always identifies
// *which account* and dash always identifies *native vs. relative*.
const ACCOUNT_PALETTE = [
  { base: "--accent", alpha: 1 },
  { base: "--positive", alpha: 1 },
  { base: "--negative", alpha: 1 },
  { base: "--text-muted", alpha: 1 },
  { base: "--accent", alpha: 0.55 },
  { base: "--positive", alpha: 0.55 },
];

function seriesColor(idx) {
  const spec = ACCOUNT_PALETTE[idx % ACCOUNT_PALETTE.length];
  const base = cssVar(spec.base);
  if (spec.alpha >= 1) return base;
  const mixed = `color-mix(in srgb, ${base} ${Math.round(spec.alpha * 100)}%, transparent)`;
  // Feature-detect color-mix() support against a scratch canvas context
  // rather than assuming it — canvas 2D silently ignores an unparseable
  // color and keeps the previous fillStyle, so a naive assignment could
  // fail invisibly. Falls back to the plain base color (still distinguished
  // by dash pattern + legend label) if unsupported.
  const testCtx = seriesColor._testCtx || (seriesColor._testCtx = document.createElement("canvas").getContext("2d"));
  testCtx.fillStyle = "#000000";
  testCtx.fillStyle = mixed;
  return testCtx.fillStyle !== "#000000" ? mixed : base;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Locale-independent — this app has no i18n elsewhere and toLocaleString's
// output isn't guaranteed stable across environments.
function formatAxisDate(ts) {
  const d = new Date(ts);
  return `${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}

function formatAxisMoney(v) {
  const rounded = Math.round(v);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toString();
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${withCommas}`;
}

// "YYYY-MM-DD" (date-only, from series/aggregated points) -> epoch ms.
function parseDateTs(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getTime();
}

// Full ISO datetime (from balance_entries) -> epoch ms.
function parseDateTimeTs(iso) {
  return new Date(iso).getTime();
}

// Sets the canvas's backing pixel buffer from its container's actual
// rendered width (standard responsive-canvas pattern) instead of the old
// hardcoded width="1100" HTML attribute, which clipped at narrow viewports.
// Drawing coordinates stay in CSS-pixel space via ctx.setTransform, so all
// downstream geometry math (xFor/yFor, tooltip hit-testing) doesn't need to
// know about devicePixelRatio at all.
function sizeCanvas(canvas) {
  const cssWidth = Math.max(canvas.parentElement.clientWidth, 260);
  const cssHeight = 300;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = "100%";
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssWidth, cssHeight };
}

// Draws the chart and returns the geometry the tooltip/legend need — or
// null if there's nothing to plot (caller shows the empty state instead).
function drawBalanceChart(canvas, data) {
  const { ctx, cssWidth, cssHeight } = sizeCanvas(canvas);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 16, right: 16, bottom: 26, left: 70 };
  const w = cssWidth - padding.left - padding.right;
  const h = cssHeight - padding.top - padding.bottom;

  const allTs = [];
  const allBal = [];
  const seriesInfo = data.series.map((s, idx) => {
    const points = s.points.map((p) => {
      const ts = parseDateTs(p.date);
      allTs.push(ts);
      allBal.push(p.balance);
      return { ts, balance: p.balance, date: p.date };
    });
    return { account: s.account, kind: s.kind, points, color: seriesColor(idx) };
  });
  const aggPoints = data.aggregated.map((p) => {
    const ts = parseDateTs(p.date);
    allTs.push(ts);
    allBal.push(p.balance);
    return { ts, balance: p.balance, date: p.date };
  });

  if (allTs.length === 0) return null;

  const minTs = Math.min(...allTs);
  const maxTs = Math.max(...allTs);
  const rawMinBal = Math.min(...allBal);
  const rawMaxBal = Math.max(...allBal);
  const balPad = Math.max((rawMaxBal - rawMinBal) * 0.08, 1);
  const minBal = rawMinBal - balPad;
  const maxBal = rawMaxBal + balPad;

  const xFor = (ts) => padding.left + (maxTs === minTs ? w / 2 : ((ts - minTs) / (maxTs - minTs)) * w);
  const yFor = (bal) => padding.top + h - ((bal - minBal) / (maxBal - minBal || 1)) * h;

  const border = cssVar("--border");
  const textMuted = cssVar("--text-muted");
  const text = cssVar("--text");
  const surface = cssVar("--surface");

  // Y gridlines + labels — a handful of evenly-spaced ticks, not one per
  // point (there can be hundreds of points per series).
  const Y_TICKS = 5;
  ctx.font = "11px sans-serif";
  for (let i = 0; i <= Y_TICKS; i++) {
    const bal = minBal + ((maxBal - minBal) * i) / Y_TICKS;
    const y = yFor(bal);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + w, y);
    ctx.stroke();
    ctx.fillStyle = textMuted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(formatAxisMoney(bal), padding.left - 8, y);
  }

  // X date labels — likewise a handful, evenly spaced across the real time
  // range (this is the fix for the old index-based xFor: ticks/points are
  // now positioned by actual elapsed time, not by position in a date list).
  const X_TICKS = Math.min(6, Math.max(1, Math.round(w / 110)));
  ctx.textBaseline = "top";
  for (let i = 0; i <= X_TICKS; i++) {
    const ts = minTs + ((maxTs - minTs) * i) / X_TICKS;
    const x = xFor(ts);
    // Center-aligning every tick clips the first/last label past the canvas
    // edge (found live via screenshot: "Jul 2026" rendered as "Jul 202").
    // Anchor the two edge ticks inward instead; middle ticks stay centered.
    ctx.textAlign = i === 0 ? "left" : i === X_TICKS ? "right" : "center";
    ctx.fillStyle = textMuted;
    ctx.fillText(formatAxisDate(ts), x, padding.top + h + 8);
  }

  // Per-account lines: solid for native (real reported balance), dashed for
  // derived (relative running total — see the eyebrow copy and legend for
  // why this distinction matters).
  for (const s of seriesInfo) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.kind === "derived" ? [6, 4] : []);
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = xFor(p.ts);
      const y = yFor(p.balance);
      p.x = x;
      p.y = y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Aggregated line: heavier weight + its own dotted dash, drawn last (on
  // top) so it reads as the "total" line rather than blending into the
  // per-account set.
  if (aggPoints.length > 0) {
    ctx.strokeStyle = text;
    ctx.lineWidth = 3;
    ctx.setLineDash([1, 4]);
    ctx.lineCap = "round";
    ctx.beginPath();
    aggPoints.forEach((p, i) => {
      const x = xFor(p.ts);
      const y = yFor(p.balance);
      p.x = x;
      p.y = y;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
  }

  // balance_entries as dot markers on their account's line. An entry whose
  // account has no matching series (005/006's documented, unvalidated-input
  // gap) is skipped rather than crashing or guessing where to draw it.
  const entryMarkers = [];
  for (const e of data.entries) {
    const series = seriesInfo.find((s) => s.account === e.account);
    if (!series) continue;
    const ts = parseDateTimeTs(e.recorded_at);
    const x = xFor(ts);
    const y = yFor(e.balance);
    ctx.fillStyle = surface;
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    entryMarkers.push({ x, y, entry: e });
  }

  return { padding, w, h, minTs, maxTs, minBal, maxBal, xFor, yFor, seriesInfo, aggPoints, entryMarkers, cssWidth, cssHeight };
}

function renderLegend(legendEl, geometry, data) {
  legendEl.innerHTML = "";
  if (!geometry) return;

  for (const s of geometry.seriesInfo) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch" + (s.kind === "derived" ? " dashed" : "");
    swatch.style.borderTopColor = s.color;
    const label = document.createElement("span");
    label.textContent = s.kind === "derived" ? `${s.account} (relative)` : s.account;
    item.append(swatch, label);
    legendEl.appendChild(item);
  }

  if (geometry.aggPoints.length > 0) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch aggregated";
    swatch.style.borderTopColor = cssVar("--text");
    const label = document.createElement("span");
    label.textContent = "Aggregated (all accounts)";
    item.append(swatch, label);
    legendEl.appendChild(item);
  }
}

// Binary search for the point nearest a target timestamp within an
// ascending-by-ts array (both series points and aggregated points are
// already sorted this way by the backend).
function nearestByTs(points, targetTs) {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (targetTs <= points[0].ts) return points[0];
  if (targetTs >= points[hi].ts) return points[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].ts < targetTs) lo = mid + 1;
    else hi = mid;
  }
  const after = points[lo];
  const before = points[lo - 1] || after;
  return (targetTs - before.ts) <= (after.ts - targetTs) ? before : after;
}

// Hand-rolled pointermove tooltip — nearest-x hit-testing across every
// rendered series + the aggregated line, plus a small radius check against
// entry dot markers. Uses `canvas.onpointermove =` (assignment, not
// addEventListener) deliberately, so re-drawing on resize replaces the old
// handler instead of accumulating a new one each time.
function attachTooltip(canvas, geometry) {
  const tooltip = document.getElementById("balance-tooltip");
  const wrap = canvas.parentElement;

  if (!geometry) {
    canvas.onpointermove = null;
    canvas.onpointerleave = null;
    tooltip.hidden = true;
    return;
  }

  canvas.onpointermove = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = evt.clientX - rect.left;
    const mouseY = evt.clientY - rect.top;

    if (mouseX < geometry.padding.left || mouseX > geometry.padding.left + geometry.w) {
      tooltip.hidden = true;
      return;
    }

    const targetTs = geometry.minTs + ((mouseX - geometry.padding.left) / geometry.w) * (geometry.maxTs - geometry.minTs);

    const lines = [];
    for (const s of geometry.seriesInfo) {
      const p = nearestByTs(s.points, targetTs);
      if (!p) continue;
      lines.push({
        label: s.kind === "derived" ? `${s.account} (relative)` : s.account,
        value: p.balance,
        color: s.color,
      });
    }
    const aggP = nearestByTs(geometry.aggPoints, targetTs);
    if (aggP) lines.push({ label: "Aggregated", value: aggP.balance, color: cssVar("--text") });

    let entryNote = null;
    for (const m of geometry.entryMarkers) {
      const dx = m.x - mouseX;
      const dy = m.y - mouseY;
      if (Math.sqrt(dx * dx + dy * dy) <= 8) {
        entryNote = `Recorded: ${m.entry.account} · ${formatRecordedAt(m.entry.recorded_at)} · ${m.entry.balance.toFixed(2)}`;
        break;
      }
    }

    tooltip.innerHTML = "";
    const dateEl = document.createElement("div");
    dateEl.className = "chart-tooltip-date";
    dateEl.textContent = formatAxisDate(targetTs);
    tooltip.appendChild(dateEl);
    for (const l of lines) {
      const row = document.createElement("div");
      row.className = "chart-tooltip-row";
      const sw = document.createElement("span");
      sw.className = "chart-tooltip-swatch";
      sw.style.background = l.color;
      row.append(sw, document.createTextNode(`${l.label}: ${l.value.toFixed(2)}`));
      tooltip.appendChild(row);
    }
    if (entryNote) {
      const row = document.createElement("div");
      row.className = "chart-tooltip-row chart-tooltip-entry";
      row.textContent = entryNote;
      tooltip.appendChild(row);
    }

    tooltip.hidden = false;
    tooltip.style.left = `${mouseX + 14}px`;
    tooltip.style.top = `${mouseY + 14}px`;
    requestAnimationFrame(() => {
      if (tooltip.hidden) return;
      const tw = tooltip.offsetWidth;
      const th = tooltip.offsetHeight;
      if (mouseX + 14 + tw > wrap.clientWidth) tooltip.style.left = `${Math.max(0, mouseX - tw - 14)}px`;
      if (mouseY + 14 + th > wrap.clientHeight) tooltip.style.top = `${Math.max(0, mouseY - th - 14)}px`;
    });
  };

  canvas.onpointerleave = () => {
    tooltip.hidden = true;
  };
}

function renderBalanceChart(canvas, data, error) {
  const loadingEl = document.getElementById("balance-loading");
  const wrapEl = document.getElementById("balance-chart-wrap");
  const legendEl = document.getElementById("balance-legend");
  const emptyEl = document.getElementById("balance-empty");
  const errorEl = document.getElementById("balance-error");
  const tooltip = document.getElementById("balance-tooltip");

  loadingEl.hidden = true;

  if (error) {
    wrapEl.hidden = true;
    legendEl.hidden = true;
    emptyEl.hidden = true;
    tooltip.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load balance trend — ${error.message}.`;
    return;
  }
  errorEl.hidden = true;

  const hasAnyPoints = data.series.some((s) => s.points.length > 0) || data.aggregated.length > 0;
  if (!hasAnyPoints) {
    wrapEl.hidden = true;
    legendEl.hidden = true;
    tooltip.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = "No balance data yet — upload files and run the pipeline.";
    return;
  }
  emptyEl.hidden = true;
  wrapEl.hidden = false;
  legendEl.hidden = false;

  const geometry = drawBalanceChart(canvas, data);
  renderLegend(legendEl, geometry, data);
  attachTooltip(canvas, geometry);
}

function renderAccountStripSkeleton() {
  const el = document.getElementById("balance-strip-loading");
  el.innerHTML = "";
  for (let i = 0; i < 6; i++) {
    const tile = document.createElement("div");
    tile.className = "tile balance-tile";
    const s1 = document.createElement("div");
    s1.className = "skeleton";
    s1.style.width = "70%";
    const s2 = document.createElement("div");
    s2.className = "skeleton";
    s2.style.width = "50%";
    tile.append(s1, s2);
    el.appendChild(tile);
  }
}

function renderAccountStrip(data, error) {
  const loadingEl = document.getElementById("balance-strip-loading");
  const stripEl = document.getElementById("balance-strip");
  const emptyEl = document.getElementById("balance-strip-empty");
  const errorEl = document.getElementById("balance-strip-error");

  loadingEl.hidden = true;

  if (error) {
    stripEl.hidden = true;
    emptyEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load account balances — ${error.message}.`;
    return;
  }
  errorEl.hidden = true;

  if (data.series.length === 0) {
    stripEl.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = "No accounts configured yet.";
    return;
  }
  emptyEl.hidden = true;
  stripEl.hidden = false;
  stripEl.innerHTML = "";

  data.series.forEach((s) => {
    const tile = document.createElement("div");
    tile.className = `tile balance-tile${s.kind === "derived" ? " muted-border" : ""}`;

    const label = document.createElement("div");
    label.className = "balance-tile-label";
    label.textContent = s.account;
    label.title = s.account;

    const value = document.createElement("div");
    value.className = "balance-tile-value";
    const last = s.points.length ? s.points[s.points.length - 1] : null;
    if (last == null) {
      value.classList.add("muted");
      value.textContent = "No data yet";
    } else {
      value.textContent = last.balance.toFixed(2);
    }

    const kindEl = document.createElement("div");
    kindEl.className = "balance-tile-kind";
    kindEl.textContent = s.kind === "derived" ? "Relative running total" : "Reported balance";

    tile.append(label, value, kindEl);
    stripEl.appendChild(tile);
  });
}

let cachedBalanceTrend = null;
let cachedBalanceError = null;

// Fetched once, fed to both renderBalanceChart() and renderAccountStrip()
// (feature 006's handoff flagged this as the efficient approach — one
// ~57KB/57ms request instead of two identical ones).
async function loadAndRenderBalance() {
  renderAccountStripSkeleton();
  const canvas = document.getElementById("balance-chart");
  try {
    cachedBalanceTrend = await jsonFetch(`${API}/balance-trend`);
    cachedBalanceError = null;
  } catch (err) {
    cachedBalanceTrend = null;
    cachedBalanceError = err;
  }
  renderAccountStrip(cachedBalanceTrend, cachedBalanceError);
  renderBalanceChart(canvas, cachedBalanceTrend, cachedBalanceError);
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (cachedBalanceTrend) {
      renderBalanceChart(document.getElementById("balance-chart"), cachedBalanceTrend, cachedBalanceError);
    }
  }, 150);
});

(async function init() {
  await Promise.all([renderCategoryTable(), renderReconciliationList(), loadAndRenderBalance()]);
})();
