/**
 * lib/browser.js - one place that decides how Chromium is launched.
 *
 * watcher.js launches a browser from four separate places (main opt-out run,
 * complaint-PDF rendering, --confirm-emails, HTML/PDF report rendering). Only
 * the main run used to pass any args, so the other three ran without the
 * anti-automation flags and without the container hardening below.
 *
 * The container flags matter more than they look. Docker gives a container 64MB
 * of /dev/shm. Chromium keeps renderer shared memory there and its tabs die
 * ("Target closed", SIGBUS) once it is exhausted, which on a small NAS shows up
 * as random per-broker failures rather than an obvious crash.
 * --disable-dev-shm-usage moves that allocation to /tmp, so a plain
 * `docker run` with no --shm-size works. docker-compose.yml additionally raises
 * shm_size, which is the faster of the two remedies when it is available.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Applied everywhere: strips the two most obvious automation tells. Broker
// sites fingerprint on these, so they are not optional.
const BASE_ARGS = [
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
];

// Linux-only. macOS/Windows have no 64MB /dev/shm to work around and the flag
// costs page-load performance there.
const LINUX_ARGS = [
  '--disable-dev-shm-usage',
];

// Opt-in via AIDR_LOW_MEMORY=1 or opts.lowMemory. Trades render fidelity for
// resident memory on boxes with ~2GB of RAM (Synology DS720+, Raspberry Pi,
// small VPS). Every flag here is verified to still launch and load a page:
// notably absent is --single-process, which Playwright does not support.
const LOW_MEMORY_ARGS = [
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees',
  '--no-zygote',
];

const VIEWPORT = { width: 1280, height: 900 };

/**
 * Decide headless vs headed.
 *
 * Explicit HEADLESS wins. Otherwise headless when we look like a Linux box with
 * no X display, which is the container and NAS case.
 *
 * @param {Record<string,string|undefined>} [env]
 * @param {string} [platform]
 * @returns {boolean}
 */
function resolveHeadless(env = process.env, platform = process.platform) {
  const v = env.HEADLESS;
  if (v !== undefined) {
    const s = String(v).toLowerCase();
    if (s === '1' || s === 'true') return true;
    if (s === '0' || s === 'false') return false;
  }
  return platform === 'linux' && !env.DISPLAY;
}

/**
 * @param {{ platform?: string, lowMemory?: boolean, env?: Record<string,string|undefined>, extraArgs?: string[] }} [opts]
 * @returns {string[]} a fresh array, safe for the caller to mutate
 */
function buildLaunchArgs(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const lowMemory = opts.lowMemory !== undefined
    ? !!opts.lowMemory
    : env.AIDR_LOW_MEMORY === '1' || env.AIDR_LOW_MEMORY === 'true';

  const args = [...BASE_ARGS];
  if (platform === 'linux') args.push(...LINUX_ARGS);
  if (lowMemory) {
    for (const flag of LOW_MEMORY_ARGS) {
      if (!args.includes(flag)) args.push(flag);
    }
  }
  // Sandboxed VMs whose egress proxy drops Chromium's CONNECTs need the
  // local forward proxy (see ~/workspace/bin/ensure-forwarder.sh). Opt in
  // with AIDR_PROXY=http://127.0.0.1:18888.
  const proxy = env.AIDR_PROXY;
  if (proxy) {
    const flag = `--proxy-server=${proxy}`;
    if (!args.includes(flag)) args.push(flag);
  }
  for (const flag of opts.extraArgs || []) {
    if (!args.includes(flag)) args.push(flag);
  }
  return args;
}

/**
 * Full options object for chromium.launchPersistentContext().
 *
 * On sandbox VMs the system NSS DB (/home/hatch/.pki/nssdb) is a read-only
 * mount carrying the MITM CA, and Chromium needs *write* access to its DB
 * directory or every https navigation fails with ERR_CERT_AUTHORITY_INVALID.
 * ensureNssDb() copies it to a writable per-user location and the launch
 * options point Chromium there via HOME. Off-sandbox (no system DB) this is
 * a no-op and HOME is left alone.
 *
 * @param {{ headless?: boolean, platform?: string, lowMemory?: boolean, env?: object, extraArgs?: string[], viewport?: object }} [opts]
 */
function buildLaunchOptions(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const launch = {
    headless: opts.headless !== undefined ? !!opts.headless : resolveHeadless(env, platform),
    viewport: opts.viewport || { ...VIEWPORT },
    args: buildLaunchArgs({ platform, lowMemory: opts.lowMemory, env, extraArgs: opts.extraArgs }),
    ignoreDefaultArgs: ['--enable-automation'],
  };
  const chromeHome = ensureNssDb(env);
  if (chromeHome) launch.env = { ...env, HOME: chromeHome };
  return launch;
}

// Read-only system NSS DB carrying the sandbox MITM CA (absent off-sandbox).
const SYSTEM_NSSDB = '/home/hatch/.pki/nssdb';

/**
 * Ensure Chromium gets a writable NSS DB that trusts the sandbox MITM CA.
 *
 * Copies the read-only system DB to ~/.chrome-home/.pki/nssdb on first use
 * (re-copies when the source DB is newer than the copy) and returns the HOME
 * value Chromium should be launched with. Returns undefined when there is no
 * system DB, i.e. on machines that need no special handling. Never throws:
 * on any failure the caller launches with the default HOME.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string|undefined}
 */
function ensureNssDb(env = process.env) {
  try {
    const srcDb = path.join(SYSTEM_NSSDB, 'cert9.db');
    if (!fs.existsSync(srcDb)) return undefined;
    const home = env.HOME || os.homedir() || '/root';
    const chromeHome = path.join(home, '.chrome-home');
    const destDir = path.join(chromeHome, '.pki', 'nssdb');
    const marker = path.join(destDir, '.aidr-nss-ready');
    const srcMtime = fs.statSync(srcDb).mtimeMs;
    let markerMtime = 0;
    try { markerMtime = fs.statSync(marker).mtimeMs; } catch (_) { /* first run */ }
    if (markerMtime < srcMtime) {
      fs.mkdirSync(destDir, { recursive: true });
      for (const f of fs.readdirSync(SYSTEM_NSSDB)) {
        const s = path.join(SYSTEM_NSSDB, f);
        if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(destDir, f));
      }
      try { fs.chmod(destDir, 0o700); } catch (_) { /* best effort */ }
      fs.writeFileSync(marker, String(srcMtime));
    }
    return chromeHome;
  } catch (_) {
    return undefined;
  }
}

/**
 * Tracker/ad-tech domains blocked in the sweep browser.
 *
 * Every third-party request the browser makes becomes a CONNECT through the
 * egress proxy, and on sandboxed runtimes each new external domain can surface
 * a per-site approval prompt to the user. Broker opt-out pages are full of
 * this junk (observed in the wild: try.abtasty.com, vendelux.com). Blocking it
 * at the request level keeps the sweep to the broker's own infrastructure:
 * fewer prompts, faster page loads, and less fingerprinting surface.
 * Pure blocklist: only these exact domains and their subdomains are aborted,
 * so functional third parties (CDNs, embedded form services) keep working.
 */
const TRACKER_HOSTS = [
  // Observed on broker opt-out pages during live runs
  'abtasty.com',
  'vendelux.com',
  // Observed 2026-09-28: ad-tech and widget domains broker pages pull in.
  // None of these participate in opt-out submission.
  'company-target.com',
  'reson8.com',
  'liadm.com',
  'hubspotonwebflow.com',
  'calendly.com',
  // A/B testing & personalization
  'optimizely.com',
  'vwo.com',
  'convert.com',
  // Analytics
  'google-analytics.com',
  'googletagmanager.com',
  'hotjar.com',
  'fullstory.com',
  'mixpanel.com',
  'segment.io',
  'amplitude.com',
  'newrelic.com',
  'nr-data.net',
  'crazyegg.com',
  'mouseflow.com',
  'luckyorange.com',
  'inspectlet.com',
  'quantummetric.com',
  'contentsquare.net',
  'hubspot.com', // hs-analytics / tracking pixels; forms use their own hosts
  'pardot.com',
  'piwik.pro',
  'matomo.cloud',
  // Ads & retargeting
  'googlesyndication.com',
  'doubleclick.net',
  'googleadservices.com',
  'googletagservices.com',
  '2mdn.net',
  'facebook.net',
  'criteo.com',
  'adsrvr.org',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
  'quantserve.com',
  'bluekai.com',
  'demdex.net',
  'omtrdc.net',
  'everesttech.net',
  'bat.bing.com',
  'analytics.tiktok.com',
  'ads-twitter.com',
  'static.ads-twitter.com',
];

/**
 * True when a hostname is a known tracker (exact or subdomain match).
 * Case-insensitive; a trailing port is ignored.
 *
 * @param {string} host e.g. "try.abtasty.com" or "GOOGLE-ANALYTICS.COM:443"
 * @returns {boolean}
 */
function isTrackerHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().split(':')[0].replace(/\.$/, '');
  if (!h) return false;
  return TRACKER_HOSTS.some((t) => h === t || h.endsWith('.' + t));
}

/**
 * Install request-level tracker blocking on a Playwright browser context.
 * Aborts requests to TRACKER_HOSTS, lets everything else through.
 * Returns the number of aborted requests (for logging).
 *
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<() => number>} getter for the blocked-request count
 */
async function installTrackerBlocking(context) {
  let blocked = 0;
  await context.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch (_) {
      return route.continue();
    }
    if (isTrackerHost(host)) {
      blocked += 1;
      return route.abort();
    }
    return route.continue();
  });
  return () => blocked;
}

/** True when the low-memory profile is active, for logging. */
function isLowMemory(env = process.env) {
  return env.AIDR_LOW_MEMORY === '1' || env.AIDR_LOW_MEMORY === 'true';
}

/** The proxy URL Chromium should use, or undefined when unset. */
function proxyUrl(env = process.env) {
  return env.AIDR_PROXY || undefined;
}

/**
 * TCP-level reachability check for an egress proxy URL.
 * Returns true when a connection to host:port opens within the timeout.
 * Never throws: any failure means "not reachable".
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function proxyReachable(url, timeoutMs = 5000) {
  const net = require('node:net');
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (_) {
      resolve(false);
      return;
    }
    const sock = net.connect(
      { host: target.hostname, port: parseInt(target.port || '80', 10) },
      () => { sock.destroy(); resolve(true); }
    );
    sock.setTimeout(timeoutMs);
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

module.exports = {
  buildLaunchArgs,
  buildLaunchOptions,
  resolveHeadless,
  isLowMemory,
  proxyUrl,
  proxyReachable,
  ensureNssDb,
  isTrackerHost,
  installTrackerBlocking,
  TRACKER_HOSTS,
  BASE_ARGS,
  LINUX_ARGS,
  LOW_MEMORY_ARGS,
  VIEWPORT,
};
