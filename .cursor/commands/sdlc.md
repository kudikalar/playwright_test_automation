<!-- ZYGEN_KIT:sdlc:v1 -->

# sdlc — Strict SDLC Orchestrator

## Intent

Drive a **strict, stage-gated SDLC** with explicit entry/exit boundaries. The orchestrator must:

- **Stay within entryStage → exitStage slice**
- **Progress deterministically toward exit**
- **Stop immediately when exit condition is met**
- **Use single-choice questions only** (no free text except links/titles)
- **Treat goal as immutable** once set

## Usage

Run:

- `/sdlc JIRA-123`

---

## ENTRY/EXIT CONTRACT (MANDATORY)

### On First Invocation

1. Read `docs/sdlc/<TICKET>.md`
2. If `entryStage` or `exitStage` is missing:
   - **STOP** and ask user to select them explicitly
   - Use single-choice format (see below)
3. Once set, these are **immutable** unless user explicitly requests change

### Valid Stages

- Entry: `Intake | PRD | Plan | TestPlan | InDev | InReview | InPR`
- Exit: Any stage >= entryStage OR `Done`

### Examples

- Entry=PRD, Exit=PRD → PO-only workflow (produce PRD, get Gate A approval, stop)
- Entry=Plan, Exit=InDev → Architect→Dev handoff (produce ADR/TRD, get Gate B, stop)
- Entry=InDev, Exit=InPR → Dev-only execution (code, test, review, PR)
- Entry=InDev, Exit=Done → Full dev lifecycle (code → test → review → PR → merge)

### Stage Boundaries

- **DO NOT** work on stages before `entryStage`
- **DO NOT** work on stages after `exitStage`
- **DO NOT** rework intake unless user explicitly chooses "[R] Re-open intake"

---

## QUESTION FORMAT (MANDATORY)

### Single-Choice Only

When user input is required, present EXACTLY ONE of these formats:

**Gate Decision:**

```
[A] Approve and continue
[R] Reject and revise
[E] Exit at this stage
```

**Action Choice:**

```
[D] Proceed with development
[T] Perform TDD first
[A] Work on ADR/TRD first
```

**Stage Selection:**

```
[1] Intake
[2] PRD
[3] Plan
[4] TestPlan
[5] InDev
[6] InReview
[7] InPR
```

### Free Text Allowed ONLY For:

- Links (PRD, ADR/TRD, PR URLs)
- Ticket titles
- Brief reasons (max 50 chars)

---

## INTAKE BEHAVIOR

Intake exists ONLY to:

1. Set `entryStage` (if missing)
2. Set `exitStage` (if missing)
3. Collect missing REQUIRED artifacts for `entryStage`

Intake must NOT:

- Rewrite goals repeatedly
- Ask speculative questions
- Restart SDLC unless user explicitly requests "[R] Re-open intake"

---

## STAGE EXECUTION RULES

For each stage between `entryStage` → `exitStage`:

1. **Check Required Artifacts**
   - If missing: Ask guided, single-choice question
   - Collect ONLY what is required to unblock

2. **Perform Stage Work**
   - Produce required artifacts
   - Update tracker immediately

3. **Present Gate Decision**
   - Use format: `[A] Approve and continue | [R] Reject and revise | [E] Exit at this stage`
   - Wait for user choice

4. **On Approval**
   - Advance to next stage (if not at exitStage)
   - Update tracker state

5. **On Rejection**
   - Revise ONLY current stage
   - Do NOT backtrack to earlier stages

6. **On Exit**
   - Stop orchestration immediately
   - Update tracker state
   - Summarize outcome (3-5 bullets)
   - Do NOT propose next steps

---

## GATE DECISION FORMAT (MANDATORY)

Every gate MUST end with exactly ONE of:

```
[A] Approve and continue
[R] Reject and revise
[E] Exit at this stage
```

User responds with: `A`, `R`, or `E` (case-insensitive)

---

## EXIT BEHAVIOR

When `exitStage` is reached:

1. **Stop orchestration immediately**
2. Update tracker `state` to `exitStage`
3. Update `lastProgressAt`
4. Output summary (3-5 bullets):
   - What was completed
   - Artifacts produced
   - Gate statuses
   - Next steps (if any) — ONLY if user asks

**DO NOT:**

- Propose next steps automatically
- Suggest continuing beyond exitStage
- Re-interpret the goal

---

## GOAL COMPLETION ENFORCEMENT

- Once orchestration starts, **goal is immutable**
- DO NOT reinterpret or expand scope
- DO NOT re-open intake unless user explicitly chooses "[R] Re-open intake"
- If goal needs change, user must manually edit tracker

---

## TRACKER DISCIPLINE

Update `docs/sdlc/<TICKET>.md` after EVERY interaction:

- `entryStage` / `exitStage` (if changed)
- `state` (current stage)
- Gate decisions (`approvedBy`, `approvedAt`, `status`)
- Artifacts produced
- `lastProgressAt` (always)

---

## OUTPUT RULE

Every `/sdlc` invocation must end with:

- **One clear question** (single-choice format), OR
- **One clear gate decision** (`[A]|[R]|[E]`), OR
- **Clean exit summary** (3-5 bullets)

**NO:**

- Paragraph explanations
- Multi-question prompts
- Theory or speculation
- Re-summarizing the goal

---

## What You (the AI) MUST Do When This Command Is Invoked

### Step 1 — Load Tracker

- Read `docs/sdlc/<TICKET>.md`
- If missing: **STOP** — tracker must exist (created by wizard)

### Step 2 — Check Entry/Exit

- If `entryStage` missing: Ask user to select (single-choice)
- If `exitStage` missing: Ask user to select (single-choice)
- If both set: Proceed to Step 3

### Step 3 — Enforce Boundaries

- Current `state` must be >= `entryStage`
- Current `state` must be <= `exitStage`
- If outside bounds: **STOP** and ask user to adjust entry/exit

### Step 4 — Check WIP Lock

- If another active ticket exists for same owner: **STOP** and present options

### Step 5 — Execute Current Stage

- Check required artifacts for current stage
- If missing: Ask single-choice question to collect
- Perform stage work
- Update tracker

### Step 6 — Gate Decision

- If stage has gate: Present `[A]|[R]|[E]` format
- Wait for user response
- On `A`: Advance to next stage (if not at exitStage)
- On `R`: Revise current stage
- On `E`: Stop at current stage, update tracker

### Step 7 — Exit Check

- If `state` == `exitStage`: **STOP**, output summary
- Otherwise: Continue to next stage

### Step 8 — Update Tracker

- Always update `lastProgressAt`
- Update artifacts, gates, state as needed

---

## Stage-Specific Actions

| Stage    | Required Artifacts              | Gate   | Exit Allowed |
| -------- | ------------------------------- | ------ | ------------ |
| Intake   | entryStage, exitStage, goal, AC | None   | Yes          |
| PRD      | PRD document                    | Gate A | Yes          |
| Plan     | ADR/TRD document                | Gate B | Yes          |
| TestPlan | Test plan                       | Gate C | Yes          |
| InDev    | Code + tests                    | None   | Yes          |
| InReview | PR link                         | None   | Yes          |
| InPR     | Coverage confirmed              | None   | Yes          |

---

## Tracker Template (use exactly for new tickets)

```markdown
# <TICKET> — <title>

## Ownership & Enforcement

- owner: <name>
- state: Intake
- entryStage: <Intake|PRD|Plan|TestPlan|InDev|InReview|InPR>
- exitStage: <Intake|PRD|Plan|TestPlan|InDev|InReview|InPR|Done>
- startedAt: <YYYY-MM-DD>
- lastProgressAt: <YYYY-MM-DD>
- deadlineAt: <YYYY-MM-DD>

## Mode & Quality Gates

- mode: tdd_strict
- coverage:
  - globalMin: 70
  - changedCodeMin: 90
  - criticalPathsMin: 100
- overrides: []

## Goal / Scope

- goal:
- outOfScope:

## Acceptance Criteria (AC)

- AC1:
- AC2:

## Open Questions (blocking)

- Q1:

## Artifacts

- PRD:
- Gherkin:
- ADR/TRD:
- TestPlan:
- PRs:

## Gates (must be approved to advance)

- GateA_PRD:
  - status: pending
  - reviewers: []
  - approvedBy:
  - approvedAt:
  - comments:
- GateB_ADR_TRD:
  - status: pending
  - reviewers: []
  - approvedBy:
  - approvedAt:
  - comments:
- GateC_TestPlan:
  - status: pending
  - reviewers: []
  - approvedBy:
  - approvedAt:
  - comments:

## Progress Checklist

- [ ] PRD finalized (Gate A)
- [ ] ADR/TRD approved (Gate B)
- [ ] Test plan approved (Gate C)
- [ ] TDD evidence captured (fail → pass)
- [ ] Implementation complete (AC met)
- [ ] Coverage meets thresholds
- [ ] PR opened
- [ ] PR merged
- [ ] Ticket terminalized

## TDD Evidence (required in tdd_strict)

- failingTestEvidence:
- passingTestEvidence:
- testCommits:

## Implementation Notes

<!-- Updated during PHASE 2 — IMPLEMENTATION -->

## Context Digest

<!-- Updated during PHASE 5 — limit to 10 bullet points -->

- What is built:
- What is explicitly NOT built:
- Key decisions and trade-offs:
```

---

## Output Expectation

- Be concise, structured, and deterministic.
- Use single-choice questions only.
- Act, don't narrate.
- Stop at exitStage immediately.
