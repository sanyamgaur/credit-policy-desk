"""Writes the credit memo text, then checks it. Same logic as web/engine.js.

The AI's only job is rewording an outline the code wrote, in plainer English. It
never decides a result and never types a number: the outline holds placeholders
like {R4.value}, and code fills in the real figures. After that, plain code checks the memo:
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
# How the AI is used: code writes an OUTLINE of the memo (it decides which rule goes
# under Concerns, Missing or Strengths) with placeholders instead of figures. The AI
# may only reword the outline in plainer English. Code then fills every figure back in
# and checks the result, so the AI never types a number and never makes a decision.

def memo_slots(ev):
    """Placeholders the AI may keep, and the exact text code puts in their place."""
    lr = ev["borrower"]["loan_request"]
    label = ev["recommendation"]["label"]
    slots = {"APP.amount": f"Rs {lr['amount_lakh']} lakh", "APP.tenure": f"{lr['tenure_months']} months",
             "APP.rate": f"{lr['annual_rate_pct']}%", "OUTCOME": label, "OUTCOME.lower": label.lower()}
    for r in ev["results"]:
        slots[f"{r['id']}.value"] = r["value_display"]
        slots[f"{r['id']}.limit"] = r["threshold_display"]
        if r["reason"]:
            slots[f"{r['id']}.reason"] = r["reason"]
    return slots


def fill_placeholders(draft, ev):
    slots = memo_slots(ev)
    return PLACEHOLDER.sub(lambda m: slots.get(m.group(1), m.group(0)), draft)


def build_memo(ev, ph):
    """ph=True gives the outline (placeholders); ph=False gives the finished template memo.
    Filling an outline's placeholders must give back exactly the template memo (tested)."""
    b, rec = ev["borrower"], ev["recommendation"]
    lr = b["loan_request"]
    by = {s: [r for r in ev["results"] if r["status"] == s]
          for s in ("FAIL", "CANT_CHECK", "BORDERLINE", "PASS")}

    def val(r): return f"{{{r['id']}.value}}" if ph else r["value_display"]
    def lim(r): return f"{{{r['id']}.limit}}" if ph else r["threshold_display"]
    def why(r): return f"{{{r['id']}.reason}}" if ph else r["reason"]

    amount = "{APP.amount}" if ph else f"Rs {lr['amount_lakh']} lakh"
    tenure = "{APP.tenure}" if ph else f"{lr['tenure_months']} months"
    rate = "{APP.rate}" if ph else f"{lr['annual_rate_pct']}%"
    label = "{OUTCOME}" if ph else rec["label"]
    label_lower = "{OUTCOME.lower}" if ph else rec["label"].lower()
    lines = ["### Summary",
             f"{b['name']}, {'an' if b['industry'][0] in 'AEIOU' else 'a'} {b['industry'].lower()} business, has asked for {amount} over {tenure} at {rate} [APP].",
             f"Against the lender's policy, the file is: {label_lower} [POLICY].",
             "### Concerns"]
    concerns = [f"{r['short']} is {val(r)}, but the policy needs {lim(r)} [{r['id']}]."
                for r in by["FAIL"] if r["metric"] != "documents_complete"]
    concerns += [f"{r['short']} is {val(r)}, close to the limit of {lim(r)} [{r['id']}]." for r in by["BORDERLINE"]]
    lines += concerns or ["None [POLICY]."]
    lines.append("### Missing information")
    missing = [f"{r['short']} could not be checked ({why(r)}) [{r['id']}]." for r in by["CANT_CHECK"]]
    missing += [f"{why(r)} [{r['id']}]." for r in by["FAIL"] if r["metric"] == "documents_complete"]
    lines += missing or ["None [POLICY]."]
    lines.append("### Strengths")
    strengths = [f"{r['short']} is {val(r)}, comfortably within the limit of {lim(r)} [{r['id']}]."
                 for r in by["PASS"] if r["metric"] in ("dscr", "debt_to_ebitda", "current_ratio", "bureau_score")]
    lines += strengths or ["None [POLICY]."]
    lines += ["### Recommendation", f"{label} [POLICY]. {rec['explain'][:-1]} [POLICY]."]
    return "\n".join(lines)


def template_memo(ev):
    """Memo written by fixed code. Used when no AI is available."""
    return build_memo(ev, False)


def memo_outline(ev):
    return build_memo(ev, True)


PROMPT = """Rewrite this credit memo in friendlier, plain English for a new analyst.

Rules:
- Keep the same headings, in the same order. Keep the meaning of every line.
- Keep every {{placeholder}} and every [tag] exactly as written. Do not add, remove or change them.
- Never write a digit. Do not add any facts.
- Every sentence must still end with its [tag] before the full stop.
- Reply with the rewritten memo only.

MEMO:
{outline}

REWRITTEN MEMO:
"""


def clean_draft(text):
    """Tidies what models add around a memo: chatty intros, code fences, '##' headings, bullets."""
    t = re.sub(r"```[a-z]*\n?", "", text or "", flags=re.I)
    m = re.search(r"^\s*#{1,6}\s*\S", t, re.M)
    if m and m.start() > 0:
        t = t[m.start():]
    lines = []
    for ln in t.split("\n"):
        ln = re.sub(r"^\s*#{1,6}\s*", "### ", ln)
        lines.append(re.sub(r"^\s*[-*•]\s+", "", ln))
    return "\n".join(lines).strip()


def ai_memo(ev):
    """Gemini rewords the code's outline; code fills in every figure."""
    draft = llm.generate(PROMPT.format(outline=memo_outline(ev)), temperature=0.2)
    return fill_placeholders(clean_draft(draft), ev)


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
