# TZ: OpenCode Managed Runner + ChatGPT UI automation

Status: draft. Complements Development Orchestrator roadmap (D5 ManagedAgentRunner) and MCP contract.

## Goal

Give Integron the ability to execute development tasks without requiring the owner to manually open chats. Two complementary paths:

1. **OpenCode Managed Runner** — reliable, local, model-agnostic agent with HTTP API.
2. **ChatGPT UI automation** — optional free-tier overflow by controlling a logged-in browser session on a machine the owner leaves running.

## Path 1: OpenCode as ManagedAgentRunner

### Architecture

```text
Integron Dev Orchestrator
    ├─ starts / monitors `opencode serve` processes or containers
    ├─ HTTP/SDK client → OpenCode server
    │     • create session
    │     • send prepared prompt (from available_tasks)
    │     • poll status / heartbeat
    │     • retrieve artifacts (branch, PR, diffs, logs)
    └─ reconciles outcome against GitHub observer
```

### Requirements

- Allowlist of repositories / working directories.
- One OpenCode server per project or shared pool with session isolation.
- Support for Docker and bare process modes.
- Idempotent start / resume / cancel.
- Map OpenCode session → `DevAgentSession` + `DevExecution`.
- Cost / token budget tracking when using paid providers.
- Fallback to ManualRunner (handoff prompt) if OpenCode is unavailable.

### Models

- OpenCode Zen (free promotional models + pay-as-you-go).
- Bring-your-own keys (Anthropic, OpenAI, Gemini, OpenRouter, Groq, etc.).
- Local via Ollama / LM Studio.
- Configurable per project or per task.

### Non-goals for first slice

- Automatic model fine-tuning.
- Direct production deploys.
- Unrestricted shell outside the project allowlist.

## Path 2: ChatGPT UI automation (owner machine)

### Intent

Owner leaves a computer (or VM) running with a logged-in browser. An MCP-controlled local agent can:

- Open a new ChatGPT chat.
- Paste a prepared task prompt.
- Optionally monitor the response and extract results / PRs.

This is an unofficial, fragile path intended for free-tier overflow or specific models not available elsewhere. It must never be the only execution path.

### Existing building blocks

- `chatgpt-web-mcp` — local MCP server that drives ChatGPT web UI via persistent browser profile.
- Playwright MCP / real-browser-mcp — general browser control of the owner's real Chrome session.
- Community bridges in the opposite direction (`opencode-chatgpt-bridge`) show the pattern works.

### Requirements if implemented

- Runs only on an explicitly designated owner machine.
- Persistent browser profile with manual login (no credential storage in Integron).
- Rate limiting, human-like delays, and circuit breaker on UI changes or captchas.
- Clear audit log of which prompts were injected.
- Easy kill switch.
- Results still reconciled against GitHub; chat self-report is untrusted.

### Risks (must be documented and accepted)

- Against the spirit and possibly the letter of ChatGPT ToS.
- UI changes break automation.
- Account rate limits, temporary bans, or detection.
- Not suitable for unattended high-volume use.

## Hybrid operating model

| Priority | Path | When used |
|----------|------|-----------|
| 1 | OpenCode Managed Runner | Default for reliable, auditable, parallel work |
| 2 | ChatGPT UI automation | Optional free overflow or specific model preference |
| 3 | Manual handoff | Fallback; owner pastes prepared prompt |

Orchestrator decides based on policy, budget, and availability. Owner can override from the control ChatGPT MCP session.

## Who controls what

- **Owner**: approvals for merge, budget limits, kill switches, which path is allowed.
- **Integron**: readiness of tasks, prompt preparation, starting runners, reconciliation with GitHub, notifications.
- **OpenCode / browser agent**: executes the concrete coding task.
- **GitHub**: source of truth for branches, PRs, CI.

## Suggested next steps

1. Prototype OpenCode adapter (start session, send prompt, poll, map to DevExecution) against a local `opencode serve`.
2. Evaluate `chatgpt-web-mcp` or Playwright MCP on the owner's machine as a separate experimental runner.
3. Add both as optional backends behind the existing `start_task` MCP tool (`mode: "opencode" | "chatgpt-ui" | "manual"`).
4. Keep ChatGPT UI path clearly marked experimental and disabled by default.
