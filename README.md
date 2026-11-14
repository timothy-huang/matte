# Matte

**Compares the destination on an invoice with the verified account on file, and holds changed payments until a callback to the number already on file confirms the exact new account.** The cleared payment then becomes *Ready for approval* by a human. The prototype stops at the approval gate.

Built for Tokyo Agent Forge. All records are synthetic, the callback is simulated, and no money moves.

## Why it matters
Japan's IPA documented a case where a business paid a fraudulent account after a bank-change request came from its supplier's genuine, compromised inbox ([IPA case report](https://www.ipa.go.jp/security/bec/hjuojm0000003c8r-att/bec_case7.pdf)). A reply in the same thread is not verification. The [Bank of Ireland's guidance](https://www.bankofireland.com/security-zone/protect-your-business/vendor-email-compromise/) says to verify through a known contact, using details held on record.

## How it works
| Step | Partner | What happens |
|---|---|---|
| 1. Retrieve guidance | **Tavily** (extract, advanced) | Pulls the official passage at setup and logs the title, URL, excerpt and whether it was live or cached. |
| 2. Propose and test the rule | **Open-weight model on Nosana** (Ollama, `qwen3.8:27b`, RTX 3090) | The model sees only the public guidance, field definitions, abstract examples and an abstract test tool. It proposes a JSON rule: allowed fields, equality and conjunction only. The app validates the rule against the required predicates and runs 11 abstract tests before activating it. |
| 3. Apply the rule to records | **Daytona** sandbox | The fixed evaluator runs with the validated rule and the synthetic records. Results return only to the app. Replay reuses the same rule ID with no new web or model call. |

**Status at submission (14 Nov, Tokyo Agent Forge):** Tavily and Daytona ran live. We deployed `qwen3.8:27b` on a Nosana RTX 3090 node, and Matte sends it the rule-proposal request on every startup. The node had not finished starting by the deadline (it returned HTTP 503), so the demo used the prewritten, source-linked rule. That rule passed the same validation and 11 tests. The UI says so on the *Rule* chip (`Nosana not up yet → prewritten rule`), on the activation screen and in the Model inputs drawer, which shows the request that was sent. When the node answers, **Retry Nosana** on the setup screen re-runs setup, and the model's rule goes live once it passes the same checks.

**Boundary:** enforced by the application. Invoice fields, account and contact values, and row outcomes are never sent to the model or its tools. The **Model inputs** drawer shows the captured outbound request bodies, with credentials excluded.

**Fallbacks:** each one is shown in the UI and the trace.
- Tavily fails: reuse a previously validated rule and its cached source, or keep changed payments held and offer *Retry check setup*.
- Model fails: use a prewritten, source-linked rule. The drawer says whether a model request was sent.
- Daytona fails: run the evaluator in a separate local process.

## Decision order
1. Missing vendor, verified destination or proposed destination → *Needs verification · Missing destination evidence*
2. Destination matches the account on file → *Ready for approval · Destination unchanged*
3. No validated rule → *Needs verification · Verification rule unavailable*
4. Exactly one callback matches payment, vendor, exact destination and trusted contact → *Ready for approval · Trusted callback confirmed*
5. A callback exists but doesn't match → *Needs verification · Callback does not match*
6. No callback, even with a thread reply → *Needs verification · Trusted callback required*

## Run it
```bash
npm install
cp .env.example .env   # TAVILY_API_KEY, DAYTONA_API_KEY, MODEL_BASE_URL, MODEL_NAME
npm test               # decision-logic acceptance checks (no partners needed)
npm run smoke          # one call each to Tavily, the model and Daytona
npm start              # http://localhost:5173
```
Add `?fail=1` to the page URL to make the first replay fail and show the retry path. The retry reuses the same callback event.

## After the hackathon
Pilot with a bookkeeping firm in shadow mode: compare a proposed payment batch against its verified vendor register, then measure how many flags are genuine changes and how long they take to resolve. Next, exclude held rows from the payment export and route cleared rows to the existing human approver.

Out of scope: PDF parsing, authentication, telephony and banking integrations.

*Illustrative mock-ups. Matte is not affiliated with or endorsed by Money Forward, Google, Yahoo Japan, Microsoft, freee or Intuit. All companies, people, accounts and phone numbers in the demo are fictional.*
