// Runs the attack cases against the JavaScript memo checker. Usage: node tests/attack_test.js
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const CAM = require(path.join(ROOT, "web", "engine.js"));
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "policy.json")));
const load = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", "borrowers", `${id}.json`)));
const { cases, clean_cases: cleanCases } = JSON.parse(fs.readFileSync(path.join(__dirname, "attack_cases.json")));

let failures = 0;
const report = (ok, label) => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"}  ${label}`); };

// Every clean template memo must pass, and every planted demo error must be caught.
for (const f of fs.readdirSync(path.join(ROOT, "data", "borrowers")).sort()) {
  const ev = CAM.evaluate(load(f.replace(".json", "")), policy);
  const memo = CAM.templateMemo(ev);
  report(CAM.checkMemo(memo, ev, policy).passed, `${f.slice(0, 3)} clean template memo passes`);
  report(!CAM.checkMemo(CAM.injectError(memo).memo, ev, policy).passed, `${f.slice(0, 3)} planted demo error is caught`);
  report(CAM.fillPlaceholders(CAM.memoOutline(ev), ev) === memo, `${f.slice(0, 3)} outline filled by code equals the template memo`);
}

for (const c of cleanCases) report(CAM.cleanDraft(c.input) === c.output, `tidy-up: ${c.name}`);

for (const c of cases) {
  const ev = CAM.evaluate(load(c.borrower), policy);
  let memo;
  if (c.draft) memo = CAM.fillPlaceholders(c.draft, ev);
  else {
    const base = CAM.templateMemo(ev);
    if (!base.includes(c.find)) { report(false, `${c.name}: text to replace not found`); continue; }
    memo = base.replace(c.find, c.replace);
  }
  const passed = CAM.checkMemo(memo, ev, policy).passed;
  report((c.expect === "allowed") === passed, `${c.name} -> ${passed ? "allowed" : "blocked"}`);
}
console.log(failures ? `\n${failures} JavaScript check(s) FAILED` : "\nAll JavaScript checks passed");
process.exitCode = failures ? 1 : 0;
