/**
 * test/email-gmail.test.js
 *
 * Gmail transport for opt-out emails (cfg.email.gmail).
 *
 *   cfg.email.gmail = true (or { account }) routes email-method brokers
 *   through `hatch_gws_cli gmail +send` instead of SMTP.
 *
 * Invariants:
 *   - SMTP with a host still wins when both are configured.
 *   - An smtp block with no host is the setup placeholder: treated as
 *     unconfigured, so Gmail (or manual) can run.
 *   - Identity guard: the address advertised to the broker must match the
 *     connected Gmail account's own address; a mismatch logs 'manual' and
 *     never sends from the wrong inbox.
 *   - CLI failures (missing binary, +send error) log 'error', never throw.
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const BROKER = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };
const PERSON = {
  firstName: 'Martin', lastName: 'Kessler', fullName: 'Martin Kessler',
  email: 'martin@kessler.io', city: 'Millbrae', state: 'CA', zip: '94030',
  phoneFormatted: '415-823-5304', country: 'US',
};
const OTHER_PERSON = { ...PERSON, email: 'someone-else@example.com', fullName: 'Someone Else' };

let execCalls;
let logCalls;
let successCalls;
let profileAddress;
let sendThrows;
let profileThrows;

const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;
const origLoad = Module._load;

function stubExec() {
  execCalls = [];
  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process') {
      return {
        execFileSync: (cmd, args, opts) => {
          execCalls.push({ cmd, args, opts });
          const sub = args[1];
          if (sub === 'users') {
            if (profileThrows) throw new Error('connect failed');
            return JSON.stringify({ emailAddress: profileAddress });
          }
          if (sub === '+send') {
            if (sendThrows) throw new Error('send rejected');
            return JSON.stringify({ ok: true });
          }
          throw new Error(`unexpected gmail subcommand: ${sub}`);
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  return require('../lib/email');
}

function restoreExec() {
  Module._load = origLoad;
  delete require.cache[require.resolve('../lib/email')];
  require('../lib/email');
}

beforeEach(() => {
  logCalls = [];
  successCalls = [];
  profileAddress = 'martin@kessler.io';
  sendThrows = false;
  profileThrows = false;
  configMod.lastOptOutDaysAgo = () => 9999;
  configMod.recordSuccess = (key, note) => { successCalls.push({ key, note }); };
  loggerMod.logResult = (name, status, note) => { logCalls.push({ name, status, note }); };
});

afterEach(() => {
  configMod.lastOptOutDaysAgo = origLastOptOut;
  configMod.recordSuccess = origRecordSuccess;
  loggerMod.logResult = origLogResult;
  restoreExec();
});

function cfgFor(extraEmail) {
  return { persons: [PERSON], email: { ...(extraEmail || {}) } };
}

test('gmail: matching identity sends via +send, logs success, records composite key', async () => {
  const email = stubExec();
  const cfg = { persons: [PERSON, OTHER_PERSON], email: { gmail: true } };
  await email.sendOptOutEmails([BROKER], cfg);
  const sends = execCalls.filter(c => c.args[1] === '+send');
  assert.equal(sends.length, 1, 'expected exactly one +send call (other person is identity-mismatched)');
  const args = sends[0].args;
  assert.ok(args.includes('privacy@pipl.com'), 'recipient must be the broker address');
  const subjIdx = args.indexOf('--subject');
  assert.ok(subjIdx >= 0 && args[subjIdx + 1].includes('Martin Kessler'), 'subject names the person');
  assert.equal(successCalls.length, 1);
  assert.equal(successCalls[0].key, 'Pipl|Martin Kessler');
  const statuses = logCalls.map(c => c.status).sort();
  assert.deepEqual(statuses, ['manual', 'success']);
  email._clearGmailCache();
});

test('gmail: identity mismatch logs manual and never sends', async () => {
  const email = stubExec();
  await email.sendOptOutEmails([BROKER], { persons: [OTHER_PERSON], email: { gmail: true } });
  const sends = execCalls.filter(c => c.args[1] === '+send');
  assert.equal(sends.length, 0, 'must not send from the wrong inbox');
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].status, 'manual');
  assert.ok(logCalls[0].note.includes('martin@kessler.io'), 'note names the connected account');
  assert.equal(successCalls.length, 0);
  email._clearGmailCache();
});

test('gmail: getProfile failure logs error, never throws', async () => {
  const email = stubExec();
  profileThrows = true;
  await email.sendOptOutEmails([BROKER], cfgFor({ gmail: true }));
  const sends = execCalls.filter(c => c.args[1] === '+send');
  assert.equal(sends.length, 0);
  assert.equal(logCalls[0].status, 'error');
  email._clearGmailCache();
});

test('gmail: +send failure logs error, records nothing', async () => {
  const email = stubExec();
  sendThrows = true;
  await email.sendOptOutEmails([BROKER], cfgFor({ gmail: true }));
  assert.equal(logCalls[0].status, 'error');
  assert.equal(successCalls.length, 0);
  email._clearGmailCache();
});

test('gmail: configured SMTP with host still takes precedence', async () => {
  const email = stubExec();
  // Stub nodemailer too: intercept its load so no real transport is built.
  const loadBefore = Module._load;
  const sentMails = [];
  Module._load = function (request, parent, isMain) {
    if (request === 'nodemailer') {
      return { createTransport: () => ({ sendMail: async (m) => { sentMails.push(m); } }) };
    }
    return loadBefore.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  const emailFresh = require('../lib/email');
  try {
    await emailFresh.sendOptOutEmails(
      [BROKER],
      cfgFor({ gmail: true, smtp: { host: 'smtp.example.com', user: 'u', pass: 'p' } })
    );
    assert.equal(sentMails.length, 1, 'SMTP path should have sent');
    const sends = execCalls.filter(c => c.args[1] === '+send');
    assert.equal(sends.length, 0, 'Gmail path must not also send');
  } finally {
    Module._load = loadBefore;
  }
  email._clearGmailCache();
});

test('gmail: smtp block without host is treated as unconfigured', async () => {
  const email = stubExec();
  await email.sendOptOutEmails([BROKER], cfgFor({ gmail: true, smtp: { host: '', user: '', pass: '' } }));
  const sends = execCalls.filter(c => c.args[1] === '+send');
  assert.equal(sends.length, 1, 'Gmail should run when smtp has no host');
  email._clearGmailCache();
});

test('gmail: { account } passes --account through to the CLI', async () => {
  const email = stubExec();
  await email.sendOptOutEmails([BROKER], cfgFor({ gmail: { account: 'acct123' } }));
  const sends = execCalls.filter(c => c.args[1] === '+send');
  assert.equal(sends.length, 1);
  const acctIdx = sends[0].args.indexOf('--account');
  assert.ok(acctIdx >= 0 && sends[0].args[acctIdx + 1] === 'acct123');
  email._clearGmailCache();
});

test('gmail: neither smtp nor gmail configured still logs manual', async () => {
  const email = stubExec();
  await email.sendOptOutEmails([BROKER], cfgFor());
  assert.equal(execCalls.length, 0, 'no CLI call without gmail configured');
  assert.equal(logCalls[0].status, 'manual');
  email._clearGmailCache();
});
