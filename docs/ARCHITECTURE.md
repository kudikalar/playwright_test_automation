# Architecture

This document explains _why_ the framework is shaped the way it is. The README explains how to
use it; this one is for the engineer who has to change it.

---

## 1. Design goals

| Goal                                    | Consequence in the code                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Support 10,000+ tests without a rewrite | Nothing test-specific lives in the core; new modules are additive            |
| Support many teams                      | Layer boundaries are enforceable by lint and review, not by convention alone |
| Support many environments               | Every value the target depends on is data (`config/environments/*.json`)     |
| Fail with information, not mystery      | Every framework error carries operation, target, page, URL, environment      |
| Be honest about results                 | Retries are bounded and reported; flaky is a distinct outcome from passed    |
| Leak no secrets                         | One masking layer sits in front of every log, report and attachment          |

---

## 2. Layer contract

```
 tests            business language + assertions
   ↓ may call
 fixtures         wiring only: construct, inject, tear down
   ↓ provide
 pages/services   workflows and endpoints
   ↓ built on
 components/client reusable regions and HTTP plumbing
   ↓ built on
 BasePage / APIRequestContext
   ↓ configured by
 configuration    values, never behaviour
```

A layer may use the layer below it and must not reach two layers down for convenience.
Concretely:

- A test never constructs a `Locator`, never calls `page.goto`, never calls `request.fetch`.
- A Page Object never reads `process.env` and never hard-codes a URL: it asks `this.environment`.
- A service never asserts; it returns a typed `ApiResponse<T>` and the test decides.
- Configuration never imports a page, a service or a test.

---

## 3. Why these particular abstractions

**`BasePage` is large on purpose.** Browser interaction vocabulary is finite and shared; if it is
not centralised, each team reinvents `clickAndWaitForNavigation` slightly differently and the
differences become flakiness. Business logic never enters it — it knows nothing about employees.

**Components exist because pages repeat regions, not screens.** A table appears on twenty screens.
Modelling it once as `TableComponent`, scoped to a root `Locator`, means a markup change is a
one-file change. Pages _compose_ components; they do not inherit from them.

**Fixtures are chained rather than merged.** `mergeTests` cannot express a dependency from one
file's fixture to another file's fixture. Chaining (`base → page → api → auth`) keeps each layer in
its own file _and_ lets `cleanup` depend on `adminEmployeeApi`, which depends on `apiRequestContext`.

**`ApiClient` is the only thing that speaks HTTP.** Retry policy, masking, timeouts and envelope
parsing exist once. When the API adds a header or a correlation id, one file changes.

**Validators are fluent and return `this`.** An API test reads as a specification
(`hasStatus().isSuccessful().matchesSchema()`), and every failure message names the endpoint and
prints the payload, so a CI log is usually enough to diagnose.

---

## 4. Data lifecycle

```
JSON template          test-data/common/employees.json
      ↓
factory                buildEmployee()  → unique name/email/date per worker
      ↓
setup                  adminEmployeeApi.createOrThrow()   (fast, reliable)
      ↓
test                   UI or API exercise
      ↓
validation             UI assertions + API read-back
      ↓
cleanup                cleanup.employee(id) → deleted in fixture teardown, even on failure
```

Uniqueness is worker-aware (`TEST_PARALLEL_INDEX` + timestamp + random), and every generated value
carries the `pwauto` prefix so a stray record is identifiable in a shared environment.

**Parallel safety rule:** assert what the test _owns_. A global count, "the newest row", or "the
first page" are shared state and will flake the moment a second worker runs.

---

## 5. Authentication model

```
global-setup ──► LoginPage (real UI sign-in, once per role)
                     │
                     ▼
        storage/auth/<env>.<role>.v1.json     (git-ignored, 45-minute reuse window)
                     │
   test.use({ role }) ──► browser.newContext({ storageState }) ──► authenticatedPage
```

The UI login path is used to create the state deliberately: a session produced any other way can
drift from how the application actually issues one. Dedicated login specs still test the form
itself. Teardown deletes the files so tokens do not linger on an agent.

---

## 6. Reporting pipeline

```
Playwright reporter events
        │  onTestEnd: normalise (suite, module, tags, project, status, steps, artifacts)
        ▼
   ExtentReportModel  ──► DataMasker ──► ExtentHtml.render ──► reports/extent/run-<stamp>/index.html
                                                        └────► reports/extent/latest.html
```

Suite and module are derived from the spec's path and annotations, so grouping requires no
bookkeeping in tests. Retries become the `FLAKY` status rather than being hidden. Artifacts are
copied next to the report so the folder is self-contained and can be zipped for a stakeholder.

---

## 7. Failure diagnostics

Every failure should answer: what was attempted, on what, where, in which environment, and what
the system actually did.

```
UiActionError: UI action "click" failed
  operation: click
  target: getByRole('button', { name: 'Save employee' })
  page: EmployeePage
  url: https://qa.workforce.example.com/employees
  environment: qa
  timeout: 20000
  cause: locator.click: Timeout 20000ms exceeded.
```

Plus, from Playwright: screenshot, video and trace — retained on failure only, so a green run
stays cheap.

---

## 8. Extension points

| Extension                              | Where it plugs in                                            | Why it is not implemented yet    |
| -------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| Accessibility (axe)                    | a fixture that wraps `page`; locators are already role-based | avoids an unused dependency      |
| Database / Kafka / Redis validation    | a new `src/integrations/<system>` client + fixture           | environment-specific             |
| GraphQL / WebSocket                    | siblings of `ApiClient` under `src/api/clients`              | not part of the current contract |
| Cloud grids (Selenium/Playwright grid) | `connectOptions` in a project's `use`                        | infrastructure choice            |
| Slack/Teams notification               | `ExtentReporter.onEnd` already has the summary               | needs a webhook secret           |
| Jira/Zephyr sync                       | a second reporter reading `reports/extent/latest.json`       | tool-specific                    |

Each is additive: none requires changing the layers above.

---

## 9. Trade-offs consciously accepted

- **A bundled reference application.** It makes the framework verifiable offline and gives every
  capability a real target. It is disabled automatically when an environment points elsewhere.
- **Explicit assertion vocabulary in ESLint.** `expect-expect` matches the final identifier of a
  call, so page-object assertion methods are listed in `eslint.config.js`. The cost is one line
  per new helper; the benefit is that a test with no assertion cannot merge.
- **Chained fixtures over merged fixtures.** Slightly stricter file ordering, in exchange for real
  cross-layer dependencies.
- **Session reuse capped at 45 minutes.** Some redundant logins, in exchange for never debugging a
  stale-token failure.
