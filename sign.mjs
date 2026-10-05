import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from './env.mjs';

const root = import.meta.dirname;
const sourceDir = path.join(root, 'dist', 'firefox');
const artifactsDir = path.join(root, 'signed');
const dryRun = process.argv.includes('--dry-run');
const channelAt = process.argv.indexOf('--channel');
const channel = channelAt === -1 ? 'unlisted' : process.argv[channelAt + 1];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

if (channel !== 'listed' && channel !== 'unlisted') {
  fail(`--channel takes listed or unlisted, not ${channel}.`);
}

await loadEnvFile();

const apiKey = process.env.WEB_EXT_API_KEY || process.env.AMO_JWT_ISSUER;
const apiSecret = process.env.WEB_EXT_API_SECRET || process.env.AMO_JWT_SECRET;

if (!apiKey || !apiSecret) {
  fail('No addons.mozilla.org credentials. Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET in the environment, or copy .env.example to .env and paste in a key pair from https://addons.mozilla.org/developers/addon/api/key/');
}

const manifest = JSON.parse(await readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const signed = async () => (await readdir(artifactsDir).catch(() => [])).filter((file) => file.endsWith('.xpi'));
const already = channel === 'unlisted' ? (await signed()).filter((file) => file.endsWith(`-${manifest.version}.xpi`)) : [];

if (already.length) {
  fail(`signed/${already[0]} already exists, and addons.mozilla.org rejects a version it has already signed.\nBump "version" in extension/manifest.json first.`);
}

const args = [
  '--yes',
  'web-ext',
  'sign',
  '--source-dir',
  sourceDir,
  '--artifacts-dir',
  artifactsDir,
  '--channel',
  channel
];

if (channel === 'listed') {
  args.push('--approval-timeout', '0');
}

if (dryRun) {
  console.log(`version ${manifest.version}, signing ${path.relative(root, sourceDir)} as a ${channel} add-on`);
  console.log(`would run: npx ${args.join(' ')}`);
  console.log(`credentials: ${process.env.WEB_EXT_API_KEY ? 'WEB_EXT_API_KEY/WEB_EXT_API_SECRET' : 'AMO_JWT_ISSUER/AMO_JWT_SECRET'} are set`);
  console.log(`artifacts:  signed/`);
  process.exit(0);
}

await run('node', ['build.mjs']);
await run('npx', args, { env: { ...process.env, WEB_EXT_API_KEY: apiKey, WEB_EXT_API_SECRET: apiSecret } });

const produced = await signed();

if (produced.length) {
  console.log(`\nSigned: ${produced.map((file) => `signed/${file}`).join(', ')}`);
  console.log('Host that file anywhere and open the link in Firefox to install it.');
} else {
  console.log(`\nSubmitted version ${manifest.version} to addons.mozilla.org. Mozilla emails you when review finishes and the listing updates itself.`);
}
