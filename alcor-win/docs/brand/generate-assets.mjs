// Rebuild vector/PNG assets with tooling isolated outside the app's dependencies.
// Set PLAYWRIGHT_MODULE, OPENTYPE_MODULE, CHROMIUM_EXECUTABLE and LOGO_FONT.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const opentype=await import(process.env.OPENTYPE_MODULE);
const fontBytes=fs.readFileSync(process.env.LOGO_FONT);
const font=opentype.parse(fontBytes.buffer.slice(fontBytes.byteOffset,fontBytes.byteOffset+fontBytes.byteLength));
const base=fs.readFileSync(path.join(out,'alcor-mark.svg'),'utf8');
const mark=base.match(/<g fill="#0b0b0c">([\s\S]*?)<\/g>/)[1];
const white='#f5f7f2',black='#0b0b0c',green='#c6f432',greenInk='#3b5700';
fs.writeFileSync(path.join(out,'alcor-mark-light.svg'),base.replace(black,white));
fs.writeFileSync(path.join(out,'alcor-mark-green.svg'),base.replace(black,green));
// Text is converted to outlines, so the SVG wordmark has no font dependency.
const lettering=font.getPath('Alcor',258,181,164,{kerning:true}).toPathData(3);
for(const [name,color,symbol] of [['alcor-logo',black,greenInk],['alcor-logo-light',white,green]]){
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 256" role="img" aria-label="Alcor"><g fill="${color}"><g transform="translate(0 14) scale(.86)" fill="${symbol}">${mark}</g><path d="${lettering}"/></g></svg>`;
 fs.writeFileSync(path.join(out,name+'.svg'),svg);
}
const icon=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Alcor app icon"><rect x="0" y="0" width="256" height="256" rx="48" fill="${green}"/><g transform="translate(23 23) scale(.82)" fill="${black}">${mark}</g></svg>`;
fs.writeFileSync(path.join(out,'alcor-app-icon.svg'),icon);
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,headless:true});
for(const name of ['alcor-mark','alcor-mark-light','alcor-mark-green','alcor-app-icon','alcor-logo','alcor-logo-light']){
 const isLogo=name.includes('logo');const width=isLogo?2160:1024,height=isLogo?768:1024;
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 const source=fs.readFileSync(path.join(out,name+'.svg'),'utf8');
 await page.setContent(`<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent}svg{width:100%;height:100%;display:block}</style>${source}`);
 await page.screenshot({path:path.join(out,name+'.png'),omitBackground:true});
 await page.close();
}
const page=await browser.newPage({viewport:{width:1632,height:1132},deviceScaleFactor:1});
await page.goto(pathToFileURL(path.join(out,'preview.html')).href,{waitUntil:'load'});
await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode())));
await page.locator('.sheet').screenshot({path:path.join(out,'alcor-logo-preview.png')});
await browser.close();
console.log('Generated 6 SVGs, 6 transparent PNGs, and the 1600 × 1100 preview.');
