/**
 * Odyssey agent.
 *
 * Opens a real Chromium window, crawls same-site pages into a graph, and
 * measures the landing page with the ui-ux-audit script (MIT, imYChaudhary22/ui-ux-audit).
 * Design numbers come from that script. Functional notes come from what the
 * agent actually saw: console errors, failed requests, and clicks.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAgentBrowser } from './browser.js';

const auditSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'audit.js'),
  'utf8',
);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

const SKIP_TEXT = /log\s*out|sign\s*out|delete|remove|checkout|payment|subscribe|unsubscribe|download/i;
const SKIP_PATH = /\.(pdf|zip|rar|7z|gz|tgz|doc|docx|xls|xlsx|ppt|pptx|csv|mp3|mp4|avi|mov|wmv|webm|jpg|jpeg|png|gif|svg|webp|ico|css|js|json|xml|rss|atom)(\?|$)/i;
const MAX_PAGES = Number(process.env.ODYSSEY_MAX_PAGES)
  || (process.env.VERCEL ? 15 : 80);

export async function runOdyssey({ url, emit }) {
  const startedAt = new Date().toISOString();
  const findings = [];
  const actions = [];
  const pagesVisited = [];
  const pageGraph = { nodes: [], edges: [] };
  let browser;
  let clicks = 0;

  const emitGraph = () => {
    emit({ type: 'graph', pageGraph: snapshotGraph(pageGraph) });
  };

  const pushAction = async (page, message, extra = {}) => {
    const entry = {
      at: new Date().toISOString(),
      message,
      url: extra.url || (page ? page.url() : url),
      viewport: extra.viewport || null,
    };
    actions.push(entry);
    let frame = null;
    if (page) {
      try {
        frame = await page.screenshot({ type: 'jpeg', quality: 55 });
      } catch {
        frame = null;
      }
    }
    emit({ type: 'action', ...entry, frame });
  };

  try {
    const launched = await launchAgentBrowser();
    browser = launched.browser;
    const headed = launched.headed;

    const browserNote = headed
      ? 'Agent browser is open on your desktop. This page mirrors every step.'
      : 'No desktop window was available, so the agent is running in the background. Watch the mirror.';
    emit({ type: 'status', message: browserNote });
    await pushAction(null, browserNote, { url, viewport: 'desktop' });

    const context = await browser.newContext({
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const networkFailures = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 280));
    });
    page.on('requestfailed', (req) => {
      const reason = req.failure()?.errorText || 'failed';
      if (reason === 'net::ERR_ABORTED') return;
      networkFailures.push(`${req.method()} ${req.url()} — ${reason}`.slice(0, 280));
    });

    await pushAction(null, `Opening ${url}`, { url, viewport: 'desktop' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(700);
    const title = await page.title();
    const landedUrl = page.url();
    pagesVisited.push({ url: landedUrl, title });
    addGraphNode(pageGraph, landedUrl, title, true);
    emitGraph();
    await pushAction(page, `Landed on “${title || landedUrl}”`, { viewport: 'desktop' });

    await scrollThrough(page);
    await pushAction(page, 'Scrolled the page so below-the-fold content loads', { viewport: 'desktop' });

    await measure(page, 'desktop', findings, emit, pushAction);
    clicks = await clickThrough(page, pushAction, pagesVisited, pageGraph, emitGraph, findings, emit);

    for (const vp of VIEWPORTS.slice(1)) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(500);
      await pushAction(page, `Switched to ${vp.name} (${vp.width}×${vp.height})`, { viewport: vp.name });
      await measure(page, vp.name, findings, emit, pushAction);
    }

    addFunctionalFindings(page.url(), consoleErrors, networkFailures, findings, emit);

    const report = buildReport({
      url,
      startedAt,
      findings,
      actions,
      pagesVisited,
      pageGraph: snapshotGraph(pageGraph),
      clicks,
    });
    emit({ type: 'done', report });
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'failed', message });
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += Math.max(500, window.innerHeight - 80)) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    window.scrollTo(0, 0);
  });
}

async function measure(page, viewport, findings, emit, pushAction) {
  await pushAction(page, `Measuring contrast, tap targets, spacing, and alignment (${viewport})`, { viewport });
  let data;
  try {
    const json = await page.evaluate(auditSource);
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (err) {
    addFinding(findings, emit, {
      severity: 'high',
      kind: 'design',
      title: `Design measurement could not run on ${viewport}`,
      where: page.url(),
      detail: err instanceof Error ? err.message : String(err),
      fix: 'The page may block injected scripts. The click-through still ran.',
      viewport,
    });
    return;
  }
  for (const finding of mapAudit(data, viewport, page.url())) {
    addFinding(findings, emit, finding);
  }
}

function mapAudit(data, viewport, pageUrl) {
  const checks = data?.checks || {};
  const out = [];

  for (const fail of (checks.contrast?.worst || []).slice(0, 6)) {
    out.push({
      severity: fail.ratio < 3 ? 'critical' : 'high',
      kind: 'design',
      title: `Text contrast ${fail.ratio}:1`,
      where: fail.where || pageUrl,
      detail: `Measured ${fail.ratio}:1. WCAG 2.2 needs ${fail.required}:1 for this text (${fail.fontPx}px).`,
      fix: `Change the text or its background until the contrast is at least ${fail.required}:1.`,
      viewport,
    });
  }

  for (const item of (checks.tapTargets?.items || []).slice(0, 6)) {
    const aaFail = item.severity === 'AA-fail';
    if (!aaFail && viewport !== 'mobile') continue;
    out.push({
      severity: aaFail ? 'critical' : 'high',
      kind: 'design',
      title: `Tap target ${item.size}`,
      where: item.where || item.label || pageUrl,
      detail: `“${item.label || 'control'}” is ${item.size} px. AA minimum is 24×24. Touch target is 44×44.`,
      fix: aaFail
        ? 'Grow the clickable area to at least 24×24 px.'
        : 'Grow the touch target to at least 44×44 px on small screens.',
      viewport,
    });
  }

  const overflow = checks.overflow?.horizontalOverflowPx || 0;
  if (overflow > 2) {
    const culprit = checks.overflow?.culprits?.[0];
    out.push({
      severity: 'critical',
      kind: 'design',
      title: `Page overflows by ${overflow}px on ${viewport}`,
      where: culprit?.where || pageUrl,
      detail: `Content is wider than the ${viewport} window, so the page scrolls sideways.`,
      fix: 'Give the overflowing element max-width: 100% and drop fixed widths that exceed the viewport.',
      viewport,
    });
  }

  for (const item of (checks.misalignment?.items || []).slice(0, 4)) {
    out.push({
      severity: 'high',
      kind: 'design',
      title: `${item.edge} edge is ${item.offBy} out of line`,
      where: item.item || item.container || pageUrl,
      detail: `Siblings line up at ${item.line}px. This one sits ${item.offBy} away.`,
      fix: `Remove the stray offset so this edge sits on the ${item.line}px line.`,
      viewport,
    });
  }

  const off4 = checks.spacingGrid?.off4Grid || [];
  if (off4.length) {
    const heavy = off4.some((row) => row.uses >= 8);
    const sample = off4.slice(0, 5).map((row) => `${row.px}px (${row.uses} uses)`).join(', ');
    out.push({
      severity: heavy ? 'high' : 'medium',
      kind: 'design',
      title: 'Spacing is off the 8px grid',
      where: `${viewport} layout`,
      detail: `Off-grid values: ${sample}.`,
      fix: 'Round padding, margin, and gap to multiples of 8. 4px is acceptable for tight gaps.',
      viewport,
    });
  }

  for (const item of (checks.animation?.layoutTriggering || []).slice(0, 3)) {
    out.push({
      severity: 'high',
      kind: 'design',
      title: 'Animation moves layout properties',
      where: item.where || pageUrl,
      detail: `This transition animates ${item.props}, which forces layout and drops frames.`,
      fix: 'Animate transform or opacity instead, around 150–300ms.',
      viewport,
    });
  }

  if ((checks.animation?.linearEasing || []).length) {
    out.push({
      severity: 'medium',
      kind: 'design',
      title: 'Motion uses linear easing',
      where: checks.animation.linearEasing[0].where || pageUrl,
      detail: 'Linear motion feels mechanical. Entrances should decelerate and exits accelerate.',
      fix: 'Use a Material standard curve such as cubic-bezier(0.2, 0, 0, 1).',
      viewport,
    });
  }

  if (checks.cssAudit?.focusRisk) {
    out.push({
      severity: 'critical',
      kind: 'design',
      title: 'Keyboard focus ring is removed',
      where: pageUrl,
      detail: 'A :focus rule sets outline to none and no :focus-visible replacement was found.',
      fix: 'Pair outline: none with a visible :focus-visible style.',
      viewport,
    });
  }

  const hasMotion = (checks.animation?.layoutTriggering || []).length > 0
    || (checks.animation?.linearEasing || []).length > 0;
  if (hasMotion && checks.cssAudit && checks.cssAudit.reducedMotionHandled === false) {
    out.push({
      severity: 'medium',
      kind: 'design',
      title: 'No reduced-motion handling',
      where: pageUrl,
      detail: 'The page animates and does not include a prefers-reduced-motion rule.',
      fix: 'Add @media (prefers-reduced-motion: reduce) and turn non-essential motion off.',
      viewport,
    });
  }

  const consistency = checks.consistency;
  if (consistency) {
    const flags = [];
    if (consistency.fontFamilies > 3) flags.push(`${consistency.fontFamilies} font families`);
    if (consistency.distinctFontSizes > 12) flags.push(`${consistency.distinctFontSizes} font sizes`);
    if (consistency.distinctTextColors > 10) flags.push(`${consistency.distinctTextColors} text colors`);
    if (consistency.distinctRadii > 6) flags.push(`${consistency.distinctRadii} corner radii`);
    if (consistency.distinctShadows > 6) flags.push(`${consistency.distinctShadows} shadows`);
    if (flags.length) {
      out.push({
        severity: 'medium',
        kind: 'design',
        title: 'Visual styles are inconsistent',
        where: `${viewport} layout`,
        detail: flags.join(', ') + '.',
        fix: 'Cut back to one or two type families and a short set of sizes, colors, radii, and shadows.',
        viewport,
      });
    }
  }

  const images = checks.images || {};
  if ((images.missingAlt || []).length) {
    out.push({
      severity: 'medium',
      kind: 'design',
      title: `${images.missingAlt.length} image${images.missingAlt.length === 1 ? '' : 's'} missing alt text`,
      where: images.missingAlt[0].src || pageUrl,
      detail: 'An image without an alt attribute is skipped by screen readers.',
      fix: 'Add alt text that describes the image, or alt="" if it is decorative.',
      viewport,
    });
  }
  if ((images.upscaled || []).length) {
    const img = images.upscaled[0];
    out.push({
      severity: 'medium',
      kind: 'design',
      title: 'Image is scaled above its real size',
      where: img.src || pageUrl,
      detail: `Shown at ${img.displayed}px from a ${img.natural}px source.`,
      fix: 'Use a source at least as wide as the displayed size.',
      viewport,
    });
  }

  return out;
}

async function clickThrough(page, pushAction, pagesVisited, pageGraph, emitGraph, findings, emit) {
  const home = page.url();
  let origin;
  try {
    origin = new URL(home).origin;
  } catch {
    return 0;
  }

  const startId = normalizeUrl(home);
  const visited = new Set([startId]);
  const queued = new Set();
  const queue = [];

  const enqueueLinks = async (fromUrl) => {
    const links = await collectSameSiteLinks(page, origin);
    for (const link of links) {
      const id = normalizeUrl(link.href);
      if (visited.has(id) || queued.has(id)) continue;
      if (!isCrawlableUrl(link.href, origin)) continue;
      queued.add(id);
      queue.push({ from: normalizeUrl(fromUrl), ...link, id });
    }
  };

  await enqueueLinks(home);
  await pushAction(
    page,
    queue.length
      ? `Found ${queue.length} same-site page${queue.length === 1 ? '' : 's'} to open (cap ${MAX_PAGES}).`
      : 'No safe same-site links to open. Design checks still ran.',
    { viewport: 'desktop' },
  );

  let clicks = 0;
  while (queue.length && visited.size < MAX_PAGES) {
    const pick = queue.shift();
    queued.delete(pick.id);
    if (visited.has(pick.id)) continue;

    try {
      await pushAction(page, `Opening “${pick.text}”`, {
        url: pick.from,
        viewport: 'desktop',
      });
      const response = await page.goto(pick.href, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(700);

      const contentType = response?.headers()?.['content-type'] || '';
      if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
        await pushAction(page, `Skipped non-HTML resource: ${pick.text}`, {
          url: pick.href,
          viewport: 'desktop',
        });
        visited.add(pick.id);
        continue;
      }

      clicks += 1;
      const landed = page.url();
      const landedId = normalizeUrl(landed);
      const landedTitle = await page.title();
      visited.add(pick.id);
      visited.add(landedId);
      pagesVisited.push({ url: landed, title: landedTitle });
      addGraphNode(pageGraph, landed, landedTitle, false);
      addGraphEdge(pageGraph, pick.from, landed, pick.text);
      emitGraph();
      await pushAction(
        page,
        landedId === pick.from
          ? `Clicked “${pick.text}” and stayed on this page`
          : `Opened “${landedTitle || landed}” (${visited.size}/${MAX_PAGES} pages)`,
        { url: landed, viewport: 'desktop' },
      );

      if (visited.size < MAX_PAGES) {
        await enqueueLinks(landed);
      }
    } catch (err) {
      visited.add(pick.id);
      const message = err instanceof Error ? err.message : String(err);
      await pushAction(page, `Open failed: “${pick.text}”`, { url: pick.href, viewport: 'desktop' });
      addFinding(findings, emit, {
        severity: 'high',
        kind: 'functional',
        title: `Page open failed: ${pick.text}`,
        where: pick.href,
        detail: message.slice(0, 280),
        fix: 'Open this link by hand and confirm the page loads.',
        viewport: 'desktop',
      });
    }
  }

  if (queue.length && visited.size >= MAX_PAGES) {
    await pushAction(
      page,
      `Reached the ${MAX_PAGES}-page crawl cap with ${queue.length} link${queue.length === 1 ? '' : 's'} still queued.`,
      { viewport: 'desktop' },
    );
  }

  await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  return clicks;
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
  if (parsed.username || parsed.password) return false;
  if (SKIP_PATH.test(parsed.pathname)) return false;
  return true;
}

async function collectSameSiteLinks(page, origin) {
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
      const label = text || next.pathname || bare;
      items.push({ text: label, href: bare });
    }
    return items;
  }, { origin, skipText: SKIP_TEXT.source, skipPath: SKIP_PATH.source });
}

function addFunctionalFindings(pageUrl, consoleErrors, networkFailures, findings, emit) {
  for (const message of [...new Set(consoleErrors)].slice(0, 6)) {
    addFinding(findings, emit, {
      severity: 'high',
      kind: 'functional',
      title: 'Console error during the visit',
      where: pageUrl,
      detail: message,
      fix: 'Reproduce the visit with DevTools open and fix the script that threw.',
      viewport: 'desktop',
    });
  }
  for (const message of [...new Set(networkFailures)].slice(0, 6)) {
    addFinding(findings, emit, {
      severity: 'high',
      kind: 'functional',
      title: 'Network request failed',
      where: pageUrl,
      detail: message,
      fix: 'Check that this URL is reachable and returns a success status.',
      viewport: 'desktop',
    });
  }
}

function addFinding(findings, emit, finding) {
  const key = [finding.severity, finding.title, finding.where].join('|');
  const existing = findings.find((item) => item.key === key);
  if (existing) {
    if (finding.viewport && !existing.viewport.split(', ').includes(finding.viewport)) {
      existing.viewport = `${existing.viewport}, ${finding.viewport}`;
    }
    return;
  }
  const stored = { ...finding, key };
  findings.push(stored);
  emit({ type: 'finding', finding: stored });
}

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

function addGraphNode(pageGraph, url, title, isStart) {
  const id = normalizeUrl(url);
  const existing = pageGraph.nodes.find((node) => node.id === id);
  if (existing) {
    if (title && !existing.title) existing.title = title;
    if (isStart) existing.isStart = true;
    return existing;
  }
  const node = { id, url: id, title: title || '', isStart: Boolean(isStart) };
  pageGraph.nodes.push(node);
  return node;
}

function addGraphEdge(pageGraph, fromUrl, toUrl, label) {
  const from = normalizeUrl(fromUrl);
  const to = normalizeUrl(toUrl);
  if (from === to) return;
  const key = `${from}->${to}->${label || ''}`;
  if (pageGraph.edges.some((edge) => `${edge.from}->${edge.to}->${edge.label || ''}` === key)) return;
  pageGraph.edges.push({ from, to, label: label || '' });
}

function snapshotGraph(pageGraph) {
  return {
    nodes: pageGraph.nodes.map((node) => ({ ...node })),
    edges: pageGraph.edges.map((edge) => ({ ...edge })),
  };
}

function buildReport({ url, startedAt, findings, actions, pagesVisited, pageGraph, clicks }) {
  const counts = { critical: 0, high: 0, medium: 0 };
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1;
  }
  const uniquePages = new Set(pagesVisited.map((page) => normalizeUrl(page.url))).size;
  const verdict = findings.length === 0
    ? `Visited ${url}. The agent opened ${uniquePages} page${uniquePages === 1 ? '' : 's'} and clicked ${clicks} link${clicks === 1 ? '' : 's'}. No measured issues.`
    : `Visited ${url} on desktop, tablet, and mobile. ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium. The agent clicked ${clicks} link${clicks === 1 ? '' : 's'}.`;

  const health = Math.max(
    0,
    Math.min(100, 100 - (counts.critical * 25 + counts.high * 12 + counts.medium * 5)),
  );

  return {
    url,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    counts,
    clicks,
    pagesVisited,
    pageGraph: pageGraph || { nodes: [], edges: [] },
    dashboard: {
      health,
      pages: uniquePages,
      clicks,
      summary: verdict,
      viewportTrend: [
        { name: 'desktop', issues: countViewportIssues(findings, 'desktop') },
        { name: 'tablet', issues: countViewportIssues(findings, 'tablet') },
        { name: 'mobile', issues: countViewportIssues(findings, 'mobile') },
      ],
    },
    actions: actions.map(({ at, message, url: actionUrl, viewport }) => ({
      at, message, url: actionUrl, viewport,
    })),
    findings: findings.map(({ key, ...finding }) => finding),
  };
}

function countViewportIssues(findings, viewport) {
  return findings.filter((finding) => String(finding.viewport || '').includes(viewport)).length;
}
