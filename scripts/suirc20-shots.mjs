import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
const URL = process.env.SHOT_URL || 'http://127.0.0.1:4173/';
const OUT = '/workspace/suicommunityx-github-io/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const notes = [];

async function shot(width, height, name) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(URL + '#/suimint', { waitUntil: 'networkidle', timeout: 120000 });
  try {
    await page.waitForSelector('table.table tbody tr, .banner.ok', { timeout: 90000 });
  } catch {}
  await page.waitForTimeout(1500);

  const topNav = page.locator('nav.tabbar-top button.tab-btn');
  const topLabels = await topNav.allTextContents();
  notes.push(`${name} topNav=${JSON.stringify(topLabels.map((s) => s.trim()))}`);
  const topBox = await page.locator('nav.tabbar-top .tabbar-inner').boundingBox();
  if (topBox) {
    const scrollW = await page.locator('nav.tabbar-top .tabbar-inner').evaluate((el) => el.scrollWidth);
    const clientW = await page.locator('nav.tabbar-top .tabbar-inner').evaluate((el) => el.clientWidth);
    notes.push(`${name} topNav scrollW=${scrollW} clientW=${clientW} overflow=${scrollW > clientW + 1}`);
  }

  await page.screenshot({ path: `${OUT}/${name}-suimint-home.png`, fullPage: true });

  const holdersBtn = page.getByRole('button', { name: '持有者', exact: true });
  if (await holdersBtn.count()) {
    await holdersBtn.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${name}-suimint-holders.png`, fullPage: true });
  }

  const ms = page.getByRole('button', { name: 'Movescriptions', exact: true });
  if (await ms.count()) {
    await ms.click();
    await page.waitForTimeout(2000);
    const sub = await page.locator('nav.tabbar-sub button.tab-btn').allTextContents();
    notes.push(`${name} movesSub=${JSON.stringify(sub.map((s) => s.trim()))}`);
    await page.screenshot({ path: `${OUT}/${name}-moves-ticks.png`, fullPage: true });
  }

  // hash route: #/holders/DGEN should open Movescriptions > holders
  await page.goto(URL + '#/holders/DGEN', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(2000);
  const sectionMoves = await page.locator('nav.tabbar-top button.tab-btn.active').textContent();
  const subActive = await page.locator('nav.tabbar-sub button.tab-btn.active').textContent().catch(() => null);
  notes.push(`${name} hash#/holders/DGEN topActive=${(sectionMoves || '').trim()} subActive=${(subActive || '').trim()}`);
  await page.screenshot({ path: `${OUT}/${name}-hash-holders-DGEN.png`, fullPage: true });

  await page.close();
  console.log('saved', name);
}

await shot(390, 844, 'live-mobile-390');
await shot(1440, 900, 'live-desktop-1440');
await browser.close();
writeFileSync(`${OUT}/nav-verify.txt`, notes.join('\n') + '\n');
console.log(notes.join('\n'));
console.log('done');
