/**
 * test/browser-tracker-blocking.test.js
 *
 * The sweep browser loads broker opt-out pages that pull in third-party
 * trackers (observed: try.abtasty.com, vendelux.com). Every such domain becomes
 * a CONNECT through the egress proxy, which on sandboxed runtimes surfaces a
 * per-site approval prompt to the user. installTrackerBlocking() aborts those
 * requests at the Playwright level. These tests pin the matcher behavior:
 * exact + subdomain matches, case-insensitivity, and no false positives on
 * real broker infrastructure.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isTrackerHost, TRACKER_HOSTS } = require('../lib/browser');

test('matches the two tracker domains observed on live broker pages', () => {
  assert.ok(isTrackerHost('try.abtasty.com'));
  assert.ok(isTrackerHost('abtasty.com'));
  assert.ok(isTrackerHost('vendelux.com'));
  assert.ok(isTrackerHost('cdn.vendelux.com'));
});

test('matches common analytics/ad-tech trackers and their subdomains', () => {
  assert.ok(isTrackerHost('www.google-analytics.com'));
  assert.ok(isTrackerHost('googletagmanager.com'));
  assert.ok(isTrackerHost('connect.facebook.net'));
  assert.ok(isTrackerHost('hotjar.com'));
  assert.ok(isTrackerHost('bat.bing.com'));
});

test('is case-insensitive and tolerates a port suffix', () => {
  assert.ok(isTrackerHost('TRY.ABTASTY.COM'));
  assert.ok(isTrackerHost('vendelux.com:443'));
});

test('does not block real broker or infrastructure hosts', () => {
  assert.ok(!isTrackerHost('www.spokeo.com'));
  assert.ok(!isTrackerHost('optout.intelius.com'));
  assert.ok(!isTrackerHost('privacy.lexisnexis.com'));
  assert.ok(!isTrackerHost('cdn.jsdelivr.net'));
  assert.ok(!isTrackerHost('example.com'));
});

test('does not match partial domain names (suffix without dot boundary)', () => {
  assert.ok(!isTrackerHost('notabtasty.com'));
  assert.ok(!isTrackerHost('vendelux.com.evil.com'));
});

test('matches the ad-tech/widget domains observed 2026-09-28', () => {
  assert.ok(isTrackerHost('s.company-target.com'));
  assert.ok(isTrackerHost('api.company-target.com'));
  assert.ok(isTrackerHost('ds.reson8.com'));
  assert.ok(isTrackerHost('d-code.liadm.com'));
  assert.ok(isTrackerHost('hubspotonwebflow.com'));
  assert.ok(isTrackerHost('assets.calendly.com'));
});

test('rejects empty and non-string input', () => {
  assert.ok(!isTrackerHost(''));
  assert.ok(!isTrackerHost(null));
  assert.ok(!isTrackerHost(undefined));
  assert.ok(!isTrackerHost(42));
});

test('blocklist is non-empty and has no duplicates', () => {
  assert.ok(TRACKER_HOSTS.length > 10);
  assert.equal(new Set(TRACKER_HOSTS).size, TRACKER_HOSTS.length);
});
