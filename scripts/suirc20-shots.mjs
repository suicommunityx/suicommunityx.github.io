import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const URL = process.env.SHOT_URL || 'http://127.0.0.1:4173/';
const OUT = '/workspace/suicommunityx-github-io/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function shot(width, height, name) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 120000 });
  try {
    await page.waitForSelector('table.table tbody tr, .banner.ok', { timeout: 90000 });
  } catch {}
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/${name}-suimint-home.png`, fullPage: true });
  // holders subtab
  const holdersBtn = page.getByRole('button', { name: '持有者', exact: true });
  if (await holdersBtn.count()) {
    await holdersBtn.first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/${name}-suimint-holders.png`, fullPage: true });
  }
  // movescriptions tab
  const ms = page.getByRole('button', { name: 'Movescriptions', exact: true });
  if (await ms.count()) {
    await ms.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${name}-moves-ticks.png`, fullPage: true });
  }
  await page.close();
  console.log('saved', name);
}
await shot(390, 844, 'live-mobile-390');
await shot(1440, 900, 'live-desktop-1440');
await browser.close();
console.log('done');
