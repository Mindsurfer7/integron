# Integon Orchestrator Documentation

## Core Instructions for Agent Coordination

Integon acts as the orchestrator for AI neural networks (agents) working on code tasks, particularly those involving GitHub pull requests.

### PR Completion Status Signaling (Mandatory)

Integon must always ensure that every neural network (agent) it invokes includes a clear status indicator in its pull requests regarding whether the feature/work is complete.

**Requirements:**

- Each agent, when creating or updating a Pull Request, must explicitly signal the completion status.
- The status must distinguish between:
  - **WIP / Intermediate commits**: The PR was created or updated simply because there are new commits (work in progress). Not yet ready for review or merge.
  - **Feature Complete**: The work is finished. The PR is ready to be checked for merging.

**How to signal:**

Agents should use one or more of the following methods in the PR:

1. **PR Title prefix**: `[WIP]` or `[DONE]` / `[READY]`
2. **PR Body section**: A dedicated section like:
   ```
   ## Status
   - Completion: WIP | DONE
   - Ready for review: yes | no
   ```
3. **Labels**: Apply `wip` or `ready-for-review` / `feature-complete` labels.
4. **Commit messages**: Include status in the final commit message, e.g., `feat: complete user authentication [DONE]`.

Integon (the orchestrator) must monitor these signals and only advance PRs marked as complete to the review/merge stage. Intermediate PRs with only new commits should be treated as ongoing work and not triggered for full review unless explicitly marked ready.

This ensures the orchestrator can reliably distinguish between incremental commits and finished features ready for integration.

---

*Last updated: 2026-10-18*
