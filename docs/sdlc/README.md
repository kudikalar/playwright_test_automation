<!-- ZYGEN_KIT:sdlc:v1 -->

# SDLC Kit — Quick Start

This folder contains per-ticket trackers managed by the **Zygen SDLC Extension**.

---

## Getting Started

### 1. Install the Kit

Run the VS Code command:

- **SDLC: Install Kit**

This creates:

- `.cursor/commands/sdlc.md` — The `/sdlc` orchestrator command for Cursor AI
- `docs/sdlc/TICKET_TEMPLATE.md` — Tracker template
- `docs/sdlc/README.md` — This file

### 2. Start a New Ticket

Run the VS Code command:

- **SDLC: Start Ticket (Wizard)**

The wizard will:

1. Ask for ticket ID, owner, type, domain, mode, title, goal, acceptance criteria, and reviewers
2. Create `docs/sdlc/<TICKET>.md` from the template
3. Copy a "continue in Cursor chat" prompt to your clipboard

### 3. Resume an Existing Ticket

Run the VS Code command:

- **SDLC: Resume Ticket**

This lets you pick an existing tracker and copies a resume prompt to your clipboard.

### 4. Run the SDLC Orchestrator in Cursor Chat

After starting or resuming a ticket, paste the prompt into Cursor chat, or run:

```
/sdlc <TICKET>
```

Example:

```
/sdlc JIRA-123
```

---

## Stage-Gated Flow

The orchestrator enforces this state machine:

```
Intake → PRD → Plan → TestPlan → InDev → InReview → InPR → Done
                                                          ↘ Blocked
                                                          ↘ Split
                                                          ↘ DeScoped
                                                          ↘ WontDo
```

### Key Rules

- **WIP Lock**: Only one active ticket per owner. Terminalize or transfer before starting another.
- **Gate Enforcement**: Each stage has a gate that must be approved before advancing.
- **TDD by Default**: Tests first, then code. Override requires explicit recording.
- **Coverage Thresholds**: 70% global minimum, 90% on changed code.

---

## Files in This Folder

| File                 | Purpose                              |
| -------------------- | ------------------------------------ |
| `TICKET_TEMPLATE.md` | Template for new ticket trackers     |
| `README.md`          | This quickstart guide                |
| `<TICKET>.md`        | Per-ticket tracker (source of truth) |

---

## Tips

1. **Don't edit TICKET_TEMPLATE.md** — it's used to generate new trackers
2. **Do edit `<TICKET>.md`** — the AI will read and update it each iteration
3. **Use terminal states** — always close tickets with: `Done | Blocked | Split | DeScoped | WontDo`
4. **Ask questions** — if the AI is unsure, it will stop and ask blocking questions

---

For more details, see `.cursor/commands/sdlc.md`.
