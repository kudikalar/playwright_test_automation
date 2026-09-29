# Upload fixtures

Files used by upload tests are generated at runtime by `createUploadFixture()` in
`src/utils/FileUtils.ts`, so no binary needs to be committed. Commit a file here only when a test
needs a specific real-world document (a signed PDF, a malformed CSV) that cannot be generated.
