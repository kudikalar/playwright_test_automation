# Playwright Enterprise Framework

A production-grade **Playwright + TypeScript** automation platform for **UI**, **REST API** and
**hybrid UI+API** testing. Built to carry thousands of tests across multiple teams, environments
and browsers without the core needing to change when a new application module arrives.

Adding a module normally means adding four things and nothing else:

```
Page Object / Component  +  JSON test data  +  API service (if needed)  +  spec
```

---

## Table of contents

1. [What you get](#what-you-get)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [First run](#first-run)
5. [Architecture](#architecture)
6. [Folder structure](#folder-structure)
7. [Environments and secrets](#environments-and-secrets)
8. [Test data](#test-data)
9. [Page Objects and components](#page-objects-and-components)
10. [Fixtures](#fixtures)
11. [Authentication](#authentication)
12. [API framework](#api-framework)
13. [Hybrid testing](#hybrid-testing)
14. [Running tests](#running-tests)
15. [Reports and diagnostics](#reports-and-diagnostics)
16. [Debugging](#debugging)
17. [Visual regression](#visual-regression)
18. [CI/CD](#cicd)
19. [Extending the framework](#extending-the-framework)
20. [Coding standards](#coding-standards)
21. [Troubleshooting](#troubleshooting)

---

## What you get

| Capability                                      | Where it lives                                      |
| ----------------------------------------------- | --------------------------------------------------- |
| UI automation with a strict Page Object Model   | `src/pages`, `src/components`                       |
| REST API automation (client → services → tests) | `src/api`                                           |
| Hybrid UI + API journeys                        | `tests/hybrid`                                      |
| JSON-only functional test data                  | `test-data/`, `src/utils/JsonReader.ts`             |
| Multi-environment execution (dev/qa/uat/prod)   | `config/environments/*.json`                        |
| Multi-browser, tablet and mobile projects       | `playwright.config.ts`                              |
| Role-based storage-state authentication         | `src/fixtures/AuthenticationManager.ts`             |
| Extent-style HTML reporting                     | `src/reporting/` → `reports/extent/`                |
| Structured logging with secret masking          | `src/utils/Logger.ts`, `src/utils/DataMasker.ts`    |
| Screenshots, video, traces on failure           | `playwright.config.ts`, `reports/`, `test-results/` |
| Contract testing with JSON Schema               | `src/api/models/schemas.ts`, `src/api/validators`   |
| Visual regression                               | `tests/visual`                                      |
| Parallel-safe data lifecycle and cleanup        | `src/data/factories`, `cleanup` fixture             |
| CI pipelines with artifact publishing           | `.github/workflows`                                 |

A **reference application** ships in `demo-app/` (dependency-free Node server with an accessible
UI and a REST API) so the framework is runnable and verifiable out of the box. Point an
environment file at your own application and the reference app disables itself.

---

## Prerequisites

- **Node.js 20+** (22 LTS recommended) and npm 10+
- Git
- Browsers are installed by Playwright — no manual downloads

---

## Installation

```bash
git clone <your-repository-url>
cd playwright-enterprise-framework
npm ci
npm run prepare:browsers          # downloads the browser builds this Playwright version needs
cp .env.example .env              # optional locally; required for qa/uat/prod
```

`.env` is git-ignored. In CI, provide the same variables as repository secrets.

The browsers are pinned to the installed Playwright version, so `npm ci` alone is not enough —
skipping the download produces `browserType.launch: Executable doesn't exist` during global
setup. The API suite (`npm run test:api`) is browserless and runs without this step.

If the download times out on a slow or filtered link, retry with a longer budget:

```bash
PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=600000 npx playwright install chromium
```

---

## First run

```bash
npm test                # API + Chromium suites against the local sandbox
npm run report:open     # open the Extent report for the last run
```

The default environment is `dev`, which targets the bundled reference application. Playwright
starts it automatically on `http://127.0.0.1:4321`.

---

## Architecture

```
                          TESTS  (tests/ui · tests/api · tests/hybrid · tests/visual)
                                     │
                    ┌────────────────┴────────────────┐
                   UI                                API
                    │                                 │
              Fixtures (page/auth)             Fixtures (api)
                    │                                 │
              Page Objects                      Domain services
                    │                          (AuthApi, EmployeeApi…)
              Components                              │
                    │                             ApiClient
               BasePage                                │
                    │                          APIRequestContext
                    └────────────────┬────────────────┘
                                     │
                              Configuration
                 (environments JSON · framework config · secrets)
                                     │
                              Test execution
                    ┌────────────────┼────────────────┐
             Extent report   Playwright artifacts    Logs
                                     │
                                   CI/CD
```

Three rules keep the layers honest:

1. A **test** contains business language and assertions — never a raw locator or a raw HTTP call.
2. A **Page Object** contains locators and workflows — never a hard-coded URL or credential.
3. **Configuration** contains values — never behaviour.

---

## Folder structure

```text
.github/workflows/      playwright.yml (PR gate) · smoke.yml · regression.yml (nightly)
config/
  environments/         dev.json · qa.json · uat.json · prod.json  (non-secret values only)
  environment.config.ts environment resolution, overrides, credential lookup
  framework.config.ts   execution knobs (workers, retries, logging, reporting)
demo-app/               reference application under test (server + accessible UI)
src/
  pages/                BasePage + one Page Object per screen
  components/           Header, Sidebar, Table, Modal, Toast, Pagination, Search, DatePicker
  api/
    clients/            ApiClient — the single HTTP entry point
    services/           AuthApi, UserApi, EmployeeApi (domain vocabulary)
    models/             wire types + JSON Schemas
    validators/         fluent response validation + schema assertions
  data/factories/       JSON template → unique runtime payloads
  fixtures/             base → page → api → auth (chained), AuthenticationManager
  utils/                JsonReader, Logger, DataMasker, Wait/Retry/File/Date/Random, assertions
  constants/            framework, API and test-taxonomy constants
  types/                Environment, ApiModels, TestData contracts
  reporting/            Extent adapter (reporter) + HTML renderer
tests/
  ui/{smoke,sanity,regression,e2e}/
  api/{smoke,regression,contract}/
  hybrid/               UI + API journeys
  visual/               screenshot baselines (__screenshots__/)
test-data/{common,dev,qa,uat}/   functional data as JSON
storage/auth/           generated session state (git-ignored)
reports/                extent · playwright · json · junit · screenshots · downloads
logs/                   per-run structured logs
scripts/                clean, open report, verification gate
```

---

## Environments and secrets

An environment file holds **non-secret** values only:

```jsonc
{
  "name": "qa",
  "ui": { "baseUrl": "https://qa.workforce.example.com", "loginPath": "/login", … },
  "api": { "baseUrl": "https://qa-api.workforce.example.com/api/v1", "apiKeyEnv": "API_KEY" },
  "timeouts": { "test": 90000, "action": 20000, "navigation": 45000, "expect": 15000, "api": 30000 },
  "retries": { "local": 0, "ci": 2, "apiMaxAttempts": 3, "apiBackoffMs": 500 },
  "features": { "employeeDeletion": true },
  "roles": { "ADMIN": { "usernameEnv": "ADMIN_USERNAME", "passwordEnv": "ADMIN_PASSWORD" } }
}
```

Credentials are referenced **by environment-variable name**, never by value. A spec asks for a
role and the framework resolves the secret:

```ts
await loginPage.loginAs('ADMIN'); // UI
await authApi.authenticateClientAs('ADMIN'); // API
```

Selecting an environment:

```bash
npm run test:qa                    # TEST_ENV=qa
TEST_ENV=uat npx playwright test   # equivalent
UI_BASE_URL=https://review-42.example.com npm test   # ad-hoc override
```

`dev` is the only environment that allows published sandbox credentials, so a clone runs with no
setup. `qa`, `uat` and `prod` fail fast with an explicit message when a secret is missing.

**Never commit** a password, token, cookie or API key. `.gitignore` covers `.env*` and
`storage/auth/`. Everything written to a log or report passes through `DataMasker` first.

---

## Test data

All functional data is JSON. `test-data/common/<name>.json` is the baseline; a file with the same
name under `test-data/<env>/` is deep-merged over it, so an environment declares only what differs.

```ts
const data = testData.get('employees'); // fully typed via TestDataRegistry
const value = readPath<string>('login', 'ui.submitLabel');
```

Unique, parallel-safe records come from a factory that layers runtime values onto the template:

```ts
const employee = buildEmployee({ templateKey: 'engineer' });
// { name: 'Auto Engineer 4F2A1B', email: 'pwauto.engineer.…@automation.test', … }
```

Lifecycle: **load template → generate unique values → create through the API → test → validate →
clean up through the API**. The `cleanup` fixture removes tracked records even when a test fails.

---

## Page Objects and components

`BasePage` provides every reusable browser action — navigation, clicks, input, dropdowns,
checkboxes, element state, extraction, mouse, uploads/downloads, dialogs, tabs, frames,
screenshots, scrolling, network interception. Page Objects add locators and workflows only.

Locator priority: `getByRole` → `getByLabel` → `getByPlaceholder` → `getByText` → `getByTestId` →
stable CSS. No XPath, no `nth-child`, no generated class names.

```ts
export class LoginPage extends BasePage {
  public readonly emailInput: Locator;

  constructor(page: Page) {
    super(page);
    this.emailInput = page.getByLabel('Email');
  }

  public async loginAs(role: UserRole): Promise<void> { … }
}
```

Reusable regions are **components** scoped to a root locator — pages compose them:

```ts
this.table = new TableComponent(page, { testId: 'employee-table', rowTestId: 'employee-row' });
await this.table.clickRowAction('Kiran Rao', 'Edit');
```

---

## Fixtures

Fixture layers are chained so a later layer can depend on an earlier one:

```
base (environment, execution, testData, log)
  └── page (loginPage, dashboardPage, employeePage, profilePage)
        └── api (apiClient, authApi, employeeApi, adminEmployeeApi, cleanup)
              └── auth (role option, authenticatedPage, dashboardAs, employeesAs, profileAs)
```

```ts
import { expect, test } from '@fixtures/index';

test.use({ role: 'MANAGER' });

test('employee workflow', async ({ employeesAs, adminEmployeeApi, cleanup, testData }) => {
  …
});
```

`environment` and `execution` are **worker-scoped**; `runContext` is **automatic** and annotates
every test with its environment and project for the report.

---

## Authentication

Global setup signs in once per role through the real UI and stores the browser state under
`storage/auth/`. Tests then start authenticated:

```ts
test.use({ role: 'ADMIN' });
test('…', async ({ dashboardAs }) => {
  await dashboardAs.open();
});
```

- Session files are git-ignored and deleted in global teardown (keep them locally with
  `KEEP_AUTH_STATE=true`).
- Reuse is capped at 45 minutes; a stale file is regenerated automatically.
- `tests/ui/smoke/login.smoke.spec.ts` still drives the real login form, on purpose.

Adding a role: add it to `roles` in the environment file, add its env vars to `.env.example`, and
add it to `ROLES_TO_AUTHENTICATE` in `global-setup.ts`.

---

## API framework

```
ApiClient  →  domain services  →  tests
```

```ts
const response = await employeeApi.create(payload);

verify(response)
  .hasStatus(201)
  .isSuccessful()
  .matchesSchema(employeeSchema)
  .hasProperty('email', payload.email)
  .respondedWithin(2000);
```

`ApiClient` owns base URL, headers, bearer/API-key auth, path and query parameters, timeouts,
retries for idempotent calls, response parsing and masked logging. Services own endpoints and
domain operations. Tests own expectations.

Negative and authorisation coverage is first-class: `skipAuth`, `withToken`, `rawBody` (sent as
bytes, so a malformed payload stays malformed) and `useApiKey`.

---

## Hybrid testing

Use the API for setup, cleanup and backend verification; use the UI for what the user sees.

```ts
const created = await adminEmployeeApi.createOrThrow(buildEmployee()); // API setup
await employeesAs.open(); // UI journey
await employeesAs.searchFor(created.email);
await employeesAs.expectEmployeeRow(created);
await adminEmployeeApi.deleteIfExists(created.id); // API cleanup
```

---

## Running tests

```bash
npm test                    # API + Chromium (default gate)
npm run test:full           # every project, including devices and Edge

npm run test:ui             # UI suites
npm run test:api            # API suites
npm run test:hybrid         # hybrid journeys
npm run test:contract       # JSON-Schema contract suite

npm run test:smoke          # --grep @smoke
npm run test:sanity
npm run test:regression
npm run test:e2e
npm run test:critical
npm run test:negative
npm run test:security

npm run test:dev | test:qa | test:uat | test:prod

npm run test:chromium | test:firefox | test:webkit | test:edge
npm run test:tablet | test:mobile
npm run test:all-browsers

npm run test:headed         # watch it run
npm run test:debug          # Playwright inspector, one worker
npm run test:ui-mode        # Playwright UI mode
npm run test:failed         # re-run only last failures
```

Tags: `@smoke @sanity @regression @e2e @api @ui @hybrid @contract @negative @critical @security
@visual @data-driven`.

---

## Reports and diagnostics

| Report            | Location                                                 | Notes                                                                                       |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Extent**        | `reports/extent/latest.html` (+ timestamped run folders) | suites, modules, tags, environment, steps, retries, embedded screenshots, trace/video links |
| Playwright HTML   | `reports/playwright/`                                    | `npm run report`                                                                            |
| JSON / JUnit      | `reports/json/results.json`, `reports/junit/results.xml` | CI ingestion                                                                                |
| Logs              | `logs/run-<id>.log`                                      | structured, masked                                                                          |
| Failure artifacts | `test-results/**`                                        | screenshot, video, trace — failures only                                                    |

```bash
npm run report:open                 # Extent report for the last run
npm run report                      # Playwright HTML report
npx playwright show-trace test-results/<test>/trace.zip
```

Reporting lives entirely in the reporter layer — no test contains reporting code.

The Extent report is one self-contained HTML file — inline styles and script, no CDN — so it opens
straight off disk and survives being emailed as a single attachment. It carries an animated result
donut, count-up KPI tiles and keyboard-navigable tabs (Overview, Suites, Modules, Projects, Tests,
Environment, Integrations), with live search and status filters over the test list. Clicking a
donut slice filters to that status.

Two behaviours are deliberate and worth knowing:

- `latest.html` only advances after a run that **executed** something. A run that reported nothing
  — an unknown `--project`, a failed global setup, `playwright test --list` — leaves the previous
  report in place and says so, instead of replacing it with an empty one.
- `latest.html` sits one directory above the run folder, so it is rendered with the run folder as
  an asset prefix. Screenshots, videos and traces resolve from either copy.

---

## Integrations

Slack, Jira, Zephyr Scale and Sauce Labs. **Every one is off until its environment variables are
set** — a default run makes no network calls and needs no credentials. See `.env.example`.

| Target           | Enable with                                                  | What it does                                                            |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Slack**        | `SLACK_WEBHOOK_URL`                                          | one Block Kit run summary; `SLACK_NOTIFY=failure` (default) or `always` |
| **Jira Cloud**   | `JIRA_ENABLED=true` + base URL / email / API token / project | one comment per referenced issue key, in Atlassian Document Format      |
| **Zephyr Scale** | `ZEPHYR_ENABLED=true` + API token + project key              | one test execution per test carrying a Zephyr case key, into a cycle    |
| **Sauce Labs**   | `SAUCE_USERNAME` + `SAUCE_ACCESS_KEY` + `SAUCE_BUILD_NAME`   | links the run to its Sauce jobs                                         |

Jira and Zephyr are driven by keys a test declares in its own title, so nothing is ever guessed:

```ts
test('Checkout rejects an expired card @PROJ-123 @PROJ-T42 @regression', async () => { … });
```

`@PROJ-123` is commented on in Jira; `@PROJ-T42` is published as a Zephyr execution. A test with no
key is reported as skipped-for-lack-of-a-key rather than invented.

Three rules hold for all four (`src/integrations/IntegrationTypes.ts`): they are opt-in, they never
throw — a dead webhook cannot turn a green suite red — and no token is ever logged, rendered or
written to an artifact. Every target reports a row in the report's Integrations tab, including why
it was inactive.

### Sauce Labs

Playwright does **not** run on Sauce through a remote endpoint. Sauce bundles the repository and
runs it on their VMs via `saucectl`, so there is no `wsEndpoint` to point at:

```bash
npm install -g saucectl        # standalone CLI, not an npm dependency
npm run sauce:config           # regenerate .sauce/config.yml from SauceConfig.ts
npm run test:sauce
```

`.sauce/config.yml` is generated from the typed definition in `src/integrations/sauce/SauceConfig.ts`
so the two cannot drift; edit the TypeScript, not the YAML. It contains no credentials — `saucectl`
reads `SAUCE_USERNAME` and `SAUCE_ACCESS_KEY` from the environment.

> **`.sauceignore` is security-critical.** `saucectl` zips and uploads the whole of `rootDir`.
> Without that file the archive would carry your `.env` and `storage/auth` session tokens to the
> cloud. Check it before the first run, and whenever you add a directory holding secrets.

---

## Debugging

```bash
npm run test:debug -- tests/ui/smoke/login.smoke.spec.ts
npm run test:headed -- --project=chromium --grep "@critical"
SLOW_MO=250 HEADLESS=false npx playwright test --workers=1
LOG_LEVEL=DEBUG npx playwright test --grep "@smoke"
```

Every framework error carries operation, target, page, URL and environment, so a CI log usually
identifies the problem without reproducing it locally.

---

## Visual regression

```bash
npm run test:visual           # compare against baselines
npm run test:visual:update    # re-baseline deliberately, then review the diff in the PR
```

Baselines live in `tests/visual/__screenshots__/<project>/…` — separate from failure screenshots.
Dynamic regions are masked in the spec rather than excluded from coverage.

---

## CI/CD

| Workflow         | Trigger                                      | Scope                                                                 |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `playwright.yml` | pull request, manual                         | lint + types + format, API suite, UI matrix (chromium/firefox/webkit) |
| `smoke.yml`      | push to main/develop, manual per environment | `@smoke` on chromium                                                  |
| `regression.yml` | nightly schedule, manual                     | API regression + sharded UI matrix incl. mobile/tablet                |

Each job installs browsers, injects credentials from repository secrets, and uploads the Extent
report, JUnit XML, screenshots, videos and traces as artifacts.

---

## Extending the framework

**Add a Page Object**

1. `src/pages/<Screen>Page.ts`, extending `BasePage`.
2. Declare `path` and `rootIndicator`, add `readonly` locators, compose components.
3. Add business methods (`createX`, `expectX`) — never expose locator logic to tests.
4. Register it in `src/fixtures/page.fixture.ts` and export it from `src/pages/index.ts`.

**Add an API service**

1. `src/api/services/<Domain>Api.ts`, extending `BaseApiService`.
2. Add routes to `src/constants/ApiConstants.ts` and models to `src/types/ApiModels.ts`.
3. Add a JSON Schema in `src/api/models/schemas.ts` for contract coverage.
4. Register the service in `src/fixtures/api.fixture.ts`.

**Add test data**

1. `test-data/common/<name>.json`; environment overrides under `test-data/<env>/`.
2. Add its type to `src/types/TestData.ts` and to `TestDataRegistry`.
3. Read it with `testData.get('<name>')`.

**Add a test**

Place it under the suite folder that matches its purpose, tag it, and use `test.step` for each
business step. Keep functional values in JSON and credentials in roles.

**Future extension points** (deliberately not implemented, so no unused dependency ships):
database validation, Kafka/Redis checks, GraphQL and WebSocket clients, accessibility scanning
(`@axe-core/playwright` plugs into the existing accessible locators), cloud browser grids, Docker,
test-management/Jira/Zephyr sync, Slack/Teams notifications from the reporter's `onEnd`.

---

## Coding standards

1. No hard-coded URLs, credentials or functional data in tests.
2. JSON is the source of functional test data.
3. No arbitrary sleeps — Playwright auto-waiting and web-first assertions only.
4. No duplicated browser actions (they belong in `BasePage`) or HTTP plumbing (it belongs in `ApiClient`).
5. No XPath; follow the locator priority.
6. Page Objects and utilities stay small and single-purpose.
7. No business logic in configuration.
8. Tests are independent, parallel-safe, and clean up what they create.
9. Strong typing everywhere; `any` is a lint error.
10. Nothing sensitive reaches a log, report or artifact.

```bash
npm run lint && npm run typecheck && npm run format:check
npm run verify        # the full gate: types, lint, format, API suite, UI smoke
```

---

## Troubleshooting

| Symptom                                      | Cause and fix                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Target environment is not reachable`        | The app or VPN is down, or `TEST_ENV`/`UI_BASE_URL` is wrong. The message prints the URL that was probed. |
| `Credentials for role "X" are unavailable`   | Missing env vars for that role. Copy `.env.example` to `.env`, or add CI secrets.                         |
| `Stored session is unavailable`              | Delete `storage/auth/` and re-run; global setup regenerates it.                                           |
| Port 4321 already in use                     | Another sandbox instance is running: `lsof -ti:4321 \| xargs kill`, or set `DEMO_APP_PORT`.               |
| Visual test fails after an intended redesign | `npm run test:visual:update`, then review the new baselines in the PR.                                    |
| `--project=edge` fails                       | Microsoft Edge is not installed on that machine; it is opt-in by design.                                  |
| A test passes alone and fails in parallel    | It depends on shared state. Generate unique data, and assert what the test owns.                          |
| Report is missing after a run                | A CLI `--reporter=` overrides the configured reporters; run without it.                                   |

---

Licensed for internal use. Contributions follow `docs/CONTRIBUTING.md`.
