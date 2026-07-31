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

async function renderCalculatorList() {
  const container = document.getElementById("calculator-list");
  const emptyEl = document.getElementById("calculator-empty");
  const rows = await jsonFetch(`${API}/calculator`);

  setEmpty(emptyEl, rows.length === 0, "No account/month data to reconcile yet.");
  container.innerHTML = "";
  if (rows.length === 0) return;

  for (const r of rows) {
    const card = document.createElement("div");
    card.style.cssText =
      "display:flex; justify-content:space-between; align-items:center; padding:0.55rem 0; border-bottom:1px solid var(--border); font-size:0.85rem;";

    const left = document.createElement("div");
    const accountLine = document.createElement("div");
    accountLine.textContent = `${r.account} · ${r.month}`;
    accountLine.style.fontWeight = "600";
    const detailLine = document.createElement("div");
    detailLine.className = "muted";
    const derived = r.derived_balance != null ? r.derived_balance.toFixed(2) : "—";
    const recorded = r.recorded_balance != null ? r.recorded_balance.toFixed(2) : "—";
    detailLine.textContent = `derived ${derived} · recorded ${recorded}`;
    left.append(accountLine, detailLine);

    const pill = document.createElement("span");
    if (r.match === true) {
      pill.className = "pill ok";
      pill.textContent = "OK";
    } else if (r.match === false) {
      pill.className = "pill mismatch";
      pill.textContent = "MISMATCH";
    } else {
      pill.className = "pill";
      pill.textContent = "?";
    }

    card.append(left, pill);
    container.appendChild(card);
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
