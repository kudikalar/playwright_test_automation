<!-- ZYGEN_KIT:sdlc:v1 -->

# <TICKET> — <title>

## Ownership & Enforcement

- owner: <name>
- author: <name>
- state: Intake
- entryStage: <Intake|PRD|Plan|TestPlan|InDev|InReview|InPR>
- exitStage: <Intake|PRD|Plan|TestPlan|InDev|InReview|InPR|Done>
- startedAt: <YYYY-MM-DD>
- lastProgressAt: <YYYY-MM-DD>
- deadlineAt: <YYYY-MM-DD>

## Mode & Quality Gates

- mode: tdd_strict # tdd_strict | dev_then_tests
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
  - status: pending # pending | approved | rejected
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
<!-- This digest becomes the canonical context for future iterations -->

- What is built:
- What is explicitly NOT built:
- Key decisions and trade-offs:
