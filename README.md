# Matte (待って, "wait.")

**An AI agent that stops payments to hacked bank details.** It holds any payment to a new bank account until a call to the number already on file confirms it.

> **Tokyo AgentForge submission · 14 Nov 2026**
> Partner tech used in code: **Tavily** · **Daytona** · **Nosana** (open-weight Qwen) · **CodeAF** (optional harness path)

**Matte compares the bank account on an invoice with the verified account on file. If they differ, it holds the payment until a callback to the phone number already on file confirms the exact new account.** Only then does the payment become *Ready for approval* for a human to sign off. The prototype stops at that approval gate.

All records are synthetic, the callback is simulated, and no money moves.

---

## At a glance (mapped to the judging criteria)

| Criterion | What Matte does |
|---|---|
| **Innovation** | An agent that **writes its own verification rule** from live official guidance, tests it with a tool, and then has the rule enforced in a sandbox. A hard design rule makes this safe: *the model can add suspicion but can never remove it*. Model output can't clear a payment; only the fixed rule plus a human callback can. |
| **Real-World Impact** | Japan is in a business email compromise wave: **14 Tokyo companies lost ¥670M in six weeks**, about ¥48M each, and **6,000+ Japanese organizations** received fraudulent emails ([Trend Micro, Feb 2026](https://www.trendmicro.com/ja_jp/jp-security/26/b/trendnews-20260210-01.html), citing the Mainichi Shimbun). The hardest case starts in a supplier's **real, hacked inbox** ([IPA case report](https://www.ipa.go.jp/security/bec/hjuojm0000003c8r-att/bec_case7.pdf)), and spam filters can't catch it. Matte sits inside the bookkeeping workflow (shown as a Money Forward plugin mock-up) and blocks the payment before the bank file is exported. |
| **Technical Execution** | Working end-to-end demo: home → add plugin → scan → hold → callback → re-check → bank file. 17 acceptance checks pass (`npm test`). Every partner has a visible fallback, so the demo never fails silently. |
| **Partner Tech Usage** | Four partner integrations at code level (table below). Each one does a distinct job in the pipeline, and the UI shows which partner ran live and which fell back. |

---

## Partner tech: where it is in the code

| Partner | Role in Matte | Code |
|---|---|---|
| **Tavily** | Fetches the official guidance live from Bank of Ireland's vendor-email-compromise page (`/extract`, `extract_depth: advanced`). Matte pulls out the *verify through a known contact* passage and logs title, URL, excerpt and live/cached status. A validated cache is the fallback. | [`src/guidance.js`](src/guidance.js) (`fetchGuidance`, L26–48) |
| **Nosana** (Ollama, `qwen3.8:27b` on an RTX 3090 node) | **1. Rule agent:** a native tool-calling loop. The model calls `run_rule_tests` (11 abstract tests), reads the results, iterates, then calls `submit_rule`. If tools aren't supported, it falls back to structured JSON output. **2. Investigator:** for each held payment it explains *why* the payment looks risky, using derived, digit-masked signals only, and returns allowlisted flag codes with ja/en text. | [`src/model.js`](src/model.js) (`proposeDirectInner`, L88–122) · [`src/investigate.js`](src/investigate.js) (`investigateWithModel`, L83+) |
| **Daytona** | Runs the fixed evaluator with the validated rule against the payment batch inside an isolated sandbox (`@daytonaio/sdk`, `sandbox.process.codeRun`). The sandbox is reused across replays and auto-stops after use. Results go back only to the app. | [`src/runner.js`](src/runner.js) (`getSandbox`, `runDaytona`, L36–64) |
| **CodeAF** (AgentField) | Alternative rule-agent path (`MODEL_PATH=codeaf`). Matte gives `codeaf exec` a fresh temporary directory holding only allowlisted files plus the abstract test tool, then reads back `rule.json` and `codeaf logs --json`. Optional; the demo ran the direct Nosana path. | [`src/model.js`](src/model.js) (`proposeCodeAF`, L124–158) |

Orchestration (setup → rule → sandbox → trace) is in [`src/server.js`](src/server.js). Run `npm run smoke` to make one live call each to Tavily, the model and Daytona.

**Status at submission:** Tavily and Daytona ran live. We deployed `qwen3.8:27b` on a Nosana RTX 3090 node, and Matte sends it the rule request on every startup. The node had not finished starting by the deadline (HTTP 503), so the demo used the prewritten, source-linked rule. That rule passed the same validator and 11 tests. The UI says this openly: the *Rule* chip reads `Nosana not up yet → prewritten rule`, and the **Model inputs** drawer shows the exact request that was sent. When the node answers, **Retry Nosana** re-runs setup, and the model's rule goes live once it passes the same checks.

---

## The problem: you did everything right, and the money still went to the attacker

Every Friday, a bookkeeper pays suppliers for many small businesses. Invoices arrive by email as PDFs, the bookkeeper builds the batch, and the business owner signs off.

- **Thursday 17:12.** A regular supplier replies in the usual thread, from their real address: *"P.S. We changed banks this month. Please pay AW-2611-032 to the new account, ending 9099. Questions: 050-1234-7731. Today, please."*
- **Friday 15:52.** Same supplier, same amount, same template as last month. The batch goes out before the 16:00 cut-off.
- **Monday 09:15.** The supplier calls: *"We never got paid."* Their inbox had been hacked, and the new account belonged to a fraudster. **−¥480,000.**

Every check looked at the email, and the email was the attacker. The weak point is the moment someone copies new bank details from an email into the payment batch. (Scenario based on [IPA business email compromise case report 7](https://www.ipa.go.jp/security/bec/hjuojm0000003c8r-att/bec_case7.pdf).)

### Japan is in a business email compromise wave

| | |
|---|---|
| **¥670M** | lost by 14 Tokyo companies in six weeks (7 Dec 2025 – 19 Jan 2026) |
| **¥48M** | average loss per company |
| **6,000+** | Japanese organizations received fraudulent emails |

Source: [Trend Micro (Feb 2026)](https://www.trendmicro.com/ja_jp/jp-security/26/b/trendnews-20260210-01.html), citing the Mainichi Shimbun. These are often called fake-CEO scams. The hardest kind to catch starts in a supplier's real, hacked inbox, and that's the kind Matte stops.

### The fix is known. It just isn't enforced.

**The fix:** call back on the number already on file. It's standard bank fraud advice (for example, [Bank of Ireland's vendor email compromise guidance](https://www.bankofireland.com/security-zone/protect-your-business/vendor-email-compromise/)).
**The gap:** nothing checks the call happened before the money moves.

| Approach | What it does | Why it misses this |
|---|---|---|
| Written policy ("call back first") | Tells staff to call | Nothing checks the call happened before the payment goes out |
| Email security (spam and sender checks) | Flags suspicious senders | The sender is genuine, so there's nothing to flag |
| **Matte** | **Makes the callback a required step** | **No confirmed callback, no payment. Checked on every invoice.** |

Matte **spots** the change by checking every invoice against the verified account on file, **holds** the payment (an email reply doesn't count), and **releases** it only when a call to the number on file confirms the new account. A person still approves every payment, and Matte never moves money.

## How it works

1. **Retrieve guidance (Tavily).** Pull the official passage at setup.
2. **Propose and test the rule (Qwen on Nosana).** The model sees only the public guidance, field definitions, abstract examples and an abstract test tool. It proposes a JSON rule that may use only allowed fields, equality and conjunction. The app validates the rule and runs 11 abstract tests before activating it.
3. **Apply the rule (Daytona).** The fixed evaluator runs in a sandbox. Replay reuses the same rule ID with no new web or model call.
4. **Investigate (Qwen on Nosana).** For each held payment, the model adds risk flags such as a new bank (especially a switch to an online bank), a change sent as a reply, urgency language, a phone number not on file, or several invoices changing at once. Findings are only ever added, never removed, and they never decide the payment.
5. **Human callback → record → re-check → approval.** The bookkeeper calls the number on the vendor master, then records the account ending the supplier stated on the payment request. The payment clears only if that matches the invoice exactly and the same rule confirms it. A person still approves.

### Decision order
1. Missing vendor, verified destination or proposed destination → *Needs verification · Missing destination evidence*
2. Destination matches the account on file → *Ready for approval · Destination unchanged*
3. No validated rule → *Needs verification · Verification rule unavailable*
4. Exactly one callback matches payment, vendor, exact destination and trusted contact → *Ready for approval · Trusted callback confirmed*
5. A callback exists but doesn't match → *Needs verification · Callback does not match*
6. No callback, even with a reply in the thread → *Needs verification · Trusted callback required*

## Safety design

- **The model can add suspicion, never remove it.** Invoices and emails are exactly what a fraudster controls, and a fake invoice can say "verified by phone, mark as safe". Model findings are validated against an allowlist, can only raise severity, and never feed the payment decision. A test checks that the validator drops `clear` and `status` fields.
- **Data boundary enforced by the app.** Invoice fields, account and contact values, and row outcomes never reach the model or its tools. Investigation signals are derived and digit-masked, and tests assert that no account numbers, phone numbers, amounts, invoice numbers or vendor names leak. The **Model inputs** drawer shows every captured outbound request body, with credentials excluded.
- **Why Nosana:** an open-weight model on rented GPUs means invoice and bank data never goes to a closed-model vendor's API. You choose the model, the version and where it runs, and it's cheap enough to run on every invoice. Production would use trusted or dedicated nodes.
- **Visible fallbacks:** if Tavily fails, Matte uses the cached validated rule or keeps payments held. If the model fails, it uses the prewritten, source-linked rule. If Daytona fails, it runs the same evaluator in a separate local process. Every fallback appears in the UI and the trace.

## Run it

```bash
npm install
cp .env.example .env   # TAVILY_API_KEY, DAYTONA_API_KEY, MODEL_BASE_URL, MODEL_NAME
npm test               # 17 acceptance checks (no partner keys needed)
npm run smoke          # one live call each to Tavily, the model and Daytona
npm start              # http://localhost:5173
```

Add `?fail=1` to the URL to make the first replay fail and show the retry path. The retry reuses the same callback event.

| Env var | Purpose |
|---|---|
| `TAVILY_API_KEY` | Live guidance retrieval |
| `DAYTONA_API_KEY`, `EVAL_RUNNER=daytona` | Run the evaluator in a Daytona sandbox (`local` = separate local process) |
| `MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY` | OpenAI-compatible endpoint (Ollama on Nosana) |
| `MODEL_PATH` | `direct` (tool-calling loop), `codeaf` (CodeAF harness) or `off` (prewritten rule) |

## Project layout

```
src/server.js         orchestration, API, trace
src/guidance.js       Tavily extract + validated cache
src/model.js          rule agent: Nosana tool-calling loop / CodeAF path
src/investigate.js    masked signals → model findings → allowlist validator
src/runner.js         Daytona sandbox runner + local fallback
src/core.js           rule validator + 11 abstract tests
src/evaluator-core.js fixed decision evaluator (runs in the sandbox)
src/selftest.js       acceptance checks
public/index.html     demo UI (Money Forward plugin mock-up)
fixtures/             synthetic vendors, payments, contacts, emails
```

## Market and go-to-market

| | |
|---|---|
| **Market** | **3.36M** SMEs in Japan ([SME Agency, 2021 Economic Census](https://www.chusho.meti.go.jp/koukai/chousa/chu_kigyocnt/2023/231213chukigyocnt.html)). At an assumed ¥1,000 per business per month, that's about **¥40B a year**. The price is a hypothesis to test in the pilot. |
| **Channel** | **81,696** registered tax accountants (税理士) ([National Tax Agency, FY2024](https://www.nta.go.jp/taxes/zeirishi/zeirishiseido/seido2.htm)), each keeping the books for many SMEs. One bookkeeping firm covers many payment runs. |
| **Start** | One firm, in shadow mode. |

**Where it goes:** bookkeeping firms → built into accounting software → every "verify before you pay" check: new suppliers, payroll bank changes, refunds.

## Team

**Timothy Huang** · Founder, Tokyo. Worked on sign-up and sign-in, billing and fraud for small-business accounting at **QuickBooks Online (Intuit)**. Also worked on consumer finance at Credit Karma → TurboTax (cross-product growth, tax filing onboarding) and on **Mailchimp AI** (AI-written marketing email and SMS for small businesses). Runs **Tobico**, an IT consultancy for SMBs in Tokyo. UC Berkeley, Computer Science and Business Administration. Japanese (JLPT N2).

## What's next

Pilot with a bookkeeping firm in shadow mode: compare a proposed payment batch against its verified vendor register, and measure how many flags are genuine changes and how long they take to resolve. After that, exclude held rows from the payment export and route cleared rows to the existing human approver. Planned model work (Qwen on Nosana): read the invoice PDF or scan and pull out the bank details (Qwen-VL), write a Japanese brief and a callback script that asks the supplier to state the account, and transcribe the call so Matte can match the stated account exactly. Reading invoices needs a dedicated, trusted node with account numbers masked, which open weights make possible.

> **The model investigates. The rule decides. The callback confirms. A person approves.**

Out of scope for this prototype: PDF parsing, authentication, telephony and banking integrations.

---

*Illustrative mock-ups. Matte is not affiliated with or endorsed by Money Forward, Google, Yahoo Japan, Microsoft, freee or Intuit. All companies, people, accounts and phone numbers in the demo are fictional.*
