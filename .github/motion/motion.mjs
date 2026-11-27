// Records every animation/transition the landing page (docs/index.html) runs in a real Chrome window.
// Fails if Windows shows no motion (its Animation effects switch must not stop the page) or if a Mac with
// Reduce Motion still animates. motion-out/<label>/motion.json can be diffed between runs.
// Usage: node motion.mjs <label> [extra chrome flags]
import puppeteer from "puppeteer-core";
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [label, ...flags] = process.argv.slice(2);
const out = path.resolve('motion-out', label);
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ channel: 'chrome', headless: false, args: ['--window-size=1440,900', ...flags], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
await page.goto(pathToFileURL(path.resolve('docs/index.html')).href, { waitUntil: 'load' });

const collect = () => page.evaluate(() => {
  const id = (el) => { let s = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).sort().join('.') : ''); const p = el.parentElement; return (p && p !== document.body ? id(p) + ' > ' : '') + s + ':' + [...(p?.children || [])].indexOf(el); };
  return document.getAnimations().map((a) => {
    const t = a.effect.getTiming(), el = a.effect.target, pseudo = a.effect.pseudoElement || '';
    return { key: id(el) + pseudo + ' | ' + (a.animationName || a.transitionProperty), kind: a.constructor.name, duration: t.duration, delay: t.delay, easing: t.easing, iterations: t.iterations, direction: t.direction, fill: t.fill, playState: a.playState };
  });
});

const env = await page.evaluate(() => ({ ua: navigator.userAgent, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches, win: document.documentElement.classList.contains('win') }));
const seen = new Map(), running = new Set();
const add = (list) => list.forEach((a) => { const { playState, ...sig } = a; seen.set(a.key, sig); if (playState === 'running') running.add(a.key); });

for (const t of [300, 1500, 3000]) { await new Promise((r) => setTimeout(r, t === 300 ? 300 : t - (t === 1500 ? 300 : 1500))); add(await collect()); await page.screenshot({ path: path.join(out, `top-${t}ms.png`) }); }
const height = await page.evaluate(() => document.body.scrollHeight);
for (let y = 0, i = 0; y < height; y += 450, i++) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await new Promise((r) => setTimeout(r, 700));
  add(await collect());
  if (i % 2 === 0) await page.screenshot({ path: path.join(out, `scroll-${String(i).padStart(2, '0')}.png`) });
}
const finals = await page.evaluate(() => [...document.querySelectorAll('.reveal, .rise, .ln')].map((el) => { const s = getComputedStyle(el); return { cls: el.className, opacity: s.opacity, transform: s.transform }; }));
const res = { label, env, animations: [...seen.values()].sort((a, b) => a.key.localeCompare(b.key)), running: [...running].sort(), finals };
fs.writeFileSync(path.join(out, 'motion.json'), JSON.stringify(res, null, 1));
console.log(label, JSON.stringify(env), 'animations:', res.animations.length, 'ever running:', res.running.length);
await browser.close();
if (env.win && res.running.length === 0) { console.error('FAIL: no animation runs on Windows'); process.exit(1); }
if (!env.win && env.reduce && res.animations.length > 0) { console.error('FAIL: animations run with Reduce Motion on a Mac'); process.exit(1); }
