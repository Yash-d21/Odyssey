import { chromium } from 'playwright';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = join(process.cwd(), 'public', 'demo-shots');
mkdirSync(outDir, { recursive: true });

const SKIP_TEXT = /log\s*out|sign\s*out|delete|remove|checkout|payment|subscribe|unsubscribe|download/i;
const SKIP_PATH = /\.(pdf|zip|rar|7z|gz|tgz|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|avi|mov|wmv|webm|jpg|jpeg|png|gif|svg|webp|ico|css|js|json|xml|rss|atom)(\?|$)/i;
const MAX_PAGES = Number(process.env.ODYSSEY_DEMO_MAX_PAGES) || 40;

const sites = [
  { id: 'demo-griet', url: 'https://griet.ac.in/', slug: 'griet' },
  { id: 'demo-google', url: 'http://google.com/', slug: 'google' },
  { id: 'demo-marvel', url: 'https://www.marvel.com/', slug: 'marvel' },
];

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

function isCrawlableUrl(href, origin) {
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (SKIP_PATH.test(parsed.pathname)) return false;
  return true;
}

async function collectLinks(page, origin) {
  return page.evaluate(({ origin, skipText, skipPath }) => {
    const textPattern = new RegExp(skipText, 'i');
    const pathPattern = new RegExp(skipPath, 'i');
    const seen = new Set();
    const items = [];
    for (const el of document.querySelectorAll('a[href]')) {
      const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80);
      if (text && textPattern.test(text)) continue;
      let href = '';
      try { href = el.href; } catch { continue; }
      if (!href || href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('tel:')) continue;
      let next;
      try { next = new URL(href); } catch { continue; }
      if (next.origin !== origin) continue;
      if (pathPattern.test(next.pathname)) continue;
      next.hash = '';
      const bare = next.href;
      if (bare.split('#')[0] === location.href.split('#')[0]) continue;
      if (seen.has(bare)) continue;
      seen.add(bare);
      items.push({ text: text || next.pathname || bare, href: bare });
    }
    return items;
  }, { origin, skipText: SKIP_TEXT.source, skipPath: SKIP_PATH.source });
}

for (const file of readdirSync(outDir)) {
  if (/\.(jpg|jpeg|png)$/i.test(file)) unlinkSync(join(outDir, file));
}

const browser = await chromium.launch({ headless: true });
const results = [];

for (const site of sites) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const pages = [];
  const shots = [];
  const actions = [];
  const graphNodes = [];
  const edges = [];

  try {
    actions.push({
      at: new Date().toISOString(),
      message: `Opening ${site.url}`,
      url: site.url,
      viewport: 'desktop',
    });
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const homeTitle = await page.title();
    const homeUrl = page.url();
    const origin = new URL(homeUrl).origin;
    const startId = normalizeUrl(homeUrl);

    graphNodes.push({ id: startId, url: startId, title: homeTitle, isStart: true });
    pages.push({ url: homeUrl, title: homeTitle });

    const homeShot = `/demo-shots/${site.slug}-0.jpg`;
    await page.screenshot({ path: join(outDir, `${site.slug}-0.jpg`), type: 'jpeg', quality: 55 });
    shots.push({ src: homeShot, caption: `Landed on “${homeTitle || homeUrl}”`, viewport: 'desktop' });
    actions.push({
      at: new Date().toISOString(),
      message: `Landed on “${homeTitle || homeUrl}”`,
      url: homeUrl,
      viewport: 'desktop',
      shot: homeShot,
    });

    const visited = new Set([startId]);
    const queued = new Set();
    const queue = [];

    const enqueue = async (fromUrl) => {
      const links = await collectLinks(page, origin);
      for (const link of links) {
        const id = normalizeUrl(link.href);
        if (visited.has(id) || queued.has(id)) continue;
        if (!isCrawlableUrl(link.href, origin)) continue;
        queued.add(id);
        queue.push({ from: normalizeUrl(fromUrl), ...link, id });
      }
    };

    await enqueue(homeUrl);
    actions.push({
      at: new Date().toISOString(),
      message: `Found ${queue.length} same-site pages to open (cap ${MAX_PAGES}).`,
      url: homeUrl,
      viewport: 'desktop',
    });

    let clicks = 0;
    let shotIndex = 0;
    while (queue.length && visited.size < MAX_PAGES) {
      const pick = queue.shift();
      queued.delete(pick.id);
      if (visited.has(pick.id)) continue;

      try {
        actions.push({
          at: new Date().toISOString(),
          message: `Opening “${pick.text}”`,
          url: pick.from,
          viewport: 'desktop',
        });
        const response = await page.goto(pick.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(800);
        const contentType = response?.headers()?.['content-type'] || '';
        if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
          visited.add(pick.id);
          actions.push({
            at: new Date().toISOString(),
            message: `Skipped non-HTML resource: ${pick.text}`,
            url: pick.href,
            viewport: 'desktop',
          });
          continue;
        }

        clicks += 1;
        const landed = page.url();
        const landedId = normalizeUrl(landed);
        const title = await page.title();
        visited.add(pick.id);
        visited.add(landedId);
        pages.push({ url: landed, title });
        if (!graphNodes.some((node) => node.id === landedId)) {
          graphNodes.push({ id: landedId, url: landedId, title, isStart: false });
        }
        edges.push({ from: pick.from, to: landedId, label: pick.text });

        shotIndex += 1;
        const shotSrc = `/demo-shots/${site.slug}-${shotIndex}.jpg`;
        await page.screenshot({
          path: join(outDir, `${site.slug}-${shotIndex}.jpg`),
          type: 'jpeg',
          quality: 55,
        });
        shots.push({
          src: shotSrc,
          caption: `Opened “${title || pick.text}”`,
          viewport: 'desktop',
        });
        actions.push({
          at: new Date().toISOString(),
          message: `Opened “${title || landed}” (${visited.size}/${MAX_PAGES} pages)`,
          url: landed,
          viewport: 'desktop',
          shot: shotSrc,
        });

        if (visited.size < MAX_PAGES) await enqueue(landed);
      } catch (err) {
        visited.add(pick.id);
        console.error(site.slug, pick.href, err instanceof Error ? err.message : err);
        actions.push({
          at: new Date().toISOString(),
          message: `Open failed: “${pick.text}”`,
          url: pick.href,
          viewport: 'desktop',
        });
      }
    }

    if (queue.length && visited.size >= MAX_PAGES) {
      actions.push({
        at: new Date().toISOString(),
        message: `Reached the ${MAX_PAGES}-page crawl cap with ${queue.length} links still queued.`,
        url: page.url(),
        viewport: 'desktop',
      });
    }

    results.push({
      id: site.id,
      url: site.url,
      homeTitle,
      homeUrl,
      pages,
      graph: { nodes: graphNodes, edges },
      shots,
      actions,
      clicks,
    });
    console.log('OK', site.slug, 'nodes', graphNodes.length, 'shots', shots.length, 'clicks', clicks);
  } catch (err) {
    console.error('FAIL', site.slug, err instanceof Error ? err.message : err);
  } finally {
    await context.close();
  }
}

await browser.close();
writeFileSync(join(outDir, 'capture.json'), JSON.stringify(results, null, 2));
console.log('wrote capture.json');
