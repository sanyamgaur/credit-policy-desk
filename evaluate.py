"""Measures how well each part works and writes eval_results.md.

  Part 1 (always runs): rule engine vs. the answers I wrote by hand.
  Part 2 (needs GEMINI_API_KEY): can the AI turn plain-English policy rules into
          the structured checks the engine uses?
  Part 3 (needs GEMINI_API_KEY): do the AI-written memos pass the number,
          citation and recommendation checks?

Run:  python3 evaluate.py
      GEMINI_API_KEY=... python3 evaluate.py
"""
import json
from collections import Counter
from pathlib import Path

import engine
import llm
import memo

OUT = Path(__file__).parent / "eval_results.md"


def part1_rules(policy):
    rows, wrong, counts = [], [], Counter()
    for path in engine.list_borrowers():
        b = engine.load_borrower(path)
        ev = engine.evaluate(b, policy)
        for r in ev["results"]:
            exp = b["expected"][r["id"]]
            counts[exp] += 1
            if r["status"] != exp:
                wrong.append(f"{b['id']} {r['id']}: expected {exp}, got {r['status']}")
        flagged = [f"{r['id']} {r['status']}" for r in engine.review_queue(ev) if r["status"] != "PASS"]
        rows.append(f"| {b['id']} | {b['planted_problem']} | {', '.join(flagged) or '-'} | "
                    f"{ev['recommendation']['label']} |")
    total = sum(counts.values())
    lines = ["## Part 1: rule engine vs. hand-written answers", "",
             f"**{total - len(wrong)} of {total} rule results match** "
             f"(12 files x 10 rules). Expected mix: "
             + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) + ".", "",
             "| File | Planted problem | Flagged (check-first order) | Outcome |",
             "|---|---|---|---|", *rows, ""]
    if wrong:
        lines += ["Mismatches:", *[f"- {w}" for w in wrong], ""]
    lines += ["Note: I wrote both the rules and the test files, so this mainly proves the engine "
              "does what I intended. Real borrower files would be messier.", ""]
    return lines, len(wrong) == 0


PARSE_PROMPT = """Convert each credit-policy rule into a structured check.
Choose "metric" ONLY from this list:
{metrics}
"op" must be one of ">=", "<=", "==". "threshold" is a number (or true for documents_complete).
Return a JSON array of objects with keys: id, metric, op, threshold.

RULES:
{rules}
"""

METRIC_HELP = {
    "vintage_years": "years the business has operated",
    "bureau_score": "promoter credit bureau score",
    "max_dpd_12m": "worst days a repayment was late in last 12 months",
    "dscr": "yearly cash profit / yearly loan repayments",
    "debt_to_ebitda": "total debt / EBITDA",
    "current_ratio": "current assets / current liabilities",
    "gst_vs_revenue_gap_pct": "percent gap between GST sales and audited revenue",
    "bank_to_gst_pct": "bank receipts as percent of GST sales",
    "bounces_6m": "bounced cheques or EMIs in last 6 months",
    "documents_complete": "whether all required documents are present",
}


def part2_parse(policy):
    prompt = PARSE_PROMPT.format(
        metrics="\n".join(f"- {k}: {v}" for k, v in METRIC_HELP.items()),
        rules="\n".join(f"{r['id']}: {r['text']}" for r in policy["rules"]))
    parsed = {p["id"]: p for p in json.loads(llm.generate(prompt, json_mode=True))}
    rows, correct = [], 0
    for r in policy["rules"]:
        p = parsed.get(r["id"], {})
        ok = (p.get("metric") == r["metric"] and p.get("op") == r["op"]
              and p.get("threshold") == r["threshold"])
        correct += ok
        rows.append(f"| {r['id']} | {r['short']} | {p.get('metric')} {p.get('op')} "
                    f"{p.get('threshold')} | {'Correct' if ok else 'WRONG'} |")
    return ["## Part 2: AI turns plain-English rules into checks", "",
            f"**{correct} of {len(policy['rules'])} rules parsed correctly.** "
            "A human still confirms the parsed rules before they are used.", "",
            "| Rule | Name | AI output | Result |", "|---|---|---|---|", *rows, ""]


def part3_memos(policy):
    rows, passed, nums, bad_nums, uncited = [], 0, 0, 0, 0
    for path in engine.list_borrowers():
        ev = engine.evaluate(engine.load_borrower(path), policy)
        text = memo.ai_memo(ev)
        c = memo.check_memo(text, ev, policy)
        passed += c["passed"]
        nums += len(c["numbers"])
        bad_nums += len(c["unmatched"])
        uncited += len(c["uncited"])
        issues = ([f"unmatched {', '.join(n['number'] for n in c['unmatched'])}"] if c["unmatched"] else []) \
            + ([f"{len(c['uncited'])} uncited sentence(s)"] if c["uncited"] else []) \
            + ([f"{len(c['contradictions'])} sentence(s) contradict a rule"] if c["contradictions"] else []) \
            + ([f"unfilled {', '.join(c['placeholders'])}"] if c["placeholders"] else []) \
            + ([] if c["recommendation_ok"] else ["recommendation changed"])
        rows.append(f"| {ev['borrower']['id']} | {'Pass' if c['passed'] else 'Flagged'} | "
                    f"{'; '.join(issues) or '-'} |")
    return ["## Part 3: AI-written memos, checked by code", "",
            f"**{passed} of 12 memos passed every check.** "
            f"{bad_nums} of {nums} numbers did not match the facts; "
            f"{uncited} sentences had no citation.", "",
            "| File | Result | Issues found |", "|---|---|---|", *rows, ""]


def main():
    policy = engine.load_policy()
    lines = ["# Evaluation results", "",
             "All borrower files and the policy are made up for this demo.", ""]
    p1, _ = part1_rules(policy)
    lines += p1
    if llm.available():
        for part in (part2_parse, part3_memos):
            try:
                lines += part(policy)
            except Exception as e:  # keep earlier results even if the AI is down
                lines += [f"## {part.__name__}: could not run", "", f"Error: {e}", ""]
        lines += [f"_AI model used: {llm.last_model_used}_", ""]
    else:
        lines += ["## Parts 2 and 3: skipped", "",
                  "Set GEMINI_API_KEY to test the AI steps.", ""]
    OUT.write_text("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
