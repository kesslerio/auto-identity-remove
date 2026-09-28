/**
 * test/error-backoff.test.js
 *
 * Failure backoff window (lib/config.js):
 *  - ERROR_RECHECK_DAYS is exported and equals 7
 *  - recordFailure stamps lastAttempt (without touching lastSuccess)
 *  - shouldSkip: broker whose last attempt failed recently → skip with reason
 *  - shouldSkip: failure older than the window → null (re-attempt)
 *  - shouldSkip: { ignoreErrorWindow: true } bypasses the backoff
 *    (--retry-failed) but not the success cooldown
 *  - shouldSkip: success cooldown still measured from the last SUCCESS,
 *    not the last attempt
 *  - shouldSkip: pending-confirm window still takes precedence
 *  - broker-runner: configure({ retryFailed: true }) threads
 *    ignoreErrorWindow through to shouldSkip
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cfg = require('../lib/config');

const N = '__test_error_backoff_broker__';
const daysAgoISO = (d) => new Date(Date.now() - d * 86400000).toISOString();

function withCleanState(fn) {
  const state = cfg.loadState();
  const prev = state.optOuts[N];
  try {
    delete state.optOuts[N];
    fn(state);
  } finally {
    if (prev === undefined) delete state.optOuts[N];
    else state.optOuts[N] = prev;
  }
}

test('ERROR_RECHECK_DAYS is exported and equals 7', () => {
  assert.equal(cfg.ERROR_RECHECK_DAYS, 7);
});

test('recordFailure stamps lastAttempt without touching lastSuccess', () => {
  withCleanState((state) => {
    const before = Date.now();
    cfg.setDryRun(true); // do not pollute state.json on disk
    cfg.recordFailure(N, 'error');
    cfg.setDryRun(false);
    const e = state.optOuts[N];
    assert.ok(e.lastAttempt, 'lastAttempt should be stamped');
    const stamped = new Date(e.lastAttempt).getTime();
    assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000, 'lastAttempt should be ~now');
    assert.equal(e.lastSuccess, undefined, 'lastSuccess must not be set by a failure');
  });
});

test('shouldSkip: recent failure → skip with backoff reason', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastAttempt: daysAgoISO(2) };
    const skip = cfg.shouldSkip(N);
    assert.ok(skip, 'should skip');
    assert.match(skip.reason, /retry in/);
  });
});

test('shouldSkip: failure older than the window → null (re-attempt)', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastAttempt: daysAgoISO(10) };
    assert.equal(cfg.shouldSkip(N), null);
  });
});

test('shouldSkip: ignoreErrorWindow bypasses the backoff (--retry-failed)', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastAttempt: daysAgoISO(2) };
    assert.equal(cfg.shouldSkip(N, { ignoreErrorWindow: true }), null);
  });
});

test('shouldSkip: ignoreErrorWindow does NOT bypass the success cooldown', () => {
  withCleanState((state) => {
    state.optOuts[N] = { lastSuccess: daysAgoISO(2) };
    const skip = cfg.shouldSkip(N, { ignoreErrorWindow: true });
    assert.ok(skip, 'success cooldown must still apply');
  });
});

test('shouldSkip: success cooldown is measured from the last success, not the last attempt', () => {
  withCleanState((state) => {
    // Succeeded 2d ago (cooldown active), last attempt stamp older → the
    // success cooldown governs, not the backoff.
    state.optOuts[N] = { lastSuccess: daysAgoISO(2), lastAttempt: daysAgoISO(100) };
    const skip = cfg.shouldSkip(N);
    assert.ok(skip, 'should skip');
    assert.match(skip.reason, /Last removed 2d ago/);
  });
});

test('shouldSkip: a fresh failure after an elapsed success cooldown uses the backoff, not the cooldown', () => {
  withCleanState((state) => {
    // Succeeded 100d ago (cooldown elapsed) but failed again 2d ago: the
    // failure is fresh evidence, so the 7-day backoff applies.
    state.optOuts[N] = { lastSuccess: daysAgoISO(100), lastAttempt: daysAgoISO(2) };
    const skip = cfg.shouldSkip(N);
    assert.ok(skip, 'should skip');
    assert.match(skip.reason, /retry in/);
  });
});

test('shouldSkip: pending-confirm window takes precedence over the failure backoff', () => {
  withCleanState((state) => {
    state.optOuts[N] = {
      lastAttempt: daysAgoISO(2),
      pendingConfirm: { since: daysAgoISO(2), snippet: 'x' },
    };
    const skip = cfg.shouldSkip(N);
    assert.ok(skip, 'should skip');
    assert.match(skip.reason, /Pending email confirmation/);
  });
});

// ─── broker-runner threads retryFailed through ───────────────────────────────

const Module = require('module');
const originalLoad = Module._load.bind(Module);

test('broker-runner passes retryFailed as ignoreErrorWindow to shouldSkip', async () => {
  const shouldSkipCalls = [];
  const configMock = {
    RECHECK_DAYS: 90,
    CONFIRM_RECHECK_DAYS: 14,
    lastOptOutDaysAgo: () => Infinity,
    shouldSkip: (key, opts) => { shouldSkipCalls.push({ key, opts }); return { reason: 'x' }; },
    isPendingConfirmation: () => false,
    recordSuccess: () => {},
    recordPendingConfirmation: () => {},
    recordFailure: () => {},
    loadState: () => ({ optOuts: {} }),
    saveCheckpoint: () => {},
    stateKey: (brokerName) => brokerName,
  };
  function patchedLoad(request, parent) {
    if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent);
    if (request === './config') return configMock;
    if (request === './logger') return { logResult: () => {} };
    if (request === './forms') return { fillForm: async () => {}, findListingUrl: async () => null };
    if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
    if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false }) };
    if (request === './retry') return { withRetry: (fn) => fn() };
    if (request === './timing') return { jitterSleep: async () => {} };
    return originalLoad(request, parent);
  }
  Module._load = patchedLoad;
  try {
    const brokerRunnerPath = require.resolve('../lib/broker-runner');
    delete require.cache[brokerRunnerPath];
    const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
    const broker = { name: N, url: 'https://example.invalid/optout' };
    const person = { firstName: 'Test', lastName: 'User', email: 't@example.com', country: 'US' };

    configure({ dryRun: false, person, retryFailed: false });
    await processBrokerWithPerson({}, broker, person);
    assert.deepEqual(shouldSkipCalls.at(-1).opts, { ignoreErrorWindow: false });

    configure({ dryRun: false, person, retryFailed: true });
    await processBrokerWithPerson({}, broker, person);
    assert.deepEqual(shouldSkipCalls.at(-1).opts, { ignoreErrorWindow: true });
  } finally {
    Module._load = originalLoad;
  }
});
