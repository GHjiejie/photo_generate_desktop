const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
function bridge(argv, env = {}) {
  let api;
  const calls = [];
  vm.runInNewContext(source, {
    process: { argv, env },
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'portraitStudio'); api = value; } },
        ipcRenderer: { invoke(...values) { calls.push(values); return Promise.resolve(); } },
      };
    },
  });
  return { api, calls };
}

test('local default ignores saved remote environment values in the preload', () => {
  const { api } = bridge(['electron', 'preload.js'], { PORTRAIT_STUDIO_REMOTE_BASE_URL: 'https://old.invalid/', PORTRAIT_STUDIO_BACKEND: 'remote' });
  assert.equal(api.backend, 'local');
});
test('the main-window backend argument selects explicit remote mode', () => {
  assert.equal(bridge(['electron', '--portrait-studio-backend=remote']).api.backend, 'remote');
  assert.equal(bridge(['electron', '--portrait-studio-backend=local']).api.backend, 'local');
});
test('conflicting, repeated and unknown backend arguments fail closed to local', () => {
  for (const argv of [['--portrait-studio-backend=remote', '--portrait-studio-backend=local'], ['--portrait-studio-backend=remote', '--portrait-studio-backend=remote'], ['--portrait-studio-backend=unknown']]) {
    assert.equal(bridge(argv).api.backend, 'local');
  }
});
test('local mode keeps the fixed native library IPC surface', async () => {
  const { api, calls } = bridge(['--portrait-studio-backend=local']);
  await api.libraryList();
  await api.chooseBatchDirectory();
  await api.commitBatch({ token: 'fixture', confirmed: true });
  const deletion = { items: [{ id: 1, expectedRevision: 2 }], expectedVersion: 3, confirmed: true };
  await api.deletePortraits(deletion);
  assert.deepEqual(calls, [['library-list'], ['library-batch-directory-choose'], ['library-batch-commit', { token: 'fixture', confirmed: true }], ['library-delete-batch', deletion]]);
  assert.equal(api.readFile, undefined);
  assert.equal(api.execute, undefined);
});
