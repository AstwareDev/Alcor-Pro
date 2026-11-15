// Render the editable HTML cover to standard and 2x-resolution PNG files.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const out=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true});
for(const scale of [1,2]){
  const page=await browser.newPage({viewport:{width:1952,height:1112},deviceScaleFactor:scale});
  await page.goto(pathToFileURL(path.join(out,'cover.html')).href,{waitUntil:'load'});
  await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode())));
  await page.locator('.cover').screenshot({path:path.join(out,scale===1?'alcor-pro-cover.png':'alcor-pro-cover@2x.png')});
  console.log(scale===1?'alcor-pro-cover.png — 1920 × 1080':'alcor-pro-cover@2x.png — 3840 × 2160');
  await page.close();
}
await browser.close();
