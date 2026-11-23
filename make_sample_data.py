"""Creates the 12 made-up borrower files in data/borrowers/.

Every borrower starts from the same clean file (BASE). Each case then changes a
few values to plant one or more problems. The "expected" block is the answer a
human analyst would give for each rule. I wrote it by hand from the planted
problems, NOT by running the engine, so the evaluation is a real check.

All money is in Rs lakh (1 lakh = 1,00,000 rupees).
"""
import copy
import json
from pathlib import Path

OUT = Path(__file__).parent / "data" / "borrowers"

BASE = {
    "application_date": "2026-11-10",
    "loan_request": {"amount_lakh": 150, "tenure_months": 60, "annual_rate_pct": 14},
    "documents": {
        "kyc": {"present": True, "incorporation_date": "2016-05-12",
                "pages": {"incorporation_date": 1}},
        "bureau": {"present": True, "promoter_score": 742, "max_dpd_12m": 0,
                   "pages": {"promoter_score": 1, "max_dpd_12m": 3}},
        "financials_fy26": {
            "present": True, "revenue": 1200, "ebitda": 180,
            "existing_annual_debt_service": 60, "existing_debt": 250,
            "current_assets": 400, "current_liabilities": 280,
            "pages": {"revenue": 4, "ebitda": 5, "existing_annual_debt_service": 18,
                      "existing_debt": 11, "current_assets": 3, "current_liabilities": 3},
        },
        "financials_fy25": {"present": True, "revenue": 1080, "ebitda": 160,
                            "pages": {"revenue": 4, "ebitda": 5}},
        "gst_fy26": {"present": True, "months_filed": 12, "turnover": 1180,
                     "pages": {"turnover": 1, "months_filed": 1}},
        "bank_fy26": {"present": True, "months": 12, "total_credits": 1050, "bounces_6m": 0,
                      "pages": {"total_credits": 2, "bounces_6m": 9}},
    },
}

ALL_PASS = {f"R{i}": "PASS" for i in range(1, 11)}

# (id, display name, what was planted, changes to BASE, rules that should NOT pass)
CASES = [
    ("B01", "Borrower A", "Nothing planted: a clean file.",
     {}, {}),
    ("B02", "Borrower B", "Profit too low to cover repayments.",
     {"documents.financials_fy26.ebitda": 120,
      "documents.financials_fy26.existing_annual_debt_service": 70,
      "documents.financials_fy26.existing_debt": 200},
     {"R4": "FAIL"}),
    ("B03", "Borrower C", "Audited revenue is much higher than GST sales.",
     {"documents.financials_fy26.revenue": 1500},
     {"R7": "FAIL"}),
    ("B04", "Borrower D", "Bank receipts far below GST sales.",
     {"documents.bank_fy26.total_credits": 650},
     {"R8": "FAIL"}),
    ("B05", "Borrower E", "Bank statements not submitted.",
     {"documents.bank_fy26": {"present": False}},
     {"R8": "CANT_CHECK", "R9": "CANT_CHECK", "R10": "FAIL"}),
    ("B06", "Borrower F", "DSCR just above the minimum.",
     {"documents.financials_fy26.ebitda": 135,
      "documents.financials_fy26.existing_annual_debt_service": 62,
      "documents.financials_fy26.existing_debt": 230},
     {"R4": "BORDERLINE"}),
    ("B07", "Borrower G", "Weak credit history.",
     {"documents.bureau.promoter_score": 655, "documents.bureau.max_dpd_12m": 60},
     {"R2": "FAIL", "R3": "FAIL"}),
    ("B08", "Borrower H", "Young business with only one audited year.",
     {"loan_request": {"amount_lakh": 60, "tenure_months": 36, "annual_rate_pct": 15},
      "documents.kyc.incorporation_date": "2024-08-01",
      "documents.financials_fy26": {
          "present": True, "revenue": 420, "ebitda": 55,
          "existing_annual_debt_service": 10, "existing_debt": 30,
          "current_assets": 150, "current_liabilities": 110,
          "pages": {"revenue": 4, "ebitda": 5, "existing_annual_debt_service": 14,
                    "existing_debt": 9, "current_assets": 3, "current_liabilities": 3}},
      "documents.financials_fy25": {"present": False},
      "documents.gst_fy26.turnover": 410,
      "documents.bank_fy26.total_credits": 370},
     {"R1": "FAIL", "R10": "FAIL"}),
    ("B09", "Borrower I", "Too much debt.",
     {"documents.financials_fy26.existing_debt": 520,
      "documents.financials_fy26.existing_annual_debt_service": 80},
     {"R5": "FAIL"}),
    ("B10", "Borrower J",
     "Three bounced EMIs, and short-term liabilities unreadable on a scanned page.",
     {"documents.bank_fy26.bounces_6m": 3,
      "documents.financials_fy26.current_liabilities": None},
     {"R6": "CANT_CHECK", "R9": "FAIL"}),
    ("B11", "Borrower K", "Only 9 of 12 months of GST returns filed.",
     {"documents.gst_fy26.months_filed": 9, "documents.gst_fy26.turnover": 885},
     {"R7": "CANT_CHECK", "R8": "CANT_CHECK", "R10": "FAIL"}),
    ("B12", "Borrower L",
     "Several problems: low current ratio, GST gap near the limit, bureau score near the limit.",
     {"documents.financials_fy26.current_assets": 300,
      "documents.financials_fy26.current_liabilities": 340,
      "documents.gst_fy26.turnover": 1084.8,
      "documents.bureau.promoter_score": 720},
     {"R2": "BORDERLINE", "R6": "FAIL", "R7": "BORDERLINE"}),
]

INDUSTRY = {
    "B01": "Packaging", "B02": "Auto components", "B03": "Textiles", "B04": "Food processing",
    "B05": "Pharma packaging", "B06": "Steel fabrication", "B07": "Seafood export",
    "B08": "Printing", "B09": "Spice trading", "B10": "Ceramics", "B11": "Tea processing",
    "B12": "Plastics",
}


def set_path(d, dotted, value):
    keys = dotted.split(".")
    for k in keys[:-1]:
        d = d[k]
    d[keys[-1]] = value


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for cid, name, planted, changes, not_pass in CASES:
        b = copy.deepcopy(BASE)
        for path, value in changes.items():
            set_path(b, path, copy.deepcopy(value))
        b = {"id": cid, "name": name, "industry": INDUSTRY[cid], "synthetic": True,
             "planted_problem": planted, **b,
             "expected": {**ALL_PASS, **not_pass}}
        (OUT / f"{cid}.json").write_text(json.dumps(b, indent=2))
    print(f"Wrote {len(CASES)} borrower files to {OUT}")


if __name__ == "__main__":
    main()
