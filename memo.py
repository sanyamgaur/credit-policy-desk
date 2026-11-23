"""Writes the credit memo text, then checks it.

The AI's only job is writing readable sentences from facts the rule engine
already worked out. It never decides a result. After it writes, plain code
checks the memo:
  1. Every number in the memo must match a number in the facts.
  2. Every sentence must cite the rule it relies on, like [R4].
  3. The recommendation must be the one the rule engine gave.
"""
import json
import re

import llm

TAG = r"\[(?:R\d+|APP|POLICY)(?:\s*,\s*(?:R\d+|APP|POLICY))*\]"


def memo_facts(ev):
    b = ev["borrower"]
    lr = b["loan_request"]
    return {
        "borrower": b["name"], "industry": b["industry"],
        "loan_request [APP]": f"Rs {lr['amount_lakh']} lakh over {lr['tenure_months']} months "
                              f"at {lr['annual_rate_pct']}%",
        "recommendation [POLICY]": ev["recommendation"]["label"],
        "recommendation_meaning": ev["recommendation"]["explain"],
        "rules": [{"tag": r["id"], "rule": r["short"], "result": r["status"],
                   "value": r["value_display"], "limit": r["threshold_display"],
                   "why_not_checked": r["reason"]} for r in ev["results"]],
    }


def template_memo(ev):
    """Memo written by fixed code. Used when no Gemini key is set."""
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
{facts}
"""


def ai_memo(ev):
    return llm.generate(PROMPT.format(facts=json.dumps(memo_facts(ev), indent=2)),
                        temperature=0.2).strip()


# ---------------- Checks on the memo (plain code) ----------------

NUM = re.compile(r"(?<![A-Za-z\d.])\d[\d,]*(?:\.\d+)?")


def numbers_by_tag(ev, policy):
    """The numbers each citation tag may back up. A sentence tagged [R6] may only
    use R6's numbers, so a number from elsewhere in the file (say, the DSCR
    limit) can't sneak into a sentence about the current ratio."""
    tags = {}

    def add(vals, v):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return
        for d in (0, 1, 2):
            vals.add(round(float(v), d))          # half-even rounding
            vals.add(float(f"{float(v) + 1e-12:.{d}f}"))  # half-up rounding

    def from_text(vals, text):
        for n in NUM.findall(text or ""):
            add(vals, float(n.replace(",", "")))

    rule_text = {r["id"]: r["text"] for r in policy["rules"]}
    for r in ev["results"]:
        vals = tags[r["id"]] = set()
        add(vals, r["value"])
        add(vals, r["threshold"])
        from_text(vals, r["reason"])
        for i in r["inputs"]:
            add(vals, i["value"])
        from_text(vals, rule_text.get(r["id"]))
    tags["APP"] = set()
    for v in ev["borrower"]["loan_request"].values():
        add(tags["APP"], v)
    tags["POLICY"] = set()
    add(tags["POLICY"], len(ev["results"]))
    for s in ("FAIL", "CANT_CHECK", "BORDERLINE", "PASS"):
        add(tags["POLICY"], sum(r["status"] == s for r in ev["results"]))
    return tags


def check_memo(memo, ev, policy):
    by_tag = numbers_by_tag(ev, policy)
    everything = set().union(*by_tag.values())
    numbers, uncited = [], []
    body_lines = [ln for ln in memo.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    for line in body_lines:
        for sentence in re.split(r"(?<=[.!?])\s+", line.strip()):
            if not sentence:
                continue
            cited = [t.strip() for tag in re.findall(TAG, sentence) for t in tag[1:-1].split(",")]
            if not cited:
                uncited.append(sentence)
            allowed = set().union(*(by_tag.get(t, set()) for t in cited)) if cited else everything
            plain = re.sub(TAG, "", sentence)
            for raw in NUM.findall(plain):
                n = float(raw.replace(",", "").rstrip("."))
                ok = any(abs(n - a) < 1e-6 for a in allowed)
                numbers.append({"number": raw, "ok": ok, "sentence": sentence})
    rec_ok = ev["recommendation"]["label"].lower() in memo.lower()
    bad = [n for n in numbers if not n["ok"]]
    return {"numbers": numbers, "unmatched": bad, "uncited": uncited,
            "recommendation_ok": rec_ok,
            "passed": not bad and not uncited and rec_ok}


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
