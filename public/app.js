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
const documentBody = document.querySelector('#document');
const download = document.querySelector('#download');
const designPdf = document.querySelector('#design-pdf');
const testingPdf = document.querySelector('#testing-pdf');
const printBtn = document.querySelector('#print');
const historyList = document.querySelector('#history');
const newRunBtn = document.querySelector('#new-run');
const menuBtn = document.querySelector('#menu');
const backdrop = document.querySelector('#backdrop');

let frameTimer = 0;
let lastFrameUrl = '';
let activeId = '';

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
  if (type === 'finding') setStatus(`Found: ${data.finding.title}`);
  if (type === 'done') {
    stopFrame();
    setBusy(false);
    setPill('Done', '');
    setStatus('Run finished.');
    activeId = id || data.id;
    renderReport(activeId, data.report);
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

function renderReport(id, data) {
  report.hidden = false;
  download.href = `/api/runs/${id}`;
  designPdf.href = `/api/runs/${id}/design.pdf`;
  testingPdf.href = `/api/runs/${id}/testing.pdf`;
  documentBody.replaceChildren();

  const finished = data.finishedAt ? new Date(data.finishedAt) : new Date();
  documentBody.append(
    el('p', 'kicker', 'Odyssey evaluation'),
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

  documentBody.append(el('h2', '', '3. Pages opened'));
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

  documentBody.append(el('h2', '', '4. Findings'));
  const groups = [
    ['critical', '4.1 Critical'],
    ['high', '4.2 High'],
    ['medium', '4.3 Medium'],
  ];
  let any = false;
  for (const [severity, heading] of groups) {
    const items = data.findings.filter((finding) => finding.severity === severity);
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
  documentBody.append(el('h2', '', '5. Screenshots'));
  if (!shots.length) {
    documentBody.append(el('p', '', 'No screenshots were captured on this pass.'));
  } else {
    shots.forEach((shot, index) => {
      documentBody.append(figure(shot.src, `Figure ${index + 1}. ${shot.caption}`, data.url));
    });
  }

  report.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    button.append(
      el('span', 'title', host),
      el('span', 'when', `${when} · ${counts.critical || 0} critical`),
    );
    button.addEventListener('click', () => openHistory(item.id));
    const pdfs = document.createElement('div');
    pdfs.className = 'pdfs';
    pdfs.append(pdfLink(item.id, 'design'), pdfLink(item.id, 'testing'));
    row.append(button, pdfs);
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

async function openHistory(id) {
  activeId = id;
  setWorking(true);
  closeNav();
  loadHistory();
  setStatus('Opening a saved report…');
  const res = await fetch(`/api/runs/${id}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.report) {
    setStatus(body.error || 'That report could not be opened.');
    return;
  }
  renderReport(id, body.report);
  setStatus('Showing a saved report.');
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
  frame.hidden = true;
  frameEmpty.hidden = false;
  liveUrl.textContent = 'Agent browser';
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

