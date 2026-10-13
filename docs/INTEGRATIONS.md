# Integrations guide — Jira · Zephyr Scale · Slack · Email · Sauce Labs

Everything a run produces can land where your team already works: failures become de-duplicated
Jira bugs, every linked test case gets a Zephyr Scale execution, and humans get one Slack message
and one email per run, each linking to the Jira bug and Zephyr cycle that run produced.

```
              ┌──────────── phase 1: record (parallel) ────────────┐   ┌─ phase 2: notify (parallel) ─┐
  test run ─► │  Sauce Labs   ·   Jira (comment / file / recover)   │ ─►│  Slack   ·   Email           │
  (report.json)│  Zephyr Scale (one execution per linked case)      │   │  "Recorded in: Jira, Zephyr" │
              └────────────────────────────────────────────────────┘   └──────────────────────────────┘
```

## Contents

1. [Rules every integration follows](#rules-every-integration-follows)
2. [Five-minute setup](#five-minute-setup)
3. [Linking tests to Jira and Zephyr](#linking-tests-to-jira-and-zephyr)
4. [Jira](#jira)
5. [Zephyr Scale](#zephyr-scale)
6. [Slack](#slack)
7. [Email](#email)
8. [Sauce Labs](#sauce-labs)
9. [CI/CD wiring](#cicd-wiring)
10. [Operations: doctor, re-publish, kill-switch](#operations)
11. [Troubleshooting](#troubleshooting)

---

## Rules every integration follows

| Rule                     | What it means in practice                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Off by default**       | No variables, no network calls. A fresh clone or a pull request never writes anywhere.                                        |
| **Never fails the run**  | A dead webhook or expired token gives a `failed` row in the report. It never turns a green suite red.                         |
| **Bounded**              | Each phase has a wall-clock budget (`INTEGRATIONS_BUDGET_MS`, default 120 s); Jira also has a call cap (`JIRA_MAX_COMMENTS`). |
| **No secrets out**       | Tokens are never logged, rendered or written to artifacts; they are scrubbed from error text.                                 |
| **Honest report**        | The Extent report's _Integrations_ tab shows one row per target, including _why_ an inactive one was skipped.                 |
| **Secrets never in git** | `npm run secrets:check` (also in the PR gate) fails the build if a credential is committed.                                   |

## Five-minute setup

```bash
cp .env.example .env          # fill in only the integrations you want
npm run integrations:doctor   # read-only: proves each credential works
npm run integrations:doctor:send   # optional: posts a test Slack message and sends a test email
npm test                      # integrations publish automatically at the end of the run
```

Doctor output looks like this:

```
  ✔ Jira          authenticated as QA Bot; project PAY readable; 3 open auto-filed bug(s); bug filing ON (per-test)
  ✔ Zephyr Scale  token valid; project PAY statuses: Not Executed, In Progress, Pass, Fail, Blocked
  ✔ Sauce Labs    authenticated in eu-central-1; run cloud suites with npm run test:sauce
  ✔ Slack         webhook URL well-formed (use --send-test to post a test message)
  ✖ Email         SMTP check failed: Invalid login: 535 5.7.3 Authentication unsuccessful (EAUTH)
```

## Linking tests to Jira and Zephyr

Keys can go in the title as tags (the original style) or, more cleanly, as annotations:

```ts
import { expect, test } from '@fixtures/index';
import { links, linkJira, linkZephyr } from '@utils/TestLinks';

// Declarative: shows in --list, the HTML report and the Extent report
test(
  'Reset link is sent to a registered address @smoke',
  links({ jira: 'PAY-3214', zephyr: ['PAY-T101', 'PAY-T102'] }),
  async ({ forgotPasswordPage }) => {
    /* … */
  },
);

// Tag style still works
test('Checkout rejects an expired card @PAY-123 @PAY-T42 @regression', async () => {
  /* … */
});

// Imperative, e.g. inside a data-driven loop
test('Refund flow', async () => {
  linkJira('PAY-88');
  linkZephyr('PAY-T77');
});
```

`links()` validates keys when the test is defined, so a typo like `PAY3214` fails loudly instead of
silently never reporting.

| Key on the test         | Effect when the test fails                    | Effect when it passes         |
| ----------------------- | --------------------------------------------- | ----------------------------- |
| Jira key (`PAY-3214`)   | One comment on that issue (grouped per issue) | nothing                       |
| Zephyr key (`PAY-T101`) | `Fail` execution in the run's cycle           | `Pass` execution              |
| _no Jira key_           | De-duplicated bug (if bug filing is on)       | recovery note on its open bug |

## Jira

**Required:** `JIRA_ENABLED=true`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`.
Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>, as a service
account if you can. Scoped tokens also need `JIRA_CLOUD_ID`.

Set `JIRA_ISSUE_KEY_PREFIXES=PAY` (your project prefixes). Without it, a tag like `@CHROME-131`
reads as an issue key and the framework would comment on somebody else's ticket.

### Automatic bug filing with de-duplication (`JIRA_CREATE_ISSUE_ON_FAILURE=true`)

With `JIRA_BUG_MODE=per-test` (the default), each failing test that names no issue gets **one Bug,
ever**, rather than one per build:

1. The test gets a fingerprint, `sha1(spec file + title with @tags removed)`, stored as a label
   `pw-fp-<12 hex>`. The same test failing on chromium and firefox is one bug, and adding a tag
   later does not fork its history.
2. One JQL search per run (`labels = pw-auto AND statusCategory != Done`) finds every open
   auto-filed bug.
3. Found → a **"still failing"** comment with the new error and run link. Not found → a new Bug
   with the error, the failed step, environment, report link and the **failure screenshot attached**
   (`JIRA_ATTACH_SCREENSHOTS`).
4. With `JIRA_NOTE_RECOVERIES=true`, an open bug whose test **passes** gets one "passing again"
   comment and the `pw-passing` label, so the note is posted once, not every green build. If the
   test fails again, the label is removed and it is commented on again. Nothing is ever closed
   automatically; your workflow decides.
5. If the search itself fails, **nothing is filed**: duplicates are worse than a missing bug, and
   the failure is shown in the report.

Labels on every auto-filed bug: `playwright`, `pw-auto`, `pw-fp-…`, plus `JIRA_LABELS`.
Useful JQL: `labels = pw-auto AND statusCategory != Done ORDER BY created DESC`.

`JIRA_BUG_MODE=run` keeps the legacy behaviour of one bug per run listing every unlinked failure.

## Zephyr Scale

**Required:** `ZEPHYR_ENABLED=true`, `ZEPHYR_API_TOKEN` (Zephyr Scale → profile → _API Access
Tokens_), `ZEPHYR_PROJECT_KEY`. EU tenants set
`ZEPHYR_BASE_URL=https://eu.api.zephyrscale.smartbear.com/v2`.

- Each run creates a cycle (`ZEPHYR_TEST_CYCLE_NAME`), or appends to `ZEPHYR_TEST_CYCLE_KEY=PAY-R12`.
- One execution per (test × linked case), with real duration, environment
  (`ZEPHYR_ENVIRONMENT_NAME`) and a per-test comment.
- Status names must exist in the project. The doctor lists them; map custom ones with
  `ZEPHYR_STATUS_PASS / _FAIL / _BLOCKED / _NOT_EXECUTED`.
- Executions are append-only, which is why a third switch (`ZEPHYR_ENABLED`) guards against a
  stray local run writing into real history.

## Slack

`SLACK_WEBHOOK_URL` (Slack → _Apps → Incoming Webhooks_). The URL **is** the credential.

One Block Kit message per run: verdict, counts, the first failures, a _View full report_ button
(`REPORT_URL`), and a **Recorded in:** line linking to the Jira bug and Zephyr cycle from phase 1.
`SLACK_NOTIFY_ON=failure` (default) keeps green runs quiet; `always` announces every run.

## Email

Any SMTP relay works:

| Provider         | `SMTP_HOST`                         | `SMTP_PORT` | `SMTP_USER` / `SMTP_PASSWORD`          |
| ---------------- | ----------------------------------- | ----------- | -------------------------------------- |
| Microsoft 365    | `smtp.office365.com`                | 587         | mailbox + password (SMTP AUTH enabled) |
| Google Workspace | `smtp.gmail.com`                    | 587         | address + **app password**             |
| Amazon SES       | `email-smtp.<region>.amazonaws.com` | 587         | SES SMTP credentials                   |
| SendGrid         | `smtp.sendgrid.net`                 | 587         | `apikey` + API key                     |
| Internal relay   | your host                           | 25/587      | often none                             |

Also `EMAIL_ENABLED=true`, `EMAIL_FROM`, `EMAIL_TO` (comma separated), optional `EMAIL_CC` / `EMAIL_BCC`.

- Port 465 uses implicit TLS. Other ports **require** STARTTLS and never send in clear text.
  `SMTP_ALLOW_SELF_SIGNED=true` is only for internal relays with private certificates.
- The body is a table-based HTML summary (renders in Outlook and Gmail) with a plain-text
  alternative: verdict banner, KPI tiles, environment, failures with error lines and linked keys,
  and a _Where this run was recorded_ section.
- `EMAIL_ATTACH_REPORT=true` attaches the Extent HTML report up to `EMAIL_MAX_ATTACHMENT_MB`.
- `EMAIL_NOTIFY_ON=always` (default) or `failure`.

## Sauce Labs

Playwright runs on Sauce through **saucectl** (Sauce uploads the repo and runs it on its VMs),
not through a remote browser endpoint.

```bash
npm install -g saucectl
# .env: SAUCE_USERNAME, SAUCE_ACCESS_KEY, SAUCE_REGION
npm run test:sauce             # run the suites in .sauce/config.yml
npm run test:sauce:publish     # run, then publish the cloud report to Jira/Zephyr/Slack/Email
```

`test:sauce:publish` downloads the Extent `report.json` from the Sauce artifacts and publishes it
**from your machine or CI runner**, so integration secrets never travel to Sauce VMs. The process
still exits with saucectl's status.

`.sauceignore` keeps `.env` and `storage/auth` out of the upload bundle. Review it whenever you
add a folder that holds secrets.

## CI/CD wiring

| Workflow         | When                 | Publishes to                                  |
| ---------------- | -------------------- | --------------------------------------------- |
| `playwright.yml` | pull requests        | nothing (`INTEGRATIONS_DISABLED=true`)        |
| `smoke.yml`      | push to main/develop | Slack + Email **on failure only**             |
| `regression.yml` | nightly + manual     | Jira + Zephyr + Slack + Email, **once**       |
| `sauce.yml`      | weekly + manual      | Jira + Zephyr + Slack + Email after Sauce run |

Nightly regression shards write Playwright blob reports with integrations off. The
`merge-and-publish` job merges them (`merge.config.ts`) and publishes the combined result once,
so ten shards give one Slack message, one Zephyr cycle and no duplicate bugs.

**Repository secrets** (Settings → Secrets and variables → Actions → _Secrets_):
`JIRA_EMAIL`, `JIRA_API_TOKEN`, `ZEPHYR_API_TOKEN`, `SLACK_WEBHOOK_URL`, `SMTP_USER`,
`SMTP_PASSWORD`, `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY`, plus the app credentials.

**Repository variables** (same page → _Variables_, not secret):
`JIRA_ENABLED`, `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_KEY_PREFIXES`,
`JIRA_CREATE_ISSUE_ON_FAILURE`, `ZEPHYR_ENABLED`, `ZEPHYR_PROJECT_KEY`, `ZEPHYR_BASE_URL`,
`ZEPHYR_ENVIRONMENT_NAME`, `EMAIL_ENABLED`, `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM`, `EMAIL_TO`,
`EMAIL_CC`, `SAUCE_REGION`.

## Operations

| Need                                           | Command / setting                                    |
| ---------------------------------------------- | ---------------------------------------------------- |
| Check all credentials (read-only)              | `npm run integrations:doctor`                        |
| Send a test Slack message and email            | `npm run integrations:doctor:send`                   |
| Re-send the last run (webhook was down, etc.)  | `npm run integrations:publish`                       |
| Re-send only to some targets                   | `npm run integrations:publish -- --only slack,email` |
| Publish a specific / downloaded report         | `npm run integrations:publish -- --report <folder>`  |
| Run locally without touching anything external | `INTEGRATIONS_DISABLED=true`                         |
| Limit a run to some targets                    | `INTEGRATIONS_ONLY=jira,slack`                       |
| Give slow endpoints more time                  | `INTEGRATIONS_BUDGET_MS=180000`                      |

## Troubleshooting

| Symptom                              | Cause / fix                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Jira `401 credentials rejected`      | Token expired (they now expire within a year), or a scoped token without `JIRA_CLOUD_ID`.        |
| Jira `404` on a comment              | Issue does not exist **or** the account cannot see it; Jira reports both as 404.                 |
| Jira `400 … issuetype`               | The project has no `Bug` type. Set `JIRA_ISSUE_TYPE` to one that exists (e.g. `Task`).           |
| Bug created but no screenshot        | No screenshot for that test (UI only) or file > 5 MB; see the Jira row detail.                   |
| Zephyr `status … does not exist`     | Map your project's names with `ZEPHYR_STATUS_*`; the doctor prints the valid ones.               |
| Zephyr "no test-case keys"           | Link tests with `links({ zephyr: 'PAY-T1' })`; executions are never guessed.                     |
| Email `EAUTH 535`                    | M365: enable _Authenticated SMTP_ for the mailbox. Gmail: use an app password.                   |
| Email `ETIMEDOUT`                    | Port blocked by the network/CI; try 587 vs 465, or an HTTP-relay provider's SMTP endpoint.       |
| Sauce `401`                          | Wrong key **or** wrong region: the account lives in one data centre (`SAUCE_REGION`).            |
| "Did not finish within the … budget" | Raise `INTEGRATIONS_BUDGET_MS`; the outcome of that one target is unknown, so check it manually. |
