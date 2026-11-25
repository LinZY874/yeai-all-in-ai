#!/usr/bin/env node
/*
 * Renders the YeAI showcase to a vertical 1080×1920, 60 fps MP4 with its soundtrack.
 *
 * The page runs in "capture" mode (index.html?capture=1): a scripted shot list drives the
 * pointer, every frame is stepped by exactly 1/60 s, and the Web Audio graph is rendered
 * offline in sync with the simulation — so the result is frame-exact, not a screen recording.
 *
 *   node tools/render-video.mjs                       # full render → ./YeAI-showcase-1080x1920-60fps.mp4
 *   node tools/render-video.mjs --stills=2,5.5,10     # quick review: PNG stills at those seconds
 *   node tools/render-video.mjs --tmp=/some/dir --out=/path/file.mp4
 *
 * Needs: Node ≥ 18, ffmpeg (libx264), puppeteer (global is fine), a Chromium browser.
 */
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || '1']; }));
const DUR = +(args.dur || 29.5);
const FPS = 60;
const FRAMES = Math.round(DUR * FPS);
const OUT = path.resolve(args.out || path.join(root, 'YeAI-showcase-1080x1920-60fps.mp4'));
const TMP = path.resolve(args.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'yeai-')));
const STILLS = args.stills ? new Set(args.stills.split(',').map((s) => Math.max(0, Math.round(+s * FPS) - 1))) : null;
fs.mkdirSync(TMP, { recursive: true });

const BROWSERS = [
  args.browser,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter((p) => p && fs.existsSync(p));

const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require('puppeteer'); } catch {
  puppeteer = require(path.join(execSync('npm root -g').toString().trim(), 'puppeteer'));
}

// --- tiny static server for the project folder
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?capture=1&n=262144`;

const browser = await puppeteer.launch({
  executablePath: BROWSERS[0],
  headless: true,
  protocolTimeout: 900000,
  defaultViewport: { width: 540, height: 960, deviceScaleFactor: 2 },
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force-color-profile=srgb',
    '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(url, { waitUntil: 'load' });
const info = await page.evaluate((d) => window.__cap.prepare(d), DUR);
console.log('browser:', BROWSERS[0].split('/').pop(), '|', JSON.stringify(info));
if (!/metal|apple|gpu/i.test(info.renderer)) console.warn('⚠ renderer looks like a software fallback:', info.renderer);

const silent = path.join(TMP, 'video-silent.mp4');
let ff = null;
if (!STILLS) {
  ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(args.crf || 18), '-maxrate', args.maxrate || '30M', '-bufsize', '60M',
    '-tune', 'film', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '5.1',
    '-x264-params', 'keyint=60:min-keyint=30:aq-mode=3', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-r', String(FPS), silent],
  { stdio: ['pipe', 'inherit', 'inherit'] });
}

const t0 = Date.now();
for (let i = 0; i < FRAMES; i++) {
  await page.evaluate(() => window.__cap.frame());
  if (STILLS) {
    if (STILLS.has(i)) {
      const f = path.join(TMP, `still-${((i + 1) / FPS).toFixed(2)}s.png`);
      await page.screenshot({ path: f, type: 'png' });
      console.log('still', f);
    }
    continue;
  }
  const png = await page.screenshot({ type: 'png', optimizeForSpeed: true });
  if (!ff.stdin.write(png)) await once(ff.stdin, 'drain');
  if ((i + 1) % 60 === 0) {
    const el = (Date.now() - t0) / 1000, rate = (i + 1) / el;
    console.log(`frame ${i + 1}/${FRAMES}  ${rate.toFixed(1)} fps  eta ${((FRAMES - i - 1) / rate).toFixed(0)}s`);
  }
}

if (!STILLS || args.audio) {
  const a = await page.evaluate(() => window.__cap.audio());
  fs.writeFileSync(path.join(TMP, 'audio.wav'), Buffer.from(a.b64, 'base64'));
  console.log(`audio: ${a.seconds.toFixed(2)}s, raw peak ${a.peak.toFixed(3)}`);
}
await browser.close();
server.close();
if (STILLS) process.exit(0);

ff.stdin.end();
const [code] = await once(ff, 'close');
if (code !== 0) throw new Error('ffmpeg video encode failed');

// loudness: one linear gain to ~-14 LUFS (phone-friendly), then a peak limiter with headroom for AAC — no auto-levelling,
// so the big hits keep their dynamics
const wav = path.join(TMP, 'audio.wav');
const meas = execSync(`ffmpeg -hide_banner -nostats -i "${wav}" -af ebur128 -f null - 2>&1`).toString();
const I = parseFloat(meas.slice(meas.lastIndexOf('Integrated loudness')).match(/I:\s*(-?[\d.]+)/)[1]);
const gain = Math.max(-12, Math.min(14, -14 - I));
console.log(`audio loudness ${I.toFixed(1)} LUFS → gain ${gain.toFixed(1)} dB`);
execSync(`ffmpeg -hide_banner -loglevel error -y -i "${silent}" -i "${wav}" -map 0:v -map 1:a -c:v copy ` +
  `-af "volume=${gain.toFixed(2)}dB,alimiter=limit=0.75:attack=1:release=80:level=0,afade=t=out:st=${(DUR - 0.9).toFixed(2)}:d=0.9" ` +
  `-c:a aac -b:a 256k -ar 48000 -t ${DUR} -movflags +faststart "${OUT}"`);
console.log('done →', OUT, `(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
