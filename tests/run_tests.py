"""Runs every test. Exit code 0 means all passed.

    python3 tests/run_tests.py

1. Attack memos against the Python memo checker (tests/attack_cases.json).
2. The same attack memos against the JavaScript checker (needs Node).
3. Parity: the Python and JavaScript rule engines must give identical results
   for all 12 borrowers under the original policy and a tightened one.
4. Rule engine vs. the hand-written expected answers.
"""
import copy
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import engine  # noqa: E402
import memo  # noqa: E402

failures = 0


def report(ok, label):
    global failures
    failures += not ok
    print(f"{'ok  ' if ok else 'FAIL'}  {label}")


def python_attacks(policy):
    print("\n== Python memo checker ==")
    for path in engine.list_borrowers():
        ev = engine.evaluate(engine.load_borrower(path), policy)
        text = memo.template_memo(ev)
        report(memo.check_memo(text, ev, policy)["passed"], f"{path.stem} clean template memo passes")
        report(not memo.check_memo(memo.inject_error(text)[0], ev, policy)["passed"],
               f"{path.stem} planted demo error is caught")
        report(memo.fill_placeholders(memo.memo_outline(ev), ev) == text,
               f"{path.stem} outline filled by code equals the template memo")
    spec = json.loads((ROOT / "tests" / "attack_cases.json").read_text())
    for c in spec["clean_cases"]:
        report(memo.clean_draft(c["input"]) == c["output"], f"tidy-up: {c['name']}")
    for c in spec["cases"]:
        ev = engine.evaluate(engine.load_borrower(ROOT / "data" / "borrowers" / f"{c['borrower']}.json"), policy)
        if "draft" in c:
            text = memo.fill_placeholders(c["draft"], ev)
        else:
            base = memo.template_memo(ev)
            if c["find"] not in base:
                report(False, f"{c['name']}: text to replace not found")
                continue
            text = base.replace(c["find"], c["replace"], 1)
        passed = memo.check_memo(text, ev, policy)["passed"]
        report((c["expect"] == "allowed") == passed, f"{c['name']} -> {'allowed' if passed else 'blocked'}")


JS_DUMP = r"""
const fs = require("fs"), path = require("path");
const ROOT = process.argv[1];
const CAM = require(path.join(ROOT, "web/engine.js"));
const policies = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {};
for (const [name, p] of Object.entries(policies)) {
  for (const f of fs.readdirSync(path.join(ROOT, "data/borrowers")).filter((f) => f.endsWith(".json")).sort()) {
    const ev = CAM.evaluate(JSON.parse(fs.readFileSync(path.join(ROOT, "data/borrowers", f))), p);
    const m = CAM.templateMemo(ev);
    out[`${name}:${f.replace(".json", "")}`] = {
      rec: ev.recommendation.code,
      rules: ev.results.map((r) => [r.id, r.status, r.value_display, r.threshold_display, r.how, r.reason]),
      memo: m, check: CAM.checkMemo(m, ev, p).passed,
    };
  }
}
console.log(JSON.stringify(out));
"""


def javascript_and_parity(policy):
    print("\n== JavaScript memo checker ==")
    try:
        r = subprocess.run(["node", str(ROOT / "tests" / "attack_test.js")], capture_output=True, text=True)
    except FileNotFoundError:
        report(False, "Node is not installed, so the JavaScript tests could not run")
        return
    print(r.stdout.strip())
    report(r.returncode == 0, "JavaScript attack tests")

    print("\n== Python vs JavaScript parity ==")
    tight = copy.deepcopy(policy)
    for rule in tight["rules"]:
        rule["threshold"] = {"R4": 1.5, "R7": 5}.get(rule["id"], rule["threshold"])
    policies = {"original": policy, "tightened": tight}
    js = json.loads(subprocess.run(["node", "-e", JS_DUMP, str(ROOT)], input=json.dumps(policies),
                                   capture_output=True, text=True, check=True).stdout)
    diffs = 0
    for name, p in policies.items():
        for path in engine.list_borrowers():
            ev = engine.evaluate(engine.load_borrower(path), p)
            text = memo.template_memo(ev)
            py = {"rec": ev["recommendation"]["code"],
                  "rules": [[r["id"], r["status"], r["value_display"], r["threshold_display"], r["how"], r["reason"]]
                            for r in ev["results"]],
                  "memo": text, "check": memo.check_memo(text, ev, p)["passed"]}
            other = js[f"{name}:{path.stem}"]
            for field in py:
                if py[field] != other[field]:
                    diffs += 1
                    print(f"  differs: {name} {path.stem} {field}")
    report(diffs == 0, f"Python and JavaScript agree on {len(js)} evaluations ({diffs} differences)")


def expected_answers(policy):
    print("\n== Rule engine vs. hand-written answers ==")
    wrong = total = 0
    for path in engine.list_borrowers():
        b = engine.load_borrower(path)
        for r in engine.evaluate(b, policy)["results"]:
            total += 1
            wrong += r["status"] != b["expected"][r["id"]]
    report(wrong == 0, f"{total - wrong} of {total} rule results match")


if __name__ == "__main__":
    pol = engine.load_policy()
    python_attacks(pol)
    javascript_and_parity(pol)
    expected_answers(pol)
    print(f"\n{'ALL TESTS PASSED' if not failures else f'{failures} TEST(S) FAILED'}")
    sys.exit(1 if failures else 0)
