import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.E2E_PORT || 8745);
const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT || 9322);
const PAGE_PATH = '/PostHog/posthog/pull/30000/';
const STUB = 'test/extension-stub.js';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css' };

async function contentScripts() {
  const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const [entry] = manifest.content_scripts;
  return [STUB, ...entry.js.map((file) => `extension/${file}`), ...entry.css.map((file) => `extension/${file}`)];
}

async function buildPage(assets) {
  const html = await readFile(path.join(root, 'test', 'e2e-page.html'), 'utf8');
  const tags = assets.map((asset) =>
    asset.endsWith('.css')
      ? `<link rel="stylesheet" href="/${asset}" />`
      : `<script src="/${asset}"></script>`
  );
  return html.replace('</body>', tags.join('') + '</body>');
}

async function startServer(assets, page) {
  const server = createServer(async (request, response) => {
    const asset = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (assets.includes(asset)) {
      response.writeHead(200, { 'content-type': TYPES[path.extname(asset)] });
      response.end(await readFile(path.join(root, asset)));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  return server;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp connection failed')), { once: true });
  });
  return new Cdp(socket);
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

const SNAPSHOT = `(() => {
  const rows = {};
  const strips = {};
  const logins = {};
  for (const row of document.querySelectorAll('[data-row]')) {
    rows[row.dataset.row] = {
      actor: row.dataset.prlanesActor,
      form: row.dataset.prlanesForm,
      pinned: row.dataset.prlanesPin === '1',
      visible: getComputedStyle(row).display !== 'none',
      fold: row.dataset.prlanesFold || null
    };
    if (row.dataset.prlanesLogin) logins[row.dataset.row] = row.dataset.prlanesLogin;
    const strip = row.querySelector(':scope > .prlanes-strip');
    if (!strip) continue;
    const face = strip.querySelector('.prlanes-strip-face');
    const body = Array.from(row.children).find((child) => !child.classList.contains('prlanes-strip'));
    strips[row.dataset.row] = {
      shown: getComputedStyle(strip).display !== 'none',
      who: strip.querySelector('.prlanes-strip-who').textContent,
      preview: strip.querySelector('.prlanes-strip-preview').textContent,
      face: face.tagName.toLowerCase() === 'img' ? face.getAttribute('src') : 'icon',
      title: strip.getAttribute('title'),
      hideShown: (() => { const h = row.querySelector('.prlanes-hide'); return Boolean(h) && getComputedStyle(h).display !== 'none'; })(),
      hideIn: (() => { const h = row.querySelector('.prlanes-hide'); return !h ? null : h.parentElement.matches('.timeline-comment-actions') ? 'actions' : h.parentElement.matches('.timeline-comment-header') ? 'header' : 'row'; })(),
      more: strip.querySelector('.prlanes-strip-more').textContent,
      bodyHidden: Boolean(body) && getComputedStyle(body).display === 'none'
    };
  }
  const shown = (role) => {
    const node = document.querySelector('[data-role="' + role + '"]');
    return Boolean(node) && Boolean(node.getClientRects().length);
  };
  const orphans = { status: shown('bot-status'), tooltip: shown('bot-tooltip') };
  const bar = document.querySelector('.prlanes-bar');
  const barCount = document.querySelectorAll('.prlanes-bar').length;
  if (!bar) return { rows, strips, logins, orphans, hasBar: false, barCount };
  return {
    rows,
    strips,
    logins,
    orphans,
    hasBar: true,
    barCount,
    hiding: Object.fromEntries(Array.from(bar.querySelectorAll('.prlanes-toggle')).map((button) => [
      button.dataset.hide,
      {
        on: button.classList.contains('prlanes-toggle--on'),
        label: button.querySelector('.prlanes-label').textContent,
        title: button.getAttribute('title'),
        lit: button.classList.contains('prlanes-toggle--lit')
      }
    ])),
    icons: bar.querySelectorAll('.prlanes-icon svg').length,
    gearIcon: Boolean(bar.querySelector('.prlanes-settings .prlanes-gear')),
    barText: bar.textContent.trim(),
    barBeforeTimeline: bar.nextElementSibling === document.querySelector('.js-discussion'),
    slot: ['rail', 'state', 'tabs', 'header'].find((name) => bar.classList.contains('prlanes-bar--' + name)) || 'timeline',
    railLeft: bar.style.left,
    railTop: bar.style.top,
    slotParent: String(bar.parentElement.className)
  };
})()`;

const assets = await contentScripts();
const page = await buildPage(assets);

if (process.argv.includes('--serve')) {
  await startServer(assets, page);
  console.log(`serving the extension against the test timeline at http://localhost:${PORT}${PAGE_PATH}`);
} else {
  const workdir = await mkdtemp(path.join(tmpdir(), 'prlanes-e2e-'));
  const server = await startServer(assets, page);
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(workdir, 'profile')}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let failure = null;

  try {
    const version = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return response.ok ? response.json() : null;
    }, 20000, 'devtools endpoint');

    const browser = await connect(version.webSocketDebuggerUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: `http://localhost:${PORT}${PAGE_PATH}` });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Runtime.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        throw new Error(`${details.text}: ${(details.exception && (details.exception.description || details.exception.value)) || expression.slice(0, 80)}`);
      }
      return result.result.value;
    };

    const clickToggle = (name) => evaluate(`document.querySelector('.prlanes-toggle[data-hide="${name}"]').click()`);
    const settings = (values) => evaluate(`globalThis.prLanesStorage.sync.set(${JSON.stringify(values)})`);
    const until = (label, ready) =>
      waitFor(async () => {
        const state = await evaluate(SNAPSHOT);
        return ready(state) ? state : null;
      }, 5000, label);

    await waitFor(() => evaluate('Boolean(document.querySelector(".prlanes-bar"))'), 15000, 'bar injection');

    const quiet = await evaluate(SNAPSHOT);

    assert.deepEqual(
      quiet.hiding.bots,
      { on: true, label: 'Show bots', title: 'Show bots (B)', lit: true },
      'a conversation opens with bots hidden, so the button offers to show them'
    );
    assert.deepEqual(
      quiet.hiding.events,
      { on: false, label: 'Hide events', title: 'Hide events (E)', lit: true },
      'and with timeline events left alone, so that button offers to hide them'
    );
    assert.equal(quiet.slot, 'rail', 'the buttons sit in a rail under the author avatar at rest');
    assert.equal(quiet.railLeft, '-72px', 'the rail lines up with the avatar gutter');
    assert.equal(quiet.railTop, '52px', 'the rail sits 12px under a 40px avatar');
    assert.equal(quiet.icons, 2, 'each button carries an icon');
    assert.equal(quiet.gearIcon, true, 'settings is a gear icon');
    assert.equal(quiet.barText, 'QuietShow botsHide events', 'the bar carries no counts');

    // Hiding a bot reviewer takes its whole row, not just the name: no orphan status icons.
    assert.equal(quiet.orphans.status, false, 'the review-status icon goes with the reviewer it belongs to');
    assert.equal(quiet.orphans.tooltip, false, 'and so does its tooltip');

    const uncollapsed = (fields) => Object.assign({ fold: null }, fields);

    // People's comments are never touched.
    assert.deepEqual(quiet.rows['pr-body'], uncollapsed({ actor: 'human', form: 'comment', pinned: true, visible: true }));
    assert.deepEqual(quiet.rows['spoof-comment'], uncollapsed({ actor: 'human', form: 'comment', pinned: false, visible: true }));

    // Posted on a person's account, but through an app: GitHub hangs the app's avatar beside theirs.
    assert.deepEqual(quiet.rows['via-app'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' },
      'a comment an app posted for somebody is the app talking');
    assert.equal(quiet.strips['via-app'].face, 'https://avatars.githubusercontent.com/in/1236702?s=40', 'and the strip wears the app face, not the account one');
    assert.equal(quiet.logins['via-app'], 'gantoine', 'while still naming the account it went out on');
    assert.deepEqual(quiet.rows['human-thread'], uncollapsed({ actor: 'human', form: 'comment', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['human-event'], uncollapsed({ actor: 'human', form: 'event', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['human-event-with-bot'], uncollapsed({ actor: 'human', form: 'event', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['composer'], uncollapsed({ actor: 'none', form: 'chrome', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['reviewer-human'], uncollapsed({ actor: 'human', form: 'reviewer', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['reviewer-team'], uncollapsed({ actor: 'human', form: 'reviewer', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['reviewer-badged'], uncollapsed({ actor: 'bot', form: 'reviewer', pinned: false, visible: false }),
      'a bot badge counts in the sidebar the same as it does in the timeline');

    // Bot comments shrink to a strip; everything else a bot did goes.
    assert.deepEqual(quiet.rows['bot-comment'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' });
    assert.deepEqual(quiet.rows['avatar-bot'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' });
    assert.deepEqual(quiet.rows['bot-review'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' });
    assert.deepEqual(quiet.rows['resolved-thread-review'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' });
    assert.deepEqual(quiet.rows['ai-review'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' });
    assert.deepEqual(quiet.rows['bot-event'], uncollapsed({ actor: 'bot', form: 'event', pinned: false, visible: false }));
    assert.deepEqual(quiet.rows['reviewer-bot'], uncollapsed({ actor: 'bot', form: 'reviewer', pinned: false, visible: false }));

    // Suggestions are nobody's review yet, so the bots button has no business with them.
    assert.equal(quiet.rows['suggested-human'].actor, undefined, 'a suggested reviewer is never classified');
    assert.equal(quiet.rows['suggested-human'].visible, true);
    assert.equal(quiet.rows['suggested-bot'].actor, undefined, 'not even a suggested bot');
    assert.equal(quiet.rows['suggested-bot'].visible, true, 'suggesting a bot is not the same as one reviewing');

    // A review whose threads have not loaded yet is still the review, not a timeline event.
    assert.deepEqual(quiet.rows['lazy-review'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'strip' },
      'a bot review with nothing but collapsed threads still gets a strip to open');
    assert.equal(quiet.strips['lazy-review'].who, 'greptile-apps');

    // The note GitHub parks on an agent's pull request belongs to the bot it names.
    assert.deepEqual(quiet.rows['copilot-prompt'], uncollapsed({ actor: 'bot', form: 'chrome', pinned: false, visible: false }),
      'the "Mention @copilot" note goes with the bots');

    // Commits belong to nobody, so hiding bots never takes them.
    assert.deepEqual(quiet.rows['human-commit'], uncollapsed({ actor: 'none', form: 'commit', pinned: false, visible: true }));
    assert.deepEqual(quiet.rows['bot-commit'], uncollapsed({ actor: 'none', form: 'commit', pinned: false, visible: true }));

    assert.deepEqual(
      quiet.strips['bot-comment'],
      {
        shown: true,
        who: 'github-actions',
        preview: 'All checks have passed.',
        face: 'icon',
        title: 'Show this comment',
        hideShown: false,
        hideIn: 'row',
        more: '',
        bodyHidden: true
      },
      'a hidden bot comment shrinks to its face, its name and one line of what it said'
    );
    assert.equal(
      quiet.strips['avatar-bot'].face,
      'https://avatars.githubusercontent.com/in/15368?v=4',
      'a bot with an avatar wears it; one without falls back to the bot glyph'
    );
    assert.equal(quiet.strips['human-thread'], undefined, 'a comment nobody is hiding is built no strip at all');
    assert.equal(quiet.logins['human-thread'], 'gantoine', 'a thread a bot opened but a person replied to speaks for the person');
    assert.equal(quiet.strips['bot-event'], undefined, 'timeline events have nothing worth previewing');
    assert.equal(quiet.strips['reviewer-bot'], undefined, 'nor do sidebar reviewers');
    assert.equal(quiet.strips['pr-body'], undefined, 'nor does the pull request description');

    // A strip opens the run it stands for, and nothing else moves.
    await evaluate('document.querySelector(\'[data-row="bot-comment"] > .prlanes-strip\').click()');
    const peeked = await until('a strip click to open its own comment', (state) => state.rows['bot-comment'].fold === 'open');
    assert.equal(peeked.strips['bot-comment'].bodyHidden, false, 'the comment it stands for is there');
    assert.equal(peeked.strips['bot-comment'].shown, false, 'and the strip that stood in for it is done');
    assert.equal(peeked.strips['bot-comment'].hideShown, true, 'a Hide takes its place');
    assert.equal(peeked.strips['bot-comment'].hideIn, 'actions', 'beside the pencil and the kebab');
    assert.equal(peeked.hiding.bots.on, true, 'the button above it did not move');
    assert.equal(peeked.rows['avatar-bot'].fold, 'strip', 'and no other bot comment opened');

    await evaluate('document.querySelector(\'[data-row="bot-comment"] .prlanes-hide\').click()');
    const shut = await until('the Hide to fold it back up', (state) => state.rows['bot-comment'].fold === 'strip');
    assert.equal(shut.strips['bot-comment'].bodyHidden, true, 'the comment goes away again');
    assert.equal(shut.strips['bot-comment'].shown, true, 'and the strip comes back');
    assert.equal(shut.strips['bot-comment'].hideShown, false, 'shut: no Hide');

    // Back-to-back comments from one bot are one strip, and they open together.
    assert.equal(shut.rows['run-1'].fold, 'strip', 'the first of the run carries the strip');
    assert.equal(shut.rows['run-2'].fold, 'gone', 'the rest fold into it');
    assert.equal(shut.rows['run-3'].fold, 'gone');
    assert.equal(shut.strips['run-1'].more, '+2 more', 'and the strip says how many came with it');
    assert.equal(shut.strips['run-2'].shown, false, 'a follower shows no strip of its own');

    await evaluate('document.querySelector(\'[data-row="run-1"] > .prlanes-strip\').click()');
    const run = await until('the run to open together', (state) => state.rows['run-1'].fold === 'open');
    assert.equal(run.rows['run-2'].fold, 'with', 'every comment in the run comes with it');
    assert.equal(run.rows['run-3'].fold, 'with');
    assert.equal(run.rows['run-2'].visible, true, 'run-2 visible');
    assert.equal(run.rows['run-3'].visible, true, 'run-3 visible');
    assert.equal(run.strips['run-1'].hideShown, true, 'one Hide folds the whole run');
    assert.equal(run.strips['run-1'].hideIn, 'header', 'in the header, for a comment with no actions of its own');
    assert.equal(run.strips['run-2'].hideShown, false, 'the followers carry none');

    await evaluate('document.querySelector(\'[data-row="run-1"] .prlanes-hide\').click()');
    await until('the run to fold back together', (state) => state.rows['run-1'].fold === 'strip' && state.rows['run-3'].fold === 'gone');

    // Showing the bots hands every run back to the button, and gives each one a Hide of its own.
    await clickToggle('bots');
    const loud = await until('the bots to come back whole', (state) => !state.hiding.bots.on);
    assert.deepEqual(loud.rows['bot-comment'], { actor: 'bot', form: 'comment', pinned: false, visible: true, fold: 'open' });
    assert.equal(loud.rows['run-1'].fold, 'open', 'a run stays a run, just an open one');
    assert.equal(loud.rows['run-2'].fold, 'with');
    assert.equal(loud.strips['run-1'].hideShown, true, 'with a Hide to fold it on its own');
    assert.equal(loud.rows['bot-event'].visible, true, 'bot timeline events come back with them');
    assert.equal(loud.rows['reviewer-bot'].visible, true, 'so do bot reviewers');
    assert.equal(loud.hiding.bots.label, 'Hide bots', 'and the button now offers to put them away again');
    assert.equal(loud.hiding.events.on, false, 'the other button did not move');

    // A Hide while the bots are shown folds that run alone.
    await evaluate('document.querySelector(\'[data-row="run-1"] .prlanes-hide\').click()');
    const lone = await until('one run folded while the rest stay out', (state) => state.rows['run-1'].fold === 'strip');
    assert.equal(lone.rows['run-3'].fold, 'gone', 'the whole run goes with it');
    assert.equal(lone.rows['bot-comment'].fold, 'open', 'and nothing else moved');
    assert.equal(lone.hiding.bots.on, false, 'least of all the button');

    await clickToggle('bots');
    await until('the bots button to go back on', (state) => state.hiding.bots.on && state.rows['bot-comment'].fold === 'strip');

    // The events button is independent of the bots one.
    await clickToggle('events');
    const still = await until('timeline events to go', (state) => state.hiding.events.on);
    assert.equal(still.hiding.events.label, 'Show events');
    assert.equal(still.rows['human-event'].visible, false, 'a person labelling something is still an event');
    assert.equal(still.rows['human-commit'].visible, false, 'and so is a commit');
    assert.equal(still.rows['bot-commit'].visible, false, 'still: bot-commit gone');
    assert.equal(still.rows['pr-body'].visible, true, 'comments are untouched by the events button');
    assert.equal(still.rows['spoof-comment'].visible, true, 'still: spoof visible');
    assert.equal(still.rows['bot-comment'].fold, 'strip', 'and the bots button is still doing its own job');

    await clickToggle('bots');
    const eventsOnly = await until('the bots to come back while events stay hidden', (state) => !state.hiding.bots.on);
    assert.equal(eventsOnly.rows['bot-comment'].fold, 'open');
    assert.equal(eventsOnly.rows['bot-event'].visible, false, 'a bot event is an event either way');
    assert.equal(eventsOnly.rows['human-commit'].visible, false, 'eventsOnly: commit gone');

    await clickToggle('bots');
    await clickToggle('events');
    await until('back to bots hidden, events shown', (state) => state.hiding.bots.on && !state.hiding.events.on);

    // b and e work the buttons from the keyboard, but not while you are writing.
    const press = (key) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);

    await press('b');
    await until('b to show the bots', (state) => !state.hiding.bots.on);
    await press('e');
    await until('e to hide the events', (state) => state.hiding.events.on);

    await evaluate(`(() => {
      const box = document.querySelector('[data-row="composer"] textarea');
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const whileTyping = await evaluate(SNAPSHOT);
    assert.equal(whileTyping.hiding.bots.on, false, 'b typed into a comment box does not move the button');
    assert.equal(whileTyping.hiding.events.on, true, 'nor does e');
    await evaluate('document.activeElement.blur()');

    await press('b');
    await press('e');
    await until('both buttons back to their opening positions', (state) => state.hiding.bots.on && !state.hiding.events.on);

    // A comment that arrives after the page settled is classified and hidden like the rest.
    await evaluate(`(() => {
      const timeline = document.querySelector('.js-discussion rails-partial');
      const row = document.createElement('div');
      row.className = 'js-timeline-item';
      row.dataset.row = 'late-bot';
      row.innerHTML = '<div class="TimelineItem"><div class="timeline-comment"><div class="timeline-comment-header"><a class="author" href="/codecov">codecov</a></div><div class="comment-body">Coverage dropped.</div></div></div>';
      timeline.appendChild(row);
    })()`);
    const late = await until('a lazily loaded bot comment to be classified', (state) => state.rows['late-bot'] && state.rows['late-bot'].actor === 'bot');
    assert.equal(late.rows['late-bot'].fold, 'strip', 'a bot comment that arrives late gets a strip too');
    assert.equal(late.strips['late-bot'].preview, 'Coverage dropped.');
    assert.equal(late.hiding.bots.lit, true, 'the bots button stays lit');

    // The badge octicon is the first signal a row is a commit; its GraphQL id is the fallback.
    await evaluate(`(() => {
      const timeline = document.querySelector('.js-discussion rails-partial');
      const row = document.createElement('div');
      row.className = 'js-timeline-item';
      row.dataset.row = 'badgeless-commit';
      row.setAttribute('data-gid', 'C_kwDObeefbeef');
      row.innerHTML = '<div class="TimelineItem"><div class="TimelineItem-body"><a class="author" href="/apps/pre-commit-ci">pre-commit-ci</a> pushed a commit</div></div>';
      timeline.appendChild(row);
    })()`);
    const byId = await until('a commit row with no badge to be known by its commit id', (state) => state.rows['badgeless-commit'] && state.rows['badgeless-commit'].form);
    assert.equal(byId.rows['badgeless-commit'].form, 'commit');
    assert.equal(byId.rows['badgeless-commit'].visible, true, 'a bot push is still a commit, not a bot comment');
    await evaluate('document.querySelector(\'[data-row="badgeless-commit"]\').remove()');

    // Collapsing is a choice of its own: without it a hidden bot comment goes altogether.
    await settings({ collapseBots: false });
    const gone = await until('bot comments to go outright', (state) => state.rows['bot-comment'].visible === false);
    assert.equal(gone.strips['bot-comment'], undefined, 'and to leave no strip behind');
    assert.equal(gone.rows['bot-comment'].fold, null);
    assert.equal(gone.rows['human-thread'].visible, true, 'people are untouched either way');
    assert.equal(gone.hiding.bots.lit, true, 'the button still knows there is something to hide');
    await settings({ collapseBots: true });
    const back = await until('the strips to come back', (state) => state.rows['bot-comment'].fold === 'strip');
    assert.equal(back.strips['bot-comment'].preview, 'All checks have passed.');

    // Resolved threads are a settings-page choice, not a button.
    await settings({ hideResolvedThreads: true });
    const noResolved = await until('resolved threads to go', (state) => state.rows['resolved-thread'].visible === false);
    assert.equal(noResolved.rows['resolved-thread-review'].visible, true, 'the review around it stays');
    await settings({ hideResolvedThreads: false });
    await until('resolved threads to come back', (state) => state.rows['resolved-thread'].visible);

    // The defaults move a conversation you have not touched yet, and only that one.
    await evaluate('delete globalThis.prLanesStorage.local.data.hide');
    await settings({ defaultHideBots: false, defaultHideEvents: true });
    const reopened = await until('the opening positions to change', (state) => !state.hiding.bots.on);
    assert.equal(reopened.hiding.events.on, true, 'reopened: events on');
    assert.equal(reopened.rows['bot-comment'].fold, 'open');
    await evaluate('delete globalThis.prLanesStorage.local.data.hide');
    await settings({ defaultHideBots: true, defaultHideEvents: false });
    await until('the opening positions to change back', (state) => state.hiding.bots.on && !state.hiding.events.on);

    await settings({ rememberPerRepo: true });
    await clickToggle('events');
    const remembered = await waitFor(
      () => evaluate('globalThis.prLanesStorage.local.data["hide:PostHog/posthog"] || null'),
      5000,
      'both buttons to be remembered against this repository'
    );
    assert.deepEqual(remembered, { bots: true, events: true }, 'the per-repository choice is stored under its own key');
    await settings({ rememberPerRepo: false });
    await clickToggle('events');
    await until('back to the opening positions', (state) => state.hiding.bots.on && !state.hiding.events.on);
    // An issue has no avatar to rail against, so the buttons go to the row the Open badge is in.
    await evaluate('document.querySelector(\'[data-role="avatar"]\').remove()');
    const beside = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.slot === 'state' ? state : null;
    }, 5000, 'the bar to fall in beside the Open badge without an avatar');
    assert.match(beside.slotParent, /metadataContent/, 'in the badge row, not the title row');

    await evaluate('document.querySelector(\'[data-role="state-row"]\').remove()');
    const tabs = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.slot === 'tabs' ? state : null;
    }, 5000, 'the bar to fall back to the tab row with no badge either');
    assert.match(tabs.slotParent, /TabNavList/, 'the fallback sits next to the tabs');

    await evaluate(`(() => {
      document.querySelector('[data-role="sticky"]').style.display = 'flex';
      window.dispatchEvent(new Event('scroll'));
    })()`);
    const sticky = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.slot === 'header' ? state : null;
    }, 5000, 'the bar to follow the sticky header');
    assert.match(sticky.slotParent, /TitleArea/, 'the bar rides the sticky header title row');

    await evaluate(`(() => {
      document.querySelector('[data-role="sticky"]').style.display = 'none';
      window.dispatchEvent(new Event('scroll'));
    })()`);
    const unstuck = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.slot === 'tabs' ? state : null;
    }, 5000, 'the bar to return to the tab row');
    assert.match(unstuck.slotParent, /TabNavList/);
    assert.equal(unstuck.railLeft, '', 'rail positioning is cleared when the bar leaves the rail');

    await evaluate('document.querySelector(\'[data-role="header"]\').remove()');
    const headerless = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.barBeforeTimeline ? state : null;
    }, 5000, 'the bar to fall back above the timeline when there is no header');
    assert.equal(headerless.slot, 'timeline', 'the bar falls back to its own row above the timeline');

    await evaluate(`(() => {
      const timeline = document.querySelector('.js-discussion rails-partial');
      const row = document.createElement('div');
      row.className = 'js-timeline-item';
      row.dataset.row = 'late-human';
      row.innerHTML = '<div class="TimelineItem"><div class="timeline-comment"><div class="timeline-comment-header"><a class="author" href="/gantoine">gantoine</a></div><div class="comment-body">Landing this now.</div></div></div>';
      timeline.appendChild(row);
    })()`);

    const liveHuman = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.rows['late-human'] && state.rows['late-human'].actor ? state : null;
    }, 5000, 'a comment that arrives live to be classified');
    assert.equal(liveHuman.rows['late-human'].actor, 'human');
    assert.equal(liveHuman.rows['late-human'].visible, true, 'a comment that arrives live is a person talking, so it shows');
    assert.equal(liveHuman.rows['late-human'].fold, null);

    await evaluate(`(() => {
      for (const row of document.querySelectorAll('[data-row]')) {
        if (row.dataset.prlanesActor === 'bot' && row.dataset.prlanesForm === 'comment') row.remove();
      }
    })()`);
    const noBots = await waitFor(async () => {
      const state = await evaluate(SNAPSHOT);
      return state.hiding.bots.lit === false ? state : null;
    }, 5000, 'the bots button to go dark once there is no bot left to hide');
    assert.equal(noBots.hiding.bots.on, true, 'the button stays on, it just has nothing to do');
    assert.equal(noBots.hiding.events.lit, true, 'the events button is still lit');
    assert.equal(noBots.rows['pr-body'].visible, true, 'the description is still there');

    await evaluate(`new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = '/extension/content/lanes.js';
      script.addEventListener('load', resolve);
      document.body.appendChild(script);
    })`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reinjected = await evaluate(SNAPSHOT);
    assert.equal(reinjected.barCount, 1, 'a second copy of the content script does not add a second switcher');

    await evaluate(`(() => {
      window.__mutations = 0;
      window.__mutationLog = [];
      const observer = new MutationObserver((records) => {
        window.__mutations += records.length;
        for (const record of records.slice(0, 4)) {
          const target = record.target.nodeType === 1 ? record.target.tagName.toLowerCase() + '.' + String(record.target.className || '').slice(0, 30) : String(record.target.nodeValue).slice(0, 30);
          window.__mutationLog.push(record.type + ' ' + (record.attributeName || '') + ' on ' + target);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      window.__stopCounting = () => observer.disconnect();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const idle = await evaluate('(() => { window.__stopCounting(); return { count: window.__mutations, log: window.__mutationLog }; })()');
    assert.equal(idle.count, 0, `extension is idle when nothing changes (saw ${idle.count}: ${idle.log.join('; ')})`);

    console.log('e2e: bar injected, rows classified, both buttons filter, strips shown, sidebar filtered, keyboard works, lazy rows handled, settings applied, idle after settling');
  } catch (error) {
    failure = error;
  } finally {
    chrome.kill('SIGKILL');
    server.close();
    await rm(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }

  if (failure) {
    console.error(`e2e failed: ${failure.message}`);
    process.exit(1);
  }
}
