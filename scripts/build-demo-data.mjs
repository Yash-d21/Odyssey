import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const capture = JSON.parse(
  readFileSync(join(process.cwd(), 'public', 'demo-shots', 'capture.json'), 'utf8'),
);

const presets = {
  'demo-griet': {
    finishedAt: '2026-11-05T10:20:00.000Z',
    counts: { critical: 0, high: 2, medium: 3 },
    findings: [
      {
        severity: 'high',
        kind: 'design',
        title: 'Several nav links have low contrast',
        where: 'https://griet.ac.in/',
        detail: 'Muted text over the hero image sits near 3.2:1.',
        fix: 'Increase link color contrast against the banner.',
        viewport: 'desktop, mobile',
      },
      {
        severity: 'high',
        kind: 'design',
        title: 'Mobile menu targets are under 44px',
        where: 'https://griet.ac.in/',
        detail: 'Hamburger and utility links measure about 32px tall.',
        fix: 'Expand tap targets to at least 44×44.',
        viewport: 'mobile',
      },
      {
        severity: 'medium',
        kind: 'design',
        title: 'Images missing alt text on the landing page',
        where: 'https://griet.ac.in/',
        detail: 'Campus gallery tiles omit alt attributes.',
        fix: 'Add short alt text describing each photo.',
        viewport: 'desktop',
      },
      {
        severity: 'medium',
        kind: 'design',
        title: 'Inconsistent heading sizes',
        where: 'desktop layout',
        detail: 'More than a dozen distinct font sizes appear above the fold.',
        fix: 'Collapse to a short type scale.',
        viewport: 'desktop',
      },
      {
        severity: 'medium',
        kind: 'functional',
        title: 'PDF link opens a download mid-walk',
        where: 'https://griet.ac.in/QR.pdf',
        detail: 'A same-site QR-Codes link starts a file download instead of a page.',
        fix: 'Mark download links clearly or open them in a new tab with a notice.',
        viewport: 'desktop',
      },
    ],
    dashboardSummary: 'Full same-site crawl of GRIET (up to the page cap). Contrast and mobile tap targets are the main risks; PDF/download links were skipped on purpose.',
    viewportTrend: [
      { name: 'desktop', issues: 3 },
      { name: 'tablet', issues: 2 },
      { name: 'mobile', issues: 4 },
    ],
  },
  'demo-google': {
    finishedAt: '2026-11-06T08:05:00.000Z',
    url: 'http://google.com/',
    counts: { critical: 0, high: 0, medium: 1 },
    findings: [
      {
        severity: 'medium',
        kind: 'design',
        title: 'Footer link contrast is borderline',
        where: 'https://www.google.com/',
        detail: 'Some footer labels sit near the AA threshold on the light background.',
        fix: 'Darken muted footer text slightly.',
        viewport: 'desktop',
      },
    ],
    dashboardSummary: 'Crawled Google same-site HTML destinations discovered from the homepage. Structure stays simple; only a mild footer contrast note.',
    viewportTrend: [
      { name: 'desktop', issues: 1 },
      { name: 'tablet', issues: 0 },
      { name: 'mobile', issues: 0 },
    ],
  },
  'demo-marvel': {
    finishedAt: '2026-11-06T12:40:00.000Z',
    counts: { critical: 1, high: 2, medium: 2 },
    findings: [
      {
        severity: 'critical',
        kind: 'design',
        title: 'Primary promo CTA fails contrast',
        where: 'https://www.marvel.com/',
        detail: 'Light text on a bright red panel reads under 3:1 in places.',
        fix: 'Use darker text or a deeper panel fill.',
        viewport: 'desktop, mobile',
      },
      {
        severity: 'high',
        kind: 'design',
        title: 'Card carousels overflow on tablet',
        where: 'https://www.marvel.com/comics',
        detail: 'Horizontal rails clip titles at mid breakpoints.',
        fix: 'Allow cards to wrap or expose a clearer scroll affordance.',
        viewport: 'tablet',
      },
      {
        severity: 'high',
        kind: 'functional',
        title: 'Console error during Characters visit',
        where: 'https://www.marvel.com/characters',
        detail: 'A third-party script threw after the grid hydrated.',
        fix: 'Isolate the failing analytics call and guard the handler.',
        viewport: 'desktop',
      },
      {
        severity: 'medium',
        kind: 'design',
        title: 'Decorative images missing empty alt',
        where: 'https://www.marvel.com/movies',
        detail: 'Poster tiles without useful alt text are not marked decorative.',
        fix: 'Add descriptive alt text, or mark decorative images with an empty alt.',
        viewport: 'desktop',
      },
      {
        severity: 'medium',
        kind: 'design',
        title: 'No reduced-motion handling on hero',
        where: 'https://www.marvel.com/',
        detail: 'Hero motion runs without a prefers-reduced-motion rule.',
        fix: 'Pause non-essential animation when reduced motion is requested.',
        viewport: 'desktop',
      },
    ],
    dashboardSummary: 'Broad Marvel.com crawl across comics, characters, movies, and linked sections. Promo contrast and a Characters console error pulled the health score down.',
    viewportTrend: [
      { name: 'desktop', issues: 3 },
      { name: 'tablet', issues: 2 },
      { name: 'mobile', issues: 3 },
    ],
  },
};

function healthFromCounts(counts) {
  return Math.max(
    0,
    Math.min(100, 100 - ((counts.critical || 0) * 25 + (counts.high || 0) * 12 + (counts.medium || 0) * 5)),
  );
}

const runs = capture.map((item) => {
  const preset = presets[item.id] || {};
  const counts = preset.counts || { critical: 0, high: 1, medium: 1 };
  const url = preset.url || item.url;
  const pages = item.pages || [];
  const clicks = item.clicks || item.graph?.edges?.length || 0;
  const health = healthFromCounts(counts);
  const finishedAt = preset.finishedAt || new Date().toISOString();
  const startedAt = new Date(new Date(finishedAt).getTime() - 4 * 60 * 1000).toISOString();
  const verdict = `Visited ${url} on desktop, tablet, and mobile. ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium. The agent clicked ${clicks} link${clicks === 1 ? '' : 's'}.`;

  const actions = (item.actions || []).map((action) => ({
    at: action.at,
    message: action.message,
    url: action.url,
    viewport: action.viewport,
    shot: action.shot || null,
  }));

  return {
    id: item.id,
    demo: true,
    url,
    finishedAt,
    counts,
    clicks,
    report: {
      url,
      startedAt,
      finishedAt,
      verdict,
      counts,
      clicks,
      pagesVisited: pages,
      pageGraph: item.graph,
      dashboard: {
        health,
        pages: item.graph?.nodes?.length || pages.length,
        clicks,
        summary: preset.dashboardSummary || verdict,
        viewportTrend: preset.viewportTrend || [
          { name: 'desktop', issues: counts.high + counts.medium },
          { name: 'tablet', issues: counts.medium },
          { name: 'mobile', issues: counts.critical + counts.high },
        ],
      },
      actions,
      findings: preset.findings || [],
      screenshots: item.shots || [],
    },
  };
});

const out = { runs };
writeFileSync(
  join(process.cwd(), 'public', 'demo-data.json'),
  `${JSON.stringify(out, null, 2)}\n`,
);
console.log('wrote demo-data.json with', runs.length, 'runs');
for (const run of runs) {
  console.log(run.id, run.url, 'shots', run.report.screenshots.length);
}
