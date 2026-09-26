/**
 * Builds the two downloadable reports for a run:
 * a design review, and a functional test of the controls the agent used.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

export async function buildPdfs(runDir, report) {
  const browser = await chromium.launch({
    headless: true,
    args: process.env.VERCEL
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [],
  });
  try {
    const page = await browser.newPage();
    await print(page, designHtml(report, runDir), join(runDir, 'design.pdf'));
    await print(page, testingHtml(report, runDir), join(runDir, 'testing.pdf'));
  } finally {
    await browser.close();
  }
}

async function print(page, html, file) {
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: file,
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
  });
}

function designHtml(report, runDir) {
  const findings = (report.findings || []).filter((item) => item.kind !== 'functional');
  const counts = tally(findings);
  const shots = (report.screenshots || []).filter((shot) => isDesignShot(shot.caption));
  const when = report.finishedAt ? new Date(report.finishedAt).toLocaleString() : '';

  return pageHtml('Odyssey design report', `
    <p class="kicker">Odyssey</p>
    <h1>Design report</h1>
    <p class="site">${esc(report.url)}</p>
    <p class="meta">${esc(when)} · Desktop, tablet, and mobile</p>

    <h2>1. Summary</h2>
    <p>This document covers visual and accessibility measurements: contrast, tap targets, spacing, alignment, overflow, motion, and focus. It does not judge whether a control completed its action.</p>
    <p>${counts.critical} critical, ${counts.high} high, and ${counts.medium} medium design issues.</p>

    <h2>2. Screens</h2>
    ${shots.length ? shots.map((shot, index) => figure(runDir, shot, index + 1)).join('') : '<p>No design screenshots were captured.</p>'}

    <h2>3. Findings</h2>
    ${findingSections(findings)}
  `);
}

function testingHtml(report, runDir) {
  const checks = componentChecks(report);
  const failures = (report.findings || []).filter((item) => item.kind === 'functional');
  const shots = (report.screenshots || []).filter((shot) => isTestingShot(shot.caption));
  const when = report.finishedAt ? new Date(report.finishedAt).toLocaleString() : '';
  const passed = checks.filter((item) => item.status === 'Passed').length;
  const failed = checks.filter((item) => item.status === 'Failed').length;
  const skipped = checks.filter((item) => item.status === 'Not exercised').length;

  return pageHtml('Odyssey testing report', `
    <p class="kicker">Odyssey</p>
    <h1>Testing report</h1>
    <p class="site">${esc(report.url)}</p>
    <p class="meta">${esc(when)} · Does the page load, and do the controls the agent used work?</p>

    <h2>1. Result</h2>
    <p>${passed} passed, ${failed} failed, ${skipped} not exercised. The agent clicked ${report.clicks || 0} link${report.clicks === 1 ? '' : 's'}.</p>

    <h2>2. Components</h2>
    <table>
      <thead><tr><th>Component</th><th>Result</th><th>What happened</th></tr></thead>
      <tbody>
        ${checks.map((item) => `<tr><td>${esc(item.name)}</td><td class="${item.status === 'Failed' ? 'bad' : ''}">${esc(item.status)}</td><td>${esc(item.detail)}</td></tr>`).join('')}
      </tbody>
    </table>

    <h2>3. Pages opened</h2>
    <ul>
      ${(report.pagesVisited || []).map((page) => `<li>${esc(page.title || 'Untitled')} — ${esc(page.url)}</li>`).join('') || '<li>No page was opened.</li>'}
    </ul>

    <h2>4. Failures while using the site</h2>
    ${failures.length ? findingSections(failures) : '<p>No console errors, failed requests, or broken clicks were recorded.</p>'}

    <h2>5. Screenshots</h2>
    ${shots.length ? shots.map((shot, index) => figure(runDir, shot, index + 1)).join('') : '<p>No interaction screenshots were captured.</p>'}
  `);
}

function componentChecks(report) {
  const actions = report.actions || [];
  const checks = [];
  const landed = actions.find((action) => action.message.startsWith('Landed on'));
  checks.push({
    name: 'Page load',
    status: landed ? 'Passed' : 'Failed',
    detail: landed ? landed.message : 'The agent did not reach a page.',
  });

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const label = clickLabel(action.message);
    if (!label) continue;
    const next = actions[index + 1];
    const failed = !next || /failed/i.test(next.message);
    checks.push({
      name: label,
      status: failed ? 'Failed' : 'Passed',
      detail: next?.message || 'No result was recorded after the click.',
    });
  }

  if (checks.length === 1 && actions.some((action) => action.message.startsWith('No safe same-site'))) {
    checks.push({
      name: 'Interactive controls',
      status: 'Not exercised',
      detail: 'The page had no safe same-site link for the agent to click.',
    });
  }
  return checks;
}

function clickLabel(message) {
  const match = /^Clicking [“"](.+)[”"]$/.exec(message || '');
  return match ? match[1] : '';
}

function isDesignShot(caption) {
  return /^(Landed on|Scrolled the page|Measuring |Switched to )/.test(caption || '');
}

function isTestingShot(caption) {
  return /^(Landed on|Clicking |Opened |Clicked |Click on )/.test(caption || '');
}

function findingSections(findings) {
  const groups = [
    ['critical', 'Critical'],
    ['high', 'High'],
    ['medium', 'Medium'],
  ];
  const blocks = groups.map(([severity, label]) => {
    const items = findings.filter((item) => item.severity === severity);
    if (!items.length) return '';
    return `<h3>${label}</h3><ol>${items.map((item) => `
      <li>
        <p><strong>${esc(item.title)}</strong></p>
        <p>Where: ${esc(item.where)}</p>
        <p>Checked on: ${esc(item.viewport)}</p>
        <p>${esc(item.detail)}</p>
        <p>Recommended change: ${esc(item.fix)}</p>
      </li>`).join('')}</ol>`;
  }).join('');
  return blocks || '<p>No issues in this category.</p>';
}

function figure(runDir, shot, number) {
  const src = dataUri(runDir, shot.src);
  if (!src) return '';
  return `<figure><img src="${src}" alt="${esc(shot.caption)}" /><figcaption>Figure ${number}. ${esc(shot.caption)}</figcaption></figure>`;
}

function dataUri(runDir, shotUrl) {
  const name = String(shotUrl || '').split('/').pop();
  if (!/^\d+\.jpg$/.test(name)) return '';
  const file = join(runDir, name);
  if (!existsSync(file)) return '';
  return `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;
}

function tally(findings) {
  return findings.reduce((counts, item) => {
    if (counts[item.severity] !== undefined) counts[item.severity] += 1;
    return counts;
  }, { critical: 0, high: 0, medium: 0 });
}

function pageHtml(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    body { margin: 0; color: #1c1915; font: 12.5pt/1.45 Georgia, "Palatino Linotype", Palatino, serif; }
    h1 { font-size: 22pt; margin: 0 0 6px; }
    h2 { font-size: 14pt; margin: 22px 0 8px; }
    h3 { font-size: 12pt; margin: 14px 0 4px; }
    p { margin: 0 0 8px; }
    .kicker { font-family: "Segoe UI", sans-serif; font-size: 9pt; letter-spacing: 0.08em; text-transform: uppercase; color: #5c564c; }
    .site { font-size: 12pt; word-break: break-all; }
    .meta { color: #5c564c; font-size: 10pt; }
    ol, ul { margin: 0 0 8px; padding-left: 1.2em; }
    li { margin: 0 0 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    th, td { border: 1px solid #d9d0c3; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f3efe6; font-family: "Segoe UI", sans-serif; font-size: 10pt; }
    td.bad { color: #9f1239; font-weight: 700; }
    img { display: block; width: 100%; height: auto; border: 1px solid #d9d0c3; }
    figure { margin: 0 0 14px; page-break-inside: avoid; }
    figcaption { margin-top: 4px; color: #5c564c; font-size: 10pt; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
