'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

// Import the actual configuration without starting Vite or making requests.
// Legacy remote endpoint/auth settings must not select the default backend.
async function configured(backend) {
  const names = ['PORTRAIT_STUDIO_BACKEND', 'PORTRAIT_STUDIO_REMOTE_BASE_URL', 'PORTRAIT_STUDIO_REMOTE_AUTHORIZATION'];
  const previous = names.map(name => process.env[name]);
  try {
    if (backend === undefined) delete process.env.PORTRAIT_STUDIO_BACKEND;
    else process.env.PORTRAIT_STUDIO_BACKEND = backend;
    process.env.PORTRAIT_STUDIO_REMOTE_BASE_URL = 'https://offline-fixture.invalid/';
    process.env.PORTRAIT_STUDIO_REMOTE_AUTHORIZATION = 'Basic FAKE_FIXTURE_NOT_A_CREDENTIAL';
    const url = pathToFileURL(path.join(__dirname, '..', 'vite.config.mjs'));
    url.search = 'fixture=' + encodeURIComponent(backend ?? 'default');
    return (await import(url.href)).default;
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
  }
}

test('default Vite preview ignores old remote credentials and retains the local read-only and filesystem boundaries', async () => {
  for (const backend of [undefined, 'local', 'unexpected']) {
    const config = await configured(backend);
    const pluginNames = config.plugins.map(plugin => plugin.name);
    assert.ok(pluginNames.includes('portrait-local-readonly-preview'));
    assert.equal(pluginNames.includes('portrait-remote-readonly-preview'), false);
    assert.equal(config.define.__PORTRAIT_STUDIO_PREVIEW_BACKEND__, '"local"');
    assert.equal(JSON.stringify(config).includes('FAKE_FIXTURE_NOT_A_CREDENTIAL'), false);
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.cors, false);
    assert.equal(config.server.fs.strict, true);
    for (const protectedPath of ['**/photo_repo/**', '**/.portrait-studio/**', '**/assets/images/**']) assert.ok(config.server.fs.deny.includes(protectedPath));
  }
});

test('remote Vite adapter is retained only for an explicit backend selection', async () => {
  const config = await configured('remote');
  const pluginNames = config.plugins.map(plugin => plugin.name);
  assert.ok(pluginNames.includes('portrait-remote-readonly-preview'));
  assert.equal(pluginNames.includes('portrait-local-readonly-preview'), false);
  assert.equal(config.define.__PORTRAIT_STUDIO_PREVIEW_BACKEND__, '"remote"');
});
