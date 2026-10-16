#!/bin/bash
# One-shot runner: installs deps if needed, then runs the demoshop sample tests
# against https://stage-vhc-healthcare.vercel.app and logs everything to sample-run.log
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin"
LOG="sample-run.log"
{
  echo "=== $(date) ==="
  echo "node: $(node -v 2>&1)   npm: $(npm -v 2>&1)"
  echo "target: $(grep -m1 baseUrl config/environments/demoshop.json)"
  if [ ! -d node_modules ]; then echo "--- npm ci ---"; npm ci --no-audit --no-fund; fi
  echo "--- ensure chromium ---"; npx playwright install chromium 2>&1 | tail -2
  echo "--- TEST 1: demoshop register smoke (project=demoshop) ---"
  npx cross-env TEST_ENV=demoshop npx playwright test --project=demoshop --reporter=list
  echo "EXIT_CODE_1=$?"
  echo "--- TEST 2: login + forgot-password smoke (project=chromium, TEST_ENV=demoshop) ---"
  npx cross-env TEST_ENV=demoshop npx playwright test --project=chromium tests/ui/smoke --reporter=list
  echo "EXIT_CODE_2=$?"
  echo "=== DONE $(date) ==="
} 2>&1 | tee "$LOG"
echo; echo "Finished. Log saved to $PWD/$LOG — you can close this window."
