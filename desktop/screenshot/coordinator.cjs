const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

// Same-user, local-only coordination. Atomic heartbeat files contain no screen data.
// A deterministic election chooses the preferred product. An exclusive owner file
// requires the old listener to unregister before the next product can take over.
function createCoordinator({directory, title, priority, onElection, onRequest, interval = 2000,
  now = Date.now, pid = process.pid, alive = value => { try { process.kill(value, 0); return true; } catch (e) { return e.code === 'EPERM'; } }}) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const mailbox = path.join(directory, 'requests');
  fs.mkdirSync(mailbox, {recursive: true, mode: 0o700});
  const id = `${pid}-${randomUUID()}`, ownFile = path.join(directory, `${id}.json`);
  const leaseFile = path.join(directory, 'owner.lock');
  let stopped = false, timer, last = {active: false, owner: ''};
  function readLease() { try { return JSON.parse(fs.readFileSync(leaseFile, 'utf8')); } catch { return null; } }
  function release() {
    // Unregister first; only then make ownership available to another process.
    onElection({active: false, owner: '', priority});
    if (readLease()?.id === id) fs.rmSync(leaseFile, {force: true});
  }
  function tick() {
    if (stopped) return last;
    const timestamp = now();
    const temporary = ownFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({id, pid, title, priority, timestamp}), {mode: 0o600});
    fs.renameSync(temporary, ownFile);
    const candidates = [];
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const filename = path.join(directory, name);
      try {
        const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!Number.isInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.priority) || typeof value.id !== 'string' || typeof value.title !== 'string') continue;
        if (!Number.isFinite(value.timestamp) || timestamp - value.timestamp > 8000 || !alive(value.pid)) {
          // Ignore stale entries. Never delete another process's file during renewal.
          continue;
        }
        candidates.push(value);
      } catch {}
    }
    candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const preferred = candidates[0];
    let owner = readLease();
    if (owner?.id === id && preferred?.id !== id) { release(); owner = readLease(); }
    if (preferred?.id === id && owner?.id !== id) {
      if (owner && !alive(owner.pid)) {
        // Re-read before removing a dead owner's lease; never steal from a live
        // but temporarily stalled process whose OS hook may still be installed.
        if (readLease()?.id === owner.id) fs.rmSync(leaseFile, {force: true});
      } else if (!owner && fs.existsSync(leaseFile) && timestamp - fs.statSync(leaseFile).mtimeMs > 8000) {
        // A process may exit between exclusive creation and writing its identity.
        fs.rmSync(leaseFile, {force: true});
      }
      try {
        const fd = fs.openSync(leaseFile, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({id, pid, title})); } finally { fs.closeSync(fd); }
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      owner = readLease();
    }
    last = {active: owner?.id === id && preferred?.id === id, owner: owner?.title || preferred?.title || '', priority};
    onElection(last);
    if (last.active && onRequest) {
      for (const name of fs.readdirSync(mailbox).filter(name => name.endsWith('.request.json')).slice(0, 32)) {
        const requestPath = path.join(mailbox, name), responsePath = requestPath.replace('.request.json', '.reply.json');
        try {
          if (fs.existsSync(responsePath)) continue;
          const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
          if (timestamp - request.created > 15000) { fs.rmSync(requestPath, {force: true}); continue; }
          let response;
          try { response = {ok: true, value: onRequest(request.payload)}; }
          catch (error) { response = {ok: false, error: error.message}; }
          fs.writeFileSync(responsePath + '.tmp', JSON.stringify(response), {mode: 0o600});
          fs.renameSync(responsePath + '.tmp', responsePath);
        } catch {}
      }
    }
    return last;
  }
  function safeTick() { try { tick(); } catch { last = {active: false, owner: '', priority}; onElection(last); } }
  safeTick();
  if (interval) { timer = setInterval(safeTick, interval); timer.unref(); }
  return {tick, state: () => last, setPriority(value) { priority = value; return tick(); },
    async request(payload) {
      const filename = path.join(mailbox, `${randomUUID()}.request.json`), reply = filename.replace('.request.json', '.reply.json');
      fs.writeFileSync(filename + '.tmp', JSON.stringify({created: now(), payload}), {mode: 0o600});
      fs.renameSync(filename + '.tmp', filename);
      try {
        for (let attempt = 0; attempt < 60 && !stopped; attempt++) {
          if (fs.existsSync(reply)) {
            const result = JSON.parse(fs.readFileSync(reply, 'utf8'));
            if (!result.ok) throw Error(result.error || '负责监听的应用未能应用设置。');
            return result.value;
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw Error('等待负责监听的应用响应超时，请重试。');
      } finally { fs.rmSync(filename, {force: true}); fs.rmSync(reply, {force: true}); }
    },
    dispose() { if (stopped) return; stopped = true; clearInterval(timer); release(); fs.rmSync(ownFile, {force: true}); }
  };
}
module.exports = {createCoordinator};
