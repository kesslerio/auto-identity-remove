/**
 * test/browser-launch.test.js
 *
 * watcher.js launches Chromium from four separate places (main run, complaint
 * PDF rendering, --confirm-emails, report rendering). Three of them passed no
 * args at all, so container-hardening and anti-automation flags applied only to
 * the main run. lib/browser.js centralises the options so every launch site
 * gets the same treatment.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildLaunchArgs, buildLaunchOptions, resolveHeadless } = require('../lib/browser');

test('buildLaunchArgs always includes the anti-automation flags', () => {
  const args = buildLaunchArgs({ platform: 'darwin' });
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
});

test('buildLaunchArgs adds container-safe flags on linux', () => {
  const args = buildLaunchArgs({ platform: 'linux' });
  // /dev/shm defaults to 64MB inside Docker; Chromium renderers die once they
  // fill it. --disable-dev-shm-usage moves shared memory to /tmp.
  assert.ok(args.includes('--disable-dev-shm-usage'), 'linux launches must not depend on a large /dev/shm');
});

test('buildLaunchArgs omits the linux-only flag on macOS', () => {
  // macOS has no /dev/shm limit to work around, and the flag costs performance.
  assert.ok(!buildLaunchArgs({ platform: 'darwin' }).includes('--disable-dev-shm-usage'));
});

test('buildLaunchArgs adds a low-memory profile when asked', () => {
  const lean = buildLaunchArgs({ platform: 'linux', lowMemory: true });
  assert.ok(lean.includes('--disable-dev-shm-usage'));
  assert.ok(lean.includes('--single-process') === false, '--single-process breaks Playwright; must not be used');
  for (const flag of ['--disable-gpu', '--disable-extensions', '--no-zygote']) {
    assert.ok(lean.includes(flag), `low-memory profile should include ${flag}`);
  }
});

test('buildLaunchArgs returns a fresh array each call', () => {
  const a = buildLaunchArgs({ platform: 'linux' });
  a.push('--mutated');
  assert.ok(!buildLaunchArgs({ platform: 'linux' }).includes('--mutated'));
});

test('buildLaunchOptions carries viewport, args and ignoreDefaultArgs', () => {
  const opts = buildLaunchOptions({ platform: 'linux', headless: true });
  assert.equal(opts.headless, true);
  assert.deepEqual(opts.viewport, { width: 1280, height: 900 });
  assert.ok(opts.args.includes('--disable-dev-shm-usage'));
  assert.deepEqual(opts.ignoreDefaultArgs, ['--enable-automation']);
});

test('resolveHeadless honours an explicit HEADLESS env value', () => {
  for (const v of ['1', 'true', 'TRUE']) {
    assert.equal(resolveHeadless({ HEADLESS: v }, 'darwin'), true, `HEADLESS=${v} should force headless`);
  }
  for (const v of ['0', 'false', 'FALSE']) {
    assert.equal(resolveHeadless({ HEADLESS: v }, 'linux'), false, `HEADLESS=${v} should force headed`);
  }
});

test('resolveHeadless auto-detects headless for a linux box with no DISPLAY', () => {
  assert.equal(resolveHeadless({}, 'linux'), true);
  assert.equal(resolveHeadless({ DISPLAY: ':0' }, 'linux'), false);
  assert.equal(resolveHeadless({}, 'darwin'), false);
});

test('every chromium launch site in watcher.js goes through lib/browser', () => {
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'watcher.js'), 'utf8');
  const launches = watcher.match(/launchPersistentContext\(/g) || [];
  assert.ok(launches.length >= 4, `expected at least 4 launch sites, found ${launches.length}`);

  const optionCalls = watcher.match(/buildLaunchOptions\(/g) || [];
  assert.equal(
    optionCalls.length,
    launches.length,
    `all ${launches.length} launchPersistentContext calls must build their options via buildLaunchOptions(); `
    + `found ${optionCalls.length}. A launch site with hand-rolled options silently loses the container flags.`,
  );
});

test('buildLaunchArgs adds --proxy-server only when AIDR_PROXY is set', () => {
  const withProxy = buildLaunchArgs({ platform: 'linux', env: { AIDR_PROXY: 'http://127.0.0.1:18888' } });
  assert.ok(withProxy.includes('--proxy-server=http://127.0.0.1:18888'));
  const without = buildLaunchArgs({ platform: 'linux', env: {} });
  assert.ok(!without.some(a => a.startsWith('--proxy-server=')), 'no proxy flag without AIDR_PROXY');
});

test('proxyUrl reads AIDR_PROXY', () => {
  const { proxyUrl } = require('../lib/browser');
  assert.equal(proxyUrl({ AIDR_PROXY: 'http://127.0.0.1:18888' }), 'http://127.0.0.1:18888');
  assert.equal(proxyUrl({}), undefined);
});

test('ensureNssDb copies the system DB to a writable HOME and is idempotent', () => {
  const os = require('node:os');
  const { ensureNssDb } = require('../lib/browser');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-nss-test-'));
  const env = { HOME: fakeHome };
  const first = ensureNssDb(env);
  assert.equal(first, path.join(fakeHome, '.chrome-home'));
  const destDb = path.join(fakeHome, '.chrome-home', '.pki', 'nssdb', 'cert9.db');
  assert.ok(fs.existsSync(destDb), 'writable copy of the NSS DB must exist');
  const mtime1 = fs.statSync(path.join(fakeHome, '.chrome-home', '.pki', 'nssdb', '.aidr-nss-ready')).mtimeMs;
  const second = ensureNssDb(env);
  assert.equal(second, first);
  const mtime2 = fs.statSync(path.join(fakeHome, '.chrome-home', '.pki', 'nssdb', '.aidr-nss-ready')).mtimeMs;
  assert.equal(mtime2, mtime1, 'second call must not re-copy');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('ensureNssDb never throws and returns undefined without a system DB', () => {
  const { ensureNssDb } = require('../lib/browser');
  // Point HOME somewhere harmless; the function must survive any FS state.
  assert.doesNotThrow(() => ensureNssDb({ HOME: '/nonexistent-home-xyz' }));
});

test('proxyReachable: true for a listening socket, false for a closed port', async () => {
  const net = require('node:net');
  const { proxyReachable } = require('../lib/browser');
  const server = net.createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  assert.equal(await proxyReachable(`http://127.0.0.1:${port}`, 2000), true);
  await new Promise((res) => server.close(res));
  assert.equal(await proxyReachable(`http://127.0.0.1:${port}`, 2000), false);
});

test('proxyReachable: false for a malformed URL, never throws', async () => {
  const { proxyReachable } = require('../lib/browser');
  assert.equal(await proxyReachable('not a url', 1000), false);
});

test('watcher.js fail-fast: proxy check runs before the main-run browser launch', () => {
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'watcher.js'), 'utf8');
  const checkIdx = watcher.indexOf('_proxyReachable(proxy)');
  // The main opt-out run's launch site (other modes launch in their own branches).
  const launchIdx = watcher.indexOf('launchPersistentContext(profileDir, buildLaunchOptions({ headless }))');
  assert.ok(checkIdx > 0, 'watcher must call the proxy reachability check');
  assert.ok(launchIdx > 0, 'watcher must launch the main-run browser');
  assert.ok(checkIdx < launchIdx, 'proxy check must run before the main-run browser launch');
  assert.ok(watcher.includes('Refusing to run'), 'dead proxy must abort with a clear message');
});
