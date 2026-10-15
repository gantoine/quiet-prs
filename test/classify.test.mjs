import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const root = import.meta.dirname;
const code = await readFile(path.join(root, '..', 'extension', 'content', 'classify.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(code, context);
const lanes = context.PRLanes;

const rules = lanes.buildRules({});

function kind(author, custom) {
  return lanes.classifyAuthor(author, custom ? lanes.buildRules(custom) : rules);
}

test('github app logins are bots', () => {
  assert.equal(kind({ login: 'github-actions', suffixedBot: true }), 'bot');
  assert.equal(kind({ login: 'some-unknown-app', suffixedBot: true }), 'bot');
});

test('known bot logins are bots without a suffix', () => {
  assert.equal(kind({ login: 'coderabbitai' }), 'bot');
  assert.equal(kind({ login: 'Codecov' }), 'bot');
});

test('github app avatars are bots', () => {
  assert.equal(kind({ login: 'mystery-reviewer', appAvatar: true }), 'bot');
});

test('the bot badge in the comment header is a bot', () => {
  assert.equal(kind({ login: 'mystery-reviewer', botBadge: true }), 'bot');
});

test('plain accounts are humans', () => {
  assert.equal(kind({ login: 'gantoine' }), 'human');
  assert.equal(kind({ login: 'robotics-fan' }), 'human');
});

test('heuristics catch token-driven bots and can be turned off', () => {
  assert.equal(kind({ login: 'release-bot' }), 'bot');
  assert.equal(kind({ login: 'posthog-ci-bot' }), 'bot');
  assert.equal(kind({ login: 'posthog-buildbot' }), 'bot');
  assert.equal(kind({ login: 'deploy-ci' }), 'bot');
  assert.equal(kind({ login: 'some-app' }), 'bot');
  assert.equal(kind({ login: 'release-bot' }, { heuristics: false }), 'human');
});

test('extra bots come from settings', () => {
  assert.equal(kind({ login: 'hedgehog' }), 'human');
  assert.equal(kind({ login: 'hedgehog' }, { extraBots: 'hedgehog\nother' }), 'bot');
});

test('the human override wins over every bot signal', () => {
  const custom = { forceHumans: 'copilot' };
  assert.equal(kind({ login: 'copilot', suffixedBot: true, appAvatar: true, botBadge: true }, custom), 'human');
});

test('logins normalize across decoration', () => {
  assert.equal(lanes.normalizeLogin('  @Dependabot[bot] '), 'dependabot');
  assert.deepEqual(Array.from(lanes.parseLoginList('a, b\nc  d')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(Array.from(lanes.parseLoginList('')), []);
});

test('an unknown author counts as a person, so their comment is never hidden', () => {
  assert.equal(kind({ login: '' }), 'human');
});

test('the settings schema is exported for both the content script and the options page', () => {
  assert.deepEqual(Object.keys(lanes.DEFAULTS).sort(), [
    'collapseBots',
    'defaultHideBots',
    'defaultHideEvents',
    'extraBots',
    'forceHumans',
    'heuristics',
    'hideResolvedThreads',
    'keepBotApprovals',
    'keepBotChangeRequests',
    'keepBotReviewComments',
    'rememberPerRepo'
  ]);
  assert.ok(lanes.CLASSIFICATION_KEYS.every((key) => key in lanes.DEFAULTS));
  assert.ok(Object.values(lanes.REVIEW_KEEP_SETTINGS).every((key) => key in lanes.DEFAULTS));
});

test('apps dropped from the built-in list are still caught by their bot signals', () => {
  for (const login of ['claude', 'cursor', 'percy', 'chromatic', 'stale']) {
    assert.equal(kind({ login }), 'human', `${login} is not assumed to be a bot by name alone`);
    assert.equal(kind({ login, suffixedBot: true }), 'bot');
    assert.equal(kind({ login, appAvatar: true }), 'bot');
  }
});

test('an author linking to /apps/ is a bot whatever the display name says', () => {
  assert.equal(kind({ login: 'copilot', appLink: true }), 'bot');
  assert.equal(kind({ login: 'a-friendly-name', appLink: true }), 'bot');
  assert.equal(kind({ login: 'a-friendly-name' }), 'human');
});

test('the human override still wins over an app link', () => {
  assert.equal(kind({ login: 'copilot', appLink: true }, { forceHumans: 'copilot' }), 'human');
});
