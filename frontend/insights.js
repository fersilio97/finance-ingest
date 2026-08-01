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

async function renderCategoryTable() {
  const table = document.getElementById("category-table");
  const emptyEl = document.getElementById("category-empty");
  const rows = await jsonFetch(`${API}/category-monthly`);

  setEmpty(emptyEl, rows.length === 0, "No data yet — upload files and run the pipeline.");
  table.hidden = rows.length === 0;
  if (rows.length === 0) return;

  const columns = Object.keys(rows[0]);
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const c of columns) {
    const th = document.createElement("th");
    if (c !== "month") th.classList.add("num");
    th.textContent = c;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of columns) {
      const td = document.createElement("td");
      const val = r[c];
      if (typeof val === "number") {
        td.classList.add("num");
        td.textContent = val.toFixed(2);
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

// Spec 003 §A: every account-month resolves to exactly one of three states.
// "not_checked" and "off" are computed server-side (build_calculator() in
// pipeline/export.py) specifically so this file never has to re-derive the
// NaN-vs-mismatch distinction that caused the original bug.
const STATE_LABEL = { not_checked: "Not checked", balanced: "Balanced", off: "Off by" };
const STATE_ORDER = { off: 0, not_checked: 1, balanced: 2 }; // differences first, then unknowns, then the quiet green tail

function money(v) {
  return v != null ? v.toFixed(2) : "—";
}

function calculatorSummary(rows) {
  const summaryEl = document.getElementById("calculator-summary");
  const offCount = rows.filter((r) => r.status === "off").length;
  const checkedCount = rows.filter((r) => r.status !== "not_checked").length;

  summaryEl.className = "calc-summary";
  if (checkedCount === 0) {
    summaryEl.classList.add("muted");
    summaryEl.textContent = "No end-of-month balances recorded yet — nothing to check against.";
  } else if (offCount === 0) {
    summaryEl.classList.add("positive");
    summaryEl.textContent = `All ${checkedCount} account-month${checkedCount === 1 ? "" : "s"} reconcile.`;
  } else {
    summaryEl.classList.add("negative");
    summaryEl.textContent = `${offCount} of ${rows.length} account-month${rows.length === 1 ? "" : "s"} ${offCount === 1 ? "is" : "are"} off.`;
  }
}

function buildCalculatorCard(r) {
  const card = document.createElement("div");
  card.className = `calc-card calc-state-${r.status}`;

  const identity = document.createElement("div");
  identity.className = "calc-identity";
  // Month leads: with only 2 distinct accounts but 12+ months each, the
  // month is what actually distinguishes a row. If this column has to
  // truncate under real panel widths, it should eat the repetitive account
  // name, not the one piece of info that changes every row.
  identity.textContent = `${r.month} · ${r.account}`;
  identity.title = `${r.account} · ${r.month}`;

  const detail = document.createElement("div");
  detail.className = "calc-detail";

  const derivedEl = document.createElement("span");
  derivedEl.className = "calc-money";
  derivedEl.textContent = money(r.derived_balance);

  const recordedEl = document.createElement("span");
  recordedEl.className = r.recorded_balance == null ? "calc-money muted" : "calc-money";
  recordedEl.textContent = money(r.recorded_balance);

  const statusEl = document.createElement("span");
  statusEl.className = "calc-status";
  if (r.status === "off") {
    const sign = r.diff > 0 ? "+" : "";
    statusEl.textContent = `Off by ${sign}${r.diff.toFixed(2)}`;
  } else {
    statusEl.textContent = STATE_LABEL[r.status];
  }

  detail.append(derivedEl, recordedEl, statusEl);

  if (r.status === "not_checked") {
    const remedy = document.createElement("a");
    remedy.className = "calc-remedy";
    remedy.href = `index.html?account=${encodeURIComponent(r.account)}&month=${encodeURIComponent(r.month)}#balances-section`;
    remedy.textContent = "Record it →";
    detail.appendChild(remedy);
  }

  card.append(identity, detail);
  return card;
}

async function renderCalculatorList() {
  const container = document.getElementById("calculator-list");
  const emptyEl = document.getElementById("calculator-empty");
  const errorEl = document.getElementById("calculator-error");
  const summaryEl = document.getElementById("calculator-summary");

  errorEl.hidden = true;
  let rows;
  try {
    rows = await jsonFetch(`${API}/calculator`);
  } catch (err) {
    container.innerHTML = "";
    summaryEl.textContent = "";
    emptyEl.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load reconciliation — ${err.message}.`;
    return;
  }

  setEmpty(emptyEl, rows.length === 0, "No account/month data to reconcile yet.");
  container.innerHTML = "";
  summaryEl.textContent = "";
  if (rows.length === 0) return;

  calculatorSummary(rows);

  const sorted = rows.slice().sort((a, b) => STATE_ORDER[a.status] - STATE_ORDER[b.status]);
  for (const r of sorted) {
    container.appendChild(buildCalculatorCard(r));
  }
}

async function renderBalanceChart() {
  const canvas = document.getElementById("balance-chart");
  const emptyEl = document.getElementById("balance-empty");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const points = await jsonFetch(`${API}/balance-trend`);
  setEmpty(emptyEl, points.length === 0, "No running-balance data yet — upload files and run the pipeline.");
  canvas.hidden = points.length === 0;
  if (points.length === 0) return;

  const byAccount = {};
  for (const p of points) {
    (byAccount[p.account] ||= []).push(p);
  }

  const allBalances = points.map((p) => p.balance_after);
  const minBal = Math.min(...allBalances, 0);
  const maxBal = Math.max(...allBalances, 1);
  const allDates = [...new Set(points.map((p) => p.date))].sort();

  const padding = 44;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;
  const xFor = (date) => padding + (allDates.indexOf(date) / Math.max(allDates.length - 1, 1)) * w;
  const yFor = (bal) => padding + h - ((bal - minBal) / Math.max(maxBal - minBal, 1)) * h;

  const border = cssVar("--border");
  const textMuted = cssVar("--text-muted");
  const text = cssVar("--text");
  const lineColors = [cssVar("--accent"), textMuted, cssVar("--positive"), cssVar("--negative")];

  // baseline grid
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, padding + h);
  ctx.lineTo(padding + w, padding + h);
  ctx.stroke();

  const legend = [];
  let colorIdx = 0;
  for (const [account, series] of Object.entries(byAccount)) {
    const color = lineColors[colorIdx++ % lineColors.length];
    legend.push({ account, color });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xFor(p.date);
      const y = yFor(p.balance_after);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
  legend.forEach((l, i) => {
    const x = padding + i * 170;
    ctx.fillStyle = l.color;
    ctx.fillRect(x, 10, 10, 10);
    ctx.fillStyle = text;
    ctx.fillText(l.account, x + 16, 19);
  });
  ctx.fillStyle = textMuted;
}

(async function init() {
  await Promise.all([renderCategoryTable(), renderCalculatorList(), renderBalanceChart()]);
})();
