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

function skeletonRows(tbody, cols, rows = 3) {
  tbody.innerHTML = Array.from({ length: rows })
    .map(() => `<tr>${`<td><div class="skeleton"></div></td>`.repeat(cols)}</tr>`)
    .join("");
}

function setEmpty(el, show, text) {
  el.hidden = !show;
  if (show) el.textContent = text;
}

let SOURCES = [];
let CATEGORIES = [];
const zoneFiles = {};

async function loadSources() {
  SOURCES = await jsonFetch(`${API}/sources`);
  renderDropZones();
  renderSourceSelect();
  renderAccountSelect();
}

async function loadCategories() {
  CATEGORIES = await jsonFetch(`${API}/categories`);
}

function categoryOptionsHtml(selected = "") {
  return (
    `<option value="" ${selected ? "" : "selected"} disabled>Select…</option>` +
    CATEGORIES.map((c) => `<option value="${c}" ${c === selected ? "selected" : ""}>${c}</option>`).join("")
  );
}

function sourceOptionsHtml(selected = "") {
  return (
    `<option value="" ${selected ? "" : "selected"}>(any source)</option>` +
    SOURCES.map(
      (s) => `<option value="${s.key}" ${s.key === selected ? "selected" : ""}>${s.label}</option>`
    ).join("")
  );
}

function renderDropZones() {
  const container = document.getElementById("drop-zones");
  container.innerHTML = SOURCES.map(
    (s) => `
      <div class="drop-zone" data-zone="${s.key}" tabindex="0" role="button" aria-label="Upload ${s.label} files">
        <div class="zone-label">${s.label}</div>
        <div class="zone-hint">click or drop .csv</div>
        <ul class="file-list"></ul>
      </div>`
  ).join("");

  for (const source of SOURCES) {
    const zone = container.querySelector(`[data-zone="${source.key}"]`);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv";
    input.multiple = true;
    input.hidden = true;
    zone.appendChild(input);

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        input.click();
      }
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("dragover");
      uploadFiles(source.key, e.dataTransfer.files);
    });
    input.addEventListener("change", () => {
      uploadFiles(source.key, input.files);
      input.value = "";
    });
  }
}

function renderFileList(sourceKey) {
  const zone = document.querySelector(`[data-zone="${sourceKey}"]`);
  const ul = zone.querySelector(".file-list");
  const files = zoneFiles[sourceKey] || [];
  ul.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.className = f.status;
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const name = document.createElement("span");
    name.textContent = f.name;
    name.title = f.name;
    li.append(dot, name);
    ul.appendChild(li);
  }
}

async function uploadFiles(sourceKey, fileList) {
  if (!fileList || fileList.length === 0) return;
  const entries = Array.from(fileList).map((file) => ({ file, name: file.name, status: "pending" }));
  zoneFiles[sourceKey] = [...(zoneFiles[sourceKey] || []), ...entries];
  renderFileList(sourceKey);

  const formData = new FormData();
  for (const e of entries) formData.append("files", e.file);

  try {
    await jsonFetch(`${API}/upload/${sourceKey}`, { method: "POST", body: formData });
    entries.forEach((e) => (e.status = "done"));
  } catch (err) {
    entries.forEach((e) => (e.status = "failed"));
  }
  renderFileList(sourceKey);
}

document.getElementById("trigger-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const summaryEl = document.getElementById("trigger-summary");
  btn.disabled = true;
  summaryEl.textContent = "Running…";
  try {
    const result = await jsonFetch(`${API}/trigger`, { method: "POST" });
    summaryEl.textContent = JSON.stringify(result, null, 2);
    await Promise.all([loadReview(), loadRules(), loadBalances()]);
  } catch (err) {
    summaryEl.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

async function loadReview() {
  const table = document.getElementById("review-table");
  const tbody = table.querySelector("tbody");
  const emptyEl = document.getElementById("review-empty");
  skeletonRows(tbody, 7);
  table.hidden = false;
  emptyEl.hidden = true;

  const rows = await jsonFetch(`${API}/transactions?status=needs_review`);
  tbody.innerHTML = "";
  setEmpty(emptyEl, rows.length === 0, "Nothing to review — every transaction matched a rule.");
  table.hidden = rows.length === 0;
  document.getElementById("review-count").textContent =
    rows.length === 0 ? "" : `(${rows.length} transaction${rows.length === 1 ? "" : "s"})`;

  for (const txn of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-cell="date"></td>
      <td data-cell="source"></td>
      <td class="truncate" data-cell="description"></td>
      <td class="num" data-cell="amount"></td>
      <td><select data-role="category">${categoryOptionsHtml()}</select></td>
      <td>
        <div style="display:flex; flex-direction:column; gap:4px;">
          <select data-role="rule-source" title="Which source this rule applies to">${sourceOptionsHtml(txn.source)}</select>
          <input type="text" data-role="match-text" placeholder="keyword for rule" style="width:18em" />
        </div>
      </td>
      <td>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button data-role="apply" type="button" title="Set the category on this transaction only, no rule">Apply</button>
          <button data-role="save-rule" type="button" class="primary" title="Set the category and create a keyword rule for future transactions">Save as rule</button>
        </div>
        <div class="field-error" data-role="error"></div>
      </td>
    `;
    tr.querySelector('[data-cell="date"]').textContent = txn.date;
    tr.querySelector('[data-cell="source"]').textContent = txn.source;
    const descCell = tr.querySelector('[data-cell="description"]');
    descCell.textContent = txn.description;
    descCell.title = txn.description;
    tr.querySelector('[data-cell="amount"]').textContent = txn.amount.toFixed(2);

    const categorySelect = tr.querySelector('[data-role="category"]');
    const ruleSourceSelect = tr.querySelector('[data-role="rule-source"]');
    const matchTextInput = tr.querySelector('[data-role="match-text"]');
    const errorEl = tr.querySelector('[data-role="error"]');
    matchTextInput.value = txn.description;

    async function submitClassify(saveAsRule) {
      errorEl.textContent = "";
      categorySelect.classList.remove("invalid");
      matchTextInput.classList.remove("invalid");

      const category = categorySelect.value;
      const matchText = matchTextInput.value.trim();

      if (!category) {
        categorySelect.classList.add("invalid");
        errorEl.textContent = "Pick a category first.";
        return;
      }
      if (saveAsRule && !matchText) {
        matchTextInput.classList.add("invalid");
        errorEl.textContent = "Keyword can't be empty — trim the description down to the phrase that identifies this rule (or use Apply for a one-off).";
        return;
      }

      try {
        await jsonFetch(`${API}/transactions/${txn.id}/classify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            save_as_rule: saveAsRule,
            match_text: saveAsRule ? matchText : null,
            source: saveAsRule ? ruleSourceSelect.value || null : null,
          }),
        });
        // Saving a rule re-enriches server-side, so every other matching
        // needs_review row is reclassified immediately — reloading here is
        // what makes them disappear from the list right away.
        await Promise.all([loadReview(), loadRules()]);
      } catch (err) {
        errorEl.textContent = err.message;
      }
    }

    tr.querySelector('[data-role="apply"]').addEventListener("click", () => submitClassify(false));
    tr.querySelector('[data-role="save-rule"]').addEventListener("click", () => submitClassify(true));

    tbody.appendChild(tr);
  }
}

function renderSourceSelect() {
  document.getElementById("rule-source").innerHTML = sourceOptionsHtml();
}

function renderAccountSelect() {
  const select = document.getElementById("balance-account");
  select.innerHTML = SOURCES.map((s) => `<option value="${s.account}">${s.account}</option>`).join("");
}

function renderCategorySelect() {
  const select = document.getElementById("rule-category");
  select.innerHTML = categoryOptionsHtml();
}

async function loadRules() {
  const tbody = document.querySelector("#rules-table tbody");
  const emptyEl = document.getElementById("rules-empty");
  skeletonRows(tbody, 5);

  const rules = await jsonFetch(`${API}/rules`);
  tbody.innerHTML = "";
  setEmpty(emptyEl, rules.length === 0, "No rules yet — classify a transaction and save it as a rule.");
  document.getElementById("rules-table").hidden = rules.length === 0;

  for (const rule of rules) {
    tbody.appendChild(renderRuleRow(rule));
  }
}

function renderRuleRow(rule) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td data-cell="source"></td>
    <td class="truncate" data-cell="match"></td>
    <td data-cell="category"></td>
    <td class="num" data-cell="priority"></td>
    <td>
      <div style="display:flex; gap:4px;">
        <button data-role="edit" class="ghost" type="button">Edit</button>
        <button data-role="delete" class="ghost" type="button">Delete</button>
      </div>
      <div class="field-error" data-role="error"></div>
    </td>
  `;
  tr.querySelector('[data-cell="source"]').textContent = rule.source || "(any)";
  const matchCell = tr.querySelector('[data-cell="match"]');
  matchCell.textContent = rule.match_text;
  matchCell.title = rule.match_text;
  tr.querySelector('[data-cell="category"]').textContent = rule.category;
  tr.querySelector('[data-cell="priority"]').textContent = rule.priority;

  tr.querySelector('[data-role="delete"]').addEventListener("click", async () => {
    // Deleting can revert the last batch's transactions this rule
    // classified back to needs_review — refresh both lists so that shows up
    // (the Needs Review count ticking back up is the visible confirmation).
    await jsonFetch(`${API}/rules/${rule.id}`, { method: "DELETE" });
    await Promise.all([loadRules(), loadReview()]);
  });

  tr.querySelector('[data-role="edit"]').addEventListener("click", () => {
    tr.replaceWith(renderRuleEditRow(rule));
  });

  return tr;
}

function renderRuleEditRow(rule) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select data-role="source">${sourceOptionsHtml(rule.source || "")}</select></td>
    <td><input type="text" data-role="match" style="width:100%" /></td>
    <td><select data-role="category">${categoryOptionsHtml(rule.category)}</select></td>
    <td><input type="number" data-role="priority" style="width:5em" /></td>
    <td>
      <div style="display:flex; gap:4px;">
        <button data-role="save" class="primary" type="button">Save</button>
        <button data-role="cancel" class="ghost" type="button">Cancel</button>
      </div>
      <div class="field-error" data-role="error"></div>
    </td>
  `;
  const matchInput = tr.querySelector('[data-role="match"]');
  matchInput.value = rule.match_text;
  tr.querySelector('[data-role="priority"]').value = rule.priority;
  const errorEl = tr.querySelector('[data-role="error"]');

  tr.querySelector('[data-role="cancel"]').addEventListener("click", () => {
    tr.replaceWith(renderRuleRow(rule));
  });

  tr.querySelector('[data-role="save"]').addEventListener("click", async () => {
    const body = {
      source: tr.querySelector('[data-role="source"]').value || null,
      match_text: matchInput.value.trim(),
      category: tr.querySelector('[data-role="category"]').value,
      priority: Number(tr.querySelector('[data-role="priority"]').value) || 100,
    };
    if (!body.match_text) {
      errorEl.textContent = "Keyword can't be empty.";
      return;
    }
    if (!body.category) {
      errorEl.textContent = "Pick a category.";
      return;
    }
    try {
      await jsonFetch(`${API}/rules/${rule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // Edits re-analyze only the last uploaded batch, not full history.
      await Promise.all([loadRules(), loadReview()]);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  return tr;
}

document.getElementById("rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const errorEl = document.getElementById("rule-error");
  errorEl.textContent = "";
  const body = {
    source: form.source.value || null,
    match_text: form.match_text.value.trim(),
    category: form.category.value,
    priority: Number(form.priority.value) || 100,
  };
  if (!body.category) {
    errorEl.textContent = "Pick a category.";
    return;
  }
  try {
    await jsonFetch(`${API}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    form.reset();
    form.priority.value = 100;
    // Adding a rule here re-enriches server-side too (same as Save as rule
    // in the review row) — refresh Needs Review so matches vanish right away.
    await Promise.all([loadRules(), loadReview()]);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

async function loadBalances() {
  const tbody = document.querySelector("#balances-table tbody");
  const emptyEl = document.getElementById("balances-empty");
  skeletonRows(tbody, 3);

  const balances = await jsonFetch(`${API}/manual-balances`);
  tbody.innerHTML = "";
  setEmpty(emptyEl, balances.length === 0, "No manual balances recorded yet.");
  document.getElementById("balances-table").hidden = balances.length === 0;

  for (const b of balances) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td data-cell="account"></td><td data-cell="month"></td><td class="num" data-cell="balance"></td>`;
    tr.querySelector('[data-cell="account"]').textContent = b.account;
    tr.querySelector('[data-cell="month"]').textContent = b.month;
    tr.querySelector('[data-cell="balance"]').textContent = b.balance.toFixed(2);
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
  await Promise.all([loadSources(), loadCategories()]);
  renderCategorySelect();
  await Promise.all([loadReview(), loadRules(), loadBalances()]);
})();
