# Evaluation results

All borrower files and the policy are made up for this demo.

## Part 1: rule engine vs. hand-written answers

**120 of 120 rule results match** (12 files x 10 rules). Expected mix: BORDERLINE 3, CANT_CHECK 5, FAIL 12, PASS 100.

| File | Planted problem | Flagged (check-first order) | Outcome |
|---|---|---|---|
| B01 | Nothing planted: a clean file. | - | Within policy |
| B02 | Profit too low to cover repayments. | R4 FAIL | Outside policy |
| B03 | Audited revenue is much higher than GST sales. | R7 FAIL | Outside policy |
| B04 | Bank receipts far below GST sales. | R8 FAIL | Outside policy |
| B05 | Bank statements not submitted. | R10 FAIL, R8 CANT_CHECK, R9 CANT_CHECK | Incomplete file |
| B06 | DSCR just above the minimum. | R4 BORDERLINE | Within policy, with borderline items |
| B07 | Weak credit history. | R2 FAIL, R3 FAIL | Outside policy |
| B08 | Young business with only one audited year. | R1 FAIL, R10 FAIL | Outside policy |
| B09 | Too much debt. | R5 FAIL | Outside policy |
| B10 | Three bounced EMIs, and short-term liabilities unreadable on a scanned page. | R9 FAIL, R6 CANT_CHECK | Outside policy |
| B11 | Only 9 of 12 months of GST returns filed. | R10 FAIL, R7 CANT_CHECK, R8 CANT_CHECK | Incomplete file |
| B12 | Several problems: low current ratio, GST gap near the limit, bureau score near the limit. | R6 FAIL, R2 BORDERLINE, R7 BORDERLINE | Outside policy |

Note: I wrote both the rules and the test files, so this mainly proves the engine does what I intended. Real borrower files would be messier.

## part2_parse: could not run

Error: Gemini API error 400: {
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/googl

## part3_memos: could not run

Error: Gemini API error 400: {
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/googl

_AI model used: None_
