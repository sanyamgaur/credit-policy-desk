/* UI for Credit Policy Desk. Every decision comes from engine.js (window.CAM); this file only displays. */
(function () {
  "use strict";
  const DATA = window.__DATA__;
  const ORIGINAL = DATA.policy;
  const BORROWERS = DATA.borrowers;
  const WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm";
  const MODELS = [
    ["Qwen2.5-0.5B-Instruct-q4f16_1-MLC", "Qwen 2.5 · 0.5B · 290 MB (fastest)"],
    ["Llama-3.2-1B-Instruct-q4f16_1-MLC", "Llama 3.2 · 1B · 705 MB (balanced)"],
    ["Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "Qwen 2.5 · 1.5B · 880 MB (best writing)"],
  ];
  const ICON = { FAIL: "✕", CANT_CHECK: "?", BORDERLINE: "!", PASS: "✓" };
  const COLUMN = { R1: "Age", R2: "Bureau", R3: "Late pay", R4: "DSCR", R5: "Debt / EBITDA", R6: "Current ratio",
    R7: "GST gap", R8: "Bank / GST", R9: "Bounces", R10: "Docs" };
  const DECISIONS = ["Not reviewed yet", "Agree with the flag", "Asked borrower for documents",
    "Override: source data was wrong", "Override: approve as a deviation"];
  const OUTCOMES = [["OUTSIDE_POLICY", "Outside policy"], ["INCOMPLETE", "Incomplete file"],
    ["WITHIN_POLICY_REVIEW", "Borderline items"], ["WITHIN_POLICY", "Within policy"]];
  const SEVERITY = { OUTSIDE_POLICY: 0, INCOMPLETE: 1, WITHIN_POLICY_REVIEW: 2, WITHIN_POLICY: 3 };
  const STEP = { x: 0.05, "%": 1, years: 0.5, days: 5, "": 1 };
  const PRESETS = { tight: { R2: 720, R4: 1.4, R5: 3.0, R6: 1.3, R7: 8 }, loose: { R2: 680, R4: 1.15, R5: 4.0, R8: 70 } };
  const MAX_TRIES = 3;
  const TEMPERATURES = [0.2, 0.5, 0.8];  // later tries are more varied
  const STORE_KEY = "cpd.decisions.v1";
  const GLOSSARY = [
    ["CAM (Credit Assessment Memo)", "The document that explains why a loan should or shouldn't be approved."],
    ["Credit policy", "A lender's own rulebook for which loans it will give."],
    ["Deviation", "Approving a loan that breaks a policy rule. Needs a senior sign-off and a written reason."],
    ["Rs lakh", "1 lakh = 1,00,000 rupees. All money here is in lakh."],
    ["EBITDA", "Yearly profit before interest, tax and accounting write-offs: roughly the cash the business makes."],
    ["DSCR", "EBITDA divided by yearly loan repayments. 1.25 means Rs 1.25 earned for every Rs 1 to repay."],
    ["Debt to EBITDA", "Total debt divided by EBITDA: about how many years of profit it takes to repay all debt."],
    ["Current ratio", "Short-term assets divided by short-term liabilities. Below 1 means bills due soon exceed cash coming soon."],
    ["GST returns", "Sales the business reports to the tax department. A cross-check on audited revenue."],
    ["Bureau score", "Credit score from a credit bureau, based on past repayment behaviour."],
    ["DPD (days past due)", "How many days late a repayment was."],
    ["EMI / bounce", "A fixed monthly loan payment. A bounce is a payment that failed for lack of funds."],
  ];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------- State ----------------
  let policy = clone(ORIGINAL);
  let writer = "template";
  let editing = false, plant = false;
  let llm = null, llmModel = null, busy = false;
  const aiMemos = {}, aiMeta = {}, memoEdits = {};
  const decisions = loadDecisions();

  const byId = (id) => BORROWERS.find((b) => b.id === id);
  const evalAll = (p) => BORROWERS.map((b) => CAM.evaluate(b, p));
  const BASE = evalAll(ORIGINAL);
  const policyKey = (p = policy) => JSON.stringify(p.rules.map((r) => r.threshold).concat(p.borderline_margin_pct));
  const policyEdited = () => policyKey() !== policyKey(ORIGINAL);
  // Short, stable fingerprint of the policy, so each audit entry says which policy it was made under.
  const policyVersion = () => {
    if (!policyEdited()) return "original";
    let h = 5381; for (const c of policyKey()) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
    return "edit-" + h.toString(16).slice(0, 6);
  };
  const outcomeBadge = (rec) => `<span class="badge o-${rec.code}">${esc(rec.label)}</span>`;
  const label = (b) => `${b.id} · ${b.name} · ${b.industry}`;
  const attentionOrder = (evs) => evs.slice().sort((a, b) =>
    SEVERITY[a.recommendation.code] - SEVERITY[b.recommendation.code] || a.borrower.id.localeCompare(b.borrower.id));
  let current = attentionOrder(BASE)[0].borrower.id;

  function loadDecisions() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveDecisions() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(decisions)); } catch (e) { /* private mode: keep in memory */ }
  }

  // ---------------- Tabs (click + arrow keys) ----------------
  const tabButtons = [...document.querySelectorAll('[role="tab"]')];
  function showTab(name, focus = false) {
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    document.querySelectorAll("section.panel").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
    if (name === "review") renderReview();
    if (name === "how") renderHow();
  }
  tabButtons.forEach((b, i) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); showTab(tabButtons[(i + d + tabButtons.length) % tabButtons.length].dataset.tab, true); }
    });
  });
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollToEl = (el) => el.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
  const goToTabs = () => scrollToEl(document.querySelector(".tabs"));
  // Briefly outline the control a feature card sent the user to, so they see where to act.
  function spotlight(el) {
    el.classList.remove("spotlight"); void el.offsetWidth; el.classList.add("spotlight");
    setTimeout(() => el.classList.remove("spotlight"), 1700);
  }
  function openFirstFlagged() { current = attentionOrder(evalAll(policy))[0].borrower.id; showTab("review"); }

  // ---------------- Feature cards: each one opens the exact place to use that feature ----------------
  document.querySelectorAll("[data-go]").forEach((card) => card.addEventListener("click", () => {
    const go = card.dataset.go;
    if (go === "review") { openFirstFlagged(); goToTabs(); }
    if (go === "whatif") {
      showTab("book");
      const btn = document.querySelector('[data-preset="tight"]');
      scrollToEl(document.querySelector("#tab-book .policy"));
      btn.focus({ preventScroll: true }); spotlight(btn);
    }
    if (go === "ai") {
      openFirstFlagged();
      document.querySelector('[data-writer="ai"]').click();
      scrollToEl($("step-memo"));
      const target = !navigator.gpu ? $("ai-box") : llm ? $("write-ai") : $("load-model");
      if (target.focus) target.focus({ preventScroll: true });
      spotlight(target);
    }
    if (go === "break") {
      openFirstFlagged();
      scrollToEl($("step-memo"));
      $("plant").focus({ preventScroll: true }); spotlight($("plant"));
    }
  }));

  // ---------------- Toast: short confirmation after an action ----------------
  let toastTimer = null;
  function toast(msg, kind = "") {
    const t = $("toast");
    t.hidden = true; t.className = `toast ${kind}`; t.textContent = msg; void t.offsetWidth; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // ---------------- AI feature status, shown on its card ----------------
  function setAiFeature(text, cls) {
    const tag = $("ai-feature-status");
    tag.textContent = text; tag.className = `f-tag ${cls}`;
  }
  if (!navigator.gpu) setAiFeature("Not available in this browser", "off");

  // ---------------- About dialog ----------------
  const about = $("about");
  $("open-about").addEventListener("click", () => about.showModal());
  about.addEventListener("click", (e) => { if (e.target === about) about.close(); });  // click on backdrop closes

  // ---------------- Loan book + policy what-if ----------------
  function renderPolicyRows() {
    $("policy-rows").innerHTML = policy.rules.map((r, i) => {
      if (r.op === "==") return `<div class="rule-row"><label title="${esc(r.text)}"><span class="rid">${r.id}</span>${esc(r.short)}</label><span class="muted small">all required</span></div>`;
      const sym = r.op === ">=" ? "≥" : "≤";
      return `<div class="rule-row" id="row-${r.id}"><label for="th-${r.id}" title="${esc(r.text)}"><span class="rid">${r.id}</span>${esc(r.short)} <span class="op">${sym}${r.unit && r.unit !== "x" ? " " + esc(r.unit) : ""}</span></label>
        <input type="number" id="th-${r.id}" data-i="${i}" min="0" step="${STEP[r.unit] ?? 1}" value="${r.threshold}"></div>`;
    }).join("");
    $("margin").value = policy.borderline_margin_pct;
    $("policy-rows").querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v) || v < 0) return;   // ignore half-typed or negative limits
      policy.rules[+inp.dataset.i].threshold = v;
      renderPortfolio();
      announcePolicy(600);
    }));
    markEdited();
  }
  $("margin").addEventListener("input", () => {
    const v = parseFloat($("margin").value);
    if (!Number.isFinite(v) || v < 0 || v > 25) return;
    policy.borderline_margin_pct = v;
    renderPortfolio();
    announcePolicy(600);
  });
  document.querySelectorAll("[data-preset]").forEach((btn) => btn.addEventListener("click", () => {
    policy = clone(ORIGINAL);
    const p = PRESETS[btn.dataset.preset];
    if (p) policy.rules.forEach((r) => { if (r.id in p) r.threshold = p[r.id]; });
    renderPolicyRows();
    renderPortfolio();
    announcePolicy(0);
  }));
  // Confirms a policy change and says how many files it moved (debounced while typing).
  let policyTimer = null;
  function announcePolicy(delay) {
    clearTimeout(policyTimer);
    policyTimer = setTimeout(() => {
      if (!policyEdited()) { toast("Back to the original policy", "good"); return; }
      const moved = evalAll(policy).filter((ev, i) => ev.recommendation.code !== BASE[i].recommendation.code).length;
      toast(`Policy updated · ${moved} file${moved === 1 ? "" : "s"} changed outcome`, "good");
    }, delay);
  }
  $("sort-attention").addEventListener("change", () => renderPortfolio());
  function markEdited() {
    policy.rules.forEach((r, i) => {
      const row = $(`row-${r.id}`);
      if (row) row.classList.toggle("changed", r.threshold !== ORIGINAL.rules[i].threshold);
    });
  }

  function renderPortfolio() {
    markEdited();
    const evs = evalAll(policy);
    const baseOf = (id) => BASE.find((e) => e.borrower.id === id);
    const count = (list, code) => list.filter((e) => e.recommendation.code === code).length;
    $("chips").innerHTML = OUTCOMES.map(([code, name]) => {
      const n = count(evs, code), d = n - count(BASE, code);
      const bad = code === "OUTSIDE_POLICY" || code === "INCOMPLETE";
      const cls = d === 0 ? "" : (d > 0) === bad ? "up" : "down";
      return `<div class="chip"><div class="n">${n}${d ? `<span class="d ${cls}">${d > 0 ? "+" : ""}${d}</span>` : ""}</div><div class="l"><span class="badge o-${code}">${name}</span></div></div>`;
    }).join("");

    const ordered = $("sort-attention").checked ? attentionOrder(evs) : evs;
    const head = `<thead><tr><th scope="col">Loan file</th>${policy.rules.map((r) => `<th scope="col" class="c" title="${esc(r.text)}">${esc(COLUMN[r.id] || r.id)}</th>`).join("")}<th scope="col">Outcome</th></tr></thead>`;
    const rows = ordered.map((ev) => {
      const b = ev.borrower, before = baseOf(b.id), moved = ev.recommendation.code !== before.recommendation.code;
      const cells = ev.results.map((r) => `<td class="c"><span class="cell s-${r.status}" title="${esc(r.short)}: ${esc(CAM.STATUS_LABEL[r.status])} (${esc(r.value_display)})" aria-label="${esc(r.short)}: ${esc(CAM.STATUS_LABEL[r.status])}">${ICON[r.status]}</span></td>`).join("");
      return `<tr class="${moved ? "moved" : ""}"><th scope="row"><button class="file-link" type="button" data-id="${esc(b.id)}"><b>${esc(b.id)}</b><span class="muted">${esc(b.industry)}</span></button></th>${cells}
        <td>${outcomeBadge(ev.recommendation)}${moved ? `<span class="was">was: ${esc(before.recommendation.label)}</span>` : ""}</td></tr>`;
    }).join("");
    $("port").innerHTML = head + `<tbody>${rows}</tbody>`;
    $("port").querySelectorAll(".file-link").forEach((btn) => btn.addEventListener("click", () => {
      current = btn.dataset.id; showTab("review"); goToTabs();
    }));

    const changes = evs.map((ev) => {
      const before = baseOf(ev.borrower.id);
      if (ev.recommendation.code === before.recommendation.code) return "";
      const moves = ev.results.filter((r, j) => r.status !== before.results[j].status)
        .map((r) => `${r.id} ${esc(r.short)}: ${esc(r.value_display)} vs ${esc(r.threshold_display)}`);
      return `<li><b>${ev.borrower.id}</b> ${esc(before.recommendation.label)} → <b>${esc(ev.recommendation.label)}</b><br><small class="muted">${moves.join(" · ")}</small></li>`;
    }).join("");
    $("changes").innerHTML = !policyEdited()
      ? `<p class="empty">This is the original policy. Try <b>Downturn: tighten</b> to see which loans would no longer qualify, and why.</p>`
      : changes ? `<ul class="changes">${changes}</ul>` : `<p class="empty">Policy edited, but no file changed its outcome.</p>`;
  }

  // ---------------- File review ----------------
  function fillBorrowerSelect() {
    $("borrower").innerHTML = attentionOrder(evalAll(policy)).map((ev) =>
      `<option value="${esc(ev.borrower.id)}">${esc(label(ev.borrower))} — ${esc(ev.recommendation.label)}</option>`).join("");
    $("borrower").value = current;
  }
  $("borrower").addEventListener("change", (e) => { current = e.target.value; renderReview(); });
  function step(d) {
    const ids = attentionOrder(evalAll(policy)).map((e) => e.borrower.id);
    current = ids[(ids.indexOf(current) + d + ids.length) % ids.length];
    renderReview();
  }
  $("prev-file").addEventListener("click", () => step(-1));
  $("next-file").addEventListener("click", () => step(1));

  const decisionKey = (rid) => `${current}:${rid}:${policyVersion()}`;

  function renderReview() {
    editing = false;
    fillBorrowerSelect();
    const b = byId(current), ev = CAM.evaluate(b, policy), q = CAM.reviewQueue(ev), lr = b.loan_request;
    $("policy-note").innerHTML = policyEdited() ? `<div class="note">You're reviewing against your <b>edited</b> policy from the Loan book tab. Decisions are recorded against that policy version.</div>` : "";
    const n = (s) => q.filter((r) => r.status === s).length;
    $("file-meta").innerHTML = `<div><h2>${esc(b.name)} <small class="muted" style="font-weight:400">· ${esc(b.industry)}</small></h2>
      <p class="muted small" style="margin:4px 0 0">Asks for Rs ${lr.amount_lakh} lakh over ${lr.tenure_months} months at ${lr.annual_rate_pct}%. ${esc(ev.recommendation.explain)}</p></div>
      <div class="counts">${outcomeBadge(ev.recommendation)}
        ${n("FAIL") ? `<span class="badge s-FAIL">${n("FAIL")} fail</span>` : ""}${n("CANT_CHECK") ? `<span class="badge s-CANT_CHECK">${n("CANT_CHECK")} can't check</span>` : ""}${n("BORDERLINE") ? `<span class="badge s-BORDERLINE">${n("BORDERLINE")} borderline</span>` : ""}</div>`;
    $("planted").textContent = b.planted_problem;

    const flagged = q.filter((r) => r.status !== "PASS"), passing = q.filter((r) => r.status === "PASS");
    $("queue").innerHTML = (flagged.length ? flagged.map((r) => ruleCard(r, true)).join("")
      : `<div class="ok">Nothing to check: every rule passes comfortably. Go to the memo below.</div>`)
      + (passing.length ? `<details class="passing"><summary>✓ ${passing.length} rules pass · show them</summary>${passing.map((r) => ruleCard(r, false)).join("")}</details>` : "");
    $("queue").querySelectorAll("[data-rid]").forEach(wireDecision);
    renderProgress();
    renderMemo();
    renderAudit();
  }

  const edited = (r) => ORIGINAL.rules.find((o) => o.id === r.id).threshold !== r.threshold;

  // Each rule as a plain question, so nobody needs to know what "DSCR" means to follow along.
  const QUESTION = {
    R1: "Has the business run long enough?", R2: "Does the owner have a good credit record?",
    R3: "Any recent late repayments?", R4: "Can profit cover all loan repayments?",
    R5: "Is total debt manageable for its profit?", R6: "Can it pay its short-term bills?",
    R7: "Do tax-reported sales match audited revenue?", R8: "Does the bank account show the sales it reports?",
    R9: "Any bounced payments recently?", R10: "Are all required documents in?",
  };

  // A small gauge: green = allowed zone, line = the limit, dot = this borrower.
  function meter(r) {
    if (typeof r.value !== "number" || r.op === "==") return "";
    const v = r.value, lim = r.threshold;
    const lo = Math.min(v, lim) * 0.5, hi = Math.max(v, lim) * 1.3 || 1;
    const pct = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
    const zone = r.op === ">=" ? `left:${pct(lim)}%;right:0` : `left:0;width:${pct(lim)}%`;
    return `<span class="meter" role="img" aria-label="${esc(r.short)} ${esc(r.value_display)}, limit ${esc(r.threshold_display)}">
      <span class="zone" style="${zone}"></span><span class="limit" style="left:${pct(lim)}%"></span><span class="dot s-${r.status}" style="left:${pct(v)}%"></span></span>`;
  }

  function ruleCard(r, open) {
    const d = decisions[decisionKey(r.id)];
    const inputs = r.inputs.length ? `<div class="table-wrap"><table><thead><tr><th>Input</th><th>Value</th><th>Where it came from</th></tr></thead><tbody>${
      r.inputs.map((i) => `<tr><td>${esc(i.label)}</td><td>${esc(typeof i.value === "number" ? CAM.fmt(i.value, i.unit) : i.value)}</td><td>${esc(i.source)}</td></tr>`).join("")}</tbody></table></div>` : "";
    const decide = r.status === "PASS" ? "" : `<div class="decide" data-rid="${r.id}">
      <div><label for="dec-${r.id}">Your decision</label><select id="dec-${r.id}">${DECISIONS.map((x) => `<option ${d && x === d.decision ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
      <div><label for="why-${r.id}">Reason (needed for any override)</label><input id="why-${r.id}" type="text" value="${esc(d ? d.reason : "")}" placeholder="e.g. Promoter brought in Rs 40 lakh fresh equity"></div>
      <div class="err" hidden style="grid-column:1/-1">Add a reason to record this override.</div></div>`;
    const calc = r.how ? `<p class="small"><b>How it's worked out:</b> <code>${esc(r.how)}</code> = <b>${esc(r.value_display)}</b></p>` : "";
    return `<details class="rule" ${open ? "open" : ""}><summary><span class="cell s-${r.status}" aria-hidden="true">${ICON[r.status]}</span>
      <span class="rule-main"><span class="title">${esc(r.short)} <span class="badge s-${r.status}">${esc(CAM.STATUS_LABEL[r.status])}</span></span><span class="q">${esc(QUESTION[r.id] || r.text)}</span></span>
      <span class="val">${esc(r.value_display)} <span class="muted">· limit ${esc(r.threshold_display)}</span></span>${meter(r)}
      <span class="decided" id="done-${r.id}">${d ? "✓ decided" : ""}</span></summary>
      <div class="body">${r.reason ? `<div class="warn">${esc(r.reason)}</div>` : ""}${edited(r) ? `<p class="note small">Limit edited in Loan book: now ${esc(r.threshold_display)}.</p>` : ""}
      ${decide}${calc}
      <details class="evidence"><summary>Where the numbers came from${r.inputs.length ? ` (${r.inputs.length})` : ""}</summary><p class="small"><b>Policy rule (${r.id}):</b> ${esc(r.text)}</p>${inputs}</details></div></details>`;
  }

  function wireDecision(box) {
    const rid = box.dataset.rid, sel = box.querySelector("select"), txt = box.querySelector("input"), err = box.querySelector(".err");
    const ev = CAM.evaluate(byId(current), policy), r = ev.results.find((x) => x.id === rid);
    const update = () => {
      const key = decisionKey(rid);
      const wasSaved = !!decisions[key];
      const missingReason = sel.value.startsWith("Override") && !txt.value.trim();
      err.hidden = !missingReason;
      if (missingReason || sel.value === DECISIONS[0]) delete decisions[key];   // overrides need a reason
      else decisions[key] = { file: current, rule: rid, decision: sel.value, reason: txt.value.trim(),
        value: r.value_display, policy: policyVersion(), at: new Date().toISOString() };
      saveDecisions();
      $(`done-${rid}`).textContent = decisions[key] ? "✓ decided" : "";
      if (!wasSaved && decisions[key]) toast("Decision saved to the audit log", "good");
      if (wasSaved && !decisions[key]) toast(missingReason ? "Not recorded: an override needs a reason" : "Decision removed", missingReason ? "bad" : "");
      renderProgress();
      renderAudit();
    };
    sel.addEventListener("change", update);
    txt.addEventListener("input", update);
  }

  function renderProgress() {
    const ev = CAM.evaluate(byId(current), policy);
    const flagged = ev.results.filter((r) => r.status !== "PASS");
    const done = flagged.filter((r) => decisions[decisionKey(r.id)]).length;
    $("progress-note").textContent = flagged.length ? `${done} of ${flagged.length} flagged rules decided` : "";
    updateStepper();
  }

  // Step tracker: shows where the reviewer is and what's left, without reading the page.
  let memoState = "none";   // "none" | "passed" | "blocked"
  function updateStepper() {
    const ev = CAM.evaluate(byId(current), policy);
    const flagged = ev.results.filter((r) => r.status !== "PASS");
    const done = flagged.filter((r) => decisions[decisionKey(r.id)]).length;
    const set = (id, text, cls) => { $(id).className = `step-link ${cls}`; $(`${id}-s`).textContent = text; };
    set("st-1", flagged.length ? `${done} of ${flagged.length} flagged decided` : "Nothing flagged", done === flagged.length ? "done" : "");
    set("st-2", memoState === "passed" ? "Passed the checks" : memoState === "blocked" ? "Blocked by the checks" : "Not written yet",
      memoState === "passed" ? "done" : memoState === "blocked" ? "attn" : "");
    const n = Object.values(decisions).filter((d) => d.file === current).length;
    set("st-3", n ? `${n} entr${n === 1 ? "y" : "ies"} for this file` : "No entries yet", n ? "done" : "");
  }

  function renderAudit() {
    const rows = Object.values(decisions).sort((a, b) => b.at.localeCompare(a.at));
    $("audit").innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>File</th><th>Rule</th><th>Value then</th><th>Decision</th><th>Reason</th><th>Policy</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.file)}</td><td>${esc(r.rule)}</td><td>${esc(r.value)}</td><td>${esc(r.decision)}</td><td>${esc(r.reason)}</td><td>${esc(r.policy)}</td></tr>`).join("")}</tbody></table></div>
      <div class="btns" style="margin-top:10px"><button class="btn small" id="dl-audit" type="button">Download CSV</button><button class="btn small ghost" id="clear-audit" type="button">Clear log</button></div>`
      : `<p class="empty">No decisions yet. Make one on a flagged rule above and it's recorded here.</p>`;
    updateStepper();
    if (!rows.length) return;
    $("dl-audit").addEventListener("click", () => {
      // Quote every cell, and stop spreadsheet apps running text that starts like a formula.
      const q = (s) => { let t = String(s ?? ""); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
      const csv = ["Time,File,Rule,Value then,Decision,Reason,Policy",
        ...rows.map((r) => [r.at, r.file, r.rule, r.value, r.decision, r.reason, r.policy].map(q).join(","))].join("\n");
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "audit_log.csv" });
      a.click();
      toast("Audit log downloaded", "good");
    });
    $("clear-audit").addEventListener("click", () => {
      if (!confirm("Clear every recorded decision from this browser?")) return;
      Object.keys(decisions).forEach((k) => delete decisions[k]);
      saveDecisions();
      renderReview();
      toast("Audit log cleared");
    });
  }

  // ---------------- Memo ----------------
  $("model").innerHTML = MODELS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("");
  document.querySelectorAll("[data-writer]").forEach((btn) => btn.addEventListener("click", () => {
    writer = btn.dataset.writer;
    document.querySelectorAll("[data-writer]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    editing = false;
    renderMemo();
  }));
  $("plant").addEventListener("click", () => {
    plant = !plant;
    $("plant").setAttribute("aria-pressed", plant);
    $("plant").textContent = plant ? "Remove the planted number" : "Test the checker: plant a wrong number";
    renderMemoOutput();
    toast(plant ? "Wrong number planted: the checks block the memo" : "Planted number removed", plant ? "bad" : "good");
  });
  $("load-model").addEventListener("click", () => ensureModel().catch(showAiError));
  $("write-ai").addEventListener("click", () => writeAiMemo(current).catch(showAiError));
  $("model").addEventListener("change", () => { $("write-ai").disabled = !(llm && llmModel === $("model").value); renderMemoOutput(); });
  $("edit-memo").addEventListener("click", () => {
    editing = !editing;
    if (editing) $("memo-editor").value = currentMemoText();
    renderMemoOutput();
    if (editing) $("memo-editor").focus();
  });
  $("memo-editor").addEventListener("input", () => { memoEdits[memoKey()] = $("memo-editor").value; renderMemoOutput(); });
  $("reset-memo").addEventListener("click", () => { delete memoEdits[memoKey()]; editing = false; renderMemoOutput(); });

  const sourceKey = (id = current) => `${writer}|${writer === "ai" ? llmModel : ""}|${id}|${policyKey()}`;
  const memoKey = () => sourceKey();

  function renderMemo() {
    $("ai-box").hidden = writer !== "ai";
    if (writer === "ai") {
      if (!navigator.gpu) {
        $("ai-status").textContent = "This browser can't run the on-device model (no WebGPU). Try recent Chrome or Edge on a laptop. The code template and every check still work.";
        $("load-model").disabled = true;
      } else if (!llm) {
        $("ai-status").textContent = "The model downloads once (290 MB for the smallest), then loads from this browser in seconds. Nothing is sent to a server.";
      }
    }
    renderMemoOutput();
  }

  function sourceText(id = current) {
    if (writer === "template") return CAM.templateMemo(CAM.evaluate(byId(id), policy));
    return aiMemos[sourceKey(id)] || "";
  }
  function currentMemoText() { return memoEdits[memoKey()] ?? sourceText(); }

  function renderMemoMarkdown(text, bad, streaming) {
    let html = text.split("\n").filter((l) => l.trim()).map((line) => {
      let s = esc(line.trim());
      s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      for (const n of bad) {
        const re = new RegExp(`(?<![\\d.,])${n.replace(/[.,\-]/g, (c) => "\\" + c)}(?![\\d])`);
        s = s.replace(re, `<mark class="bad">${n}</mark>`);
      }
      s = s.replace(/\[((?:R\d+|APP|POLICY)(?:\s*,\s*(?:R\d+|APP|POLICY))*)\]/g, '<span class="tag">$1</span>');
      return /^#{1,6}\s/.test(line.trim()) ? `<h4>${s.replace(/^#{1,6}\s*/, "")}</h4>` : `<p>${s}</p>`;
    }).join("");
    if (streaming) html += '<span class="cursor"></span>';
    return html;
  }

  function provenance() {
    const meta = aiMeta[sourceKey()];
    let s = writer === "template" ? "<b>Code template</b> · written entirely by code"
      : meta ? `<b>Reworded by ${esc(MODELS.find((m) => m[0] === meta.model)[1].split(" · ").slice(0, 2).join(" "))}</b> on this device · figures filled in by code · ${meta.passed ? (meta.tries > 1 ? `passed on try ${meta.tries}` : "passed first try") : `blocked after ${meta.tries} tries`}`
      : "<b>On-device AI</b>";
    if (memoEdits[memoKey()] !== undefined) s += " · <b>edited by reviewer</b>";
    return s;
  }

  function renderMemoOutput(streaming = false) {
    const ev = CAM.evaluate(byId(current), policy);
    let text = currentMemoText();
    $("provenance").innerHTML = provenance();
    $("edit-memo").textContent = editing ? "Done" : "Edit";
    $("edit-memo").disabled = !text || streaming;
    $("reset-memo").hidden = memoEdits[memoKey()] === undefined;
    $("memo-editor").hidden = !editing;
    $("memo-text").hidden = editing;
    $("plant").disabled = !text || streaming;
    if (!text) {
      $("memo-text").innerHTML = `<p class="empty">${!navigator.gpu ? "This browser can't run the on-device model." : llm ? "Click <b>Write memo</b> to let the on-device model reword the outline." : "Load the model above, then click <b>Write memo</b>."}</p>
        <button class="btn small" type="button" id="use-template">Use the code template instead</button>`;
      $("use-template").addEventListener("click", () => document.querySelector('[data-writer="template"]').click());
      $("memo-checks").innerHTML = `<p class="empty">Checks run as soon as there's a memo.</p>`;
      memoState = "none"; renderPipeline("", null, false); updateStepper();
      return;
    }
    let plantNote = "";
    if (plant && !streaming) {
      const r = CAM.injectError(text);
      text = r.memo;
      if (r.old) plantNote = `<p class="muted small">Planted: changed <b>${esc(r.old)}</b> to <b>${esc(r.wrong)}</b>.</p>`;
    }
    const c = CAM.checkMemo(text, ev, policy);
    $("memo-text").innerHTML = renderMemoMarkdown(text, c.unmatched.map((n) => n.number), streaming);
    if (streaming) { $("memo-checks").innerHTML = `<p class="empty">Waiting for the model to finish…</p>`; renderPipeline(text, c, true); return; }
    const okN = c.numbers.filter((n) => n.ok).length;
    const line = (ok, title, body, items) => `<div class="check-line"><span class="ic" aria-hidden="true">${ok ? "✅" : "❌"}</span><div><b>${title}</b> ${body}${items || ""}</div></div>`;
    $("memo-checks").innerHTML = plantNote
      + line(!c.unmatched.length, "Numbers:", `${okN} of ${c.numbers.length} match the rule they cite`,
        c.unmatched.map((n) => `<div class="err"><b>${esc(n.number)}</b> isn't a figure of the rule this sentence cites.<br><small>${esc(n.sentence)}</small></div>`).join(""))
      + line(!c.contradictions.length, "Meaning:", c.contradictions.length ? `${c.contradictions.length} sentence(s) contradict a rule's result` : "no sentence contradicts a rule's result",
        c.contradictions.map((x) => `<div class="err">${esc(x.why)}.<br><small>${esc(x.sentence)}</small></div>`).join(""))
      + line(!c.uncited.length, "Sources:", c.uncited.length ? `${c.uncited.length} sentence(s) cite no rule` : "every sentence cites a rule",
        c.uncited.map((s) => `<div class="warn">${esc(s)}</div>`).join(""))
      + line(c.recommendationOk, "Outcome", `${c.recommendationOk ? "matches" : "doesn't match"} the rule engine ("${esc(ev.recommendation.label)}")`,
        c.decisionConflicts.map((x) => `<div class="err">${esc(x.why)}.<br><small>${esc(x.sentence)}</small></div>`).join(""))
      + (c.placeholders.length ? line(false, "Unfilled placeholders:", esc(c.placeholders.join(", "))) : "")
      + (c.passed ? `<div class="ok">Passed every check. Ready for the reviewer.</div>` : `<div class="err">Blocked. Fix the flagged items before it reaches the reviewer.</div>`);
    memoState = c.passed ? "passed" : "blocked";
    renderPipeline(text, c, false);
    updateStepper();
  }

  const modelName = (id) => MODELS.find((m) => m[0] === id)[1].split(" · ").slice(0, 2).join(" ");

  // The 3-step strip above the memo: who did what to this memo, and the result.
  function renderPipeline(text, c, streaming) {
    const meta = aiMeta[sourceKey()];
    $("pl-1").className = "on";
    if (writer === "template") {
      $("pl-2").className = "skipped"; $("pl-2-s").textContent = "Skipped: code template";
    } else {
      $("pl-2").className = text ? "on" : "";
      $("pl-2-s").textContent = streaming ? "Writing…" : meta ? `${modelName(meta.model)} · ${meta.tries} ${meta.tries === 1 ? "try" : "tries"}`
        : llm ? "Ready: click Write memo" : "Load the model first";
    }
    $("pl-3").className = !text || streaming ? "" : c.passed ? "good" : "bad";
    $("pl-3-s").textContent = !text ? "Waiting for a memo" : streaming ? "Runs when writing ends" : c.passed ? "Passed" : "Blocked";
  }

  // ---------------- On-device AI (WebLLM) ----------------
  function setProgress(frac, text) {
    $("progress").hidden = false;
    $("progress").firstElementChild.style.width = `${Math.round(frac * 100)}%`;
    $("ai-status").textContent = text;
    if (frac < 1) setAiFeature(`Loading · ${Math.round(frac * 100)}%`, "optional");
  }
  function showAiError(e) {
    busy = false;
    setAiFeature("Couldn't load · template still works", "off");
    $("load-model").disabled = false;
    $("ai-status").innerHTML = `<span style="color:var(--fail)">${esc(e.message || e)}</span> You can keep using the code template.`;
  }

  async function ensureModel() {
    const id = $("model").value;
    if (llm && llmModel === id) return;
    if (!navigator.gpu) throw new Error("This browser can't run the on-device model (no WebGPU).");
    $("load-model").disabled = true; $("write-ai").disabled = true;
    setProgress(0, "Loading the WebLLM library…");
    const webllm = await import(WEBLLM_URL);
    if (llm) { await llm.unload(); llm = null; }
    llm = await webllm.CreateMLCEngine(id, { initProgressCallback: (r) => setProgress(r.progress || 0, r.text || "") });
    llmModel = id;
    setProgress(1, `Ready: ${MODELS.find((m) => m[0] === id)[1]} is running on this device.`);
    setAiFeature("Ready · runs on this device", "ready");
    toast("AI model ready. It runs on this device.", "good");
    $("load-model").disabled = false; $("write-ai").disabled = false;
    renderMemoOutput();
  }

  // The model rewords the code's outline. Code then fills every figure back in.
  async function generateMemo(id, temperature, onToken) {
    const ev = CAM.evaluate(byId(id), policy);
    const stream = await llm.chat.completions.create({
      messages: [{ role: "user", content: CAM.memoPrompt(ev) }],
      temperature, max_tokens: 700, stream: true,
    });
    let draft = "";
    for await (const chunk of stream) {
      draft += (chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) || "";
      if (onToken) onToken(CAM.fillPlaceholders(CAM.cleanDraft(draft), ev));
    }
    return CAM.fillPlaceholders(CAM.cleanDraft(draft), ev);
  }

  /* Write, check, and try again if the checks block it (up to MAX_TRIES).
   * If every try is blocked, the last one is kept so the reviewer can see why. */
  async function writeChecked(id, onStatus, onToken) {
    const ev = CAM.evaluate(byId(id), policy);
    let text = "", check = null, tries = 0;
    while (tries < MAX_TRIES) {
      tries++;
      if (onStatus) onStatus(tries);
      text = await generateMemo(id, TEMPERATURES[tries - 1], onToken);
      check = CAM.checkMemo(text, ev, policy);
      if (check.passed) break;
    }
    return { text, check, tries };
  }

  async function writeAiMemo(id) {
    if (busy) return;
    await ensureModel();
    busy = true; $("write-ai").disabled = true;
    const key = sourceKey(id);
    try {
      const r = await writeChecked(id,
        (n) => { $("ai-status").textContent = n === 1 ? "Writing on this device…" : `Try ${n} of ${MAX_TRIES}: the last draft was blocked, writing again…`; },
        (t) => { aiMemos[key] = t; if (current === id) renderMemoOutput(true); });
      aiMemos[key] = r.text;
      aiMeta[key] = { model: llmModel, tries: r.tries, passed: r.check.passed };
      delete memoEdits[key];
      $("ai-status").textContent = r.check.passed
        ? `Passed every check${r.tries > 1 ? ` on try ${r.tries} of ${MAX_TRIES}` : " on the first try"}.`
        : `All ${MAX_TRIES} tries were blocked. The last draft is shown so you can see why. Use the code template, or try again.`;
      toast(r.check.passed ? "AI memo passed every check" : `AI memo blocked after ${MAX_TRIES} tries`, r.check.passed ? "good" : "bad");
    } finally {
      busy = false; $("write-ai").disabled = false;
    }
    renderMemoOutput();
  }

  // ---------------- How well it works ----------------
  function renderHow() {
    let match = 0, total = 0;
    const rows = BASE.map((ev) => {
      const b = ev.borrower;
      ev.results.forEach((r) => { total++; if (b.expected[r.id] === r.status) match++; });
      const flagged = CAM.reviewQueue(ev).filter((r) => r.status !== "PASS").map((r) => `${r.id} ${CAM.STATUS_LABEL[r.status].toLowerCase()}`);
      return `<tr><td><b>${b.id}</b></td><td>${esc(b.planted_problem)}</td><td>${esc(flagged.join(", ") || "-")}</td></tr>`;
    }).join("");
    const kinds = BASE.flatMap((ev) => ev.results.map((r) => ev.borrower.expected[r.id]));
    const k = (s) => kinds.filter((x) => x === s).length;
    $("eval-rules").innerHTML = `<p><b>${match} of ${total}</b> rule results match answers written by hand (12 files × 10 rules, original policy):
      ${k("FAIL")} fails, ${k("CANT_CHECK")} can't-checks and ${k("BORDERLINE")} borderline cases, plus ${k("PASS")} passes.
      The same person wrote the rules and the test files, so this mostly shows the engine does what was intended. Real files are messier.</p>
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Planted problem</th><th>Flagged</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $("glossary").innerHTML = GLOSSARY.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("");
  }

  $("run-ai-test").addEventListener("click", async () => {
    const btn = $("run-ai-test");
    try {
      if (!navigator.gpu) throw new Error("This browser can't run the on-device model (no WebGPU). Try recent Chrome or Edge on a laptop.");
      if (busy) return;
      btn.disabled = true;
      $("ai-test-status").textContent = "Loading the model…";
      writer = "ai";
      document.querySelectorAll("[data-writer]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.writer === "ai"));
      await ensureModel();
      busy = true;
      const results = [];
      for (const b of BORROWERS) {
        const n = results.length + 1;
        const r = await writeChecked(b.id, (t) => { $("ai-test-status").textContent = `Writing memo ${n} of ${BORROWERS.length}${t > 1 ? ` (try ${t})` : ""}…`; });
        const key = sourceKey(b.id);
        aiMemos[key] = r.text;
        aiMeta[key] = { model: llmModel, tries: r.tries, passed: r.check.passed };
        results.push({ id: b.id, c: r.check, tries: r.tries });
        renderAiTest(results);
      }
      $("ai-test-status").textContent = `Done with ${MODELS.find((m) => m[0] === llmModel)[1]}. Open any file in File review to read its memo.`;
    } catch (e) {
      $("ai-test-status").innerHTML = `<span style="color:var(--fail)">${esc(e.message || e)}</span>`;
    } finally {
      busy = false; btn.disabled = false;
    }
  });

  function renderAiTest(results) {
    const passed = results.filter((r) => r.c.passed).length;
    const first = results.filter((r) => r.c.passed && r.tries === 1).length;
    const nums = results.reduce((s, r) => s + r.c.numbers.length, 0);
    const bad = results.reduce((s, r) => s + r.c.unmatched.length, 0);
    const unc = results.reduce((s, r) => s + r.c.uncited.length, 0);
    $("ai-test").innerHTML = `<div class="chips" style="grid-template-columns:repeat(2,1fr);margin-top:12px">
      <div class="chip"><div class="n">${passed}/${results.length}</div><div class="l">passed every check (within ${MAX_TRIES} tries)</div></div>
      <div class="chip"><div class="n">${first}/${results.length}</div><div class="l">passed on the first try</div></div>
      <div class="chip"><div class="n">${bad}</div><div class="l">wrong figures in final drafts (of ${nums})</div></div>
      <div class="chip"><div class="n">${unc}</div><div class="l">unsourced sentences in final drafts</div></div></div>
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Result</th><th>Tries</th><th>What the checks caught in the last draft</th></tr></thead><tbody>${
        results.map((r) => {
          const issues = [];
          if (r.c.unmatched.length) issues.push(`wrong figures: ${r.c.unmatched.map((n) => n.number).join(", ")}`);
          if (r.c.uncited.length) issues.push(`${r.c.uncited.length} unsourced sentence(s)`);
          if (r.c.contradictions.length) issues.push(`${r.c.contradictions.length} sentence(s) contradict a rule`);
          if (r.c.placeholders.length) issues.push(`unfilled ${r.c.placeholders.join(", ")}`);
          if (!r.c.recommendationOk) issues.push("outcome changed");
          return `<tr><td>${r.id}</td><td>${r.c.passed ? '<span class="badge s-PASS">Passed</span>' : '<span class="badge s-FAIL">Blocked</span>'}</td><td>${r.tries}</td><td>${esc(issues.join(" · ") || "-")}</td></tr>`;
        }).join("")}</tbody></table></div>`;
  }

  // ---------------- Start ----------------
  renderPolicyRows();
  renderPortfolio();
  renderHow();
})();
