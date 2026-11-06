const form = document.querySelector('#run-form');
const urlInput = document.querySelector('#url');
const runBtn = document.querySelector('#run-btn');
const statusEl = document.querySelector('#status');
const frame = document.querySelector('#frame');
const frameEmpty = document.querySelector('#frame-empty');
const liveUrl = document.querySelector('#live-url');
const livePill = document.querySelector('#live-pill');
const actions = document.querySelector('#actions');
const report = document.querySelector('#report');
const reportLayout = document.querySelector('#report-layout');
const documentBody = document.querySelector('#document');
const download = document.querySelector('#download');
const designPdf = document.querySelector('#design-pdf');
const testingPdf = document.querySelector('#testing-pdf');
const printBtn = document.querySelector('#print');
const historyList = document.querySelector('#history');
const newRunBtn = document.querySelector('#new-run');
const menuBtn = document.querySelector('#menu');
const backdrop = document.querySelector('#backdrop');
const liveGraph = document.querySelector('#live-graph');
const graphEmpty = document.querySelector('#graph-empty');
const dashSummary = document.querySelector('#dash-summary');
const dashHealth = document.querySelector('#dash-health');
const dashStats = document.querySelector('#dash-stats');
const scoreRing = document.querySelector('#score-ring');
const severityChart = document.querySelector('#severity-chart');
const activityChart = document.querySelector('#activity-chart');
const viewportChart = document.querySelector('#viewport-chart');

let frameTimer = 0;
let lastFrameUrl = '';
let activeId = '';
let livePageGraph = { nodes: [], edges: [] };

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  resetView();
  setWorking(true);
  setBusy(true);
  setStatus('Starting the agent…');
  setPill('Live', 'live');

  let res;
  try {
    res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  } catch {
    fail('Could not reach Odyssey. Is the server still running?');
    return;
  }

  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream')) {
    const body = await res.json().catch(() => ({}));
    fail(body.error || 'Could not start the run.');
    return;
  }

  await readRun(res);
});

function applyRunEvent(id, type, data) {
  if (type === 'started') {
    activeId = data.id;
    pollFrame(data.id);
    return;
  }
  if (type === 'status') setStatus(data.message);
  if (type === 'action') {
    addAction(data);
    if (data.url) liveUrl.textContent = data.url;
    if (data.preview) showFrame(data.preview);
  }
  if (type === 'graph' && data.pageGraph) {
    livePageGraph = data.pageGraph;
    renderGraph(liveGraph, livePageGraph, { emptyEl: graphEmpty });
  }
  if (type === 'finding') setStatus(`Found: ${data.finding.title}`);
  if (type === 'done') {
    stopFrame();
    setBusy(false);
    setPill('Done', '');
    setStatus('Run finished.');
    activeId = id || data.id;
    if (data.report?.pageGraph) {
      livePageGraph = data.report.pageGraph;
      renderGraph(liveGraph, livePageGraph, { emptyEl: graphEmpty });
    }
    renderReport(activeId, data.report, { demo: false });
    loadHistory();
  }
  if (type === 'failed') fail(data.message || 'The agent stopped.');
}

async function readRun(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let id = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop();
    for (const chunk of chunks) {
      const type = (chunk.match(/^event: (.+)$/m) || [])[1];
      const dataLine = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(6)).join('\n');
      if (!type || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (type === 'started') id = data.id;
      applyRunEvent(id, type, data);
    }
  }
}

function showFrame(src) {
  frame.src = src;
  frame.hidden = false;
  frameEmpty.hidden = true;
}

function pollFrame(id) {
  stopFrame();
  const tick = async () => {
    try {
      const res = await fetch(`/api/runs/${id}/frame`, { cache: 'no-store' });
      if (res.status === 200) {
        const blob = await res.blob();
        if (lastFrameUrl) URL.revokeObjectURL(lastFrameUrl);
        lastFrameUrl = URL.createObjectURL(blob);
        frame.src = lastFrameUrl;
        frame.hidden = false;
        frameEmpty.hidden = true;
      }
    } catch {
      /* keep the last frame */
    }
  };
  tick();
  frameTimer = window.setInterval(tick, 700);
}

printBtn.addEventListener('click', () => window.print());

function renderReport(id, data, options = {}) {
  const demo = Boolean(options.demo);
  reportLayout.hidden = false;
  report.hidden = false;
  download.href = `/api/runs/${id}`;
  if (demo) {
    designPdf.hidden = true;
    testingPdf.hidden = true;
  } else {
    designPdf.hidden = false;
    testingPdf.hidden = false;
    designPdf.href = `/api/runs/${id}/design.pdf`;
    testingPdf.href = `/api/runs/${id}/testing.pdf`;
  }
  documentBody.replaceChildren();

  const finished = data.finishedAt ? new Date(data.finishedAt) : new Date();
  documentBody.append(
    el('p', 'kicker', demo ? 'Odyssey demo evaluation' : 'Odyssey evaluation'),
    el('h1', '', 'UI/UX evaluation report'),
    el('p', 'site', data.url),
    el('p', 'meta', `${finished.toLocaleString()} · Desktop, tablet, and mobile`),
    el('h2', '', '1. Summary'),
    el('p', '', data.verdict),
    el('p', '', countSentence(data.counts)),
    el('h2', '', '2. What the agent did'),
  );

  const steps = document.createElement('ol');
  steps.className = 'steps';
  for (const action of data.actions || []) {
    const item = document.createElement('li');
    item.append(el('p', '', action.message));
    if (action.shot) item.append(figure(action.shot, action.message, data.url));
    steps.append(item);
  }
  if (!steps.childElementCount) {
    steps.append(el('li', '', 'The agent did not record any steps.'));
  }
  documentBody.append(steps);

  documentBody.append(el('h2', '', '3. Site structure'));
  const graphWrap = document.createElement('div');
  graphWrap.className = 'graph-host report-graph';
  documentBody.append(graphWrap);
  renderGraph(graphWrap, data.pageGraph || { nodes: [], edges: [] });

  documentBody.append(el('h2', '', '4. Pages opened'));
  const pages = document.createElement('ul');
  const seen = new Set();
  for (const page of data.pagesVisited || []) {
    const line = `${page.title || 'Untitled'} — ${page.url}`;
    if (seen.has(line)) continue;
    seen.add(line);
    pages.append(el('li', '', line));
  }
  if (!pages.childElementCount) pages.append(el('li', '', 'No page title was recorded.'));
  documentBody.append(pages);

  documentBody.append(el('h2', '', '5. Findings'));
  const groups = [
    ['critical', '5.1 Critical'],
    ['high', '5.2 High'],
    ['medium', '5.3 Medium'],
  ];
  let any = false;
  for (const [severity, heading] of groups) {
    const items = (data.findings || []).filter((finding) => finding.severity === severity);
    if (!items.length) continue;
    any = true;
    documentBody.append(el('h3', '', heading));
    const list = document.createElement('ol');
    list.className = 'findings';
    items.forEach((finding) => {
      const item = document.createElement('li');
      item.append(
        el('p', 'finding-title', finding.title),
        el('p', '', `Where: ${finding.where}`),
        el('p', '', `Checked on: ${finding.viewport}. ${finding.kind === 'functional' ? 'Found while the agent was using the site.' : 'Found by measurement.'}`),
        el('p', '', finding.detail),
        el('p', '', `Recommended change: ${finding.fix}`),
      );
      list.append(item);
    });
    documentBody.append(list);
  }
  if (!any) {
    documentBody.append(el('p', '', 'No measured issues on this pass.'));
  }

  const shots = data.screenshots || [];
  documentBody.append(el('h2', '', '6. Screenshots'));
  if (!shots.length) {
    documentBody.append(el('p', '', demo ? 'Demo runs do not include screenshots.' : 'No screenshots were captured on this pass.'));
  } else {
    shots.forEach((shot, index) => {
      documentBody.append(figure(shot.src, `Figure ${index + 1}. ${shot.caption}`, data.url));
    });
  }

  renderDashboard(data);
  reportLayout.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderDashboard(data) {
  const counts = data.counts || { critical: 0, high: 0, medium: 0 };
  const pages = uniquePageCount(data);
  const clicks = data.clicks || 0;
  const dash = data.dashboard || {};
  const health = typeof dash.health === 'number'
    ? dash.health
    : Math.max(0, Math.min(100, 100 - ((counts.critical || 0) * 25 + (counts.high || 0) * 12 + (counts.medium || 0) * 5)));
  const summary = dash.summary || data.verdict || 'Run finished.';
  const trend = Array.isArray(dash.viewportTrend) && dash.viewportTrend.length
    ? dash.viewportTrend
    : [
      { name: 'desktop', issues: countViewport(data.findings, 'desktop') },
      { name: 'tablet', issues: countViewport(data.findings, 'tablet') },
      { name: 'mobile', issues: countViewport(data.findings, 'mobile') },
    ];

  dashSummary.textContent = summary;
  dashHealth.textContent = String(health);
  scoreRing.style.setProperty('--score', String(health));
  scoreRing.dataset.tone = health >= 75 ? 'good' : health >= 45 ? 'mid' : 'bad';

  dashStats.replaceChildren();
  for (const [label, value] of [
    ['Pages', pages],
    ['Clicks', clicks],
    ['Critical', counts.critical || 0],
    ['High', counts.high || 0],
    ['Medium', counts.medium || 0],
  ]) {
    const cell = document.createElement('div');
    cell.className = 'stat';
    cell.append(el('span', 'stat-value', String(value)), el('span', 'stat-label', label));
    dashStats.append(cell);
  }

  renderBarChart(severityChart, [
    { label: 'Critical', value: counts.critical || 0, color: 'var(--critical)' },
    { label: 'High', value: counts.high || 0, color: 'var(--high)' },
    { label: 'Medium', value: counts.medium || 0, color: 'var(--medium)' },
  ]);

  renderBarChart(activityChart, [
    { label: 'Pages', value: pages, color: 'var(--green-ink)' },
    { label: 'Clicks', value: clicks, color: '#64d2ff' },
  ]);

  renderBarChart(viewportChart, trend.map((item, index) => ({
    label: item.name,
    value: item.issues || 0,
    color: ['#2997ff', '#64d2ff', '#ac8eff'][index % 3],
  })));
}

function uniquePageCount(data) {
  if (typeof data.dashboard?.pages === 'number') return data.dashboard.pages;
  const seen = new Set();
  for (const page of data.pagesVisited || []) {
    seen.add(String(page.url || '').split('#')[0]);
  }
  if (data.pageGraph?.nodes?.length) return data.pageGraph.nodes.length;
  return seen.size;
}

function countViewport(findings, viewport) {
  return (findings || []).filter((finding) => String(finding.viewport || '').includes(viewport)).length;
}

function renderBarChart(host, items) {
  host.replaceChildren();
  const max = Math.max(1, ...items.map((item) => item.value));
  const width = 280;
  const height = 120;
  const gap = 16;
  const barWidth = Math.max(24, (width - gap * (items.length + 1)) / items.length);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: String(height), role: 'img' });
  items.forEach((item, index) => {
    const x = gap + index * (barWidth + gap);
    const barHeight = Math.round((item.value / max) * 70);
    const y = 82 - barHeight;
    svg.appendChild(svgEl('rect', {
      x: String(x),
      y: String(y),
      width: String(barWidth),
      height: String(Math.max(barHeight, item.value ? 4 : 0)),
      rx: '6',
      fill: item.color,
    }));
    svg.appendChild(svgText(x + barWidth / 2, 18, String(item.value), 'bar-value'));
    svg.appendChild(svgText(x + barWidth / 2, 108, item.label, 'bar-label'));
  });
  host.append(svg);
}

const graphViews = new WeakMap();
let graphMarkerSerial = 0;

function renderGraph(host, pageGraph, options = {}) {
  const nodes = pageGraph?.nodes || [];
  const edges = pageGraph?.edges || [];
  const emptyEl = options.emptyEl || null;
  if (!nodes.length) {
    host.hidden = true;
    host.replaceChildren();
    graphViews.delete(host);
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  host.hidden = false;

  const view = ensureGraphView(host);
  const width = Math.max(520, 120 + nodes.length * 18);
  const height = Math.max(260, 160 + nodes.length * 22);
  const positions = layoutGraph(nodes, edges, width, height);
  const markerId = view.markerId;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    class: 'site-graph',
    role: 'img',
    'aria-label': 'Site page graph',
  });

  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: markerId,
    markerWidth: '8',
    markerHeight: '8',
    refX: '7',
    refY: '3',
    orient: 'auto',
    markerUnits: 'strokeWidth',
  });
  marker.appendChild(svgEl('path', { d: 'M0,0 L7,3 L0,6 Z', fill: '#6e6e73' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    svg.appendChild(svgEl('line', {
      x1: String(from.x),
      y1: String(from.y),
      x2: String(to.x),
      y2: String(to.y),
      class: 'graph-edge',
      'marker-end': `url(#${markerId})`,
    }));
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2 - 8;
    if (edge.label) svg.appendChild(svgText(mx, my, edge.label, 'edge-label'));
  }

  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const group = svgEl('g', { class: node.isStart ? 'graph-node start' : 'graph-node' });
    const radius = nodes.length > 24 ? 10 : nodes.length > 12 ? 14 : 18;
    group.appendChild(svgEl('circle', {
      cx: String(pos.x),
      cy: String(pos.y),
      r: String(radius),
    }));
    const label = shortLabel(node.title || node.url, nodes.length > 20 ? 14 : 22);
    group.appendChild(svgText(pos.x, pos.y + radius + 14, label, 'node-label'));
    const title = svgEl('title');
    title.textContent = `${node.title || 'Untitled'}\n${node.url}`;
    group.appendChild(title);
    svg.appendChild(group);
  }

  view.canvas.replaceChildren(svg);
  applyGraphTransform(view);
}

function ensureGraphView(host) {
  let view = graphViews.get(host);
  if (view?.shell?.isConnected) return view;
  if (view) graphViews.delete(host);

  host.classList.add('graph-host');
  host.replaceChildren();

  const shell = document.createElement('div');
  shell.className = 'graph-shell';

  const toolbar = document.createElement('div');
  toolbar.className = 'graph-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Graph controls');

  const zoomOutBtn = graphToolButton('−', 'Zoom out');
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'graph-zoom-label';
  zoomLabel.textContent = '100%';
  const zoomInBtn = graphToolButton('+', 'Zoom in');
  const resetBtn = graphToolButton('Reset', 'Reset zoom and pan');
  const fullBtn = graphToolButton('Full', 'Toggle fullscreen');

  toolbar.append(zoomOutBtn, zoomLabel, zoomInBtn, resetBtn, fullBtn);

  const viewport = document.createElement('div');
  viewport.className = 'graph-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Graph canvas. Scroll to zoom, drag to pan.');

  const canvas = document.createElement('div');
  canvas.className = 'graph-canvas';
  viewport.append(canvas);
  shell.append(toolbar, viewport);
  host.append(shell);

  view = {
    host,
    shell,
    viewport,
    canvas,
    zoomLabel,
    fullBtn,
    scale: 1,
    x: 0,
    y: 0,
    markerId: `graph-arrow-${++graphMarkerSerial}`,
    dragging: false,
    lastX: 0,
    lastY: 0,
  };
  graphViews.set(host, view);

  const zoomBy = (factor, clientX, clientY) => {
    const prev = view.scale;
    const next = clampGraphScale(prev * factor);
    if (next === prev) {
      updateGraphZoomLabel(view);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const px = (clientX ?? (rect.left + rect.width / 2)) - rect.left;
    const py = (clientY ?? (rect.top + rect.height / 2)) - rect.top;
    view.x = px - ((px - view.x) * next) / prev;
    view.y = py - ((py - view.y) * next) / prev;
    view.scale = next;
    applyGraphTransform(view);
  };

  zoomInBtn.addEventListener('click', () => zoomBy(1.2));
  zoomOutBtn.addEventListener('click', () => zoomBy(1 / 1.2));
  resetBtn.addEventListener('click', () => {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    applyGraphTransform(view);
  });
  fullBtn.addEventListener('click', () => toggleGraphFullscreen(view));

  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomBy(factor, event.clientX, event.clientY);
  }, { passive: false });

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    view.dragging = true;
    view.lastX = event.clientX;
    view.lastY = event.clientY;
    viewport.classList.add('panning');
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!view.dragging) return;
    view.x += event.clientX - view.lastX;
    view.y += event.clientY - view.lastY;
    view.lastX = event.clientX;
    view.lastY = event.clientY;
    applyGraphTransform(view);
  });
  const endPan = (event) => {
    if (!view.dragging) return;
    view.dragging = false;
    viewport.classList.remove('panning');
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  };
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  document.addEventListener('fullscreenchange', () => {
    const active = document.fullscreenElement === shell;
    shell.classList.toggle('is-fullscreen', active);
    fullBtn.textContent = active ? 'Exit' : 'Full';
    fullBtn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Toggle fullscreen');
  });

  return view;
}

function graphToolButton(label, aria) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'graph-tool';
  button.textContent = label;
  button.setAttribute('aria-label', aria);
  button.title = aria;
  return button;
}

function clampGraphScale(scale) {
  return Math.min(4, Math.max(0.35, Math.round(scale * 100) / 100));
}

function applyGraphTransform(view) {
  view.canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  updateGraphZoomLabel(view);
}

function updateGraphZoomLabel(view) {
  view.zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
}

async function toggleGraphFullscreen(view) {
  try {
    if (document.fullscreenElement === view.shell) {
      await document.exitFullscreen();
      return;
    }
    if (document.fullscreenElement) await document.exitFullscreen();
    await view.shell.requestFullscreen();
  } catch {
    view.shell.classList.toggle('is-fullscreen-fallback');
    const active = view.shell.classList.contains('is-fullscreen-fallback');
    view.fullBtn.textContent = active ? 'Exit' : 'Full';
    view.fullBtn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Toggle fullscreen');
  }
}

function layoutGraph(nodes, edges, width, height) {
  const positions = new Map();
  const start = nodes.find((node) => node.isStart) || nodes[0];
  const children = new Map();
  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from).push(edge.to);
  }

  const levels = new Map();
  const queue = [[start.id, 0]];
  const seen = new Set([start.id]);
  while (queue.length) {
    const [id, depth] = queue.shift();
    levels.set(id, depth);
    for (const next of children.get(id) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([next, depth + 1]);
    }
  }
  for (const node of nodes) {
    if (!levels.has(node.id)) levels.set(node.id, Math.max(...levels.values(), 0) + 1);
  }

  const byLevel = new Map();
  for (const node of nodes) {
    const depth = levels.get(node.id) || 0;
    if (!byLevel.has(depth)) byLevel.set(depth, []);
    byLevel.get(depth).push(node);
  }

  const maxDepth = Math.max(...byLevel.keys(), 0);
  for (const [depth, row] of byLevel) {
    row.forEach((node, index) => {
      const x = row.length === 1
        ? width / 2
        : 60 + (index * (width - 120)) / Math.max(row.length - 1, 1);
      const y = maxDepth === 0
        ? height / 2
        : 50 + (depth * (height - 90)) / Math.max(maxDepth, 1);
      positions.set(node.id, { x, y });
    });
  }
  return positions;
}

function shortLabel(text, max = 22) {
  const cleaned = String(text || '').replace(/^https?:\/\//, '');
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(1, max - 1))}…` : cleaned;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, value);
  }
  return node;
}

function svgText(x, y, text, className) {
  const node = svgEl('text', {
    x: String(x),
    y: String(y),
    'text-anchor': 'middle',
    class: className,
  });
  node.textContent = text;
  return node;
}

function countSentence(counts) {
  const critical = counts?.critical || 0;
  const high = counts?.high || 0;
  const medium = counts?.medium || 0;
  return `This pass recorded ${critical} critical issue${critical === 1 ? '' : 's'}, ${high} high issue${high === 1 ? '' : 's'}, and ${medium} medium issue${medium === 1 ? '' : 's'}.`;
}

function figure(src, caption, pageUrl) {
  const node = document.createElement('figure');
  const image = document.createElement('img');
  image.src = src;
  image.alt = caption || `Screen captured on ${pageUrl}`;
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  node.append(image, cap);
  return node;
}

async function loadHistory() {
  let items = [];
  try {
    const res = await fetch('/api/history');
    items = await res.json();
  } catch {
    items = [];
  }
  historyList.replaceChildren();
  if (!items.length) {
    historyList.append(el('li', 'empty', 'No reports yet.'));
    return;
  }
  for (const item of items) {
    const row = document.createElement('li');
    if (item.id === activeId) row.className = 'active';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'item';
    const when = item.finishedAt ? new Date(item.finishedAt).toLocaleString() : 'Earlier';
    const counts = item.counts || {};
    let host = item.url;
    try { host = new URL(item.url).host; } catch { /* keep the raw link */ }
    const titleRow = document.createElement('span');
    titleRow.className = 'title-row';
    titleRow.append(el('span', 'title', host));
    if (item.demo) titleRow.append(el('span', 'demo-badge', 'Demo'));
    button.append(
      titleRow,
      el('span', 'when', `${when} · ${counts.critical || 0} critical`),
    );
    button.addEventListener('click', () => openHistory(item.id, Boolean(item.demo)));
    row.append(button);
    if (!item.demo) {
      const pdfs = document.createElement('div');
      pdfs.className = 'pdfs';
      pdfs.append(pdfLink(item.id, 'design'), pdfLink(item.id, 'testing'));
      row.append(pdfs);
    } else {
      row.append(el('p', 'demo-note', 'Demo — open for graph and dashboard'));
    }
    historyList.append(row);
  }
}

newRunBtn.addEventListener('click', () => {
  activeId = '';
  resetView();
  setWorking(false);
  setStatus('Waiting for a link.');
  setPill('Idle', '');
  urlInput.focus();
  loadHistory();
  closeNav();
});

menuBtn.addEventListener('click', () => document.body.classList.add('nav-open'));
backdrop.addEventListener('click', closeNav);

function closeNav() {
  document.body.classList.remove('nav-open');
}

function pdfLink(id, which) {
  const link = document.createElement('a');
  link.href = `/api/runs/${id}/${which}.pdf`;
  link.download = `odyssey-${which}.pdf`;
  link.textContent = which === 'design' ? 'Design PDF' : 'Testing PDF';
  return link;
}

async function openHistory(id, demo = false) {
  activeId = id;
  setWorking(true);
  closeNav();
  loadHistory();
  setStatus(demo ? 'Opening a demo report…' : 'Opening a saved report…');
  const res = await fetch(`/api/runs/${id}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.report) {
    setStatus(body.error || 'That report could not be opened.');
    return;
  }
  if (body.report.pageGraph) {
    livePageGraph = body.report.pageGraph;
    renderGraph(liveGraph, livePageGraph, { emptyEl: graphEmpty });
  }
  renderReport(id, body.report, { demo: demo || Boolean(body.demo) });
  setStatus(demo || body.demo ? 'Showing a demo report.' : 'Showing a saved report.');
}

loadHistory();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function addAction(data) {
  const item = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date(data.at).toLocaleTimeString();
  const text = document.createElement('span');
  text.textContent = data.message;
  item.append(time, text);
  actions.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

function resetView() {
  actions.replaceChildren();
  documentBody.replaceChildren();
  report.hidden = true;
  reportLayout.hidden = true;
  frame.hidden = true;
  frameEmpty.hidden = false;
  liveUrl.textContent = 'Agent browser';
  livePageGraph = { nodes: [], edges: [] };
  liveGraph.hidden = true;
  graphViews.delete(liveGraph);
  liveGraph.replaceChildren();
  if (graphEmpty) graphEmpty.hidden = false;
  dashSummary.textContent = '';
  dashHealth.textContent = '—';
  dashStats.replaceChildren();
  severityChart.replaceChildren();
  activityChart.replaceChildren();
  viewportChart.replaceChildren();
  scoreRing.style.removeProperty('--score');
  delete scoreRing.dataset.tone;
  designPdf.hidden = false;
  testingPdf.hidden = false;
}

function setWorking(on) {
  document.body.classList.toggle('working', on);
}

function setBusy(busy) {
  runBtn.disabled = busy;
  urlInput.disabled = busy;
  runBtn.textContent = busy ? 'Running…' : 'Run';
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setPill(text, kind) {
  livePill.textContent = text;
  livePill.className = `pill${kind ? ` ${kind}` : ''}`;
}

function fail(message) {
  setBusy(false);
  setPill('Stopped', 'bad');
  setStatus(message);
}

function stopFrame() {
  if (frameTimer) window.clearInterval(frameTimer);
  frameTimer = 0;
}
