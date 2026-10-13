const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createShortcut, validate} = require('./shortcut.cjs');
const {createCoordinator} = require('./coordinator.cjs');
const key = `${process.platform === 'darwin' ? 'Command' : 'Control'}+Alt+Shift+S`;
function registry() {
  const hooks = new Map();
  return {hooks, register(k, callback) { if (hooks.has(k)) return false; hooks.set(k, callback); return true; }, unregister(k) { hooks.delete(k); }};
}
test('conflicting rebind and failed disk write preserve the existing shortcut', () => {
  const globalShortcut = registry(); let fail = false, saved, captures = 0;
  const shortcut = createShortcut({globalShortcut, initial: {enabled: true, accelerator: key}, onCapture: () => captures++, persist: value => {if (fail) throw Error('disk full'); saved = value;}});
  globalShortcut.register('Control+Q', () => {});
  assert.throws(() => shortcut.save({enabled: true, accelerator: 'Control+Q'}), /占用/);
  assert.equal(shortcut.state().accelerator, key);
  fail = true;
  assert.throws(() => shortcut.save({enabled: true, accelerator: 'Control+D'}), /disk full/);
  assert.equal(globalShortcut.hooks.has('Control+D'), false);
  globalShortcut.hooks.get(key)(); assert.equal(captures, 1);
  fail = false; shortcut.save({enabled: false, accelerator: key});
  assert.equal(saved.enabled, false); assert.equal(globalShortcut.hooks.has(key), false);
  shortcut.dispose(); assert.equal(globalShortcut.hooks.has('Control+Q'), true);
});
test('reject unsafe/bare accelerators without disturbing a registered hook', () => {
  for (const accelerator of ['S', 'Shift+S', 'Control+Control+S', 'Control+', 'Command+;rm -rf', 'Alt+Escape']) assert.throws(() => validate({enabled: true, accelerator}));
  assert.deepEqual(validate({enabled: false, accelerator: 'Control+F12'}), {enabled: false, accelerator: 'Control+F12'});
  assert.equal(validate({enabled: true, accelerator: 'Shift+Alt+CommandOrControl+S'}).accelerator, key);
});
test('product election, priority change, clean shutdown, crash and lease expiry', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpoor-election-'));
  const globalShortcut = registry(); let clock = 1000;
  const live = new Set([11, 12]);
  const a = createShortcut({globalShortcut, initial: {enabled: true, accelerator: key}, active: false, onCapture() {}, persist() {}});
  const b = createShortcut({globalShortcut, initial: {enabled: true, accelerator: key}, active: false, onCapture() {}, persist() {}});
  const make = (pid, title, priority, shortcut) => createCoordinator({directory, pid, title, priority, interval: 0, now: () => clock, alive: pid => live.has(pid), onElection: state => shortcut.setActive(state.active)});
  const low = make(11, 'SayAgain', 50, a);
  const high = make(12, 'Director', 100, b);
  try {
    low.tick(); high.tick();
    assert.equal(a.state().registered, false); assert.equal(b.state().registered, true);
    assert.equal(low.state().owner, 'Director'); assert.equal(globalShortcut.hooks.size, 1);
    low.setPriority(200); high.tick(); low.tick();
    assert.equal(a.state().registered, true); assert.equal(b.state().registered, false);
    low.dispose(); high.tick(); assert.equal(b.state().registered, true);
    // Simulate an ungraceful exit: OS releases the hook, stale heartbeat stays.
    b.dispose(); live.delete(12);
    const next = make(11, 'SayAgain', 50, a);
    assert.equal(a.state().registered, true); next.dispose();
    live.add(12); clock += 9000;
    const afterExpiry = make(11, 'SayAgain', 50, a);
    assert.equal(afterExpiry.state().owner, 'SayAgain'); afterExpiry.dispose();
  } finally {low.dispose(); high.dispose(); a.dispose(); b.dispose(); fs.rmSync(directory, {recursive: true, force: true});}
});
test('shared shortcut updates are adopted without a second persistence write', () => {
  const globalShortcut = registry(); let writes = 0;
  const shortcut = createShortcut({globalShortcut, initial: {enabled: true, accelerator: key}, active: false, onCapture() {}, persist() { writes++; }});
  shortcut.save({enabled: true, accelerator: 'Control+F9'}, false);
  assert.equal(writes, 0); assert.equal(globalShortcut.hooks.size, 0);
  shortcut.setActive(true); assert.equal(globalShortcut.hooks.has('Control+F9'), true);
  shortcut.save({enabled: false, accelerator: 'Control+F9'}, false);
  assert.equal(globalShortcut.hooks.size, 0); shortcut.dispose();
});
test('standby requests are acknowledged by the owner, including rejection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpoor-mailbox-'));
  let applied;
  const shared = {directory, interval: 0, alive: () => true, onElection() {}};
  const owner = createCoordinator({...shared, pid: 20, title: 'Director', priority: 100, onRequest(value) {
    const next = validate(value);
    if (next.accelerator === 'Control+Q') throw Error('occupied');
    applied = next; return next;
  }});
  const standby = createCoordinator({...shared, pid: 21, title: 'SayAgain', priority: 50});
  try {
    const success = standby.request({enabled: true, accelerator: key});
    owner.tick(); assert.equal((await success).accelerator, key); assert.equal(applied.accelerator, key);
    const rejected = standby.request({enabled: true, accelerator: 'Control+Q'});
    owner.tick(); await assert.rejects(rejected, /occupied/); assert.equal(applied.accelerator, key);
    assert.deepEqual(fs.readdirSync(path.join(directory, 'requests')), []);
  } finally { standby.dispose(); owner.dispose(); fs.rmSync(directory, {recursive: true, force: true}); }
});
test('exclusive lease prevents overlap even when the OS allows duplicate hooks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hotpoor-exclusive-'));
  const active = new Set();
  const make = (pid, priority) => createCoordinator({directory, pid, title: String(pid), priority, interval: 0, alive: () => true,
    onElection(state) { if (state.active) active.add(pid); else active.delete(pid); assert(active.size <= 1, 'two product listeners became active'); }});
  const low = make(40, 50), high = make(41, 100);
  try {
    assert.deepEqual([...active], [40]); // Higher priority must wait for release.
    low.tick(); assert.equal(active.size, 0);
    high.tick(); assert.deepEqual([...active], [41]);
    low.setPriority(200); assert.deepEqual([...active], [41]);
    high.tick(); low.tick(); assert.deepEqual([...active], [40]);
    low.dispose(); high.tick(); assert.deepEqual([...active], [41]);
  } finally { low.dispose(); high.dispose(); fs.rmSync(directory, {recursive: true, force: true}); }
});
