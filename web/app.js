/* UI for Credit Policy Desk. All decisions come from engine.js (window.CAM). */
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
  const DECISIONS = ["Not reviewed yet", "Agree with the flag", "Asked borrower for documents",
    "Override: source data was wrong", "Override: approve as a deviation"];
  const OUTCOMES = [["WITHIN_POLICY", "Within policy"], ["WITHIN_POLICY_REVIEW", "Borderline items"],
    ["INCOMPLETE", "Incomplete file"], ["OUTSIDE_POLICY", "Outside policy"]];
  const STEP = { x: 0.05, "%": 1, years: 0.5, days: 5, "": 1 };
  const PRESETS = {
    tight: { R2: 720, R4: 1.4, R5: 3.0, R6: 1.3, R7: 8 },
    loose: { R2: 680, R4: 1.15, R5: 4.0, R8: 70 },
  };
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

  let policy = clone(ORIGINAL);
  let current = BORROWERS[0].id;
  let writer = "template";
  const decisions = {};
  const aiMemos = {};
  let llm = null, llmModel = null, busy = false;

  const byId = (id) => BORROWERS.find((b) => b.id === id);
  const evalAll = (p) => BORROWERS.map((b) => CAM.evaluate(b, p));
  const BASE = evalAll(ORIGINAL);
  const policyKey = () => JSON.stringify(policy.rules.map((r) => r.threshold).concat(policy.borderline_margin_pct));
  const policyEdited = () => policyKey() !== JSON.stringify(ORIGINAL.rules.map((r) => r.threshold).concat(ORIGINAL.borderline_margin_pct));
  const outcomeBadge = (rec) => `<span class="badge o-${rec.code}">${esc(rec.label)}</span>`;
  const label = (b) => `${b.id} · ${b.name} · ${b.industry}`;

  // ---------------- Tabs ----------------
  function showTab(name) {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
    document.querySelectorAll("section.panel").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
    if (name === "review") renderReview();
    if (name === "memo") renderMemo();
    if (name === "about") renderAbout();
  }
  document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------------- 1. Policy what-if ----------------
  function renderPolicyRows() {
    $("policy-rows").innerHTML = policy.rules.map((r, i) => {
      if (r.op === "==") return `<div class="rule-row"><label title="${esc(r.text)}"><span class="rid">${r.id}</span>${esc(r.short)}</label><span class="muted" style="font-size:13px">all required</span></div>`;
      const sym = r.op === ">=" ? "≥" : "≤";
      return `<div class="rule-row" id="row-${r.id}"><label for="th-${r.id}" title="${esc(r.text)}"><span class="rid">${r.id}</span>${esc(r.short)} <span class="op">${sym}${r.unit && r.unit !== "x" ? " " + esc(r.unit) : ""}</span></label>
        <input type="number" id="th-${r.id}" data-i="${i}" step="${STEP[r.unit] ?? 1}" value="${r.threshold}"></div>`;
    }).join("");
    $("margin").value = policy.borderline_margin_pct;
    $("policy-rows").querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      policy.rules[+inp.dataset.i].threshold = v;
      renderPortfolio();
    }));
    markEdited();
  }
  $("margin").addEventListener("input", () => {
    const v = parseFloat($("margin").value);
    if (!Number.isFinite(v) || v < 0) return;
    policy.borderline_margin_pct = v;
    renderPortfolio();
  });
  document.querySelectorAll("[data-preset]").forEach((btn) => btn.addEventListener("click", () => {
    policy = clone(ORIGINAL);
    const p = PRESETS[btn.dataset.preset];
    if (p) policy.rules.forEach((r) => { if (r.id in p) r.threshold = p[r.id]; });
    renderPolicyRows();
    renderPortfolio();
  }));
  function markEdited() {
    policy.rules.forEach((r, i) => {
      const row = $(`row-${r.id}`);
      if (row) row.classList.toggle("changed", r.threshold !== ORIGINAL.rules[i].threshold);
    });
  }

  function renderPortfolio() {
    markEdited();
    const evs = evalAll(policy);
    const count = (list, code) => list.filter((e) => e.recommendation.code === code).length;
    $("chips").innerHTML = OUTCOMES.map(([code, name]) => {
      const n = count(evs, code), d = n - count(BASE, code);
      const bad = code === "OUTSIDE_POLICY" || code === "INCOMPLETE";
      const cls = d === 0 ? "" : (d > 0) === bad ? "up" : "down";
      return `<div class="chip"><div class="n">${n}${d ? `<span class="d ${cls}">${d > 0 ? "+" : ""}${d}</span>` : ""}</div><div class="l"><span class="badge o-${code}">${name}</span></div></div>`;
    }).join("");

    const head = `<thead><tr><th>Loan file</th>${policy.rules.map((r) => `<th class="c" title="${esc(r.short)}">${r.id}</th>`).join("")}<th>Outcome</th></tr></thead>`;
    const rows = evs.map((ev, i) => {
      const b = ev.borrower, moved = ev.recommendation.code !== BASE[i].recommendation.code;
      const cells = ev.results.map((r) => `<td class="c"><span class="cell s-${r.status}" title="${esc(r.short)}: ${esc(CAM.STATUS_LABEL[r.status])} (${esc(r.value_display)})">${ICON[r.status]}</span></td>`).join("");
      return `<tr data-id="${b.id}" class="${moved ? "moved" : ""}"><td><b>${b.id}</b> <span class="muted">${esc(b.industry)}</span></td>${cells}
        <td>${outcomeBadge(ev.recommendation)}${moved ? `<span class="was">was: ${esc(BASE[i].recommendation.label)}</span>` : ""}</td></tr>`;
    }).join("");
    $("port").innerHTML = head + `<tbody>${rows}</tbody>`;
    $("port").querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => {
      current = tr.dataset.id;
      showTab("review");
      document.querySelector("nav.tabs").scrollIntoView({ behavior: "smooth" });
    }));

    const changes = [];
    evs.forEach((ev, i) => {
      const before = BASE[i];
      const ruleMoves = ev.results.filter((r, j) => r.status !== before.results[j].status)
        .map((r, _, arr) => `${r.id} ${esc(r.short)}: ${esc(r.value_display)} vs ${esc(r.threshold_display)}`);
      if (ev.recommendation.code !== before.recommendation.code)
        changes.push(`<li><b>${ev.borrower.id}</b> ${esc(before.recommendation.label)} → <b>${esc(ev.recommendation.label)}</b><br><small>${ruleMoves.join(" · ")}</small></li>`);
    });
    $("changes").innerHTML = !policyEdited() ? `<p class="muted" style="margin:0">This is the original policy. Try <b>Downturn: tighten</b> to see which files would no longer qualify.</p>`
      : changes.length ? `<ul class="changes" style="padding-left:18px;margin:0">${changes.join("")}</ul>`
      : `<p class="muted" style="margin:0">Policy edited, but no file changed its outcome.</p>`;
  }

  // ---------------- 2. Review a file ----------------
  function fillBorrowerSelect(sel) {
    sel.innerHTML = BORROWERS.map((b) => `<option value="${b.id}">${esc(label(b))}</option>`).join("");
    sel.value = current;
  }
  $("borrower").addEventListener("change", (e) => { current = e.target.value; renderReview(); });

  function renderReview() {
    fillBorrowerSelect($("borrower"));
    const b = byId(current), ev = CAM.evaluate(b, policy), q = CAM.reviewQueue(ev), lr = b.loan_request;
    $("policy-note").innerHTML = policyEdited() ? `<div class="note">You are reviewing against your <b>edited</b> policy from tab 1.</div>` : "";
    const n = (s) => q.filter((r) => r.status === s).length;
    $("file-meta").innerHTML = `<div class="row" style="justify-content:space-between">
      <div><h2>${esc(b.name)} <small style="font-weight:400">· ${esc(b.industry)}</small></h2>
      <small>Asks for Rs ${lr.amount_lakh} lakh over ${lr.tenure_months} months at ${lr.annual_rate_pct}%</small></div>
      <div class="counts">${outcomeBadge(ev.recommendation)}
      <span class="badge s-FAIL">${n("FAIL")} fail</span><span class="badge s-CANT_CHECK">${n("CANT_CHECK")} can't check</span>
      <span class="badge s-BORDERLINE">${n("BORDERLINE")} borderline</span></div></div>
      <p style="margin:8px 0 0;font-size:13.5px" class="muted">${esc(ev.recommendation.explain)}</p>`;
    $("planted").textContent = b.planted_problem;

    const flagged = q.filter((r) => r.status !== "PASS");
    const html = (flagged.length ? "" : `<div class="ok" style="margin-top:10px">Nothing to check first: every rule passes comfortably.</div>`)
      + q.map((r) => ruleCard(r, r.status !== "PASS")).join("");
    $("queue").innerHTML = html;
    $("queue").querySelectorAll("[data-key]").forEach(wireDecision);
    renderAudit();
  }

  const edited = (r) => ORIGINAL.rules.find((o) => o.id === r.id).threshold !== r.threshold;

  function ruleCard(r, open) {
    const key = `${current}:${r.id}`;
    const d = decisions[key] || { decision: DECISIONS[0], reason: "" };
    const inputs = r.inputs.length ? `<div class="table-wrap"><table><thead><tr><th>Input</th><th>Value</th><th>Where it came from</th></tr></thead><tbody>${
      r.inputs.map((i) => `<tr><td>${esc(i.label)}</td><td>${esc(typeof i.value === "number" ? CAM.fmt(i.value, i.unit) : i.value)}</td><td>${esc(i.source)}</td></tr>`).join("")}</tbody></table></div>` : "";
    const decide = r.status === "PASS" ? "" : `<div class="decide" data-key="${key}">
      <div><label>Reviewer decision</label><select>${DECISIONS.map((x) => `<option ${x === d.decision ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
      <div><label>Reason (needed for any override)</label><input type="text" value="${esc(d.reason)}" placeholder="e.g. Promoter brought in Rs 40 lakh fresh equity"></div>
      <div class="err" hidden style="grid-column:1/-1">An override needs a written reason. It goes into the audit log.</div></div>`;
    return `<details class="rule" ${open ? "open" : ""}><summary><span class="cell s-${r.status}">${ICON[r.status]}</span>
      <span class="title">${r.id} · ${esc(r.short)}</span><span class="badge s-${r.status}">${esc(CAM.STATUS_LABEL[r.status])}</span>
      <span class="val">${esc(r.value_display)} · policy: ${esc(r.threshold_display)}</span></summary>
      <div class="body"><p><b>Rule:</b> ${esc(r.text)}${edited(r) ? ` <span class="badge" style="background:var(--accent-soft);color:var(--accent)">Edited in tab 1: now ${esc(r.threshold_display)}</span>` : ""}</p>${r.reason ? `<div class="warn">${esc(r.reason)}</div>` : ""}
      ${inputs}${r.how ? `<p><b>Calculation:</b> <code>${esc(r.how)}</code> = <b>${esc(r.value_display)}</b></p>` : ""}${decide}</div></details>`;
  }

  function wireDecision(box) {
    const key = box.dataset.key, sel = box.querySelector("select"), txt = box.querySelector("input"), err = box.querySelector(".err");
    const update = () => {
      decisions[key] = { decision: sel.value, reason: txt.value };
      err.hidden = !(sel.value.startsWith("Override") && !txt.value.trim());
      renderAudit();
    };
    sel.addEventListener("change", update);
    txt.addEventListener("input", update);
    update();
  }

  function auditRows() {
    return Object.entries(decisions).filter(([, v]) => v.decision !== DECISIONS[0])
      .map(([k, v]) => ({ file: k.split(":")[0], rule: k.split(":")[1], ...v }));
  }
  function renderAudit() {
    const rows = auditRows();
    $("audit").innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>File</th><th>Rule</th><th>Decision</th><th>Reason</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${r.file}</td><td>${r.rule}</td><td>${esc(r.decision)}</td><td>${r.reason ? esc(r.reason) : (r.decision.startsWith("Override") ? '<span style="color:var(--fail)">missing</span>' : "")}</td></tr>`).join("")}</tbody></table></div>
      <div class="btns"><button class="btn" id="dl-audit">Download audit log (CSV)</button></div>`
      : `<p class="muted" style="margin:0">No decisions recorded yet. Every decision and its reason lands here.</p>`;
    const dl = $("dl-audit");
    if (dl) dl.addEventListener("click", () => {
      const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const csv = ["File,Rule,Decision,Reason", ...rows.map((r) => [r.file, r.rule, r.decision, r.reason].map(q).join(","))].join("\n");
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "audit_log.csv" });
      a.click();
    });
  }

  // ---------------- 3. Memo ----------------
  $("model").innerHTML = MODELS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("");
  $("memo-borrower").addEventListener("change", (e) => { current = e.target.value; renderMemo(); });
  document.querySelectorAll("[data-writer]").forEach((btn) => btn.addEventListener("click", () => {
    writer = btn.dataset.writer;
    document.querySelectorAll("[data-writer]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
    renderMemo();
  }));
  $("plant").addEventListener("change", () => renderMemoOutput());
  $("load-model").addEventListener("click", () => ensureModel().catch(showAiError));
  $("write-ai").addEventListener("click", () => writeAiMemo(current).catch(showAiError));
  $("model").addEventListener("change", () => { $("write-ai").disabled = !(llm && llmModel === $("model").value); });

  const memoKey = (id) => `${id}|${llmModel}|${policyKey()}`;

  function renderMemo() {
    fillBorrowerSelect($("memo-borrower"));
    $("ai-box").hidden = writer !== "ai";
    if (writer === "ai" && !navigator.gpu) {
      $("ai-status").innerHTML = "This browser doesn't support WebGPU, so the model can't run here. Try recent Chrome or Edge on a desktop. The template memo and all checks still work.";
      $("load-model").disabled = true;
    } else if (writer === "ai" && !llm) {
      $("ai-status").textContent = "The model downloads once, then stays cached in this browser for next time. Your data is never sent to a server.";
    }
    renderMemoOutput();
  }

  function currentMemoText() {
    if (writer === "template") return CAM.templateMemo(CAM.evaluate(byId(current), policy));
    return aiMemos[memoKey(current)] || "";
  }

  function renderMemoMarkdown(text, bad, streaming) {
    let html = text.split("\n").filter((l) => l.trim()).map((line) => {
      let s = esc(line.trim());
      s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      for (const n of bad) {
        const re = new RegExp(`(?<![\\d.,])${n.replace(/[.,]/g, (c) => "\\" + c)}(?![\\d])`);
        s = s.replace(re, `<mark class="bad">${n}</mark>`);
      }
      s = s.replace(/\[((?:R\d+|APP|POLICY)(?:\s*,\s*(?:R\d+|APP|POLICY))*)\]/g, '<span class="tag">$1</span>');
      return /^#{1,6}\s/.test(line.trim()) ? `<h4>${s.replace(/^#{1,6}\s*/, "")}</h4>` : `<p>${s}</p>`;
    }).join("");
    if (streaming) html += '<span class="cursor"></span>';
    return html;
  }

  function renderMemoOutput(streaming = false) {
    const ev = CAM.evaluate(byId(current), policy);
    let text = currentMemoText();
    let plantNote = "";
    if (!text) {
      $("memo-text").innerHTML = `<p class="muted">${llm ? "Click <b>Write memo</b> to let the on-device model draft it." : "Load a model, then click <b>Write memo</b>."}</p>`;
      $("memo-checks").innerHTML = `<p class="muted">Checks run as soon as there is a memo.</p>`;
      return;
    }
    if ($("plant").checked && !streaming) {
      const r = CAM.injectError(text);
      text = r.memo;
      if (r.old) plantNote = `<p class="muted" style="font-size:13px">Planted: changed <b>${esc(r.old)}</b> to <b>${esc(r.wrong)}</b>.</p>`;
    }
    const c = CAM.checkMemo(text, ev, policy);
    $("memo-text").innerHTML = renderMemoMarkdown(text, c.unmatched.map((n) => n.number), streaming);
    if (streaming) { $("memo-checks").innerHTML = `<p class="muted">Waiting for the model to finish…</p>`; return; }
    const okN = c.numbers.filter((n) => n.ok).length;
    $("memo-checks").innerHTML = plantNote + `
      <div class="check-line"><span class="ic">${c.unmatched.length ? "❌" : "✅"}</span><div><b>Numbers:</b> ${okN} of ${c.numbers.length} match the calculated facts
        ${c.unmatched.map((n) => `<div class="err"><b>${esc(n.number)}</b> is not in the facts.<br><small>${esc(n.sentence)}</small></div>`).join("")}</div></div>
      <div class="check-line"><span class="ic">${c.uncited.length ? "❌" : "✅"}</span><div><b>Sources:</b> ${c.uncited.length ? `${c.uncited.length} sentence(s) cite no rule` : "every sentence cites a rule"}
        ${c.uncited.map((s) => `<div class="warn">${esc(s)}</div>`).join("")}</div></div>
      <div class="check-line"><span class="ic">${c.recommendationOk ? "✅" : "❌"}</span><div><b>Outcome</b> ${c.recommendationOk ? "matches" : "does not match"} the rule engine ("${esc(ev.recommendation.label)}")</div></div>
      ${c.passed ? `<div class="ok">Memo passed every check. It can go to the reviewer.</div>` : `<div class="err">Memo blocked. Fix the flagged items before it reaches the reviewer.</div>`}`;
  }

  // ---------------- On-device AI (WebLLM) ----------------
  function setProgress(frac, text) {
    $("progress").hidden = false;
    $("progress").firstElementChild.style.width = `${Math.round(frac * 100)}%`;
    $("ai-status").textContent = text;
  }
  function showAiError(e) {
    busy = false;
    $("load-model").disabled = false;
    $("ai-status").innerHTML = `<span style="color:var(--fail)">${esc(e.message || e)}</span>`;
  }

  async function ensureModel() {
    const id = $("model").value;
    if (llm && llmModel === id) return;
    if (!navigator.gpu) throw new Error("This browser doesn't support WebGPU. Try recent Chrome or Edge on a desktop.");
    $("load-model").disabled = true; $("write-ai").disabled = true;
    setProgress(0, "Loading the WebLLM library…");
    const webllm = await import(WEBLLM_URL);
    if (llm) { await llm.unload(); llm = null; }
    llm = await webllm.CreateMLCEngine(id, { initProgressCallback: (r) => setProgress(r.progress || 0, r.text || "") });
    llmModel = id;
    setProgress(1, `Ready: ${MODELS.find((m) => m[0] === id)[1]} is running on this device.`);
    $("load-model").disabled = false; $("write-ai").disabled = false;
    renderMemoOutput();
  }

  async function generateMemo(id, onToken) {
    const ev = CAM.evaluate(byId(id), policy);
    const stream = await llm.chat.completions.create({
      messages: [{ role: "user", content: CAM.memoPrompt(ev) }],
      temperature: 0.2, max_tokens: 600, stream: true,
    });
    let text = "";
    for await (const chunk of stream) {
      text += (chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) || "";
      if (onToken) onToken(text);
    }
    return text.trim();
  }

  async function writeAiMemo(id) {
    if (busy) return;
    await ensureModel();
    busy = true; $("write-ai").disabled = true;
    $("ai-status").textContent = "Writing on this device…";
    const key = memoKey(id);
    aiMemos[key] = await generateMemo(id, (t) => { aiMemos[key] = t; if (current === id) renderMemoOutput(true); });
    busy = false; $("write-ai").disabled = false;
    $("ai-status").textContent = "Done. The checks on the right ran on the model's output.";
    renderMemoOutput();
  }

  // ---------------- 4. How well it works ----------------
  function renderAbout() {
    let match = 0, total = 0;
    const rows = BASE.map((ev) => {
      const b = ev.borrower;
      ev.results.forEach((r) => { total++; if (b.expected[r.id] === r.status) match++; });
      const flagged = CAM.reviewQueue(ev).filter((r) => r.status !== "PASS").map((r) => `${r.id} ${CAM.STATUS_LABEL[r.status].toLowerCase()}`);
      return `<tr><td><b>${b.id}</b></td><td>${esc(b.planted_problem)}</td><td>${esc(flagged.join(", ") || "-")}</td></tr>`;
    }).join("");
    $("eval-rules").innerHTML = `<p style="margin-top:0"><b>${match} of ${total}</b> rule results match answers I wrote by hand (12 files × 10 rules, original policy).
      I wrote both the rules and the test files, so this mostly proves the engine does what I intended. Real files are messier.</p>
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Planted problem</th><th>Flagged</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $("glossary").innerHTML = GLOSSARY.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("");
  }

  $("run-ai-test").addEventListener("click", async () => {
    const btn = $("run-ai-test");
    try {
      if (!navigator.gpu) throw new Error("This browser doesn't support WebGPU. Try recent Chrome or Edge on a desktop.");
      if (busy) return;
      btn.disabled = true;
      $("ai-test-status").textContent = "Loading model (see tab 3 for progress)…";
      writer = "ai";
      document.querySelectorAll("[data-writer]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.writer === "ai"));
      $("ai-box").hidden = false;
      await ensureModel();
      busy = true;
      const results = [];
      for (const b of BORROWERS) {
        $("ai-test-status").textContent = `Writing memo ${results.length + 1} of ${BORROWERS.length}…`;
        const text = await generateMemo(b.id);
        aiMemos[memoKey(b.id)] = text;
        const ev = CAM.evaluate(b, policy);
        results.push({ id: b.id, c: CAM.checkMemo(text, ev, policy) });
        renderAiTest(results);
      }
      $("ai-test-status").textContent = `Done with ${MODELS.find((m) => m[0] === llmModel)[1]}. Open any memo in tab 3 to see it.`;
    } catch (e) {
      $("ai-test-status").innerHTML = `<span style="color:var(--fail)">${esc(e.message || e)}</span>`;
    } finally {
      busy = false; btn.disabled = false;
    }
  });

  function renderAiTest(results) {
    const passed = results.filter((r) => r.c.passed).length;
    const nums = results.reduce((s, r) => s + r.c.numbers.length, 0);
    const bad = results.reduce((s, r) => s + r.c.unmatched.length, 0);
    const unc = results.reduce((s, r) => s + r.c.uncited.length, 0);
    const recBad = results.filter((r) => !r.c.recommendationOk).length;
    $("ai-test").innerHTML = `<div class="chips" style="grid-template-columns:repeat(3,1fr)">
      <div class="chip"><div class="n">${passed}/${results.length}</div><div class="l">memos passed every check</div></div>
      <div class="chip"><div class="n">${bad}</div><div class="l">wrong numbers blocked (of ${nums})</div></div>
      <div class="chip"><div class="n">${unc}</div><div class="l">sentences with no source</div></div></div>
      ${recBad ? `<p class="err">${recBad} memo(s) changed the outcome and were blocked.</p>` : ""}
      <div class="table-wrap"><table><thead><tr><th>File</th><th>Result</th><th>What the checks caught</th></tr></thead><tbody>${
        results.map((r) => {
          const issues = [];
          if (r.c.unmatched.length) issues.push(`wrong numbers: ${r.c.unmatched.map((n) => n.number).join(", ")}`);
          if (r.c.uncited.length) issues.push(`${r.c.uncited.length} uncited sentence(s)`);
          if (!r.c.recommendationOk) issues.push("outcome changed");
          return `<tr><td>${r.id}</td><td>${r.c.passed ? '<span class="badge s-PASS">Passed</span>' : '<span class="badge s-FAIL">Blocked</span>'}</td><td>${esc(issues.join(" · ") || "-")}</td></tr>`;
        }).join("")}</tbody></table></div>`;
  }

  // ---------------- Start ----------------
  renderPolicyRows();
  renderPortfolio();
  renderAbout();
})();
