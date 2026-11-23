"""Writes the credit memo text, then checks it. Same logic as web/engine.js.

The AI's only job is writing readable sentences. It never decides a result, and
it never types a number: it writes placeholders like {R4.value}, and code fills
in the real figures. After that, plain code checks the memo:
  1. Every figure must be an exact figure of the rule its sentence cites.
  2. Words must not contradict a rule's real result ("passes" for a failed rule).
  3. Every sentence must cite the rule it relies on, like [R4].
  4. The memo must state the rule engine's outcome and not recommend otherwise.
"""
import json
import re

import engine
import llm

TAG = r"\[(?:R\d+|APP|POLICY)(?:\s*,\s*(?:R\d+|APP|POLICY))*\]"
# A number, with an optional minus sign and an optional unit word after it.
NUM = re.compile(r"(?<![A-Za-z\d.\-−])([-−]?)(\d[\d,]*(?:\.\d+)?)(\s*(?:crore|cr\b|lakhs?))?", re.I)

POSITIVE = re.compile(r"\b(pass(es|ed)?|comfortabl[ey]|within (the )?(limit|policy|threshold)|meets?|satisf(y|ies|ied)"
                      r"|healthy|above (the )?(required |policy )?minimum|under (the )?(cap|maximum))\b", re.I)
NEGATIVE = re.compile(r"\b(fail(s|ed)?|breach(es|ed)?|below (the )?(required |policy )?minimum"
                      r"|above (the )?(maximum|cap|limit)|exceed(s|ed)?|short of|violat(es|ed|ion))\b", re.I)
APPROVE = re.compile(r"\b(recommend(s|ed)? (approv\w*|sanction\w*)|approve the loan|should be approved"
                     r"|can be approved|sanction the loan)\b", re.I)
DECLINE = re.compile(r"\b(declin\w*|reject\w*)\b", re.I)
PLACEHOLDER = re.compile(r"\{([A-Z0-9]+\.[a-z]+|OUTCOME)\}")


# ---------------- Writing ----------------

def memo_slots(ev):
    """Placeholders the AI may use, and the exact text code puts in their place."""
    lr = ev["borrower"]["loan_request"]
    slots = {"APP.amount": f"Rs {lr['amount_lakh']} lakh", "APP.tenure": f"{lr['tenure_months']} months",
             "APP.rate": f"{lr['annual_rate_pct']}%", "OUTCOME": ev["recommendation"]["label"]}
    for r in ev["results"]:
        slots[f"{r['id']}.value"] = r["value_display"]
        slots[f"{r['id']}.limit"] = r["threshold_display"]
        if r["reason"]:
            slots[f"{r['id']}.reason"] = r["reason"]
    return slots


def fill_placeholders(draft, ev):
    slots = memo_slots(ev)
    return PLACEHOLDER.sub(lambda m: slots.get(m.group(1), m.group(0)), draft)


def memo_facts(ev):
    b = ev["borrower"]
    return {
        "borrower": b["name"], "industry": b["industry"],
        "loan_request_tag_APP": "{APP.amount} over {APP.tenure} at {APP.rate}",
        "outcome_tag_POLICY": "{OUTCOME}",
        "outcome_meaning": ev["recommendation"]["explain"],
        "rules": [{"tag": r["id"], "rule": r["short"], "result": r["status"],
                   "value": f"{{{r['id']}.value}}", "limit": f"{{{r['id']}.limit}}",
                   "why_not_checked": f"{{{r['id']}.reason}}" if r["reason"] else None}
                  for r in ev["results"]],
    }


def template_memo(ev):
    """Memo written by fixed code. Used when no AI is available."""
    b, rec = ev["borrower"], ev["recommendation"]
    lr = b["loan_request"]
    by = {s: [r for r in ev["results"] if r["status"] == s]
          for s in ("FAIL", "CANT_CHECK", "BORDERLINE", "PASS")}
    lines = ["### Summary",
             f"{b['name']}, a {b['industry'].lower()} business, has asked for "
             f"Rs {lr['amount_lakh']} lakh over {lr['tenure_months']} months at "
             f"{lr['annual_rate_pct']}% [APP].",
             f"Against the lender's policy, the file is: {rec['label'].lower()} [POLICY].",
             "### Concerns"]
    concerns = [f"{r['short']} is {r['value_display']}, but the policy needs "
                f"{r['threshold_display']} [{r['id']}]." for r in by["FAIL"]
                if r["metric"] != "documents_complete"]
    concerns += [f"{r['short']} is {r['value_display']}, close to the limit of "
                 f"{r['threshold_display']} [{r['id']}]." for r in by["BORDERLINE"]]
    lines += concerns or ["None [POLICY]."]
    lines.append("### Missing information")
    missing = [f"{r['short']} could not be checked ({r['reason']}) [{r['id']}]."
               for r in by["CANT_CHECK"]]
    missing += [f"{r['reason']} [{r['id']}]." for r in by["FAIL"]
                if r["metric"] == "documents_complete"]
    lines += missing or ["None [POLICY]."]
    lines.append("### Strengths")
    strengths = [f"{r['short']} is {r['value_display']}, comfortably within the limit of "
                 f"{r['threshold_display']} [{r['id']}]." for r in by["PASS"]
                 if r["metric"] in ("dscr", "debt_to_ebitda", "current_ratio", "bureau_score")]
    lines += strengths or ["None [POLICY]."]
    lines += ["### Recommendation", f"{rec['label']} [POLICY]. {rec['explain'][:-1]} [POLICY]."]
    return "\n".join(lines)


PROMPT = """You are drafting a short credit memo for a human credit reviewer at a lender.

Rules you must follow:
1. NEVER type a digit. Wherever a number belongs, copy the placeholder from the facts exactly,
   for example {{R4.value}} or {{APP.amount}}. Code replaces placeholders with the real figures.
2. Do not change the outcome. State it with the {{OUTCOME}} placeholder.
3. Describe each rule's result truthfully: a FAIL rule does not meet the policy, a PASS rule does.
4. End every sentence with the tags of the facts it relies on, placed before the full stop,
   like "... does not meet the policy [R4]." Use [APP] for loan application details and
   [POLICY] for the overall outcome.
5. Plain English that a new analyst can follow. 120 to 200 words.
6. Use exactly these headings, each on its own line starting with "### ":
   Summary, Concerns, Missing information, Strengths, Recommendation.
   If a section has nothing, write "None [POLICY]."

FACTS:
{facts}
"""


def ai_memo(ev):
    """Gemini writes a draft with placeholders; code fills in every figure."""
    draft = llm.generate(PROMPT.format(facts=json.dumps(memo_facts(ev), indent=2)),
                         temperature=0.2).strip()
    return fill_placeholders(draft, ev)


# ---------------- Checks on the memo (plain code) ----------------

def parse_numbers(text):
    out = []
    for m in NUM.finditer(text or ""):
        n = float(m.group(2).replace(",", ""))
        if m.group(1):
            n = -n
        if m.group(3) and "cr" in m.group(3).lower():
            n *= 100  # crore -> lakh
        out.append({"raw": m.group(0).strip(), "n": n})
    return out


def numbers_by_tag(ev, policy):
    """The exact figures each citation tag may use, read from the same display text
    the reviewer sees (so "1.07x" allows 1.07, not 1 or 1.1). A sentence tagged
    [R6] may only use R6's own figures. Loan-application inputs belong to [APP]."""
    tags = {}
    rule_text = {r["id"]: r["text"] for r in policy["rules"]}
    app_source = engine.DOC_TITLES["application"]
    for r in ev["results"]:
        texts = [r["value_display"], r["threshold_display"], r["reason"], rule_text.get(r["id"])]
        texts += [engine.fmt(i["value"], i["unit"]) for i in r["inputs"]
                  if i["source"] != app_source and isinstance(i["value"], (int, float))
                  and not isinstance(i["value"], bool)]
        tags[r["id"]] = [p["n"] for t in texts for p in parse_numbers(t)]
    lr = ev["borrower"]["loan_request"]
    tags["APP"] = [lr["amount_lakh"], lr["tenure_months"], lr["annual_rate_pct"]]
    tags["POLICY"] = [len(ev["results"])] + [sum(r["status"] == s for r in ev["results"])
                                             for s in ("FAIL", "CANT_CHECK", "BORDERLINE", "PASS")]
    return tags


def check_memo(memo, ev, policy):
    by_tag = numbers_by_tag(ev, policy)
    everything = [n for vals in by_tag.values() for n in vals]
    status = {r["id"]: r["status"] for r in ev["results"]}
    code, label = ev["recommendation"]["code"], ev["recommendation"]["label"]
    numbers, uncited, contradictions, decision_conflicts = [], [], [], []
    placeholders = re.findall(r"\{[^}\n]*\}", memo)
    body = [ln for ln in memo.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    for line in body:
        for sentence in re.split(r"(?<=[.!?])\s+", line.strip()):
            if not sentence:
                continue
            cited = [t.strip() for tag in re.findall(TAG, sentence) for t in tag[1:-1].split(",")]
            if not cited:
                uncited.append(sentence)
            plain = re.sub(TAG, "", sentence)
            # 1. Every figure must be one of the cited rules' exact figures.
            allowed = [n for t in cited for n in by_tag.get(t, [])] if cited else everything
            for p in parse_numbers(plain):
                numbers.append({"number": p["raw"], "ok": any(abs(p["n"] - a) < 1e-9 for a in allowed),
                                "sentence": sentence})
            # 2. Words must not contradict the cited rule's real result.
            rules = [t for t in cited if t in status]
            results = {status[t] for t in rules}
            if rules and len(results) == 1:
                s = results.pop()
                if s in ("FAIL", "CANT_CHECK") and POSITIVE.search(plain):
                    contradictions.append({"sentence": sentence, "why": f"says it passes, but {', '.join(rules)} "
                                           + ("fails" if s == "FAIL" else "could not be checked")})
                if s != "FAIL" and NEGATIVE.search(plain):
                    contradictions.append({"sentence": sentence, "why": f"says it fails, but {', '.join(rules)} "
                                           + ("could not be checked" if s == "CANT_CHECK" else "passes")})
            # 3. The memo must not recommend a different decision from the rule engine.
            approves = APPROVE.search(plain) and not re.search("deviation", plain, re.I)
            if approves and code in ("OUTSIDE_POLICY", "INCOMPLETE"):
                decision_conflicts.append({"sentence": sentence,
                                           "why": f"recommends approval, but the file is {label.lower()}"})
            if DECLINE.search(plain) and code in ("WITHIN_POLICY", "WITHIN_POLICY_REVIEW"):
                decision_conflicts.append({"sentence": sentence,
                                           "why": "recommends declining, but the file is within policy"})
    rec_ok = label.lower() in memo.lower() and not decision_conflicts
    bad = [n for n in numbers if not n["ok"]]
    return {"numbers": numbers, "unmatched": bad, "uncited": uncited, "contradictions": contradictions,
            "decision_conflicts": decision_conflicts, "placeholders": placeholders,
            "recommendation_ok": rec_ok,
            "passed": not bad and not uncited and not contradictions and rec_ok and not placeholders}


def inject_error(memo):
    """Demo only: change one decimal number to show the checker catching it."""
    for line_no, line in enumerate(memo.splitlines()):
        if line.startswith("#"):
            continue
        m = re.search(r"\d+\.\d+", re.sub(TAG, lambda x: " " * len(x.group()), line))
        if m:
            wrong = f"{float(m.group()) + 0.42:.2f}"
            lines = memo.splitlines()
            lines[line_no] = line[:m.start()] + wrong + line[m.end():]
            return "\n".join(lines), m.group(), wrong
    return memo, None, None
