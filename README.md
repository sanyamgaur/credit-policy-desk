# CAM Policy Check

A small prototype for checking a loan file against a lender's **own credit policy** before a
credit memo (CAM) goes to a reviewer.

**The problem:** AI can draft a credit memo in minutes. But the reviewer still has to answer two
questions: *does this loan break our policy?* and *can I trust the numbers in this memo?*

**The idea:** let code make every decision, let AI only write, and show the reviewer the
problems first.

1. **Code** reads each number from the borrower's documents and records the page it came from.
2. **Code** checks each policy rule: *Fails*, *Can't check* (evidence missing), *Borderline*
   (within 5% of the limit) or *Passes*.
3. The reviewer sees failures first. Any override needs a written reason, which goes into an
   audit log.
4. **AI (Gemini)** writes the memo text from the calculated facts. Code then checks that every
   number in the memo matches a fact, that every sentence cites a rule, and that the
   recommendation wasn't changed.

> All borrowers, numbers and the lender policy are made up. No real or employer data is used.

## Web version: no API key, runs in the browser

`docs/index.html` is a single page with everything above, plus:

- **Policy what-if:** change any limit (or click *Downturn: tighten*) and all 12 files re-check
  instantly, showing which loans would no longer qualify and why.
- **On-device AI:** a small open-source model (Qwen 2.5 or Llama 3.2, via WebLLM) runs on the
  viewer's own computer through WebGPU. No API key, no server, and the borrower data never
  leaves the device. The model only writes; code checks every number before the memo is shown.
- **AI test:** one click has the model write memos for all 12 files and reports how many the
  checks blocked.

The model downloads once (290 MB for the smallest) and is cached. It needs a browser with
WebGPU, such as recent Chrome or Edge on a desktop. Everything except the AI writing works in
any browser.

**Host it free on GitHub Pages:** push this folder to GitHub, open *Settings → Pages*, choose
*Deploy from a branch*, branch `main`, folder `/docs`. Your link will be
`https://<your-username>.github.io/<repo-name>/`.

After changing `web/*`, `policy.json` or the borrower data, rebuild the page:

```bash
python3 build_web.py
```

## Files

| File | What it does |
|---|---|
| `policy.json` | 10 made-up credit-policy rules, in plain English and as structured checks |
| `make_sample_data.py` | Creates 12 made-up borrower files, each with planted problems and hand-written expected answers |
| `engine.py` | The rule engine. No AI. Calculates ratios, checks rules, keeps the evidence trail |
| `memo.py` | Writes the memo (template or Gemini) and checks it with code |
| `llm.py` | Minimal Gemini API client (standard library only) |
| `evaluate.py` | Measures each part and writes `eval_results.md` |
| `app.py` | Streamlit demo (Python version) |
| `web/engine.js` | The same rule engine and memo checks in JavaScript, tested to give identical results |
| `web/app.js`, `web/style.css`, `web/template.html` | The web page |
| `build_web.py` | Combines the web files and data into `docs/index.html` |

## Run it

```bash
pip install -r requirements.txt
python3 evaluate.py          # rule engine test, no key needed
streamlit run app.py
```

To test the AI steps, get a free key from Google AI Studio, then:

```bash
export GEMINI_API_KEY=your-key
python3 evaluate.py          # adds Part 2 (rule parsing) and Part 3 (memo checks)
```

Model names change; set `GEMINI_MODEL` if the default in `llm.py` is no longer available.

## Results so far

- Rule engine: 120 of 120 rule results match the hand-written answers (12 files x 10 rules).
  I wrote both the rules and the test files, so this mainly shows the engine does what I
  intended; real files are messier.
- AI steps: see `eval_results.md` after running with a key.

## Deploy (free)

Push to a public GitHub repo, then create an app on Streamlit Community Cloud pointing at
`app.py`. Without a key, the hosted app runs in template mode, and every check still works.
Only add `GEMINI_API_KEY` as a secret if you're fine with visitors using your free quota.

## Trying to break my own checker

The first memo checker only asked whether each number existed *somewhere* in the borrower's
facts. Testing found it could be fooled in several ways: a wrong figure that happened to match
another rule's limit, a figure rounded so far it hid a failure ("DSCR is 1x"), a dropped minus
sign, the right number with the wrong meaning ("1.07x, comfortably above the minimum"), and a
memo recommending approval for a loan outside policy.

The fix has two parts:

1. **The AI never types a number.** Code writes an outline of the memo with placeholders like
   `{R4.value}`, and the AI only rewords it in plainer English. Code fills the exact figures
   back in. Number errors become impossible rather than merely detected.

   *Why an outline:* my first version asked the small on-device model (0.5B) to write the whole
   memo from the facts. It ignored the format and wrote a generic paragraph with no figures, no
   sources and no outcome; the checker blocked it. Rewording a code-written outline is a much
   smaller job that small models can do. If a draft is still blocked, it gets up to 3 tries,
   and the page reports how many tries each memo needed.
2. **Code checks what's left:** each figure must be an exact figure of the rule its sentence
   cites; words like "passes" or "fails" must match that rule's real result; the memo may not
   recommend a different decision from the rule engine; amounts in crore are converted to lakh.

`tests/attack_cases.json` keeps every attack as a permanent test. Run everything with:

```bash
python3 tests/run_tests.py
```

It checks the attack memos in Python and JavaScript, that both engines agree on 24 evaluations,
and the 120 hand-written rule answers.

**Known limits:** the meaning check uses word lists, so unusual phrasing can slip past it. A
production version would need a stronger approach, such as formal rule checking.

## What I'd do next

- Read numbers from real PDFs, with a confidence score per field. A low-confidence field
  becomes *Can't check* instead of a silent guess.
- Let a lender upload its policy document; AI drafts the rules, a human confirms them.
- Track which rules get overridden most. That shows where the policy itself needs updating.
- Keep the approval-time numbers as the baseline for monitoring the loan afterwards.
