import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOdyssey } from './agent.js';
import { buildPdfs } from './pdfs.js';

const root = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(join(root, 'public')));

const dataDir = process.env.VERCEL ? join('/tmp', 'odyssey') : join(root, 'data');
const historyFile = join(dataDir, 'history.json');
const demoFile = join(root, 'public', 'demo-data.json');
mkdirSync(dataDir, { recursive: true });

const runs = new Map();
const pdfJobs = new Map();
let active = false;
let demoCache = null;

app.get('/api/history', (_req, res) => {
  const demos = readDemos().map((item) => ({
    id: item.id,
    url: item.url,
    finishedAt: item.finishedAt,
    counts: item.counts,
    clicks: item.clicks,
    demo: true,
  }));
  const real = readHistory().map((item) => ({ ...item, demo: false }));
  res.json([...demos, ...real]);
});

app.get('/api/demo/:id', (req, res) => {
  const item = readDemos().find((demo) => demo.id === req.params.id);
  if (!item?.report) {
    res.status(404).json({ error: 'Unknown demo run' });
    return;
  }
  res.json({
    id: item.id,
    url: item.url,
    status: 'done',
    error: null,
    demo: true,
    report: item.report,
  });
});

app.post('/api/run', async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  let target;
  try {
    target = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    res.status(400).json({ error: 'Enter a full website link, like https://example.com' });
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.status(400).json({ error: 'Only http and https links can be audited.' });
    return;
  }
  if (active) {
    res.status(409).json({ error: 'An audit is already running. Wait for it to finish.' });
    return;
  }

  const id = randomUUID();
  const run = {
    id,
    url: target.href,
    status: 'running',
    frame: null,
    dir: join(dataDir, id),
    events: [],
    listeners: new Set(),
    report: null,
    error: null,
  };
  runs.set(id, run);
  active = true;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  run.listeners.add(res);
  writeEvent(res, { type: 'started', id });
  res.on('close', () => run.listeners.delete(res));

  try {
    await runOdyssey({
      url: target.href,
      emit: (event) => publish(run, event),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('odyssey run failed:', message);
    publish(run, { type: 'failed', message });
  } finally {
    active = false;
    if (run.status === 'running') run.status = run.error ? 'error' : 'done';
    run.listeners.delete(res);
    res.end();
  }
});

app.get('/api/runs/:id/events', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of run.events) writeEvent(res, event);
  run.listeners.add(res);
  req.on('close', () => run.listeners.delete(res));
});

app.get('/api/runs/:id/frame', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run?.frame) {
    res.status(204).end();
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(run.frame);
});

app.get('/api/runs/:id/:which(design|testing).pdf', async (req, res) => {
  if (!isRunId(req.params.id)) {
    res.status(400).end();
    return;
  }
  const stored = loadStored(req.params.id);
  if (!stored?.report) {
    res.status(404).json({ error: 'That report is not ready yet.' });
    return;
  }
  try {
    await ensurePdfs(req.params.id, stored.dir, stored.report);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Could not build the PDF.' });
    return;
  }
  const file = join(stored.dir, `${req.params.which}.pdf`);
  res.download(file, `odyssey-${req.params.which}.pdf`);
});

app.get('/api/runs/:id/shots/:name', (req, res) => {
  if (!isRunId(req.params.id) || !/^\d+\.jpg$/.test(req.params.name)) {
    res.status(400).end();
    return;
  }
  const file = join(dataDir, req.params.id, req.params.name);
  if (!existsSync(file)) {
    res.status(404).end();
    return;
  }
  res.sendFile(file);
});

app.get('/api/runs/:id', (req, res) => {
  const demo = readDemos().find((item) => item.id === req.params.id);
  if (demo?.report) {
    res.json({
      id: demo.id,
      url: demo.url,
      status: 'done',
      error: null,
      demo: true,
      report: demo.report,
    });
    return;
  }
  if (!isRunId(req.params.id)) {
    res.status(400).json({ error: 'Unknown run' });
    return;
  }
  const run = runs.get(req.params.id);
  if (run) {
    res.json({
      id: run.id,
      url: run.url,
      status: run.status,
      error: run.error,
      report: run.report,
    });
    return;
  }
  const file = join(dataDir, req.params.id, 'report.json');
  if (!existsSync(file)) {
    res.status(404).json({ error: 'Unknown run' });
    return;
  }
  res.type('json').send(readFileSync(file, 'utf8'));
});

function publish(run, event) {
  if (event.frame) {
    run.frame = event.frame;
    event.shot = saveShot(run, event.frame);
  }
  if (event.type === 'done' && event.report) {
    const shots = run.events.filter((item) => item.type === 'action').map((item) => item.shot || null);
    event.report.actions.forEach((action, index) => {
      action.shot = shots[index] || null;
    });
    event.report.screenshots = event.report.actions
      .filter((action) => action.shot)
      .map((action) => ({
        src: action.shot,
        caption: action.message,
        viewport: action.viewport,
      }));
    run.status = 'done';
    run.report = event.report;
    saveReport(run);
  }
  if (event.type === 'failed') {
    run.status = 'error';
    run.error = event.message;
  }
  const stored = { ...event };
  delete stored.frame;
  run.events.push(stored);
  const wire = { ...stored };
  if (event.frame) {
    wire.preview = `data:image/jpeg;base64,${Buffer.from(event.frame).toString('base64')}`;
  }
  for (const listener of run.listeners) writeEvent(listener, wire);
}

function saveShot(run, frame) {
  mkdirSync(run.dir, { recursive: true });
  const count = run.events.filter((item) => item.type === 'action' && item.shot).length;
  const name = `${count}.jpg`;
  writeFileSync(join(run.dir, name), frame);
  return `/api/runs/${run.id}/shots/${name}`;
}

function saveReport(run) {
  mkdirSync(run.dir, { recursive: true });
  const stored = {
    id: run.id,
    url: run.url,
    status: 'done',
    error: null,
    report: run.report,
  };
  writeFileSync(join(run.dir, 'report.json'), JSON.stringify(stored));
  const history = readHistory().filter((item) => item.id !== run.id);
  history.unshift({
    id: run.id,
    url: run.url,
    finishedAt: run.report.finishedAt,
    counts: run.report.counts,
    clicks: run.report.clicks,
  });
  writeFileSync(historyFile, JSON.stringify(history.slice(0, 30), null, 2));
  ensurePdfs(run.id, run.dir, run.report).catch((err) => {
    console.error(`PDF build failed for ${run.id}:`, err instanceof Error ? err.message : err);
  });
}

function loadStored(id) {
  const live = runs.get(id);
  if (live?.report) return { dir: live.dir, report: live.report };
  const file = join(dataDir, id, 'report.json');
  if (!existsSync(file)) return null;
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    return stored?.report ? { dir: join(dataDir, id), report: stored.report } : null;
  } catch {
    return null;
  }
}

function ensurePdfs(id, dir, report) {
  const design = join(dir, 'design.pdf');
  const testing = join(dir, 'testing.pdf');
  if (existsSync(design) && existsSync(testing)) return Promise.resolve();
  if (!pdfJobs.has(id)) {
    const job = buildPdfs(dir, report).finally(() => pdfJobs.delete(id));
    pdfJobs.set(id, job);
  }
  return pdfJobs.get(id);
}

function readHistory() {
  if (!existsSync(historyFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(historyFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readDemos() {
  if (demoCache) return demoCache;
  if (!existsSync(demoFile)) {
    demoCache = [];
    return demoCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(demoFile, 'utf8'));
    demoCache = Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    demoCache = [];
  }
  return demoCache;
}

function isRunId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function writeEvent(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

const port = Number(process.env.PORT) || 4173;
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Odyssey is running at http://localhost:${port}`);
  });
}

export default app;
