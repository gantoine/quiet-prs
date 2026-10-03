import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Shoots a real pull request twice (untouched, then with the out-of-the-box defaults) plus the
// labelled bar on its own, and composes tools/listing.html into the 1280x800 both stores ask for.
// The extension is injected rather than installed, the same trick test/e2e.mjs uses.

const root = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PR_URL = process.env.PR_URL || 'https://github.com/PostHog/posthog/pull/57759';
const PORT = Number(process.env.LISTING_PORT || 9421);
const OUT = path.join(root, 'docs', 'screenshots', 'listing-1280x800.png');

const PANEL_WIDTH = 290;
const LEAD_IN = 55; // a sliver of the row above the first bot comment, so the crop is not flush

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(args) {
  return spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', ...args], {
    stdio: 'ignore'
  });
}

async function connect() {
  let version;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch (error) {
      await wait(250);
    }
  }
  if (!version) throw new Error('chrome never came up');

  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

  let id = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  return (method, params = {}, sessionId) => {
    const mid = id++;
    socket.send(JSON.stringify({ id: mid, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
  };
}

const workdir = await mkdtemp(path.join(tmpdir(), 'prlanes-listing-'));
const chrome = launch([`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(workdir, 'profile')}`, '--window-size=1280,1600', 'about:blank']);

try {
  const send = await connect();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId);

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
    return result.result.value;
  };

  const file = (relative) => readFile(path.join(root, relative), 'utf8');

  await send('Page.addScriptToEvaluateOnNewDocument', { source: await file('test/extension-stub.js') }, sessionId);
  await send('Page.navigate', { url: PR_URL }, sessionId);
  await wait(9000);

  const css = await file('extension/content/lanes.css');
  await evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()`);
  await evaluate(await file('extension/content/classify.js'));
  await evaluate(await file('extension/content/lanes.js'));
  await wait(3000);

  if (!(await evaluate("Boolean(document.querySelector('.prlanes-bar'))"))) {
    throw new Error(`the extension never took hold on ${PR_URL}`);
  }

  const setHide = async (bots, events) => {
    await evaluate(`globalThis.prLanesStorage.local.set({ hide: { bots: ${bots}, events: ${events} } })`);
    await wait(1500);
  };

  const shoot = async (name) => {
    const height = await evaluate('document.documentElement.scrollHeight');
    const { data } = await send('Page.captureScreenshot', {
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1280, height: Math.min(height, 20000), scale: 1 }
    }, sessionId);
    await writeFile(path.join(workdir, name), Buffer.from(data, 'base64'));
    return height;
  };

  await setHide(false, false);
  const before = await shoot('before.png');

  await setHide(true, false);
  const after = await shoot('after.png');

  // Both panels crop to the same place: where the bots start talking. Above it the two states are
  // the same page, so a crop any higher shows nothing worth showing.
  const conversation = await evaluate(`(() => {
    const row = document.querySelector('[data-prlanes-actor="bot"][data-prlanes-form="comment"]:not([data-prlanes-pin="1"])');
    return row ? Math.round(row.getBoundingClientRect().top + window.scrollY) : -1;
  })()`);
  if (conversation < 0) throw new Error(`no bot comment to point at on ${PR_URL}`);

  const bar = JSON.parse(await evaluate(`(() => {
    const bar = document.querySelector('.prlanes-bar');
    bar.scrollIntoView({ block: 'center' });
    const r = bar.getBoundingClientRect();
    return JSON.stringify({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
  })()`));
  const shot = await send('Page.captureScreenshot', {
    captureBeyondViewport: true,
    clip: { x: bar.x - 8, y: bar.y - 8, width: bar.width + 16, height: bar.height + 16, scale: 3 }
  }, sessionId);
  await writeFile(path.join(workdir, 'bar.png'), Buffer.from(shot.data, 'base64'));

  const crop = Math.round((conversation - LEAD_IN) * (PANEL_WIDTH / 1280));
  const page = (await file('tools/listing.html')).replace(/\{\{CROP\}\}/g, String(crop));
  await writeFile(path.join(workdir, 'listing.html'), page);

  console.log(`${PR_URL}\n  before ${before}px, after ${after}px (${Math.round((1 - after / before) * 100)}% shorter)`);

  const composer = launch([
    '--window-size=1280,800',
    `--user-data-dir=${path.join(workdir, 'composer')}`,
    '--allow-file-access-from-files',
    `--screenshot=${OUT}`,
    `file://${path.join(workdir, 'listing.html')}`
  ]);
  await new Promise((resolve, reject) => {
    composer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`composer exited with ${code}`))));
    composer.on('error', reject);
  });

  console.log(`  ${path.relative(root, OUT)}`);
} finally {
  chrome.kill('SIGKILL');
  await rm(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
