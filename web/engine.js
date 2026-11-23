/* Rule engine + memo checks, in JavaScript (same logic as engine.py and memo.py).
 * Plain code makes every decision here. No AI.
 * Works in the browser (window.CAM) and in Node (module.exports) for testing. */
(function (root) {
  "use strict";

  const STATUS_ORDER = { FAIL: 0, CANT_CHECK: 1, BORDERLINE: 2, PASS: 3 };
  const STATUS_LABEL = { FAIL: "Fails policy", CANT_CHECK: "Can't check", BORDERLINE: "Borderline", PASS: "Passes" };
  const DOC_TITLES = {
    application: "Loan application form",
    kyc: "KYC / incorporation certificate",
    bureau: "Credit bureau report",
    financials_fy26: "Audited financials FY26",
    financials_fy25: "Audited financials FY25",
    gst_fy26: "GST returns FY26",
    bank_fy26: "Bank statements FY26",
  };

  class Missing extends Error {}

  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  function yearlyRepayment(amount, months, ratePct) {
    const r = ratePct / 1200;
    if (r === 0) return (amount / months) * 12;
    const f = Math.pow(1 + r, months);
    return ((amount * r * f) / (f - 1)) * 12;
  }

  class Trail {
    constructor(b) { this.b = b; this.inputs = []; this.missingDocs = []; }
    doc(key) {
      const d = this.b.documents[key];
      if (!d || !d.present) throw new Missing(`${DOC_TITLES[key]} not provided`);
      return d;
    }
    field(docKey, field, label, unit = "") {
      const d = this.doc(docKey);
      const value = d[field];
      if (value === null || value === undefined) throw new Missing(`${label} could not be read from ${DOC_TITLES[docKey]}`);
      const page = (d.pages || {})[field];
      this.inputs.push({ label, value, unit, source: DOC_TITLES[docKey] + (page ? `, page ${page}` : "") });
      return value;
    }
    months(docKey, field, needed) {
      const d = this.doc(docKey);
      const got = d[field] || 0;
      if (got < needed) throw new Missing(`${DOC_TITLES[docKey]} cover only ${got} of ${needed} months`);
      this.inputs.push({ label: `${DOC_TITLES[docKey]}: months covered`, value: got, unit: "months", source: DOC_TITLES[docKey] });
      return got;
    }
    application(field, label, unit = "") {
      const value = this.b.loan_request[field];
      this.inputs.push({ label, value, unit, source: DOC_TITLES.application });
      return value;
    }
    derived(label, value, unit, how) {
      this.inputs.push({ label, value: round(value, 2), unit, source: `Calculated: ${how}` });
      return value;
    }
  }

  function newLoanYearly(t) {
    const amt = t.application("amount_lakh", "Loan asked for", "Rs lakh");
    const months = t.application("tenure_months", "Tenure", "months");
    const rate = t.application("annual_rate_pct", "Interest rate", "%");
    return t.derived("New loan: yearly repayments", yearlyRepayment(amt, months, rate), "Rs lakh",
      `EMI on Rs ${amt} lakh over ${months} months at ${rate}% x 12`);
  }

  const METRICS = {
    vintage_years(t) {
      const inc = t.field("kyc", "incorporation_date", "Date of incorporation");
      const app = t.b.application_date;
      t.inputs.push({ label: "Application date", value: app, unit: "", source: DOC_TITLES.application });
      const days = (Date.parse(app) - Date.parse(inc)) / 86400000;
      return [days / 365.25, `(${app} - ${inc}) / 365.25 days`];
    },
    bureau_score(t) { return [t.field("bureau", "promoter_score", "Promoter bureau score"), "Read directly from the bureau report"]; },
    max_dpd_12m(t) { return [t.field("bureau", "max_dpd_12m", "Worst days-past-due in last 12 months", "days"), "Read directly from the bureau report"]; },
    dscr(t) {
      const ebitda = t.field("financials_fy26", "ebitda", "EBITDA (yearly cash profit)", "Rs lakh");
      const existing = t.field("financials_fy26", "existing_annual_debt_service", "Existing loans: yearly repayments", "Rs lakh");
      const nw = newLoanYearly(t);
      return [ebitda / (existing + nw), `${ebitda} / (${existing} + ${nw.toFixed(2)})`];
    },
    debt_to_ebitda(t) {
      const ebitda = t.field("financials_fy26", "ebitda", "EBITDA (yearly cash profit)", "Rs lakh");
      const existing = t.field("financials_fy26", "existing_debt", "Existing debt", "Rs lakh");
      const amt = t.application("amount_lakh", "Loan asked for", "Rs lakh");
      return [(existing + amt) / ebitda, `(${existing} + ${amt}) / ${ebitda}`];
    },
    current_ratio(t) {
      const ca = t.field("financials_fy26", "current_assets", "Current assets", "Rs lakh");
      const cl = t.field("financials_fy26", "current_liabilities", "Current liabilities", "Rs lakh");
      return [ca / cl, `${ca} / ${cl}`];
    },
    gst_vs_revenue_gap_pct(t) {
      t.months("gst_fy26", "months_filed", 12);
      const gst = t.field("gst_fy26", "turnover", "GST-reported sales", "Rs lakh");
      const rev = t.field("financials_fy26", "revenue", "Audited revenue", "Rs lakh");
      return [(Math.abs(gst - rev) / rev) * 100, `|${gst} - ${rev}| / ${rev} x 100`];
    },
    bank_to_gst_pct(t) {
      t.months("gst_fy26", "months_filed", 12);
      t.months("bank_fy26", "months", 12);
      const credits = t.field("bank_fy26", "total_credits", "Money received in bank", "Rs lakh");
      const gst = t.field("gst_fy26", "turnover", "GST-reported sales", "Rs lakh");
      return [(credits / gst) * 100, `${credits} / ${gst} x 100`];
    },
    bounces_6m(t) {
      t.months("bank_fy26", "months", 6);
      return [t.field("bank_fy26", "bounces_6m", "Bounced cheques/EMIs, last 6 months"), "Counted from the bank statement"];
    },
    documents_complete(t) {
      const docs = t.b.documents;
      for (const key of ["kyc", "bureau", "financials_fy26", "financials_fy25"]) {
        const ok = !!(docs[key] && docs[key].present);
        t.inputs.push({ label: DOC_TITLES[key], value: ok ? "Present" : "Missing", unit: "", source: "Document checklist" });
        if (!ok) t.missingDocs.push(DOC_TITLES[key]);
      }
      for (const [key, field] of [["gst_fy26", "months_filed"], ["bank_fy26", "months"]]) {
        const d = docs[key] || {};
        if (!d.present) {
          t.inputs.push({ label: DOC_TITLES[key], value: "Missing", unit: "", source: "Document checklist" });
          t.missingDocs.push(DOC_TITLES[key]);
          continue;
        }
        const got = d[field] || 0;
        t.inputs.push({ label: DOC_TITLES[key], value: `${got} of 12 months`, unit: "", source: "Document checklist" });
        if (got < 12) t.missingDocs.push(`${DOC_TITLES[key]} (only ${got} of 12 months)`);
      }
      return [t.missingDocs.length === 0, "Checklist of required documents"];
    },
  };

  function judge(value, rule, margin) {
    const { op, threshold: limit } = rule;
    if (op === "==") return value === limit ? "PASS" : "FAIL";
    const v = round(value, 4);
    if (op === ">=") return v < limit ? "FAIL" : v < limit * (1 + margin) ? "BORDERLINE" : "PASS";
    if (op === "<=") return v > limit ? "FAIL" : v > limit * (1 - margin) ? "BORDERLINE" : "PASS";
    throw new Error(`Unknown operator ${op}`);
  }

  function fmt(value, unit) {
    if (value === null || value === undefined) return "-";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "number") {
      if (unit === "%") return `${value.toFixed(1)}%`;
      if (unit === "x") return `${value.toFixed(2)}x`;
      if (unit === "years") return `${value.toFixed(1)} years`;
      if (unit === "days") return `${value} days`;
      if (unit === "Rs lakh") {
        const s = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return `Rs ${s} lakh`.replace(".00 lakh", " lakh");
      }
    }
    return `${value} ${unit}`.trim();
  }

  function recommend(results) {
    const isDocs = (r) => r.metric === "documents_complete";
    const fails = results.filter((r) => r.status === "FAIL" && !isDocs(r)).map((r) => r.id);
    const incomplete = results.filter((r) => r.status === "CANT_CHECK" || (isDocs(r) && r.status === "FAIL")).map((r) => r.id);
    const border = results.filter((r) => r.status === "BORDERLINE").map((r) => r.id);
    if (fails.length) return { code: "OUTSIDE_POLICY", label: "Outside policy",
      explain: "Decline, or approve only as a documented deviation signed off by a senior credit officer.", rules: fails.concat(incomplete) };
    if (incomplete.length) return { code: "INCOMPLETE", label: "Incomplete file",
      explain: "Collect the missing documents before taking a credit decision.", rules: incomplete };
    if (border.length) return { code: "WITHIN_POLICY_REVIEW", label: "Within policy, with borderline items",
      explain: "Within policy, but a reviewer should look at the borderline items first.", rules: border };
    return { code: "WITHIN_POLICY", label: "Within policy", explain: "Every rule passes comfortably.", rules: [] };
  }

  function evaluate(borrower, policy) {
    const margin = (policy.borderline_margin_pct ?? 5) / 100;
    const results = policy.rules.map((rule) => {
      const t = new Trail(borrower);
      let value = null, how = null, status, reason = null;
      try {
        [value, how] = METRICS[rule.metric](t);
        status = judge(value, rule, margin);
        if (rule.metric === "documents_complete" && !value) reason = "Missing: " + t.missingDocs.join("; ");
      } catch (e) {
        if (!(e instanceof Missing)) throw e;
        value = null; how = null; status = "CANT_CHECK"; reason = e.message;
      }
      return {
        id: rule.id, short: rule.short, text: rule.text, metric: rule.metric, op: rule.op,
        threshold: rule.threshold, unit: rule.unit, value, status, reason, how, inputs: t.inputs,
        value_display: value === true ? "All present" : value === false ? "Incomplete" : fmt(value, rule.unit),
        threshold_display: rule.op === "==" ? "all present"
          : `${rule.op === ">=" ? "at least" : "at most"} ${fmt(rule.threshold, rule.unit)}`,
      };
    });
    return { borrower, results, recommendation: recommend(results) };
  }

  function reviewQueue(ev) {
    return ev.results.slice().sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || parseInt(a.id.slice(1)) - parseInt(b.id.slice(1)));
  }

  // ---------------- Memo ----------------
  const TAG_SRC = String.raw`\[(?:R\d+|APP|POLICY)(?:\s*,\s*(?:R\d+|APP|POLICY))*\]`;
  const tagRe = (flags = "") => new RegExp(TAG_SRC, flags);
  const numRe = () => /(?<![A-Za-z\d.])\d[\d,]*(?:\.\d+)?/g;

  function memoFacts(ev) {
    const b = ev.borrower, lr = b.loan_request;
    return {
      borrower: b.name, industry: b.industry,
      "loan_request [APP]": `Rs ${lr.amount_lakh} lakh over ${lr.tenure_months} months at ${lr.annual_rate_pct}%`,
      "recommendation [POLICY]": ev.recommendation.label,
      recommendation_meaning: ev.recommendation.explain,
      rules: ev.results.map((r) => ({ tag: r.id, rule: r.short, result: r.status, value: r.value_display,
        limit: r.threshold_display, why_not_checked: r.reason })),
    };
  }

  function templateMemo(ev) {
    const b = ev.borrower, rec = ev.recommendation, lr = b.loan_request;
    const by = (s) => ev.results.filter((r) => r.status === s);
    const lines = ["### Summary",
      `${b.name}, a ${b.industry.toLowerCase()} business, has asked for Rs ${lr.amount_lakh} lakh over ${lr.tenure_months} months at ${lr.annual_rate_pct}% [APP].`,
      `Against the lender's policy, the file is: ${rec.label.toLowerCase()} [POLICY].`,
      "### Concerns"];
    const concerns = by("FAIL").filter((r) => r.metric !== "documents_complete")
      .map((r) => `${r.short} is ${r.value_display}, but the policy needs ${r.threshold_display} [${r.id}].`)
      .concat(by("BORDERLINE").map((r) => `${r.short} is ${r.value_display}, close to the limit of ${r.threshold_display} [${r.id}].`));
    lines.push(...(concerns.length ? concerns : ["None [POLICY]."]), "### Missing information");
    const missing = by("CANT_CHECK").map((r) => `${r.short} could not be checked (${r.reason}) [${r.id}].`)
      .concat(by("FAIL").filter((r) => r.metric === "documents_complete").map((r) => `${r.reason} [${r.id}].`));
    lines.push(...(missing.length ? missing : ["None [POLICY]."]), "### Strengths");
    const strengths = by("PASS").filter((r) => ["dscr", "debt_to_ebitda", "current_ratio", "bureau_score"].includes(r.metric))
      .map((r) => `${r.short} is ${r.value_display}, comfortably within the limit of ${r.threshold_display} [${r.id}].`);
    lines.push(...(strengths.length ? strengths : ["None [POLICY]."]));
    lines.push("### Recommendation", `${rec.label} [POLICY]. ${rec.explain.slice(0, -1)} [POLICY].`);
    return lines.join("\n");
  }

  const MEMO_PROMPT = `You are drafting a short credit memo for a human credit reviewer at a lender.

Rules you must follow:
1. Use ONLY the facts in the JSON below. Do not add, round differently, or invent any number.
2. Do not change the recommendation. State it exactly as given.
3. End every sentence with the tags of the facts it relies on, placed before the full stop,
   like "... below the minimum [R4]." Use [APP] for loan application details and [POLICY]
   for the overall recommendation.
4. Plain English that a new analyst can follow. 120 to 200 words.
5. Use exactly these headings, each on its own line starting with "### ":
   Summary, Concerns, Missing information, Strengths, Recommendation.
   If a section has nothing, write "None [POLICY]."

FACTS:
`;

  function memoPrompt(ev) { return MEMO_PROMPT + JSON.stringify(memoFacts(ev), null, 2); }

  /* The numbers each citation tag is allowed to back up. A sentence tagged [R6]
   * may only use R6's numbers, so a number that exists elsewhere in the file
   * (say, the DSCR limit) can't sneak into a sentence about the current ratio. */
  function numbersByTag(ev, policy) {
    const tags = {};
    const adder = (vals) => (v) => {
      if (typeof v !== "number") return;
      for (const d of [0, 1, 2]) { vals.push(round(v, d)); vals.push(Number(v.toFixed(d))); }
    };
    const fromText = (add, text) => { for (const n of String(text || "").match(numRe()) || []) add(parseFloat(n.replace(/,/g, ""))); };
    for (const r of ev.results) {
      const vals = (tags[r.id] = []), add = adder(vals);
      add(r.value); add(r.threshold); fromText(add, r.reason);
      r.inputs.forEach((i) => add(i.value));
      const rule = policy.rules.find((p) => p.id === r.id);
      if (rule) fromText(add, rule.text);
    }
    tags.APP = []; Object.values(ev.borrower.loan_request).forEach(adder(tags.APP));
    tags.POLICY = []; const addP = adder(tags.POLICY);
    addP(ev.results.length);
    for (const s of ["FAIL", "CANT_CHECK", "BORDERLINE", "PASS"]) addP(ev.results.filter((r) => r.status === s).length);
    return tags;
  }

  function checkMemo(memo, ev, policy) {
    const byTag = numbersByTag(ev, policy);
    const everything = [].concat(...Object.values(byTag));
    const numbers = [], uncited = [];
    const body = memo.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    for (const line of body) {
      for (const sentence of line.trim().split(/(?<=[.!?])\s+/)) {
        if (!sentence) continue;
        const cited = (sentence.match(tagRe("g")) || []).flatMap((t) => t.slice(1, -1).split(/\s*,\s*/));
        if (!cited.length) uncited.push(sentence);
        const allowed = cited.length ? [].concat(...cited.map((t) => byTag[t] || [])) : everything;
        const plain = sentence.replace(tagRe("g"), "");
        for (const raw of plain.match(numRe()) || []) {
          const n = parseFloat(raw.replace(/,/g, "").replace(/\.$/, ""));
          numbers.push({ number: raw, ok: allowed.some((a) => Math.abs(n - a) < 1e-6), sentence });
        }
      }
    }
    const recommendationOk = memo.toLowerCase().includes(ev.recommendation.label.toLowerCase());
    const unmatched = numbers.filter((n) => !n.ok);
    return { numbers, unmatched, uncited, recommendationOk, passed: !unmatched.length && !uncited.length && recommendationOk };
  }

  function injectError(memo) {
    const lines = memo.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#")) continue;
      const masked = lines[i].replace(tagRe("g"), (m) => " ".repeat(m.length));
      const m = /\d+\.\d+/.exec(masked);
      if (m) {
        const wrong = (parseFloat(m[0]) + 0.42).toFixed(2);
        lines[i] = lines[i].slice(0, m.index) + wrong + lines[i].slice(m.index + m[0].length);
        return { memo: lines.join("\n"), old: m[0], wrong };
      }
    }
    return { memo, old: null, wrong: null };
  }

  const api = { STATUS_ORDER, STATUS_LABEL, evaluate, reviewQueue, fmt, templateMemo, memoPrompt,
    checkMemo, injectError, yearlyRepayment };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CAM = api;
})(typeof window !== "undefined" ? window : globalThis);
