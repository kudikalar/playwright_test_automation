#!/bin/bash
# Runs the login + forgot-password smoke specs against the demoshop environment
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin"
LOG="smoke-run.log"
{
  echo "=== $(date) ==="
  echo "target: $(grep -m1 baseUrl config/environments/demoshop.json)"
  npx cross-env TEST_ENV=demoshop npx playwright test --project=chromium tests/ui/smoke --reporter=list
  echo "EXIT_CODE=$?"
  echo "=== DONE $(date) ==="
} 2>&1 | tee "$LOG"
echo; echo "Finished. Log saved to $PWD/$LOG — you can close this window."
