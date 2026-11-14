# Matte — Tokyo Agent Forge build spec

## The Friday payment run

It’s Friday afternoon. You’re about to pay a supplier **¥480,000**. The work is done, the invoice looks right, and the supplier replies from their usual email address to confirm they’ve changed banks. Would you pay it?

Japan’s IPA documented a case where a Japanese business sent money to a fraudulent account after a change request came from its supplier’s genuine, apparently compromised inbox. [IPA case report](https://www.ipa.go.jp/security/bec/hjuojm0000003c8r-att/bec_case7.pdf)

**Matte compares the destination on the invoice with the verified account on file.** It holds changed payments until a callback to the number already on file confirms the exact new account. That payment then becomes **Ready for approval** by a human. The demo uses synthetic records, a simulated callback, and an animated transfer that stops at the approval gate.

## One screen, one minute

Show the batch, two invoice cards, a transfer strip, and a collapsible evidence panel on one page. Open on P3.

| Time | Stage action |
|---|---|
| 0–10s | Show two nearly identical ¥480,000 invoices. Ask, “Would you pay it?” |
| 10–22s | Click **Reveal change**. Highlight account endings `2002 → 9099`. Freeze the transfer halfway at **Needs verification**. Show “Supplier replied in the same thread” and “Trusted callback pending.” |
| 22–36s | Open the evidence panel. Show the bank guidance, the trusted-callback rule, and **Test passed · email reply alone stays held**. Open **Model inputs** to show the actual model request content. |
| 36–53s | Click **Replay callback confirmation**. Show that the number on file was used and the supplier confirmed the exact new account. Rerun the same rule and move the transfer marker to **Ready for approval**. |
| 53–60s | Show the batch. P3 flipped. P2 is still held, even though it’s for the same supplier. |

| Payment | Supplier | Amount | On file → invoice | Start → after replay |
|---|---|---:|---|---|
| P1 | Kumo Supplies | ¥62,000 | A-1001 → A-1001 | Ready → Ready |
| P2 | Aoba Works | ¥195,000 | A-2002 → A-8088 | Held → Held |
| P3 | Aoba Works | ¥480,000 | A-2002 → A-9099 | Held → Ready |

P2 and P3 have same-thread replies. Only P3 offers replay, after the reveal and once a validated rule is available. During replay, disable the button and show **Checking confirmation…**. On failure, keep P3 held and show **Check unavailable · Retry**. Retry reuses the same event. **Reset demo** or refresh restores the initial view and removes the callback. Discard late results from reset runs. Use keyboard-operable controls, text status labels, and a static transfer marker for reduced motion.

## The decision check

Use fixture JSON and compare full destination keys. The UI can show masked endings.

- **Payment** — unique ID, vendor ID, amount in whole yen, proposed destination, thread-reply flag.
- **Vendor** — unique ID, verified destination, optional trusted contact reference.
- **Callback** — unique event ID, payment ID, vendor ID, confirmed destination, contact reference, method `callback`, outcome `confirmed`. The server creates one preset event per run from P3 and the trusted contact on file. Duplicate clicks reuse it.
- **Result** — payment ID, status, reason, optional rule ID.

Apply these checks in order:

| Condition | Result |
|---|---|
| Vendor, verified destination, or proposed destination is missing | Needs verification · Missing destination evidence |
| Destination matches the verified account | Ready for approval · Destination unchanged |
| Destination changed and no validated rule is available | Needs verification · Verification rule unavailable |
| One confirmed callback matches payment, vendor, exact destination, and trusted contact on file | Ready for approval · Trusted callback confirmed |
| Callback is present but any required value is missing or different | Needs verification · Callback does not match |
| Callback is absent, including when a thread reply exists | Needs verification · Trusted callback required |

Replay evaluates P3 only and leaves the vendor record as it was. The prototype ends at human approval. PDF parsing, authentication, telephony, and banking integrations are out of scope.

## How the agent builds the check

1. **Tavily retrieves the guidance at setup.** Extract the relevant passage from the [Bank of Ireland’s official guidance](https://www.bankofireland.com/security-zone/protect-your-business/vendor-email-compromise/). It explains why a known contact is required even after an email reply. Pass the excerpt to CodeAF. Log the title, URL, excerpt, and live or cached status. If retrieval fails, reuse a previously validated rule with its source evidence or keep changed payments held and offer **Retry check setup**.
2. **CodeAF on Daytona proposes and tests a JSON rule using Nosana’s hosted open-weight model.** The request allowlist contains public guidance, field definitions, abstract examples, and abstract test tool schemas and results. Capture the actual outbound message and tool content for **Model inputs**, excluding credentials. Give the model-facing process no fixture mount or record-reading tool. Accept only allowed field names, equality, and conjunctions. Require the predicates in the decision table. Test unchanged, email-only, exact callback, wrong payment/vendor/account/contact, and missing contact before activating the rule. Log the chosen fields, rule ID, and test result.
3. **Daytona applies the rule on the record side.** The app runs the fixed evaluator in a separate process with the validated rule and synthetic records. Return payment results only to the app and log the rule ID and run outcome there. Invoice fields, account and contact values, and row outcomes stay out of the model request and tools. Replay uses the same rule ID without another web or model call. Describe this as an application-enforced boundary. Add a separate outbound-blocked sandbox only if time allows and verify the block before claiming it.

**After the hackathon.** Pilot with a bookkeeping firm by comparing a proposed payment batch with its verified vendor register in shadow mode. Measure how many flags are genuine changes and how long they take to resolve. Then exclude held rows from the integrated payment export and route cleared rows to the existing human approver.

## Build and submit by 17:30 JST

| Elapsed | Ship |
|---|---|
| 0–15 min | Test P3 on the real partner stack. Fetch the source, try a CodeAF → Nosana tool call, and apply the tested rule on Daytona. Email alone must hold and the exact callback must flip the result. If native tool calling fails, use structured CodeAF output and have the app invoke Daytona. |
| 15–40 min | Finish fixtures, evaluation, replay, and reset. If Nosana is still blocked, use a prewritten, source-linked rule with Tavily evidence and Daytona execution. If Daytona is also blocked, run the evaluator locally. Show the path and partners that actually ran. |
| 40–80 min | Build the invoice reveal, frozen transfer, and approval flip. |
| 80–105 min | Add the trace and request drawer. Use plain text if behind. Cut extra animation and sandbox work first. |
| 105–120 min | Rehearse twice from reset and submit. |

## Acceptance checks

1. **Exact match.** Email alone and a wrong-account callback both hold P3. The exact callback flips it using the same rule ID.
2. **Scope.** P1 stays ready, P2 stays held, and the vendor record is untouched after replay.
3. **Source.** The official excerpt appears in CodeAF’s input and the trace maps it to the callback requirement. Retrieval failure without a validated cache holds changed payments.
4. **Model inputs.** The drawer matches the captured request content. No fixture values, account or contact details, or row outcomes cross the model boundary. If the fallback made no model call, say so.
5. **Replay.** Reveal, verify, and reset twice. Duplicate clicks create one event per run. On execution failure, P3 stays held and retry reuses the event.
