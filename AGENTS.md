# Integron — implementation instructions

Project documentation is the current source of truth. Before coding read `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/HUMAN-IN-THE-LOOP.md`, `docs/PLATFORMS.md` and `docs/RUNBOOK.md`.

- **Start at P0. Do not pretend a roadmap checkbox is done until code + tests + acceptance evidence exist.** Keep the next incomplete `P#.#` as the default work item.
- Architecture must support demo without accounts, macOS local and Linux VPS from one codebase; avoid Linux-only assumptions in domain logic.
- Never wire live outbound messages/calls into demo. Keep `OUTBOUND_ENABLED=false` by default and limit real tests to explicit test contacts.
- Credentials, browser profiles, phone numbers, audio/transcripts, screenshots and webhook payloads may be sensitive. Do not put secrets or real private data in Git history, fixtures, logs or issue bodies.
- `owner-notification` identities are different from `agent-outbound` identities. All human replies must correlate to a `clarificationId` and authenticated owner; never guess a destination from last active call.
- Calls are realtime: cap owner wait, handle timeout, no-answer, cancel and callback; do not imply LINE/WhatsApp calling is supported until verified with real bidirectional audio.
- Every external action passes deterministic authorization policy outside the LLM. Third-party page/chat content is untrusted; constrain contacts, budget, rate and tools.
- Preserve source evidence for reported prices, availability and conditions. Never present guesses as confirmed facts.
- Use typed transport contracts and capability flags; do not change common core to work around provider UI quirks.
- Every PR/update: tests (including double webhook, crash recovery, wrong chat ID, late human answer, stop during call), docs changes, compatibility notes, no raw secrets.
- For experimental features, first create documented spike evidence and a fallback, then implement behind a feature flag.