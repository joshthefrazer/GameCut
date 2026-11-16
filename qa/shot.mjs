import { _electron as electron } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const ROOT='/tmp/claude-0/scratch/gc/GameCut', OUT=ROOT+'/qa/out';
const SRC=OUT+'/shot-src.mp4';
const name = process.argv[2] || 'ui-editor';
execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','20','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',SRC]);
const P='/tmp/gc-shot-'+process.pid; await rm(P,{recursive:true,force:true});
const app=await electron.launch({args:['.','--no-sandbox','--disable-gpu','--user-data-dir='+P],cwd:ROOT,timeout:60000});
const win=await app.firstWindow(); await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]; w.setSize(1600,960); w.center();});
const errs=[]; win.on('pageerror',e=>errs.push(e.message)); win.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await win.waitForLoadState('domcontentloaded'); await sleep(2000);
await win.click('#homeNew'); await sleep(1000);
await win.setInputFiles('#filePicker',[SRC,SRC]);
for(let i=0;i<80;i++){ if(await win.evaluate(()=>window.gc.store.doc.tracks.flatMap(t=>t.clips).filter(c=>c.type==='video').length>=1)) break; await sleep(300);}
await sleep(2500);
await win.evaluate(()=>{const {cmds,store}=window.gc; cmds.splitAt(6,[]); cmds.splitAt(12,[]); const t=cmds.addTextClip(2,null); t.text.text='CLUTCH 1v4'; const t2=cmds.addTextClip(8,null); t2.text.text='GG'; store.docChanged('x'); window.gc.playback.seek(3);});
await sleep(1200);
if (process.argv[3]) { const fn = (await import(process.argv[3])).default; await fn(win, app); }
await win.screenshot({path:OUT+'/'+name+'.png'});
console.log('errors:', JSON.stringify(errs.slice(0,8)));
await app.close();
