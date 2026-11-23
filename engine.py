"""Rule engine: checks a borrower file against a credit policy.

Plain Python makes every decision in this file. No AI is involved, so the same
file always gets the same answer, and every answer can be traced back to the
document and page it came from.

Each rule ends in one of four results:
  FAIL        - breaks the policy
  CANT_CHECK  - a document or number needed for the rule is missing
  BORDERLINE  - passes, but within 5% of the limit, so a human should look
  PASS        - passes comfortably
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent
POLICY_PATH = ROOT / "policy.json"
BORROWER_DIR = ROOT / "data" / "borrowers"

# Lower number = reviewer should look at it first.
STATUS_ORDER = {"FAIL": 0, "CANT_CHECK": 1, "BORDERLINE": 2, "PASS": 3}
STATUS_LABEL = {
    "FAIL": "Fails policy",
    "CANT_CHECK": "Can't check",
    "BORDERLINE": "Borderline",
    "PASS": "Passes",
}

DOC_TITLES = {
    "application": "Loan application form",
    "kyc": "KYC / incorporation certificate",
    "bureau": "Credit bureau report",
    "financials_fy26": "Audited financials FY26",
    "financials_fy25": "Audited financials FY25",
    "gst_fy26": "GST returns FY26",
    "bank_fy26": "Bank statements FY26",
}


class Missing(Exception):
    """Raised when a rule cannot be checked because an input is missing."""


def load_policy(path=POLICY_PATH):
    return json.loads(Path(path).read_text())


def list_borrowers():
    return sorted(BORROWER_DIR.glob("B*.json"))


def load_borrower(path):
    return json.loads(Path(path).read_text())


def yearly_repayment(amount, months, annual_rate_pct):
    """Yearly total of a standard EMI (monthly instalment) loan."""
    r = annual_rate_pct / 1200
    if r == 0:
        return amount / months * 12
    emi = amount * r * (1 + r) ** months / ((1 + r) ** months - 1)
    return emi * 12


class Trail:
    """Collects the evidence used for one rule: where each number came from."""

    def __init__(self, borrower):
        self.b = borrower
        self.inputs = []

    def doc(self, key):
        d = self.b["documents"].get(key)
        if not d or not d.get("present"):
            raise Missing(f"{DOC_TITLES[key]} not provided")
        return d

    def field(self, doc_key, field, label, unit=""):
        d = self.doc(doc_key)
        value = d.get(field)
        if value is None:
            raise Missing(f"{label} could not be read from {DOC_TITLES[doc_key]}")
        page = d.get("pages", {}).get(field)
        source = DOC_TITLES[doc_key] + (f", page {page}" if page else "")
        self.inputs.append({"label": label, "value": value, "unit": unit, "source": source})
        return value

    def months(self, doc_key, field, needed):
        d = self.doc(doc_key)
        got = d.get(field) or 0
        if got < needed:
            raise Missing(f"{DOC_TITLES[doc_key]} cover only {got} of {needed} months")
        self.inputs.append({"label": f"{DOC_TITLES[doc_key]}: months covered", "value": got,
                            "unit": "months", "source": DOC_TITLES[doc_key]})
        return got

    def application(self, field, label, unit=""):
        value = self.b["loan_request"][field]
        self.inputs.append({"label": label, "value": value, "unit": unit,
                            "source": DOC_TITLES["application"]})
        return value

    def derived(self, label, value, unit, how):
        self.inputs.append({"label": label, "value": round(value, 2), "unit": unit,
                            "source": f"Calculated: {how}"})
        return value


# ---- One function per metric. Each returns (value, how it was calculated). ----

def m_vintage_years(t):
    inc = t.field("kyc", "incorporation_date", "Date of incorporation")
    app = t.b["application_date"]
    t.inputs.append({"label": "Application date", "value": app, "unit": "",
                     "source": DOC_TITLES["application"]})
    years = (date.fromisoformat(app) - date.fromisoformat(inc)).days / 365.25
    return years, f"({app} - {inc}) / 365.25 days"


def m_bureau_score(t):
    v = t.field("bureau", "promoter_score", "Promoter bureau score")
    return v, "Read directly from the bureau report"


def m_max_dpd_12m(t):
    v = t.field("bureau", "max_dpd_12m", "Worst days-past-due in last 12 months", "days")
    return v, "Read directly from the bureau report"


def _new_loan_yearly(t):
    amt = t.application("amount_lakh", "Loan asked for", "Rs lakh")
    months = t.application("tenure_months", "Tenure", "months")
    rate = t.application("annual_rate_pct", "Interest rate", "%")
    yearly = yearly_repayment(amt, months, rate)
    return t.derived("New loan: yearly repayments", yearly, "Rs lakh",
                     f"EMI on Rs {amt} lakh over {months} months at {rate}% x 12")


def m_dscr(t):
    ebitda = t.field("financials_fy26", "ebitda", "EBITDA (yearly cash profit)", "Rs lakh")
    existing = t.field("financials_fy26", "existing_annual_debt_service",
                       "Existing loans: yearly repayments", "Rs lakh")
    new = _new_loan_yearly(t)
    return ebitda / (existing + new), f"{ebitda} / ({existing} + {new:.2f})"


def m_debt_to_ebitda(t):
    ebitda = t.field("financials_fy26", "ebitda", "EBITDA (yearly cash profit)", "Rs lakh")
    existing = t.field("financials_fy26", "existing_debt", "Existing debt", "Rs lakh")
    amt = t.application("amount_lakh", "Loan asked for", "Rs lakh")
    return (existing + amt) / ebitda, f"({existing} + {amt}) / {ebitda}"


def m_current_ratio(t):
    ca = t.field("financials_fy26", "current_assets", "Current assets", "Rs lakh")
    cl = t.field("financials_fy26", "current_liabilities", "Current liabilities", "Rs lakh")
    return ca / cl, f"{ca} / {cl}"


def m_gst_vs_revenue_gap_pct(t):
    t.months("gst_fy26", "months_filed", 12)
    gst = t.field("gst_fy26", "turnover", "GST-reported sales", "Rs lakh")
    rev = t.field("financials_fy26", "revenue", "Audited revenue", "Rs lakh")
    return abs(gst - rev) / rev * 100, f"|{gst} - {rev}| / {rev} x 100"


def m_bank_to_gst_pct(t):
    t.months("gst_fy26", "months_filed", 12)
    t.months("bank_fy26", "months", 12)
    credits = t.field("bank_fy26", "total_credits", "Money received in bank", "Rs lakh")
    gst = t.field("gst_fy26", "turnover", "GST-reported sales", "Rs lakh")
    return credits / gst * 100, f"{credits} / {gst} x 100"


def m_bounces_6m(t):
    t.months("bank_fy26", "months", 6)
    v = t.field("bank_fy26", "bounces_6m", "Bounced cheques/EMIs, last 6 months")
    return v, "Counted from the bank statement"


def m_documents_complete(t):
    docs = t.b["documents"]
    missing = []
    for key in ["kyc", "bureau", "financials_fy26", "financials_fy25"]:
        ok = bool(docs.get(key, {}).get("present"))
        t.inputs.append({"label": DOC_TITLES[key], "value": "Present" if ok else "Missing",
                         "unit": "", "source": "Document checklist"})
        if not ok:
            missing.append(DOC_TITLES[key])
    for key, field in [("gst_fy26", "months_filed"), ("bank_fy26", "months")]:
        d = docs.get(key, {})
        if not d.get("present"):
            t.inputs.append({"label": DOC_TITLES[key], "value": "Missing",
                             "unit": "", "source": "Document checklist"})
            missing.append(DOC_TITLES[key])
            continue
        got = d.get(field, 0)
        t.inputs.append({"label": DOC_TITLES[key], "value": f"{got} of 12 months",
                         "unit": "", "source": "Document checklist"})
        if got < 12:
            missing.append(f"{DOC_TITLES[key]} (only {got} of 12 months)")
    t.missing_docs = missing
    return len(missing) == 0, "Checklist of required documents"


METRICS = {
    "vintage_years": m_vintage_years,
    "bureau_score": m_bureau_score,
    "max_dpd_12m": m_max_dpd_12m,
    "dscr": m_dscr,
    "debt_to_ebitda": m_debt_to_ebitda,
    "current_ratio": m_current_ratio,
    "gst_vs_revenue_gap_pct": m_gst_vs_revenue_gap_pct,
    "bank_to_gst_pct": m_bank_to_gst_pct,
    "bounces_6m": m_bounces_6m,
    "documents_complete": m_documents_complete,
}


def judge(value, rule, margin):
    op, limit = rule["op"], rule["threshold"]
    if op == "==":
        return "PASS" if value == limit else "FAIL"
    v = round(value, 4)
    if op == ">=":
        if v < limit:
            return "FAIL"
        return "BORDERLINE" if v < limit * (1 + margin) else "PASS"
    if op == "<=":
        if v > limit:
            return "FAIL"
        return "BORDERLINE" if v > limit * (1 - margin) else "PASS"
    raise ValueError(f"Unknown operator {op}")


def fmt(value, unit):
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if unit == "%":
        return f"{value:.1f}%"
    if unit == "x":
        return f"{value:.2f}x"
    if unit == "years":
        return f"{value:.1f} years"
    if unit == "days":
        return f"{value:g} days"
    if unit == "Rs lakh":
        return f"Rs {value:,.2f} lakh".replace(".00 lakh", " lakh")
    if isinstance(value, float):
        return f"{value:g}"
    return f"{value} {unit}".strip()


def recommend(results):
    """The overall outcome is decided by rules too, never by the AI."""
    fails = [r["id"] for r in results if r["status"] == "FAIL" and r["metric"] != "documents_complete"]
    incomplete = [r["id"] for r in results if r["status"] == "CANT_CHECK"
                  or (r["metric"] == "documents_complete" and r["status"] == "FAIL")]
    border = [r["id"] for r in results if r["status"] == "BORDERLINE"]
    if fails:
        return {"code": "OUTSIDE_POLICY", "label": "Outside policy",
                "explain": "Decline, or approve only as a documented deviation signed off by a senior credit officer.",
                "rules": fails + incomplete}
    if incomplete:
        return {"code": "INCOMPLETE", "label": "Incomplete file",
                "explain": "Collect the missing documents before taking a credit decision.",
                "rules": incomplete}
    if border:
        return {"code": "WITHIN_POLICY_REVIEW", "label": "Within policy, with borderline items",
                "explain": "Within policy, but a reviewer should look at the borderline items first.",
                "rules": border}
    return {"code": "WITHIN_POLICY", "label": "Within policy",
            "explain": "Every rule passes comfortably.", "rules": []}


def evaluate(borrower, policy=None):
    policy = policy or load_policy()
    margin = policy.get("borderline_margin_pct", 5) / 100
    results = []
    for rule in policy["rules"]:
        t = Trail(borrower)
        try:
            value, how = METRICS[rule["metric"]](t)
            status = judge(value, rule, margin)
            reason = None
            if rule["metric"] == "documents_complete" and not value:
                reason = "Missing: " + "; ".join(t.missing_docs)
        except Missing as e:
            value, how, status, reason = None, None, "CANT_CHECK", str(e)
        results.append({
            "id": rule["id"], "short": rule["short"], "text": rule["text"],
            "metric": rule["metric"], "op": rule["op"], "threshold": rule["threshold"],
            "unit": rule["unit"], "value": value, "status": status, "reason": reason,
            "how": how, "inputs": t.inputs,
            "value_display": "All present" if value is True else (
                "Incomplete" if value is False else fmt(value, rule["unit"])),
            "threshold_display": ("all present" if rule["op"] == "==" else
                                  f"{'at least' if rule['op'] == '>=' else 'at most'} "
                                  f"{fmt(rule['threshold'], rule['unit'])}"),
        })
    return {"borrower": borrower, "results": results, "recommendation": recommend(results)}


def review_queue(evaluation):
    """Rules in the order a reviewer should check them: failures first."""
    return sorted(evaluation["results"], key=lambda r: (STATUS_ORDER[r["status"]],
                                                        int(r["id"][1:])))


if __name__ == "__main__":
    pol = load_policy()
    for path in list_borrowers():
        ev = evaluate(load_borrower(path), pol)
        flags = [f"{r['id']}:{r['status']}" for r in review_queue(ev) if r["status"] != "PASS"]
        print(f"{ev['borrower']['id']}  {ev['recommendation']['label']:<38} {' '.join(flags)}")
