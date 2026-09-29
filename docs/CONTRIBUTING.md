# Contributing

## Before you start

```bash
npm ci
npx playwright install
npm test          # confirm a green baseline on your machine
```

## The loop

1. **Branch** — `feature/<module>-<what>`, `fix/<what>`.
2. **Write the test first** if you are adding coverage; write the Page Object/service it needs.
3. **Keep the layers** — see `docs/ARCHITECTURE.md` §2. If a test needs a locator, the Page Object
   is missing a method.
4. **Data goes to JSON** — `test-data/common/<name>.json`, typed in `src/types/TestData.ts`.
5. **Run the gate**:

   ```bash
   npm run verify        # types + lint + format + API suite + UI smoke
   ```

6. **Open the PR** with the Extent summary line from the run, and say which suites you executed.

## Definition of done

- [ ] Test is tagged (`@smoke`/`@regression`/…) and named as a business behaviour
- [ ] No hard-coded URL, credential or functional value in the spec
- [ ] `test.step` used for each business step
- [ ] New browser action added to `BasePage`, not to a page (if it is generic)
- [ ] New endpoint added to a service, not called directly from a test
- [ ] New assertion helper named `expectX`/`assertX` **and** registered in `eslint.config.js`
- [ ] Created records are tracked with the `cleanup` fixture
- [ ] Test passes with `--repeat-each=3 --workers=4` (parallel safety)
- [ ] `npm run verify` is green
- [ ] No secret in code, log, report or fixture data

## Review checklist for the reviewer

| Question                                      | Where it usually goes wrong                                   |
| --------------------------------------------- | ------------------------------------------------------------- |
| Would this test fail for a real defect only?  | Assertions on shared/global state                             |
| Would a failure be diagnosable from CI alone? | Missing `test.step`, generic assertion messages               |
| Is the data unique per worker?                | Reusing a fixed email or name                                 |
| Is cleanup guaranteed on failure?             | Deleting at the end of the test body instead of via `cleanup` |
| Is the abstraction in the right layer?        | A locator in a spec, a `fetch` in a service test              |
| Could this leak a secret?                     | Logging a request body or a header bag by hand                |

## Commit style

```
feat(employee): add UI regression for department filtering
fix(api-client): send raw bodies as bytes so malformed payloads stay malformed
chore(ci): shard the nightly UI matrix
docs(readme): document the role-based auth flow
```

## Flaky tests

A flake is a defect in the test until proven otherwise. Do not raise `retries` to make a suite
green. Reproduce with:

```bash
npx playwright test <spec> --repeat-each=5 --workers=4
```

Then fix the cause: shared state, a missing wait on a business event, or an assertion on data
another worker can change.
