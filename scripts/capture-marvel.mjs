import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'public', 'demo-shots');
const capture = JSON.parse(readFileSync(join(outDir, 'capture.json'), 'utf8'));

function normalizeUrl(raw) {
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.href;
  } catch {
    return String(raw || '').split('#')[0];
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
const page = await context.newPage();

const start = 'https://www.marvel.com/';
await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
const homeTitle = await page.title();
const startId = normalizeUrl(page.url());
await page.screenshot({ path: join(outDir, 'marvel-0.jpg'), type: 'jpeg', quality: 62 });

const targets = [
  { text: 'Comics', href: 'https://www.marvel.com/comics' },
  { text: 'Characters', href: 'https://www.marvel.com/characters' },
  { text: 'Movies', href: 'https://www.marvel.com/movies' },
];

const graphNodes = [{ id: startId, url: startId, title: homeTitle, isStart: true }];
const edges = [];
const pages = [{ url: page.url(), title: homeTitle }];
const shots = [{
  src: '/demo-shots/marvel-0.jpg',
  caption: `Landed on “${homeTitle}”`,
  viewport: 'desktop',
}];
const actions = [
  { at: new Date().toISOString(), message: 'Opening https://www.marvel.com/', url: start, viewport: 'desktop' },
  {
    at: new Date().toISOString(),
    message: `Landed on “${homeTitle}”`,
    url: page.url(),
    viewport: 'desktop',
    shot: '/demo-shots/marvel-0.jpg',
  },
];

let i = 0;
for (const pick of targets) {
  try {
    actions.push({
      at: new Date().toISOString(),
      message: `Clicking “${pick.text}”`,
      url: start,
      viewport: 'desktop',
    });
    await page.goto(pick.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const title = await page.title();
    const url = page.url();
    const id = normalizeUrl(url);
    if (!graphNodes.some((node) => node.id === id)) {
      graphNodes.push({ id, url: id, title, isStart: false });
    }
    edges.push({ from: startId, to: id, label: pick.text });
    pages.push({ url, title });
    i += 1;
    const shotSrc = `/demo-shots/marvel-${i}.jpg`;
    await page.screenshot({ path: join(outDir, `marvel-${i}.jpg`), type: 'jpeg', quality: 62 });
    shots.push({
      src: shotSrc,
      caption: `Opened “${title || pick.text}”`,
      viewport: 'desktop',
    });
    actions.push({
      at: new Date().toISOString(),
      message: `Opened “${title || url}”`,
      url,
      viewport: 'desktop',
      shot: shotSrc,
    });
    console.log('marvel', pick.text, title);
  } catch (err) {
    console.error('fail', pick.href, err instanceof Error ? err.message : err);
  }
}

const marvel = {
  id: 'demo-marvel',
  url: 'https://www.marvel.com/',
  homeTitle,
  homeUrl: start,
  pages,
  graph: { nodes: graphNodes, edges },
  shots,
  actions,
  clicks: edges.length,
};

const idx = capture.findIndex((item) => item.id === 'demo-marvel');
if (idx >= 0) capture[idx] = marvel;
else capture.push(marvel);
writeFileSync(join(outDir, 'capture.json'), JSON.stringify(capture, null, 2));
await browser.close();
console.log('marvel nodes', graphNodes.length, 'shots', shots.length);
