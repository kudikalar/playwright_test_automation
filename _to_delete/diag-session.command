#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin"
node --input-type=module - <<'JS' 2>&1 | tee diag-session.log
import { chromium } from '@playwright/test';
const b = await chromium.launch(); const p = await b.newPage();
await p.goto('https://stage-vhc-healthcare.vercel.app/login');
await p.getByLabel(/email/i).fill('customer@vhc.test');
await p.getByPlaceholder('Enter your password').fill('VisionDemo#2026');
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForURL(/dashboard/, { timeout: 30000 });
console.log('URL:', p.url());
console.log('localStorage:', await p.evaluate(() => Object.keys(localStorage).map(k => [k, String(localStorage.getItem(k)).slice(0, 60)])));
console.log('sessionStorage:', await p.evaluate(() => Object.keys(sessionStorage)));
console.log('cookies:', (await p.context().cookies()).map(c => `${c.name} (httpOnly=${c.httpOnly})`));
await b.close();
JS
echo "DIAG DONE"
