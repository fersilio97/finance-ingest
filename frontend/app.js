const API = "/api";

async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? res.json() : null;
}

let SOURCES = [];

async function loadSources() {
  SOURCES = await jsonFetch(`${API}/sources`);
  renderDropZones();
  renderSourceSelect();
  renderAccountSelect();
}

function renderDropZones() {
  const container = document.getElementById("drop-zones");
  container.innerHTML = "";
  for (const source of SOURCES) {
    const zone = document.createElement("div");
    zone.className = "drop-zone";
    zone.innerHTML = `
      <strong>${source.label}</strong>
      <div class="muted">click or drop .csv files</div>
      <div class="staged" data-role="staged"></div>
    `;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv";
    input.multiple = true;
    input.hidden = true;

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      uploadFiles(source.key, e.dataTransfer.files, zone);
    });
    input.addEventListener("change", () => uploadFiles(source.key, input.files, zone));

    zone.appendChild(input);
    container.appendChild(zone);
  }
}

async function uploadFiles(sourceKey, fileList, zoneEl) {
  if (!fileList || fileList.length === 0) return;
  const formData = new FormData();
  for (const file of fileList) formData.append("files", file);

  const status = document.getElementById("upload-status");
  try {
    const result = await jsonFetch(`${API}/upload/${sourceKey}`, { method: "POST", body: formData });
    const staged = zoneEl.querySelector('[data-role="staged"]');
    staged.textContent = result.saved.map((p) => p.split(/[\\/]/).pop()).join(", ");
    status.textContent = `Uploaded ${fileList.length} file(s) to ${sourceKey}.`;
  } catch (err) {
    status.textContent = `Upload failed: ${err.message}`;
  }
}

document.getElementById("trigger-btn").addEventListener("click", async () => {
  const summaryEl = document.getElementById("trigger-summary");
  summaryEl.textContent = "Running...";
  try {
    const result = await jsonFetch(`${API}/trigger`, { method: "POST" });
    summaryEl.textContent = JSON.stringify(result, null, 2);
    await Promise.all([loadReview(), loadRules(), loadBalances()]);
  } catch (err) {
    summaryEl.textContent = `Failed: ${err.message}`;
  }
});

async function loadReview() {
  const rows = await jsonFetch(`${API}/transactions?status=needs_review`);
  const tbody = document.querySelector("#review-table tbody");
  tbody.innerHTML = "";
  for (const txn of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${txn.date}</td>
      <td>${txn.source}</td>
      <td>${txn.description}</td>
      <td>${txn.amount.toFixed(2)}</td>
      <td><input type="text" placeholder="Category:Sub" data-role="category" /></td>
      <td><input type="checkbox" data-role="save-rule" checked /></td>
      <td><button data-role="classify">Classify</button></td>
    `;
    tr.querySelector('[data-role="classify"]').addEventListener("click", async () => {
      const category = tr.querySelector('[data-role="category"]').value.trim();
      if (!category) return;
      const saveAsRule = tr.querySelector('[data-role="save-rule"]').checked;
      await jsonFetch(`${API}/transactions/${txn.id}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, save_as_rule: saveAsRule }),
      });
      await Promise.all([loadReview(), loadRules()]);
    });
    tbody.appendChild(tr);
  }
}

function renderSourceSelect() {
  const select = document.getElementById("rule-source");
  select.innerHTML = `<option value="">(any source)</option>` +
    SOURCES.map((s) => `<option value="${s.key}">${s.label}</option>`).join("");
}

function renderAccountSelect() {
  const select = document.getElementById("balance-account");
  select.innerHTML = SOURCES.map((s) => `<option value="${s.account}">${s.account}</option>`).join("");
}

async function loadRules() {
  const rules = await jsonFetch(`${API}/rules`);
  const tbody = document.querySelector("#rules-table tbody");
  tbody.innerHTML = "";
  for (const rule of rules) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${rule.source || "(any)"}</td>
      <td>${rule.match_text}</td>
      <td>${rule.category}</td>
      <td>${rule.priority}</td>
      <td><button data-role="delete">Delete</button></td>
    `;
    tr.querySelector('[data-role="delete"]').addEventListener("click", async () => {
      await jsonFetch(`${API}/rules/${rule.id}`, { method: "DELETE" });
      loadRules();
    });
    tbody.appendChild(tr);
  }
}

document.getElementById("rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    source: form.source.value || null,
    match_text: form.match_text.value.trim(),
    category: form.category.value.trim(),
    priority: Number(form.priority.value) || 100,
  };
  await jsonFetch(`${API}/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  form.reset();
  form.priority.value = 100;
  loadRules();
});

async function loadBalances() {
  const balances = await jsonFetch(`${API}/manual-balances`);
  const tbody = document.querySelector("#balances-table tbody");
  tbody.innerHTML = "";
  for (const b of balances) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${b.account}</td><td>${b.month}</td><td>${b.balance.toFixed(2)}</td>`;
    tbody.appendChild(tr);
  }
}

document.getElementById("balance-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    account: form.account.value,
    month: form.month.value,
    balance: Number(form.balance.value),
  };
  await jsonFetch(`${API}/manual-balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  form.reset();
  loadBalances();
});

(async function init() {
  await loadSources();
  await Promise.all([loadReview(), loadRules(), loadBalances()]);
})();
