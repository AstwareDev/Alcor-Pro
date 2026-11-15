// Read-only check of a running, pre-existing Windows debug build with WebView2 CDP enabled.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9223');
const pages=browser.contexts().flatMap(c=>c.pages());
console.log('PAGES',pages.map(p=>p.url()));
const page=pages.find(p=>p.url().includes('1420'))??pages[0];
await page.locator('body').waitFor();
await page.locator('.alcor-brand').first().waitFor();
console.log('NATIVE BRAND',await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {green:s.getPropertyValue('--brand-green').trim(),accent:s.getPropertyValue('--accent-primary').trim()};}));
// The person may have navigated since the initial Home search smoke check.
// Inspect branding without navigating, changing appearance, or touching their project.
const brand=await page.locator('.alcor-brand').first().getAttribute('aria-label');
if(brand!=='Alcor')throw new Error('Native Alcor branding is missing');
console.log('Native Alcor branding verified. Current view and saved preferences were left unchanged.');
await page.screenshot({path:path.join(path.dirname(fileURLToPath(import.meta.url)),'native-app-screenshot.png')});
// Disconnect the automation transport; leave the person's desktop app open.
process.exit(0);
