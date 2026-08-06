// UI audit harness: plays a real game and screenshots EVERY screen, host and phone,
// at realistic viewports. Not a pass/fail test — it exists so UI changes can be judged
// against actual rendered output rather than guessed at.
//
// Run: node test/uishots.mjs [--prod]   (server on :8787 must be running)
// Writes test/out/ui/*.png

import { chromium } from '../scraper/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8787';
const PROD = process.argv.includes('--prod');
const Q = PROD ? '' : '?emu=1';
const HANDLES = ['zachking', 'tiktok'];
const OUT = 'test/out/ui';
mkdirSync(OUT, { recursive: true });

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1280, height: 800 };

const log = (...a) => console.log(...a);
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log('  shot: ' + name);
};
const txt = (p, s) => p.locator(s).innerText().catch(() => '');
const vis = (p, s) => p.locator(s).isVisible().catch(() => false);

const browser = await chromium.launch({ headless: true });

const hostCtx = await browser.newContext({ viewport: DESK });
const host = await hostCtx.newPage();
await host.goto(`${BASE}/host.html${Q}`, { waitUntil: 'domcontentloaded' });
await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('room-code')?.textContent || ''), { timeout: 30000 });
const code = await txt(host, '#room-code');
log('room ' + code);
await host.fill('#round-count', '2');
await shot(host, 'host-1-lobby-empty');

// landing page, both sizes
const land = await (await browser.newContext({ viewport: PHONE })).newPage();
await land.goto(`${BASE}/index.html${Q}`, { waitUntil: 'domcontentloaded' });
await shot(land, 'phone-0-landing');

const players = [];
for (let i = 0; i < 2; i++) {
  const ctx = await browser.newContext({ viewport: PHONE });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/play.html${Q}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#btn-join:not([disabled])', { timeout: 30000 });
  if (i === 0) await shot(p, 'phone-1-join-empty');
  await p.fill('#f-name', `Player${i + 1}`);
  await p.fill('#f-code', code);
  await p.fill('#f-handle', HANDLES[i]);
  if (i === 0) await shot(p, 'phone-2-join-filled');
  await p.click('#btn-join');
  await p.waitForSelector('#view-lobby:not(.hidden)', { timeout: 30000 });
  if (i === 0) await shot(p, 'phone-3-lobby');
  players.push(p);
}

await host.waitForFunction(() => document.getElementById('player-count')?.textContent === '2', { timeout: 20000 });
await shot(host, 'host-2-lobby-players');

await host.click('#btn-start');
await host.waitForSelector('#view-loading:not(.hidden)', { timeout: 15000 });
await host.waitForTimeout(2500);
await shot(host, 'host-3-loading');

await host.waitForSelector('#view-playing:not(.hidden)', { timeout: 200000 });
await host.waitForTimeout(6000);
await shot(host, 'host-4-playing');

for (const [i, p] of players.entries()) {
  await p.waitForTimeout(500);
  await shot(p, `phone-4-playing-p${i + 1}${(await vis(p, '#sit-out')) ? '-sitout' : ''}`);
}

// vote from whoever is not the owner
for (const p of players) {
  if (await vis(p, '#sit-out')) continue;
  await p.locator('.vote-btn:not([disabled])').first().click().catch(() => {});
}
await host.waitForTimeout(1200);
for (const [i, p] of players.entries()) {
  if (await vis(p, '#sit-out')) continue;
  await shot(p, `phone-5-voted-p${i + 1}`);
}

await host.waitForSelector('#view-reveal:not(.hidden)', { timeout: 60000 });
await shot(host, 'host-5-reveal');
for (const [i, p] of players.entries()) await shot(p, `phone-6-reveal-p${i + 1}`);

await host.click('#btn-next');
await host.waitForSelector('#view-playing:not(.hidden)', { timeout: 30000 });
// No timer any more: nobody votes this round, so the host has to force the reveal.
await host.click('#btn-reveal');
await host.waitForSelector('#view-reveal:not(.hidden)', { timeout: 30000 });
await host.click('#btn-next');
await host.waitForSelector('#view-finished:not(.hidden)', { timeout: 30000 });
await shot(host, 'host-6-finished');
for (const [i, p] of players.entries()) {
  await p.waitForSelector('#view-finished:not(.hidden)', { timeout: 20000 }).catch(() => {});
  await shot(p, `phone-7-finished-p${i + 1}`);
}

// landscape phone, the awkward case
await players[0].setViewportSize({ width: 844, height: 390 });
await shot(players[0], 'phone-8-landscape');

// horizontal-overflow check on every phone screen
const overflow = await players[0].evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}));
log('  landscape overflow check: ' + JSON.stringify(overflow));

await browser.close();
log('\ndone -> ' + OUT);
