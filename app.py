"""Streamlit demo. Run:  streamlit run app.py"""
import csv
import io
import os
from pathlib import Path

import streamlit as st

try:  # Streamlit Cloud keeps the key in "secrets"; locally use an env variable.
    if "GEMINI_API_KEY" in st.secrets:
        os.environ["GEMINI_API_KEY"] = st.secrets["GEMINI_API_KEY"]
except Exception:
    pass

import engine  # noqa: E402
import evaluate  # noqa: E402
import llm  # noqa: E402
import memo  # noqa: E402

st.set_page_config(page_title="CAM Policy Check", page_icon="🔎", layout="wide")

ICON = {"FAIL": "🔴", "CANT_CHECK": "🟠", "BORDERLINE": "🟡", "PASS": "🟢"}
DECISIONS = ["Not reviewed yet", "Agree with the flag", "Asked borrower for documents",
             "Override: source data was wrong", "Override: approve as a deviation"]
GLOSSARY = {
    "CAM (Credit Assessment Memo)": "The document that explains why a loan should or shouldn't be approved.",
    "Credit policy": "A lender's own rulebook for which loans it will give.",
    "Deviation": "Approving a loan that breaks a policy rule. Needs a senior person's sign-off and a written reason.",
    "Rs lakh": "1 lakh = 1,00,000 rupees. All money here is in lakh.",
    "EBITDA": "Yearly profit before interest, tax and accounting write-offs. A rough measure of cash the business makes.",
    "DSCR": "EBITDA divided by yearly loan repayments. 1.25 means the business earns Rs 1.25 for every Rs 1 it must repay.",
    "Debt to EBITDA": "Total debt divided by EBITDA: how many years of profit it would take to repay all debt.",
    "Current ratio": "Short-term assets divided by short-term liabilities. Below 1 means bills due soon exceed cash coming soon.",
    "GST returns": "Sales the business reports to the tax department. A useful cross-check on audited revenue.",
    "Bureau score": "Credit score from a credit bureau such as CIBIL, based on past repayment behaviour.",
    "DPD (days past due)": "How many days late a repayment was.",
    "EMI / bounce": "A fixed monthly loan payment. A bounce is a payment that failed for lack of funds.",
}

if "decisions" not in st.session_state:
    st.session_state.decisions = {}
if "ai_memos" not in st.session_state:
    st.session_state.ai_memos = {}

policy = engine.load_policy()
paths = engine.list_borrowers()
borrowers = {p.stem: engine.load_borrower(p) for p in paths}

# ---------------- Sidebar ----------------
with st.sidebar:
    st.header("Loan file")
    bid = st.selectbox("Choose a borrower", list(borrowers),
                       format_func=lambda k: f"{k} · {borrowers[k]['name']} · {borrowers[k]['industry']}")
    with st.expander("What I planted in this file (spoiler)"):
        st.write(borrowers[bid]["planted_problem"])
    st.divider()
    st.subheader("How it works")
    st.markdown(
        "1. **Code** reads each number and notes the page it came from.\n"
        "2. **Code** checks every policy rule: Fails, Can't check, Borderline or Passes.\n"
        "3. The reviewer sees problems **first**, and records a decision with a reason.\n"
        "4. **AI only writes** the memo text. Code then checks every number it used.")
    st.caption("AI never decides a result. Same file in, same answer out.")

b = borrowers[bid]
ev = engine.evaluate(b, policy)
queue = engine.review_queue(ev)
rec = ev["recommendation"]
counts = {s: sum(r["status"] == s for r in queue) for s in ICON}

# ---------------- Header ----------------
st.title("Credit memo policy check")
st.caption("Checks a loan file against the lender's own credit policy, shows the reviewer what to "
           "look at first, and keeps AI away from the decisions.")
st.info("Demo only. The borrowers, numbers and the lender policy are all made up.", icon="ℹ️")

lr = b["loan_request"]
c1, c2, c3, c4, c5 = st.columns([1.3, 1.6, 1, 1, 1])
c1.metric(f"Loan asked ({lr['tenure_months']} months, {lr['annual_rate_pct']}%)",
          f"Rs {lr['amount_lakh']} lakh")
c2.metric("Policy outcome", rec["label"])
c3.metric("🔴 Fails", counts["FAIL"])
c4.metric("🟠 Can't check", counts["CANT_CHECK"])
c5.metric("🟡 Borderline", counts["BORDERLINE"])
st.caption(f"**What this means:** {rec['explain']}")

tab1, tab2, tab3, tab4 = st.tabs(["1 · Check these first", "2 · Draft memo",
                                  "3 · Policy and terms", "4 · How well it works"])

# ---------------- Tab 1: review queue ----------------
with tab1:
    flagged = [r for r in queue if r["status"] != "PASS"]
    passing = [r for r in queue if r["status"] == "PASS"]
    if not flagged:
        st.success("Nothing to review first: every rule passes comfortably.")

    def show_rule(r, open_):
        title = (f"{ICON[r['status']]} {r['id']} · {r['short']} — {engine.STATUS_LABEL[r['status']]}: "
                 f"{r['value_display']} (policy: {r['threshold_display']})")
        with st.expander(title, expanded=open_):
            st.write(f"**Rule:** {r['text']}")
            if r["reason"]:
                st.warning(r["reason"])
            if r["inputs"]:
                st.write("**Evidence trail**")
                st.dataframe(
                    [{"Input": i["label"], "Value": engine.fmt(i["value"], i["unit"])
                      if isinstance(i["value"], (int, float)) else i["value"],
                      "Where it came from": i["source"]} for i in r["inputs"]],
                    hide_index=True, use_container_width=True)
            if r["how"]:
                st.write(f"**Calculation:** `{r['how']}` = **{r['value_display']}**")
            if r["status"] != "PASS":
                key = f"{bid}:{r['id']}"
                prev = st.session_state.decisions.get(key, {})
                d1, d2 = st.columns([1, 2])
                choice = d1.selectbox("Reviewer decision", DECISIONS, key=f"sel-{key}",
                                      index=DECISIONS.index(prev.get("decision", DECISIONS[0])))
                note = d2.text_input("Reason (needed for any override)", key=f"txt-{key}",
                                     value=prev.get("reason", ""))
                if choice.startswith("Override") and not note.strip():
                    st.error("An override needs a written reason. It goes into the audit log.")
                st.session_state.decisions[key] = {"decision": choice, "reason": note}

    for r in flagged:
        show_rule(r, open_=True)
    if passing:
        st.write(f"**Passing rules ({len(passing)})**")
        for r in passing:
            show_rule(r, open_=False)

    log = [{"File": k.split(":")[0], "Rule": k.split(":")[1], **v}
           for k, v in st.session_state.decisions.items() if v["decision"] != DECISIONS[0]]
    st.divider()
    st.write("**Audit log** (every reviewer decision, with its reason)")
    if log:
        st.dataframe(log, hide_index=True, use_container_width=True)
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["File", "Rule", "decision", "reason"])
        w.writeheader()
        w.writerows(log)
        st.download_button("Download audit log (CSV)", buf.getvalue(), "audit_log.csv", "text/csv")
    else:
        st.caption("No decisions recorded yet.")

# ---------------- Tab 2: memo ----------------
with tab2:
    options = ["Template (no AI)"] + (["Gemini (AI)"] if llm.available() else [])
    writer = st.radio("Who writes the memo text?", options, horizontal=True)
    if not llm.available():
        st.caption("AI writing is off because no GEMINI_API_KEY is set. The checks below work the same way.")

    text = None
    if writer.startswith("Template"):
        text = memo.template_memo(ev)
    else:
        if st.button("Write memo with Gemini", type="primary"):
            with st.spinner("Writing..."):
                try:
                    st.session_state.ai_memos[bid] = memo.ai_memo(ev)
                except Exception as e:  # show the error instead of crashing the demo
                    st.error(f"Gemini call failed: {e}")
        text = st.session_state.ai_memos.get(bid)

    if text:
        plant = st.toggle("Demo: plant a wrong number in the memo, to see the check catch it")
        if plant:
            text, old, new = memo.inject_error(text)
            if old:
                st.caption(f"Changed {old} to {new}.")
        check = memo.check_memo(text, ev, policy)

        left, right = st.columns([3, 2])
        with left:
            st.markdown(text.replace("\n", "\n\n"))
        with right:
            st.subheader("Checks on this memo")
            n_ok = sum(n["ok"] for n in check["numbers"])
            st.write(f"{'✅' if not check['unmatched'] else '❌'} **Numbers:** "
                     f"{n_ok} of {len(check['numbers'])} match the calculated facts")
            for n in check["unmatched"]:
                st.error(f"**{n['number']}** is not in the facts. Sentence: _{n['sentence']}_")
            st.write(f"{'✅' if not check['uncited'] else '❌'} **Citations:** "
                     f"{'every sentence cites a rule' if not check['uncited'] else str(len(check['uncited'])) + ' sentence(s) cite nothing'}")
            for s in check["uncited"]:
                st.warning(s)
            st.write(f"{'✅' if check['recommendation_ok'] else '❌'} **Recommendation** "
                     f"{'matches' if check['recommendation_ok'] else 'does not match'} the rule engine "
                     f"(\"{rec['label']}\")")
            if check["passed"]:
                st.success("Memo passed all checks. It can go to the reviewer.")
            else:
                st.error("Memo blocked: fix the flagged items before it goes to the reviewer.")

# ---------------- Tab 3: policy ----------------
with tab3:
    st.subheader(policy["name"])
    st.caption(policy["note"])
    st.dataframe([{"Rule": r["id"], "In plain English": r["text"],
                   "As a check": f"{r['metric']} {r['op']} {r['threshold']}"} for r in policy["rules"]],
                 hide_index=True, use_container_width=True)
    st.caption(f"Borderline = passes, but within {policy['borderline_margin_pct']}% of the limit.")
    st.subheader("Terms used here")
    for term, meaning in GLOSSARY.items():
        st.markdown(f"**{term}:** {meaning}")

# ---------------- Tab 4: evaluation ----------------
with tab4:
    lines, _ = evaluate.part1_rules(policy)
    st.markdown("\n".join(lines))
    saved = Path(__file__).parent / "eval_results.md"
    if saved.exists() and "## Part 2" in saved.read_text():
        st.markdown("## Part 2" + saved.read_text().split("## Part 2", 1)[1])
    else:
        st.info("The AI steps (rule parsing and memo writing) are measured by running "
                "`evaluate.py` with a Gemini key. Results appear here once saved.")
