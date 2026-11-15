// Read-only check of a running, pre-existing Windows debug build with WebView2 CDP enabled.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9223');
const pages=browser.contexts().flatMap(c=>c.pages());
console.log('PAGES',pages.map(p=>p.url()));
const page=pages.find(p=>p.url().includes('1420'))??pages[0];
await page.locator('body').waitFor();
await page.getByRole('button',{name:'Search projects',exact:true}).click();
const search=page.locator('input').first();
await search.fill('Untitled');
await page.getByText('Untitled Project',{exact:true}).waitFor();
await search.fill('');
await page.keyboard.press('Escape');
console.log('Native home search interaction succeeded. No project opened or modified.');
await page.screenshot({path:path.join(path.dirname(fileURLToPath(import.meta.url)),'native-app-screenshot.png')});
// Disconnect the automation transport; leave the person's desktop app open.
process.exit(0);
