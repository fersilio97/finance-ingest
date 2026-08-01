import { merchantKey } from "./merchant-key.js";
import { suggestKeyword, matchesKeyword, ruleAppliesToSource, sourceScopesOverlap } from "./rule-keyword.js";

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

function skeletonGroupRows(tbody, rows = 6) {
  // Skeleton in the *collapsed-group* shape (8 cols), not the old per-row
  // shape, so the layout doesn't jump when real data lands (spec 002 §E).
  tbody.innerHTML = Array.from({ length: rows })
    .map(() => `<tr class="group-row skeleton-row">${`<td><div class="skeleton"></div></td>`.repeat(8)}</tr>`)
    .join("");
}

function setEmpty(el, show, text) {
  el.hidden = !show;
  if (show) el.textContent = text;
}

let SOURCES = [];
let CATEGORIES = [];
let RULES = [];
let NEEDS_REVIEW = null; // null = not loaded / load failed
let CLASSIFIED = null;
const GROUPS = new Map(); // merchantKey -> { key, members, rowEl, memberRowEls }
const expandedKeys = new Set();
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

// ---------------------------------------------------------------------------
// Needs Review — grouped by merchant (spec 002)
// ---------------------------------------------------------------------------

function buildGroups(rows) {
  const map = new Map();
  for (const txn of rows) {
    const key = merchantKey(txn.description);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(txn);
  }
  const groups = Array.from(map.entries()).map(([key, members]) => ({ key, members, rowEl: null, memberRowEls: null }));
  groups.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
  return groups;
}

function groupStats(members) {
  const dates = members.map((m) => m.date).slice().sort();
  const amounts = members.map((m) => m.amount);
  const total = amounts.reduce((s, a) => s + a, 0);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const spansSign = min < 0 && max > 0;
  const absAmounts = amounts.map((a) => Math.abs(a)).filter((a) => a > 0.001);
  const minAbs = absAmounts.length ? Math.min(...absAmounts) : 0;
  const maxAbs = absAmounts.length ? Math.max(...absAmounts) : 0;
  const wideSpread = minAbs > 0 && maxAbs / minAbs > 50;
  return {
    count: members.length,
    dateFrom: dates[0],
    dateTo: dates[dates.length - 1],
    total,
    min,
    max,
    variance: spansSign || wideSpread,
  };
}

// The suggested keyword for a *group* comes from its shared tokens, not one
// arbitrary member (spec 002 §C) — take each of the first 5 members' own
// 001 suggestion and keep only the leading words every sampled member agrees on.
function suggestGroupKeyword(members) {
  const sample = members
    .slice(0, 5)
    .map((m) => suggestKeyword(m.description))
    .filter(Boolean);
  if (sample.length === 0) return "";
  const wordLists = sample.map((s) => s.split(" "));
  let common = wordLists[0];
  for (const words of wordLists.slice(1)) {
    let i = 0;
    while (i < common.length && i < words.length && words[i] === common[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return common.join(" ");
}

function findDuplicateRule(matchText, ruleSource) {
  const kw = matchText.trim().toLowerCase();
  return RULES.find((r) => r.match_text.toLowerCase() === kw && (r.source || null) === (ruleSource || null));
}

// Shadowing (rule-vs-rule) + over-broad-match (rule-vs-data) warnings — 001 §C.
// `newPriority` defaults to 100, matching every rule the review queue itself
// creates; the standalone Rules form is the only surface where it can differ.
function computeWarnings({ keyword, ruleSource, matches, newPriority = 100 }) {
  const warnings = [];
  const kw = keyword.toLowerCase();

  for (const rule of RULES) {
    if (!sourceScopesOverlap(ruleSource || null, rule.source || null)) continue;
    const existing = rule.match_text.toLowerCase();
    if (existing === kw) continue; // duplicate — handled as a hard block elsewhere
    const existingFiresFirst = rule.priority <= newPriority;
    if (kw.includes(existing) && existingFiresFirst) {
      warnings.push(
        `“${keyword}” will never fire — rule #${rule.id} “${rule.match_text}” ` +
          `(${rule.source || "any source"}) → ${rule.category} already matches everything this would, and it was created first.`
      );
    } else if (existing.includes(kw) && !kw.includes(existing)) {
      warnings.push(
        `This keyword also swallows rule #${rule.id} “${rule.match_text}” ` +
          `(${rule.source || "any source"}) → ${rule.category}. Transactions that rule catches today may change category.`
      );
    }
  }

  if (matches.length > 0) {
    const keyCounts = new Map();
    for (const t of matches) {
      const k = merchantKey(t.description);
      keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
    }
    const sorted = [...keyCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [dominantKey, dominantCount] = sorted[0];
    const unrelatedCount = matches.length - dominantCount;
    // "Dominant" only means something if it's an actual majority. With e.g.
    // 4 matches that are 4 different merchant keys (a generic word like
    // "cafe" hitting several unrelated cafes), whichever key happens to sort
    // first isn't meaningfully "the real merchant" — the warning must not
    // claim it is.
    const hasRealMajority = dominantCount > matches.length / 2;

    if (sorted.length > 1 && unrelatedCount > 0) {
      const others = matches.filter((t) => merchantKey(t.description) !== dominantKey);
      // Among the outliers, prefer surfacing a transfer-like row (Zelle/Venmo/
      // person-to-person) — that's the highest-signal false positive this
      // warning exists to catch (a keyword coincidentally matching a payment
      // memo, not a merchant), not just whichever non-dominant row sorts first.
      const TRANSFER_HINT = /\bzelle\b|\bvenmo\b|payment (from|to)\b/i;
      const example = others.find((t) => TRANSFER_HINT.test(t.description)) || others[0];

      warnings.push(
        hasRealMajority
          ? `${dominantCount} of the ${matches.length} matches are “${dominantKey}”, but ${unrelatedCount} ` +
              `look${unrelatedCount === 1 ? "s" : ""} unrelated — “${example.description}”.`
          : `These ${matches.length} matches don't look like one merchant — e.g. “${example.description}”. Check the list before saving.`
      );
    }
  }

  return warnings;
}

// --- Live match preview + warnings, shared by every keyword input on the
// page (grouped rows, expanded member rows, and the standalone rule form).
// One DOM subtree, reparented under whichever row is currently active —
// this is what keeps 263 collapsed rows from each paying for their own
// (mostly-empty) preview area on first paint.
let sharedPreviewTr = null;
let previewDebounce = null;

function ensureSharedPreviewRow() {
  if (sharedPreviewTr) return sharedPreviewTr;
  const tr = document.createElement("tr");
  tr.className = "preview-row";
  tr.hidden = true;
  const td = document.createElement("td");
  td.colSpan = 8;
  td.innerHTML =
    `<div class="preview-line muted" data-role="preview-text"></div>` +
    `<div class="warnings" data-role="warnings" hidden></div>`;
  tr.appendChild(td);
  sharedPreviewTr = tr;
  return tr;
}

function renderPreviewAndWarnings({ textEl, warnEl, keyword, sourceScope, newPriority = 100 }) {
  if (NEEDS_REVIEW === null || CLASSIFIED === null) {
    textEl.className = "preview-line muted";
    textEl.textContent = "Couldn't check matches — the rule can still be saved.";
    warnEl.hidden = true;
    warnEl.innerHTML = "";
    return;
  }

  const nrMatches = NEEDS_REVIEW.filter(
    (t) => matchesKeyword(t.description, keyword) && ruleAppliesToSource(sourceScope, t.source)
  );
  const clMatches = CLASSIFIED.filter(
    (t) => matchesKeyword(t.description, keyword) && ruleAppliesToSource(sourceScope, t.source)
  );
  const total = nrMatches.length + clMatches.length;

  textEl.innerHTML = "";
  if (total === 0) {
    textEl.className = "preview-line muted";
    textEl.textContent = "Matches nothing — check the spelling, or use Apply for a one-off.";
  } else {
    textEl.className = "preview-line";
    const strong = document.createElement("strong");
    strong.textContent = `Matches ${total} transaction${total === 1 ? "" : "s"}`;
    const rest = document.createElement("span");
    rest.textContent = ` — ${nrMatches.length} waiting for review, ${clMatches.length} already classified. `;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ghost preview-show";
    btn.textContent = "Show";
    btn.addEventListener("click", () => {
      const all = [...nrMatches, ...clMatches];
      const shown = all.slice(0, 10);
      const overflow = all.length - shown.length;
      const ul = document.createElement("ul");
      ul.className = "preview-match-list";
      for (const t of shown) {
        const li = document.createElement("li");
        li.textContent = `${t.date} · ${t.amount.toFixed(2)} · ${t.description}`;
        li.title = t.description;
        ul.appendChild(li);
      }
      if (overflow > 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = `…and ${overflow} more`;
        ul.appendChild(li);
      }
      btn.replaceWith(ul);
    });
    textEl.append(strong, rest, btn);
  }

  const advisory = [];
  if (keyword.length > 0 && keyword.length < 3) {
    advisory.push(`“${keyword}” is very short — it will match inside other words.`);
  }
  advisory.push(...computeWarnings({ keyword, ruleSource: sourceScope, matches: [...nrMatches, ...clMatches], newPriority }));

  warnEl.innerHTML = "";
  if (advisory.length === 0) {
    warnEl.hidden = true;
  } else {
    warnEl.hidden = false;
    for (const w of advisory) {
      const div = document.createElement("div");
      div.className = "warning-item";
      div.textContent = `⚠ ${w}`;
      warnEl.appendChild(div);
    }
  }
}

function attachKeywordBehavior(input, { getSourceScope, rowEl }) {
  const showAndCompute = () => {
    const tr = ensureSharedPreviewRow();
    rowEl.after(tr);
    tr.hidden = false;
    const textEl = tr.querySelector('[data-role="preview-text"]');
    const warnEl = tr.querySelector('[data-role="warnings"]');
    const keyword = input.value.trim();

    clearTimeout(previewDebounce);
    if (!keyword) {
      textEl.className = "preview-line muted";
      textEl.textContent = "Type a keyword to see what it will match.";
      warnEl.hidden = true;
      warnEl.innerHTML = "";
      return;
    }
    textEl.className = "preview-line muted";
    textEl.innerHTML = `<div class="skeleton" style="width:220px"></div>`;
    warnEl.hidden = true;
    previewDebounce = setTimeout(() => {
      renderPreviewAndWarnings({ textEl, warnEl, keyword, sourceScope: getSourceScope() });
    }, 200);
  };

  input.addEventListener("input", showAndCompute);
  input.addEventListener("focus", () => {
    input.select();
    showAndCompute();
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!input.value.trim() && sharedPreviewTr) sharedPreviewTr.hidden = true;
    }, 150);
  });
}

// --- Lazy-hydrated controls -------------------------------------------------
// The category select (21 options) is the single biggest DOM cost in the old
// row-per-transaction layout (24,998 <option> nodes across 862 rows). Every
// collapsed row still needs one, but the full option list is only built the
// first time it's actually opened — most of 263 rows never get touched in a
// given session. Rule-source stays eager (7 options, cheap, and its default
// value matters before the user ever focuses it).

function buildCategorySelect(selected) {
  const select = document.createElement("select");
  select.dataset.role = "category";
  select.dataset.hydrated = "0";
  select.innerHTML = `<option value="" selected>Select…</option>`;
  const hydrate = () => {
    if (select.dataset.hydrated === "1") return;
    select.dataset.hydrated = "1";
    select.innerHTML = categoryOptionsHtml(selected || "");
  };
  select.addEventListener("focus", hydrate);
  select.addEventListener("mousedown", hydrate);
  return select;
}

function buildRuleSourceSelect(selected) {
  const select = document.createElement("select");
  select.dataset.role = "rule-source";
  select.innerHTML = sourceOptionsHtml(selected || "");
  return select;
}

// --- Classify actions --------------------------------------------------------

async function performClassify({ txnId, description, categorySelect, saveAsRule, keywordInput, ruleSourceSelect, errorEl, onRemoved }) {
  errorEl.textContent = "";
  categorySelect.classList.remove("invalid");
  keywordInput.classList.remove("invalid");

  const category = categorySelect.value;
  const matchText = keywordInput.value.trim();
  const ruleSource = ruleSourceSelect.value || null;

  if (!category) {
    categorySelect.classList.add("invalid");
    errorEl.textContent = "Pick a category first.";
    return;
  }
  if (saveAsRule) {
    if (!description || !description.trim() || description.trim().toLowerCase() === "no description") {
      errorEl.textContent =
        "This description is empty — a keyword rule can't identify it. Use Apply to categorise this one transaction.";
      return;
    }
    if (!matchText) {
      keywordInput.classList.add("invalid");
      errorEl.textContent =
        "Keyword can't be empty — trim the description down to the phrase that identifies this rule (or use Apply for a one-off).";
      return;
    }
    const dup = findDuplicateRule(matchText, ruleSource);
    if (dup) {
      keywordInput.classList.add("invalid");
      errorEl.textContent = `Rule #${dup.id} already matches "${matchText}" for this source.`;
      return;
    }
  }

  try {
    const res = await jsonFetch(`${API}/transactions/${txnId}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category,
        save_as_rule: saveAsRule,
        match_text: saveAsRule ? matchText : null,
        source: saveAsRule ? ruleSource : null,
      }),
    });

    let removedIds;
    if (saveAsRule) {
      removedIds = (NEEDS_REVIEW || [])
        .filter((t) => matchesKeyword(t.description, matchText) && ruleAppliesToSource(ruleSource, t.source))
        .map((t) => t.id);
      if (!removedIds.includes(txnId)) removedIds.push(txnId);
      await loadRules();
    } else {
      removedIds = [txnId];
    }
    removeTxnsFromReview(removedIds);
    onRemoved?.();

    if (saveAsRule) {
      // The originating row was classified directly (not by the re-enrich
      // sweep), so enrich.classified only counts the *other* rows the new
      // rule caught — the real total this action produced is that plus one.
      const total = (res.enrich?.classified ?? 0) + 1;
      setStatus(`Saved. ${total} transaction${total === 1 ? "" : "s"} classified as ${category}.`);
    } else {
      setStatus(`Applied ${category} to 1 transaction.`);
    }
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function performGroupSave({ group, categorySelect, keywordInput, ruleSourceSelect, errorEl }) {
  errorEl.textContent = "";
  categorySelect.classList.remove("invalid");
  keywordInput.classList.remove("invalid");

  const category = categorySelect.value;
  const matchText = keywordInput.value.trim();
  const ruleSource = ruleSourceSelect.value || null;

  if (!category) {
    categorySelect.classList.add("invalid");
    errorEl.textContent = "Pick a category first.";
    return;
  }
  const allNoDescription = group.members.every(
    (m) => !m.description || !m.description.trim() || m.description.trim().toLowerCase() === "no description"
  );
  if (allNoDescription) {
    errorEl.textContent =
      "This description is empty — a keyword rule can't identify it. Expand the group and use Apply on each transaction instead.";
    return;
  }
  if (!matchText) {
    keywordInput.classList.add("invalid");
    errorEl.textContent = "Keyword can't be empty.";
    return;
  }
  const dup = findDuplicateRule(matchText, ruleSource);
  if (dup) {
    keywordInput.classList.add("invalid");
    errorEl.textContent = `Rule #${dup.id} already matches "${matchText}" for this source.`;
    return;
  }

  try {
    const res = await jsonFetch(`${API}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: ruleSource, match_text: matchText, category, priority: 100 }),
    });
    const removedIds = (NEEDS_REVIEW || [])
      .filter((t) => matchesKeyword(t.description, matchText) && ruleAppliesToSource(ruleSource, t.source))
      .map((t) => t.id);
    await loadRules();
    removeTxnsFromReview(removedIds);
    const classifiedTotal = res.enrich?.classified ?? removedIds.length;
    const remaining = NEEDS_REVIEW ? NEEDS_REVIEW.length : 0;
    setStatus(
      `Saved rule "${matchText}" → ${category}. ${classifiedTotal} transaction${classifiedTotal === 1 ? "" : "s"} classified; ${remaining} still to review.`
    );
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function setStatus(text) {
  const el = document.getElementById("review-status");
  el.hidden = false;
  el.textContent = text;
}

// --- In-place updates (spec 002 §F.4) ---------------------------------------
// Never rebuilds the whole table after an action. Re-scans the *cache* (an
// in-memory filter over <1000 rows, sub-millisecond) for every group that
// lost a member — including groups other than the one just acted on, which
// matters when a saved keyword turns out to be broader than intended.

function removeTxnsFromReview(ids) {
  const idSet = new Set(ids);
  if (idSet.size === 0 || !NEEDS_REVIEW) return;
  NEEDS_REVIEW = NEEDS_REVIEW.filter((t) => !idSet.has(t.id));

  const touchedKeys = [];
  for (const [key, group] of GROUPS) {
    const before = group.members.length;
    group.members = group.members.filter((t) => !idSet.has(t.id));
    if (group.members.length !== before) touchedKeys.push(key);
  }
  for (const key of touchedKeys) {
    const group = GROUPS.get(key);
    if (group.members.length === 0) {
      removeGroupFromDom(group);
      GROUPS.delete(key);
    } else {
      refreshGroupHeaderDom(group);
    }
  }

  updateReviewCountHeading();
  const emptyEl = document.getElementById("review-empty");
  const table = document.getElementById("review-table");
  if (NEEDS_REVIEW.length === 0) {
    setEmpty(emptyEl, true, "Nothing to review — every transaction matched a rule.");
    table.hidden = true;
  }
}

function removeGroupFromDom(group) {
  if (sharedPreviewTr && group.rowEl && sharedPreviewTr.previousElementSibling === group.rowEl) {
    sharedPreviewTr.hidden = true;
  }
  if (group.memberRowEls) {
    for (const el of group.memberRowEls) el.remove();
  }
  if (group.rowEl) group.rowEl.remove();
  expandedKeys.delete(group.key);
}

function refreshGroupHeaderDom(group) {
  const tr = group.rowEl;
  if (!tr) return;
  const stats = groupStats(group.members);
  const countCell = tr.querySelector('[data-cell="count"]');
  const dateCell = tr.querySelector('[data-cell="daterange"]');
  const amountCell = tr.querySelector('[data-cell="amountrange"]');
  const varianceCell = tr.querySelector('[data-cell="variance"]');
  if (countCell) countCell.textContent = `${stats.count} transaction${stats.count === 1 ? "" : "s"}`;
  if (dateCell) dateCell.textContent = stats.dateFrom === stats.dateTo ? stats.dateFrom : `${stats.dateFrom} → ${stats.dateTo}`;
  if (amountCell) amountCell.textContent = `${stats.total.toFixed(2)} (${stats.min.toFixed(2)} to ${stats.max.toFixed(2)})`;
  if (varianceCell) {
    varianceCell.hidden = !stats.variance;
    if (stats.variance) varianceCell.textContent = "Amounts vary a lot — worth expanding before making one rule.";
  }
}

function updateReviewCountHeading() {
  const el = document.getElementById("review-count");
  const n = NEEDS_REVIEW ? NEEDS_REVIEW.length : 0;
  const groupCount = GROUPS.size;
  el.textContent = n === 0 ? "" : `(${n} transaction${n === 1 ? "" : "s"} · ${groupCount} group${groupCount === 1 ? "" : "s"})`;
}

// --- Expand / collapse -------------------------------------------------------

function toggleGroupExpand(group) {
  if (expandedKeys.has(group.key)) {
    collapseGroup(group);
  } else {
    expandGroup(group);
  }
}

function expandGroup(group) {
  expandedKeys.add(group.key);
  const disclosureBtn = group.rowEl?.querySelector('[data-role="disclosure"]');
  if (disclosureBtn) {
    disclosureBtn.setAttribute("aria-expanded", "true");
    disclosureBtn.textContent = "▾";
  }
  const memberEls = [];
  let anchor = group.rowEl;
  for (const member of group.members) {
    const tr = createMemberRow(group, member);
    anchor.after(tr);
    anchor = tr;
    memberEls.push(tr);
  }
  group.memberRowEls = memberEls;
}

function collapseGroup(group) {
  expandedKeys.delete(group.key);
  const disclosureBtn = group.rowEl?.querySelector('[data-role="disclosure"]');
  if (disclosureBtn) {
    disclosureBtn.setAttribute("aria-expanded", "false");
    disclosureBtn.textContent = "▸";
  }
  if (group.memberRowEls) {
    for (const el of group.memberRowEls) {
      if (sharedPreviewTr && sharedPreviewTr.previousElementSibling === el) sharedPreviewTr.hidden = true;
      el.remove();
    }
    group.memberRowEls = null;
  }
}

// --- Row builders -------------------------------------------------------------

function createMemberRow(group, member) {
  const tr = document.createElement("tr");
  tr.className = "member-row";
  tr.dataset.memberId = String(member.id);
  tr.innerHTML = `
    <td class="truncate" data-cell="desc"></td>
    <td></td>
    <td data-cell="date"></td>
    <td class="num" data-cell="amount"></td>
    <td data-cell="category"></td>
    <td data-cell="rulesource"></td>
    <td data-cell="keyword"></td>
    <td data-cell="actions"></td>
  `;
  const descCell = tr.querySelector('[data-cell="desc"]');
  descCell.textContent = "↳ " + member.description;
  descCell.title = member.description;
  tr.querySelector('[data-cell="date"]').textContent = member.date;
  tr.querySelector('[data-cell="amount"]').textContent = member.amount.toFixed(2);

  const categorySelect = buildCategorySelect("");
  tr.querySelector('[data-cell="category"]').appendChild(categorySelect);
  const ruleSourceSelect = buildRuleSourceSelect(member.source);
  tr.querySelector('[data-cell="rulesource"]').appendChild(ruleSourceSelect);
  const keywordInput = document.createElement("input");
  keywordInput.type = "text";
  keywordInput.placeholder = "keyword for rule";
  keywordInput.autocomplete = "off";
  keywordInput.value = suggestKeyword(member.description);
  tr.querySelector('[data-cell="keyword"]').appendChild(keywordInput);

  const actionsCell = tr.querySelector('[data-cell="actions"]');
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.textContent = "Apply";
  applyBtn.title = "Set the category on this transaction only, no rule";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "Save as rule";
  const errorEl = document.createElement("div");
  errorEl.className = "field-error";
  actionsCell.append(applyBtn, saveBtn, errorEl);

  attachKeywordBehavior(keywordInput, { getSourceScope: () => ruleSourceSelect.value || null, rowEl: tr });

  applyBtn.addEventListener("click", () =>
    performClassify({
      txnId: member.id,
      description: member.description,
      categorySelect,
      saveAsRule: false,
      keywordInput,
      ruleSourceSelect,
      errorEl,
      onRemoved: () => tr.remove(),
    })
  );
  saveBtn.addEventListener("click", () =>
    performClassify({
      txnId: member.id,
      description: member.description,
      categorySelect,
      saveAsRule: true,
      keywordInput,
      ruleSourceSelect,
      errorEl,
      onRemoved: () => tr.remove(),
    })
  );

  return tr;
}

function createGroupRow(group) {
  const tr = document.createElement("tr");
  tr.className = "group-row";
  tr.dataset.groupKey = group.key;
  const stats = groupStats(group.members);
  const firstDesc = group.members[0].description;

  tr.innerHTML = `
    <td data-cell="merchant">
      <button type="button" class="disclosure" data-role="disclosure" aria-expanded="false" title="Expand group">▸</button>
      <span class="merchant-label" data-cell="label"></span>
      <div class="variance-note muted" data-cell="variance" hidden></div>
    </td>
    <td class="num" data-cell="count"></td>
    <td data-cell="daterange"></td>
    <td class="num" data-cell="amountrange"></td>
    <td data-cell="category"></td>
    <td data-cell="rulesource"></td>
    <td data-cell="keyword"></td>
    <td data-cell="actions"></td>
  `;

  tr.querySelector('[data-cell="label"]').textContent = group.key || "(uncategorised)";
  tr.querySelector('[data-cell="merchant"]').title = firstDesc;
  tr.querySelector('[data-cell="count"]').textContent = `${stats.count} transactions`;
  tr.querySelector('[data-cell="daterange"]').textContent = `${stats.dateFrom} → ${stats.dateTo}`;
  tr.querySelector('[data-cell="amountrange"]').textContent =
    `${stats.total.toFixed(2)} (${stats.min.toFixed(2)} to ${stats.max.toFixed(2)})`;
  if (stats.variance) {
    const noteEl = tr.querySelector('[data-cell="variance"]');
    noteEl.hidden = false;
    noteEl.textContent = "Amounts vary a lot — worth expanding before making one rule.";
  }

  const categorySelect = buildCategorySelect("");
  tr.querySelector('[data-cell="category"]').appendChild(categorySelect);
  const ruleSourceSelect = buildRuleSourceSelect(group.members[0].source);
  tr.querySelector('[data-cell="rulesource"]').appendChild(ruleSourceSelect);
  const keywordInput = document.createElement("input");
  keywordInput.type = "text";
  keywordInput.placeholder = "keyword for rule";
  keywordInput.autocomplete = "off";
  keywordInput.value = suggestGroupKeyword(group.members);
  tr.querySelector('[data-cell="keyword"]').appendChild(keywordInput);

  const actionsCell = tr.querySelector('[data-cell="actions"]');
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "Save as rule";
  saveBtn.title = "Create a rule from this keyword — classifies every matching transaction now, and every future import";
  const errorEl = document.createElement("div");
  errorEl.className = "field-error";
  actionsCell.append(saveBtn, errorEl);

  attachKeywordBehavior(keywordInput, { getSourceScope: () => ruleSourceSelect.value || null, rowEl: tr });

  saveBtn.addEventListener("click", () => performGroupSave({ group, categorySelect, keywordInput, ruleSourceSelect, errorEl }));

  tr.querySelector('[data-role="disclosure"]').addEventListener("click", () => toggleGroupExpand(group));

  group.rowEl = tr;
  return tr;
}

function createSingletonRow(group) {
  const txn = group.members[0];
  const tr = document.createElement("tr");
  tr.className = "singleton-row";
  tr.dataset.groupKey = group.key;
  tr.innerHTML = `
    <td class="truncate" data-cell="desc"></td>
    <td></td>
    <td data-cell="date"></td>
    <td class="num" data-cell="amount"></td>
    <td data-cell="category"></td>
    <td data-cell="rulesource"></td>
    <td data-cell="keyword"></td>
    <td data-cell="actions"></td>
  `;
  const descCell = tr.querySelector('[data-cell="desc"]');
  descCell.textContent = txn.description;
  descCell.title = txn.description;
  tr.querySelector('[data-cell="date"]').textContent = txn.date;
  tr.querySelector('[data-cell="amount"]').textContent = txn.amount.toFixed(2);

  const categorySelect = buildCategorySelect("");
  tr.querySelector('[data-cell="category"]').appendChild(categorySelect);
  const ruleSourceSelect = buildRuleSourceSelect(txn.source);
  tr.querySelector('[data-cell="rulesource"]').appendChild(ruleSourceSelect);
  const keywordInput = document.createElement("input");
  keywordInput.type = "text";
  keywordInput.placeholder = "keyword for rule";
  keywordInput.autocomplete = "off";
  keywordInput.value = suggestKeyword(txn.description);
  tr.querySelector('[data-cell="keyword"]').appendChild(keywordInput);

  const actionsCell = tr.querySelector('[data-cell="actions"]');
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.textContent = "Apply";
  applyBtn.title = "Set the category on this transaction only, no rule";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "Save as rule";
  const errorEl = document.createElement("div");
  errorEl.className = "field-error";
  actionsCell.append(applyBtn, saveBtn, errorEl);

  attachKeywordBehavior(keywordInput, { getSourceScope: () => ruleSourceSelect.value || null, rowEl: tr });

  applyBtn.addEventListener("click", () =>
    performClassify({ txnId: txn.id, description: txn.description, categorySelect, saveAsRule: false, keywordInput, ruleSourceSelect, errorEl })
  );
  saveBtn.addEventListener("click", () =>
    performClassify({ txnId: txn.id, description: txn.description, categorySelect, saveAsRule: true, keywordInput, ruleSourceSelect, errorEl })
  );

  group.rowEl = tr;
  return tr;
}

// --- Load / full render -------------------------------------------------------

async function loadReview() {
  const table = document.getElementById("review-table");
  const tbody = table.querySelector("tbody");
  const emptyEl = document.getElementById("review-empty");
  const errorEl = document.getElementById("review-error");
  const statusEl = document.getElementById("review-status");

  errorEl.hidden = true;
  statusEl.hidden = true;
  skeletonGroupRows(tbody, 6);
  table.hidden = false;
  emptyEl.hidden = true;

  let needsReview, classified;
  try {
    [needsReview, classified] = await Promise.all([
      jsonFetch(`${API}/transactions?status=needs_review`),
      jsonFetch(`${API}/transactions?status=classified`),
    ]);
  } catch (err) {
    tbody.innerHTML = "";
    table.hidden = true;
    errorEl.hidden = false;
    errorEl.textContent = `Couldn't load transactions — ${err.message}.`;
    NEEDS_REVIEW = null;
    CLASSIFIED = null;
    updateReviewCountHeading();
    return;
  }

  NEEDS_REVIEW = needsReview;
  CLASSIFIED = classified;
  expandedKeys.clear();
  renderReviewTable();
}

function renderReviewTable() {
  const table = document.getElementById("review-table");
  const tbody = table.querySelector("tbody");
  const emptyEl = document.getElementById("review-empty");
  tbody.innerHTML = "";
  GROUPS.clear();
  sharedPreviewTr = null; // detached with the old tbody contents

  setEmpty(emptyEl, NEEDS_REVIEW.length === 0, "Nothing to review — every transaction matched a rule.");
  table.hidden = NEEDS_REVIEW.length === 0;
  if (NEEDS_REVIEW.length === 0) {
    updateReviewCountHeading();
    return;
  }

  const groups = buildGroups(NEEDS_REVIEW);
  const frag = document.createDocumentFragment();
  for (const group of groups) {
    GROUPS.set(group.key, group);
    const row = group.members.length === 1 ? createSingletonRow(group) : createGroupRow(group);
    frag.appendChild(row);
  }
  tbody.appendChild(frag);
  updateReviewCountHeading();
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

// ---------------------------------------------------------------------------
// Rules panel
// ---------------------------------------------------------------------------

async function loadRules() {
  const tbody = document.querySelector("#rules-table tbody");
  const emptyEl = document.getElementById("rules-empty");
  skeletonRows(tbody, 5);

  const rules = await jsonFetch(`${API}/rules`);
  RULES = rules;
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

const ruleForm = document.getElementById("rule-form");
const ruleMatchInput = ruleForm.querySelector('[name="match_text"]');
const ruleSourceFormSelect = document.getElementById("rule-source");
const rulePreviewEl = document.getElementById("rule-preview");
const ruleWarningsEl = document.getElementById("rule-warnings");
let ruleFormDebounce = null;

function computeAndShowStandalonePreview() {
  const keyword = ruleMatchInput.value.trim();
  clearTimeout(ruleFormDebounce);
  rulePreviewEl.hidden = false;
  if (!keyword) {
    rulePreviewEl.className = "preview-line muted";
    rulePreviewEl.textContent = "Type a keyword to see what it will match.";
    ruleWarningsEl.hidden = true;
    ruleWarningsEl.innerHTML = "";
    return;
  }
  rulePreviewEl.className = "preview-line muted";
  rulePreviewEl.innerHTML = `<div class="skeleton" style="width:220px"></div>`;
  ruleWarningsEl.hidden = true;
  ruleFormDebounce = setTimeout(() => {
    renderPreviewAndWarnings({
      textEl: rulePreviewEl,
      warnEl: ruleWarningsEl,
      keyword,
      sourceScope: ruleSourceFormSelect.value || null,
      newPriority: Number(ruleForm.priority.value) || 100,
    });
  }, 200);
}
ruleMatchInput.addEventListener("input", computeAndShowStandalonePreview);
ruleMatchInput.addEventListener("focus", () => {
  ruleMatchInput.select();
  computeAndShowStandalonePreview();
});
ruleSourceFormSelect.addEventListener("change", () => {
  if (ruleMatchInput.value.trim()) computeAndShowStandalonePreview();
});

ruleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const errorEl = document.getElementById("rule-error");
  errorEl.textContent = "";
  const source = form.source.value || null;
  const matchText = form.match_text.value.trim();
  const category = form.category.value;
  const priority = Number(form.priority.value) || 100;

  if (!category) {
    errorEl.textContent = "Pick a category.";
    return;
  }
  if (!matchText) {
    errorEl.textContent = "Keyword can't be empty.";
    return;
  }
  const dup = findDuplicateRule(matchText, source);
  if (dup) {
    errorEl.textContent = `Rule #${dup.id} already matches "${matchText}" for this source.`;
    return;
  }

  try {
    const res = await jsonFetch(`${API}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, match_text: matchText, category, priority }),
    });
    const removedIds = NEEDS_REVIEW
      ? NEEDS_REVIEW.filter((t) => matchesKeyword(t.description, matchText) && ruleAppliesToSource(source, t.source)).map((t) => t.id)
      : [];
    form.reset();
    form.priority.value = 100;
    rulePreviewEl.hidden = true;
    ruleWarningsEl.hidden = true;
    await loadRules();
    if (NEEDS_REVIEW) removeTxnsFromReview(removedIds);
    const classifiedTotal = res.enrich?.classified ?? removedIds.length;
    const remaining = NEEDS_REVIEW ? NEEDS_REVIEW.length : "?";
    setStatus(
      `Saved rule "${matchText}" → ${category}. ${classifiedTotal} transaction${classifiedTotal === 1 ? "" : "s"} classified; ${remaining} still to review.`
    );
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Manual EOM Balances
// ---------------------------------------------------------------------------

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

// The Insights "Not checked" remedy link (spec 003 §A.1) jumps here with
// ?account=...&month=... — prefill and focus the balance form so entering
// the missing figure is one field-fill away, not a hunt.
function prefillBalanceFormFromQuery() {
  const params = new URLSearchParams(location.search);
  const account = params.get("account");
  const month = params.get("month");
  if (!account && !month) return;
  const accountSelect = document.getElementById("balance-account");
  const monthInput = document.getElementById("balance-month");
  if (account) accountSelect.value = account;
  if (month) monthInput.value = month;
  document.getElementById("balances-section")?.scrollIntoView({ block: "start" });
  monthInput.focus();
}

(async function init() {
  await Promise.all([loadSources(), loadCategories()]);
  renderCategorySelect();
  await Promise.all([loadReview(), loadRules(), loadBalances()]);
  prefillBalanceFormFromQuery();
})();
