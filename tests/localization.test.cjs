const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { trustedSender } = require('../electron-security.cjs');
const { LibraryError } = require('../local-library.cjs');
const { createLocalAdapter } = require('../local-electron.cjs');
const { messages, messageText, errorText, errorResult, publicIssue, publicUnpaired, publicBatchRow } = require('../localization.cjs');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-localization-test-'));
  const directory = await fs.realpath(temporary), root = path.join(directory, 'library'), profile = path.join(directory, 'profile');
  await fs.mkdir(root); await fs.mkdir(profile);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rendererURL = 'file:///portrait-localization-test/index.html';
  const frame = { url: rendererURL }, sender = { mainFrame: frame };
  const event = { senderFrame: frame, sender }, handlers = new Map(), dialogs = [];
  let dialogError = null;
  const adapter = createLocalAdapter({
    app: { isPackaged: true, getPath: () => profile }, defaultRoot: root,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (_window, options) => { dialogs.push(options); if (dialogError) throw dialogError; return { canceled: true, filePaths: [] }; } },
    shell: { trashItem: () => { throw new Error('Trash must not run in localization tests'); } },
    protocol: { handle: () => {} }, nativeImage: {}, BrowserWindow: { fromWebContents: () => null }, rendererURL, trustedSender
  });
  // The adapter initialization itself is exercised only against this owned temp
  // library; no application, native dialog or clipboard is launched.
  const original = process.env.PORTRAIT_STUDIO_LIBRARY_DIR;
  process.env.PORTRAIT_STUDIO_LIBRARY_DIR = root;
  try { await adapter.initialise(); }
  finally { if (original === undefined) delete process.env.PORTRAIT_STUDIO_LIBRARY_DIR; else process.env.PORTRAIT_STUDIO_LIBRARY_DIR = original; }
  return { root, profile, handlers, dialogs, event, frame, sender,
    invoke: (channel, ...args) => handlers.get(channel)(event, ...args),
    setDialogError: error => { dialogError = error; } };
}

test('shared messages have complete matching locale keys and safe known-code error text', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zh).sort());
  for (const [key, english] of Object.entries(messages.en)) {
    assert.equal(typeof english, 'string'); assert.ok(english.trim());
    assert.equal(/[\u3400-\u9fff]/.test(english), false, key);
    assert.ok(messages.zh[key].trim());
  }
  assert.equal(errorText('CONFLICT', 'en'), messages.en['errors.CONFLICT']);
  assert.equal(errorText('CONFLICT', 'zh'), messages.zh['errors.CONFLICT']);
  assert.equal(messageText('unknown.key', 'en'), messages.en['errors.IO_ERROR']);
  const privateMessage = '/Users/private/person/secret.png 中文原始异常';
  const known = errorResult(new LibraryError('CONFLICT', privateMessage), 'en');
  assert.deepEqual(known, { ok: false, error: { code: 'CONFLICT', message: messages.en['errors.CONFLICT'] } });
  for (const error of [new Error(privateMessage), { code: '/private/path', message: privateMessage }, { code: 'EIO', message: privateMessage }, { code: Symbol('unknown') }]) {
    assert.deepEqual(errorResult(error, 'en'), { ok: false, error: { code: 'IO_ERROR', message: messages.en['errors.IO_ERROR'] } });
  }
  for (const code of ['EACCES', 'EPERM', 'EROFS']) assert.equal(errorResult({ code, message: privateMessage }, 'en').error.code, 'PERMISSION_DENIED');
});

test('language IPC accepts only fixed scalar en/zh from the trusted main frame without writing library/profile settings', async t => {
  const f = await fixture(t);
  const indexPath = path.join(f.root, '.portrait-studio/library.json'), before = await fs.readFile(indexPath);
  const unauthorized = [
    { senderFrame: { url: f.frame.url }, sender: f.sender },
    { senderFrame: { url: 'https://example.com/' }, sender: f.sender },
    { senderFrame: null, sender: f.sender }
  ];
  for (const event of unauthorized) {
    const result = await f.handlers.get('library-ui-language')(event, 'en');
    assert.equal(result.ok, false); assert.equal(result.error.code, 'FORBIDDEN');
    assert.equal(result.error.message, messages.zh['errors.FORBIDDEN']);
  }
  assert.deepEqual(await f.invoke('library-ui-language', 'en'), { ok: true, data: { locale: 'en' } });
  for (const value of [null, undefined, {}, { locale: 'zh', path: '/etc' }, ['zh'], 1, 'EN', 'en-US', 'zh-CN', '../zh']) {
    const result = await f.invoke('library-ui-language', value);
    assert.equal(result.error.code, 'INVALID_LOCALE'); assert.equal(result.error.message, messages.en['errors.INVALID_LOCALE']);
  }
  assert.equal((await f.invoke('library-ui-language', 'zh', { path: '/etc' })).error.code, 'INVALID_LOCALE');
  await f.invoke('library-choose');
  assert.equal(f.dialogs.at(-1).title, messages.en['native.libraryTitle']);
  assert.deepEqual(await fs.readFile(indexPath), before); assert.deepEqual(await fs.readdir(f.profile), []);
  assert.deepEqual(await f.invoke('library-ui-language', 'zh'), { ok: true, data: { locale: 'zh' } });
});

test('all four native chooser dialogs follow the live language including descriptions, buttons and filters', async t => {
  const f = await fixture(t);
  const choices = [
    ['library-choose', 'library', null], ['library-image-choose', 'image', 'imageFilter'],
    ['library-batch-images-choose', 'batchImages', null], ['library-batch-manifest-choose', 'batchManifest', 'jsonFilter']
  ];
  for (const locale of ['zh', 'en', 'zh']) {
    await f.invoke('library-ui-language', locale);
    for (const [channel, name, filter] of choices) {
      const result = await f.invoke(channel), options = f.dialogs.at(-1), table = messages[locale];
      assert.deepEqual(result, { ok: true, data: { cancelled: true } });
      assert.equal(options.title, table[`native.${name}Title`]);
      assert.equal(options.message, table[`native.${name}Message`]);
      assert.equal(options.buttonLabel, table[`native.${name}Button`]);
      if (filter) assert.equal(options.filters[0].name, table[`native.${filter}`]);
      assert.deepEqual(options.properties, channel === 'library-choose' ? ['openDirectory', 'createDirectory'] : channel === 'library-batch-images-choose' ? ['openDirectory'] : ['openFile']);
    }
  }
});

test('native failure responses use live localized code messages and never expose raw exceptions', async t => {
  const f = await fixture(t);
  await f.invoke('library-ui-language', 'en');
  f.setDialogError(new LibraryError('CONFLICT', '/Users/private/secret.json 内部异常'));
  assert.equal((await f.invoke('library-choose')).error.message, messages.en['errors.CONFLICT']);
  f.setDialogError(Object.assign(new Error('/private/person/file.txt details'), { code: 'UNKNOWN_INTERNAL' }));
  assert.deepEqual((await f.invoke('library-choose')).error, { code: 'IO_ERROR', message: messages.en['errors.IO_ERROR'] });
  await f.invoke('library-ui-language', 'zh');
  f.setDialogError(Object.assign(new Error('/private/person/file.txt details'), { code: 'EACCES' }));
  assert.deepEqual((await f.invoke('library-choose')).error, { code: 'PERMISSION_DENIED', message: messages.zh['errors.PERMISSION_DENIED'] });
});

test('batch public data exposes code-based reasons without Chinese exception text or internal paths', () => {
  const issue = publicIssue({ code: 'MISSING_PROMPT_ZH', message: '原记录缺少中文 /private/path', detail: '/private/detail', recordIndex: 2, id: 12, sourceFileName: '012.png', severity: 'error' });
  assert.deepEqual(issue, { code: 'MISSING_PROMPT_ZH', recordIndex: 2, id: 12, sourceFileName: '012.png', severity: 'error' });
  assert.deepEqual(publicUnpaired({ sourceFileName: 'extra.png', reason: 'NO_UNIQUE_MANIFEST_RECORD', extra: '/private/path' }), { sourceFileName: 'extra.png', reasonCode: 'NO_UNIQUE_MANIFEST_RECORD' });
  assert.equal(publicUnpaired({ sourceFileName: 'extra.png', reason: '/private/raw/error' }).reasonCode, 'IO_ERROR');
  const row = publicBatchRow({ index: 2, id: 12, label: 'source label', status: 'importable', issueCodes: ['SELECTED_DEFAULT_TYPE'] }, { status: 'conflict', code: 'DUPLICATE_ID', message: '私有原始异常', targetFileName: 'existing.png' }, { sourceFileName: '012.png', matchMethod: 'exact' });
  assert.deepEqual(row, { recordIndex: 2, id: 12, label: 'source label', sourceFileName: '012.png', targetFileName: 'existing.png', status: 'conflict', code: 'DUPLICATE_ID', issueCodes: ['SELECTED_DEFAULT_TYPE', 'DUPLICATE_ID'], matchMethod: 'exact' });
  assert.equal(Object.hasOwn(row, 'reason'), false);
  assert.equal(messageText(`issues.${row.code}`, 'en'), messages.en['issues.DUPLICATE_ID']);
});

test('preload exposes one fixed language method without exposing arbitrary channel or path access', async () => {
  let exposed; const calls = [];
  const source = await fs.readFile(path.join(__dirname, '../preload.js'), 'utf8');
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'portraitStudio'); exposed = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } };
  } });
  await exposed.setUILanguage('en');
  assert.deepEqual(calls[0], ['library-ui-language', 'en']);
  assert.equal(Object.hasOwn(exposed, 'invoke'), false); assert.equal(Object.hasOwn(exposed, 'readFile'), false);
});
