const API = "/api/insights";

async function jsonFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function renderCategoryTable() {
  const rows = await jsonFetch(`${API}/category-monthly`);
  const table = document.getElementById("category-table");
  if (rows.length === 0) {
    table.innerHTML = "<tr><td>No data yet — run the pipeline first.</td></tr>";
    return;
  }
  const columns = Object.keys(rows[0]);
  const thead = `<thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map(
      (r) =>
        `<tr>${columns
          .map((c) => `<td>${typeof r[c] === "number" ? r[c].toFixed(2) : r[c]}</td>`)
          .join("")}</tr>`
    )
    .join("")}</tbody>`;
  table.innerHTML = thead + tbody;
}

async function renderCalculatorTable() {
  const rows = await jsonFetch(`${API}/calculator`);
  const tbody = document.querySelector("#calculator-table tbody");
  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr style="${r.match === false ? 'background:rgba(255,0,0,0.08)' : ''}">
        <td>${r.account}</td>
        <td>${r.month}</td>
        <td>${r.derived_balance != null ? r.derived_balance.toFixed(2) : "-"}</td>
        <td>${r.recorded_balance != null ? r.recorded_balance.toFixed(2) : "-"}</td>
        <td>${r.diff != null ? r.diff.toFixed(2) : "-"}</td>
        <td>${r.match === null ? "?" : r.match ? "OK" : "MISMATCH"}</td>
      </tr>`
    )
    .join("");
}

async function renderBalanceChart() {
  const points = await jsonFetch(`${API}/balance-trend`);
  const canvas = document.getElementById("balance-chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (points.length === 0) {
    ctx.fillText("No running-balance data yet — run the pipeline first.", 10, 20);
    return;
  }

  const byAccount = {};
  for (const p of points) {
    (byAccount[p.account] ||= []).push(p);
  }

  const allBalances = points.map((p) => p.balance_after);
  const minBal = Math.min(...allBalances, 0);
  const maxBal = Math.max(...allBalances, 1);
  const allDates = [...new Set(points.map((p) => p.date))].sort();

  const padding = 40;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;
  const xFor = (date) => padding + (allDates.indexOf(date) / Math.max(allDates.length - 1, 1)) * w;
  const yFor = (bal) => padding + h - ((bal - minBal) / Math.max(maxBal - minBal, 1)) * h;

  const colors = ["#2a6df4", "#e0662a", "#2ab34a", "#a92ae0", "#e0c02a"];
  let colorIdx = 0;
  const legend = [];

  for (const [account, series] of Object.entries(byAccount)) {
    const color = colors[colorIdx++ % colors.length];
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

  ctx.fillStyle = "currentColor";
  legend.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.fillRect(padding + i * 160, 5, 10, 10);
    ctx.fillStyle = "currentColor";
    ctx.fillText(l.account, padding + i * 160 + 15, 14);
  });
}

(async function init() {
  await Promise.all([renderCategoryTable(), renderCalculatorTable(), renderBalanceChart()]);
})();
