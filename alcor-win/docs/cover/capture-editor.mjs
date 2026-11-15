// Browser-only marketing capture. No native services, API calls, or saved project changes.
// Set PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE to installed playwright-core / Chromium paths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const out = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 900 }, deviceScaleFactor: 2 });
// Keep the fixture offline: optional ML models are not needed for this capture.
await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:1420/') ? route.continue() : route.abort());
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem('split.editor.default.h', JSON.stringify({media:330,inspector:280}));
  localStorage.setItem('split.editor.default.preset', JSON.stringify({timeline:345}));
});
await page.goto('http://127.0.0.1:1420/?dev=editor', { waitUntil:'networkidle' });
await page.locator('.editor').waitFor();
const result = await page.evaluate(async () => {
  const resources = performance.getEntriesByType('resource').map(e=>e.name);
  const solidUrl = resources.find(u=>/\/solid-js\.js\?/.test(u));
  const webUrl = resources.find(u=>/\/solid-js_web\.js\?/.test(u));
  const [{createComponent}, {render}, {Editor}, {EditorView}, {PreviewView}, {MediaPanelView}, {InspectorView}, {TimelinePane}, {PromptBar}, fixture, model] = await Promise.all([
    import(solidUrl), import(webUrl), import('/src/editor/editor.ts'), import('/src/editor/EditorView.tsx'),
    import('/src/preview/PreviewView.tsx'), import('/src/mediapanel/MediaPanelView.tsx'),
    import('/src/inspector/InspectorView.tsx'), import('/src/timeline/view/TimelinePane.tsx'),
    import('/src/promptbar/PromptBar.tsx'), import('/src/timeline/dev.tsx'), import('/src/model/index.ts'),
  ]);
  // Original procedural artwork: a quiet alpine lake at dusk, not a stock asset.
  function landscape(seed, variant=0) {
    const c=document.createElement('canvas'); c.width=1920; c.height=1080;
    const g=c.getContext('2d'); let state=seed;
    const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
    const sky=g.createLinearGradient(0,0,0,730);
    sky.addColorStop(0,'#132f40'); sky.addColorStop(.48,'#6c8585'); sky.addColorStop(.8,'#e2b185'); sky.addColorStop(1,'#d5a47f');
    g.fillStyle=sky;g.fillRect(0,0,1920,1080);
    const halo=g.createRadialGradient(1295,365,15,1295,365,390);halo.addColorStop(0,'#f3c79b66');halo.addColorStop(1,'#f3c79b00');
    g.fillStyle=halo;g.fillRect(600,0,1320,900);
    g.fillStyle='#f5dfb8';g.beginPath();g.arc(1295+variant*60,365,48,0,Math.PI*2);g.fill();
    const ridges=[];
    for(let layer=0;layer<5;layer++){
      const pts=[]; const y=505+layer*46;
      for(let x=-80;x<=2000;x+=32){const peak=Math.sin(x/(170+layer*40)+layer*1.5)*70+Math.sin(x/67+layer)*27+rand()*24;pts.push([x,y-peak]);}
      ridges.push(pts);g.beginPath();g.moveTo(-80,780);pts.forEach(p=>g.lineTo(...p));g.lineTo(2000,780);g.closePath();
      g.fillStyle=['#697c7b','#4d696b','#32565d','#203f47','#122e38'][layer];g.fill();
    }
    const water=g.createLinearGradient(0,705,0,1080);water.addColorStop(0,'#697e7a');water.addColorStop(.4,'#2c515b');water.addColorStop(1,'#102d3b');
    g.fillStyle=water;g.fillRect(0,705,1920,375);
    for(let i=0;i<2300;i++){const y=708+rand()*372,x=rand()*1920;g.globalAlpha=.035+rand()*.10;g.fillStyle=i%4===0?'#dfba95':'#c6d3c9';g.fillRect(x,y,2+rand()*(6+(y-705)/5),.6+rand()*1.1);}g.globalAlpha=1;
    for(let i=0;i<100;i++){const y=713+i*2.9;g.globalAlpha=.11*(1-i/105);g.fillStyle='#f8ce99';g.fillRect(1290-(y-705)*.25+rand()*16,y,4+(y-705)*.45,1.5);}g.globalAlpha=1;
    // A foreground shoreline anchors the composition.
    g.fillStyle='#0a242c';g.beginPath();g.moveTo(0,930);g.bezierCurveTo(210,890,310,1000,540,1015);g.bezierCurveTo(660,1025,800,1070,960,1080);g.lineTo(0,1080);g.closePath();g.fill();
    const vignette=g.createRadialGradient(960,520,250,960,520,1100);vignette.addColorStop(0,'#00000000');vignette.addColorStop(1,'#00000066');g.fillStyle=vignette;g.fillRect(0,0,1920,1080);
    const grain=g.getImageData(0,0,1920,1080);for(let i=0;i<grain.data.length;i+=4){const n=(rand()-.5)*8;grain.data[i]+=n;grain.data[i+1]+=n;grain.data[i+2]+=n;}g.putImageData(grain,0,0);
    return c;
  }
  const posters=[landscape(42),landscape(154,1),landscape(772,2)];
  const urls=posters.map(c=>c.toDataURL('image/png'));
  const doc=fixture.realisticDocument();
  const names={V1:'Lakeside — wide.png',V2:'Evening light.png',V3:'Mountain pass.png',A1:'Ambient score.wav',A2:'Lake atmosphere.wav',I1:'End card.png'};
  for(const asset of doc.mediaAssets){asset.name=names[asset.id]??asset.name;if(['V1','V2','V3','I1'].includes(asset.id)){asset.type='image';asset.url=urls[asset.id==='V2'?1:asset.id==='V3'?2:0];asset.hasAudio=false;}}
  const timeline=doc.timelines[0];timeline.name='Still in motion';
  timeline.tracks=timeline.tracks.slice(0,5);
  for(const track of timeline.tracks) for(const clip of track.clips){
    if(clip.mediaType==='video'){clip.mediaType='image';clip.sourceClipType='image';}
    if(clip.mediaType==='text'){clip.textContent='STILL IN MOTION';clip.textStyle=model.makeTextStyle({fontName:'Segoe UI',fontSize:92,tracking:15});clip.durationFrames=210;}
  }
  timeline.markers[0].name='Opening';timeline.markers[1].name='Light study';
  doc.mediaManifest.entries=doc.mediaAssets.map(a=>model.mediaAssetToManifestEntry(a,undefined));
  const editor=new Editor(doc);editor.ui.currentFrame=120;editor.ui.zoomScale=1.6;
  window.coverEditor=editor;
  const originalVisuals=fixture.fakeVisuals();
  const posterFor=asset=>posters[asset.id==='V2'?1:asset.id==='V3'?2:0];
  const visuals={...originalVisuals,imageTile:asset=>({image:posterFor(asset),aspect:16/9}),thumbnails:asset=>({images:[posterFor(asset)],startTime:0,spacing:90,aspect:16/9})};
  const thumbs={peek:()=>posters[0],load:async()=>posters[0],isLive:()=>true};
  const host=document.createElement('div');host.style.height='100%';
  const old=document.getElementById('root');old.hidden=true;document.body.append(host);
  render(()=>createComponent(EditorView,{
    title:'Still in motion · Alcor Pro',onExport:()=>{},panels:{
      media:()=>createComponent(MediaPanelView,{editor,thumbnailProvider:thumbs}),
      preview:()=>{const column=document.createElement('div');column.className='app-preview-column';render(()=>[createComponent(PreviewView,{editor,resolveUrl:id=>doc.mediaAssets.find(a=>a.id===id&&a.type==='image')?.url??null}),createComponent(PromptBar,{editor,onOpenSettings:()=>{}})],column);return column;},
      inspector:()=>createComponent(InspectorView,{editor}),timeline:()=>createComponent(TimelinePane,{editor,visuals})
    }
  }),host);
  return {artwork:urls[0],font:getComputedStyle(document.body).fontFamily};
});
fs.writeFileSync(path.join(out,'demo-landscape.png'),Buffer.from(result.artwork.split(',')[1],'base64'));
// Drive a real visible UI control and verify the inspector responds.
const guides=page.getByRole('button',{name:'Canvas Guides',exact:true});
await guides.click();
await page.getByRole('menu').waitFor();
await page.mouse.click(600,18);
await page.getByRole('menu').waitFor({state:'hidden'});
// A clip selection exercises the timeline -> inspector path without modifying document data.
await page.evaluate(()=>{window.coverEditor.ui.zoomScale=1.75;window.coverEditor.ui.timelineScrollOffsetX=0;window.coverEditor.ui.selectedClipIds=new Set([window.coverEditor.timeline.tracks[0].clips[0].id]);});
await page.getByText('STILL IN MOTION',{exact:true}).first().waitFor({timeout:10000}).catch(()=>{});
await page.screenshot({path:path.join(out,'editor-screenshot.png')});
await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
await page.screenshot({path:path.join(out,'editor-screenshot-light.png')});
const lightTheme=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return {background:s.getPropertyValue('--bg-surface').trim(),accent:s.getPropertyValue('--accent-primary').trim()};});
console.log('LIGHT THEME',lightTheme);
console.log(JSON.stringify({screenshot:'editor-screenshot.png',size:'3840 × 1800',font:result.font,errors,inspector:(await page.locator('body').innerText()).slice(-500)},null,2));
await browser.close();
if(errors.length)process.exitCode=1;
