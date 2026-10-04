// Every write uses a fresh temporary source/repository/profile. Only native
// picker results are controlled; parsing, IPC, CAS and persistence stay real.
const { _electron: electron, expect } = require('@playwright/test');
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const executable = process.env.PORTRAIT_STUDIO_EXECUTABLE;
const requestedKind = process.env.PORTRAIT_STUDIO_VERIFICATION_NAME || `${executable ? 'packaged' : 'source'}-${version}`;
if (!/^[a-zA-Z0-9._-]+$/.test(requestedKind)) throw new Error('Verification name must be a plain filename component');
const kind = requestedKind.startsWith('batch-') ? requestedKind : `batch-${requestedKind}`;
const output = path.join(project, '.verification');
// macOS os.tmpdir() can use the /var alias. The scanner intentionally rejects
// symlink ancestors, so the test fixture and queued picker path must be canonical.
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `portrait-${kind}-`)));
const sourceDirectory = path.join(temporary, 'fixture-source');
const sourceImageDirectory = path.join(sourceDirectory, 'images');
const singleDirectory = path.join(temporary, 'single-manifest-source');
const singleImageDirectory = path.join(singleDirectory, 'images');
const libraryRoot = path.join(temporary, 'isolated-repository');
const profile = path.join(temporary, 'isolated-profile');
const indexPath = path.join(libraryRoot, '.portrait-studio', 'library.json');
const manifestPath = path.join(sourceDirectory, 'complete-manifest.json');
const exceptionPath = path.join(sourceDirectory, 'exception-manifest.json');
const conflictPath = path.join(sourceDirectory, 'conflict-manifest.json');
const checks = [];
const clipboardChecks = [];
const screenshots = [];
const security = [];
const errors = [];
const previews = [];
const directoryChecks = [];
let app;
let page;
const testSubstitutions = {
  nativePicker: 'Only dialog.showOpenDialog selection results are queued; real IPC, source parsing, CAS and persistence stay in use. Interactive macOS picker operation is not tested.',
  clipboard: 'Only this test-owned main-process clipboard.writeText/readText are replaced by an in-memory text buffer. The production copy IPC handler stays in use; the OS clipboard is never read or written.'
};
let commitReport;
let importedItems;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const clone = value => JSON.parse(JSON.stringify(value));
const readIndex = () => JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const imageNames = ['701-alpha.png', '702-702-beta.png', '703-gamma.png', '704-delta.png', '704-704-delta.png'];

for (const directory of [sourceImageDirectory, singleImageDirectory, libraryRoot, profile, output]) fs.mkdirSync(directory, { recursive: true });
for (const [index, name] of imageNames.entries()) {
  const image = new PNG({ width: 16, height: 24 });
  for (let pixel = 0; pixel < image.data.length; pixel += 4) {
    image.data[pixel] = 35 + index * 41;
    image.data[pixel + 1] = 180 - index * 27;
    image.data[pixel + 2] = 75 + index * 22;
    image.data[pixel + 3] = 255;
  }
  const bytes = PNG.sync.write(image);
  fs.writeFileSync(path.join(sourceImageDirectory, name), bytes);
  fs.writeFileSync(path.join(singleImageDirectory, name), bytes);
}

function record(id, image, label) {
  const en = `Use case: isolated batch fixture ${id}.\nAsset type: standalone adult portrait.\nSubject: one fictional adult woman age 28 with dark eyes and hair.\nStyle and scene: window light, fully clothed cream blouse, 85 mm lens.\nComposition: vertical 2:3, shoulders up, one woman only.\nConstraints: keep complete text; no words, logos, watermark, collage or multiple panels. Literal markup is text: <script>globalThis.__batchInjected = true</script>.`;
  const zh = `用途：隔离批量验证 ${id}。\n素材类型：单幅成年人物肖像。\n主体：一位虚构的28岁成年女性，深色眼睛和头发。\n风格与场景：窗光、完整着装的奶油色衬衫、85毫米镜头。\n构图：竖版2:3、肩部以上、仅一位女性。\n约束：保留全文；不要文字、标志、水印、拼贴或多面板。以下标签仅为文字：<script>globalThis.__batchInjected = true</script>。`;
  return { id, image, prompt_file: `${image.slice(0, -4)}.txt`, label, prompt: en, prompt_cn: zh, prompt_en: en, image_url: `file:///isolated-fixture/${image}`, prompt_url: `file:///isolated-fixture/${image.slice(0, -4)}.txt`, style_tag_cn: '完整来源字段', style_tag_en: 'complete original source fields' };
}

// Array order intentionally differs from image enumeration and numeric order.
const records = [
  record(703, '703-gamma.png', '<img src=x onerror="globalThis.__batchInjected=true">'),
  record(701, '701-alpha.png', '批导入完整条目 701'),
  record(702, '702-beta.png', '同编号双前缀条目 702'),
];
const missingChinese = record(702, '702-beta.png', '缺少中文不能猜');
delete missingChinese.prompt_cn;
const ambiguousImage = record(704, '704-unavailable.png', '两个相同编号候选不能猜');
// Explicit filenames must never fall back to another stem. An ID-only record
// with two candidates is the separate, actual ambiguous pairing case.
delete ambiguousImage.image;
const exceptions = [
  clone(records[1]),
  record(705, '705-missing.png', '缺图不能猜'),
  ambiguousImage,
  missingChinese,
  clone(records[0]),
  { ...clone(records[0]), label: '重复703不能按数组顺序配对' },
];
const conflicting = clone(records[1]);
conflicting.prompt_cn += '\n这项来源内容改变，需要明确冲突处理。';
fs.writeFileSync(manifestPath, json(records));
fs.writeFileSync(exceptionPath, json(exceptions));
fs.writeFileSync(conflictPath, json([conflicting]));
fs.writeFileSync(path.join(singleDirectory, path.basename(manifestPath)), json(records));

function fingerprint(directory) {
  const files = {};
  function visit(parent, relative = '') {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(parent, entry.name);
      // Normal reads acquire/release this lock too, including image requests.
      // Persistent-state comparisons cover every index/image/archive/recovery
      // byte while excluding only these known ephemeral repository locks.
      if (directory === libraryRoot && ['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json'].includes(name)) continue;
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) { const bytes = fs.readFileSync(file); files[name] = { size: bytes.length, sha256: sha(bytes) }; }
      else files[name] = { unexpectedFileType: true };
    }
  }
  visit(directory);
  return files;
}
const sourceBefore = fingerprint(sourceDirectory);
const singleBefore = fingerprint(singleDirectory);
const sourceHashes = Object.fromEntries(imageNames.map(name => [name, sourceBefore[`images/${name}`].sha256]));
const manifestSha256 = sourceBefore[path.basename(manifestPath)].sha256;

function assertSourceUnchanged() {
  expect(fingerprint(sourceDirectory)).toEqual(sourceBefore);
  expect(fingerprint(singleDirectory)).toEqual(singleBefore);
}
function unwrap(result) { expect(result?.ok, JSON.stringify(result)).toBe(true); return result.data; }
async function bridge(method, payload) { return page.evaluate(({ method, payload }) => window.portraitStudio[method](payload), { method, payload }); }
async function state() {
  const result = unwrap(await bridge('libraryList'));
  expect(result.configured).toBe(true);
  expect(result.root).toBe(fs.realpathSync(libraryRoot));
  expect(result.writable).toBe(true);
  return result;
}
async function selectDialog(file, action) {
  await app.evaluate((_electron, value) => { globalThis.__portraitBatchDialogs.push(value); }, file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] });
  const result = await action();
  await expect.poll(() => app.evaluate(() => globalThis.__portraitBatchDialogs.length)).toBe(0);
  return result;
}
async function selections(manifest = manifestPath) {
  const before = await pickerCount();
  const directory = unwrap(await selectDialog(sourceDirectory, () => bridge('chooseBatchDirectory')));
  expect(await pickerCount()).toBe(before + 1);
  expect(typeof directory.selectionId).toBe('string');
  expect(directory.path).toBe(fs.realpathSync(sourceDirectory));
  expect(directory.imageCount).toBe(imageNames.length);
  expect(directory.manifests.map(item => item.relativePath).sort()).toEqual([manifestPath, exceptionPath, conflictPath].map(file => path.basename(file)).sort());
  const selected = directory.manifests.find(item => item.relativePath === path.basename(manifest));
  expect(selected, `manifest candidate ${path.basename(manifest)}`).toBeTruthy();
  expect(typeof selected.candidateId).toBe('string');
  const expectedCount = manifest === exceptionPath ? exceptions.length : manifest === conflictPath ? 1 : records.length;
  expect(selected.recordCount).toBe(expectedCount);
  directoryChecks.push({ phase: 'bridge-selection', pickerCalls: 1, sourceDirectory, imageCount: directory.imageCount, manifests: directory.manifests, selectedRelativePath: selected.relativePath });
  return { directorySelectionId: directory.selectionId, manifestCandidateId: selected.candidateId, type: 'photo' };
}
async function pickerCount() { return app.evaluate(() => globalThis.__portraitBatchDialogOptions.length); }
async function cancelSelection(value) { return unwrap(await bridge('cancelBatch', value)); }
async function openBatch() {
  await openLibraryMenu();
  await expect(page.locator('#libraryBatch')).toBeEnabled();
  await page.locator('#libraryBatch').click();
  await expect(page.locator('#batchImportDialog')).toBeVisible();
}
async function chooseUI(manifest, { directory = sourceDirectory, automatic = false } = {}) {
  const before = await pickerCount();
  await selectDialog(directory, () => page.locator('#batchChooseDirectory').click());
  await expect(page.locator('#batchDirectoryPath')).toContainText(path.basename(directory));
  await expect(page.locator('#batchDiscoverySummary')).toBeVisible();
  if (automatic) {
    await expect(page.locator('#batchManifestCandidate')).toHaveCount(0);
  } else {
    const select = page.locator('#batchManifestCandidate');
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('');
    await expect(page.locator('#batchPreview')).toBeDisabled();
    const candidate = await select.locator('option').evaluateAll((options, relativePath) => options.find(option => option.value && option.textContent.includes(relativePath))?.value, path.basename(manifest));
    expect(typeof candidate).toBe('string');
    await select.selectOption(candidate);
  }
  await expect(page.locator('#batchManifestPath')).toContainText(path.basename(manifest));
  expect(await pickerCount(), 'directory choice and candidate selection use exactly one native picker').toBe(before + 1);
  const options = await app.evaluate(() => globalThis.__portraitBatchDialogOptions.at(-1));
  expect(options.properties).toContain('openDirectory');
  expect(options.properties).not.toContain('openFile');
  directoryChecks.push({ phase: automatic ? 'single-candidate-auto-ui' : 'multi-candidate-explicit-ui', pickerCalls: 1, sourceDirectory: directory, selectedRelativePath: path.basename(manifest), nativePickerOptions: options });
  await expect(page.locator('#batchChooseImages, #batchChooseManifest')).toHaveCount(0);
  await expect(page.locator('#batchDefaultType')).toHaveCount(0);
}
async function openLibraryMenu() {
  if (!await page.locator('#libraryMenuPanel').isVisible()) await page.locator('#libraryMenuToggle').click();
  await expect(page.locator('#libraryMenuPanel')).toBeVisible();
}
async function closeLibraryMenu() {
  if (await page.locator('#libraryMenuPanel').isVisible()) await page.locator('#libraryMenuToggle').click();
  await expect(page.locator('#libraryMenuPanel')).toHaveCount(0);
}
async function setLanguage(language) {
  if (!await page.locator('#settingsPanel').isVisible()) await page.locator('#settingsToggle').click();
  await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
  await expect(page.locator(`#uiLanguage button[data-language="${language}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#settingsToggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
}
async function assertLanguage(language) {
  await page.locator('#settingsToggle').click();
  await expect(page.locator(`#uiLanguage button[data-language="${language}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#settingsToggle').click();
}
async function previewUI() {
  await page.locator('#batchPreview').click();
  await expect(page.locator('#batchSummary')).toBeVisible();
  await expect(page.locator('#batchTargetRoot')).toContainText(fs.realpathSync(libraryRoot));
}
async function screenshot(name) {
  await page.mouse.move(0, 0);
  const filename = `${kind}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
  screenshots.push({ filename, viewport: page.viewportSize() });
}
async function copy(action, text, label) {
  await app.evaluate(({ clipboard }, sentinel) => clipboard.writeText(sentinel), `Portrait batch clipboard sentinel ${clipboardChecks.length}`);
  await action();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { message: label }).toBe(text);
  clipboardChecks.push(label);
}
function storedItem(id) {
  const item = readIndex().items.find(value => value.id === id);
  expect(item, `stored item ${id}`).toBeTruthy();
  const file = fs.realpathSync(path.join(libraryRoot, item.imageRel));
  const relative = path.relative(fs.realpathSync(libraryRoot), file);
  expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
  expect(file.includes('app.asar')).toBe(false);
  const bytes = fs.readFileSync(file);
  expect(item.size).toBe(bytes.length);
  expect(item.sha256).toBe(sha(bytes));
  return { item, file, bytes, sha256: sha(bytes) };
}
async function closeOwnedApp() {
  if (!app) return;
  await app.close();
  app = undefined;
}
async function launch(withEnvironment = true) {
  const environment = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
  delete environment.PORTRAIT_STUDIO_LIBRARY_DIR;
  if (withEnvironment) environment.PORTRAIT_STUDIO_LIBRARY_DIR = libraryRoot;
  app = await electron.launch({ executablePath: executable || require('electron'), args: executable ? [] : [project], env: environment });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ clipboard, dialog }) => {
    globalThis.__portraitBatchClipboardText = '';
    clipboard.writeText = text => { globalThis.__portraitBatchClipboardText = String(text); };
    clipboard.readText = () => globalThis.__portraitBatchClipboardText;
    globalThis.__portraitBatchDialogs = [];
    globalThis.__portraitBatchDialogOptions = [];
    dialog.showOpenDialog = async (...args) => {
      globalThis.__portraitBatchDialogOptions.push(args.at(-1));
      if (!globalThis.__portraitBatchDialogs.length) throw new Error('Unexpected native picker in isolated batch verification');
      return globalThis.__portraitBatchDialogs.shift();
    };
  });
  const settings = await app.evaluate(({ app, BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { pid: process.pid, packaged: app.isPackaged, userData: app.getPath('userData'), contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
  });
  expect(settings.userData).toBe(profile);
  expect(settings.contextIsolation).toBe(true);
  expect(settings.sandbox).toBe(true);
  expect(settings.nodeIntegration).toBe(false);
  expect(settings.webSecurity).toBe(true);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await page.evaluate(() => window.portraitStudio.mode)).not.toBe('browser-preview');
  for (const method of ['chooseBatchDirectory', 'previewBatch', 'commitBatch', 'cancelBatch']) {
    expect(await page.evaluate(method => typeof window.portraitStudio[method], method)).toBe('function');
  }
  for (const method of ['chooseBatchImages', 'chooseBatchManifest', 'getUpdateState', 'checkForUpdates', 'chooseUpdateSource', 'downloadUpdate', 'installUpdate', 'onUpdateState', 'acknowledgeAppReady']) {
    expect(await page.evaluate(method => typeof window.portraitStudio[method], method)).toBe('undefined');
  }
  await expect(page.locator('#appUpdate')).toHaveCount(0);
  security.push(settings);
  await page.setViewportSize({ width: 1440, height: 920 });
  await openLibraryMenu();
  for (const id of ['libraryCreate', 'libraryConfigure', 'libraryBatch']) await expect(page.locator(`#${id}`), `${id} is enabled in desktop build`).toBeEnabled();
  await closeLibraryMenu();
  await state();
}

(async () => {
  try {
    await launch();
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    expect((await state()).items).toEqual([]);
    // Save the same isolated root through the normal native choice so restart
    // tests exercise persisted configuration rather than the test environment.
    unwrap(await selectDialog(libraryRoot, () => bridge('chooseLibrary')));
    const initialIndex = fs.readFileSync(indexPath);
    const initialTree = fingerprint(libraryRoot);
    checks.push('isolated empty writable repository, private profile, sandbox and actual batch bridge initialized; update UI and all update preload methods are absent');

    await openBatch();
    await selectDialog(null, () => page.locator('#batchChooseDirectory').click());
    expect(fs.readFileSync(indexPath)).toEqual(initialIndex);
    expect(fingerprint(libraryRoot)).toEqual(initialTree);
    await page.locator('#batchCancel').click();
    await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    await openBatch();
    await chooseUI(path.join(singleDirectory, path.basename(manifestPath)), { directory: singleDirectory, automatic: true });
    await previewUI();
    await expect(page.locator('#batchItems tbody tr[data-status="import"]')).toHaveCount(3);
    await expect(page.locator('#batchConfirm')).toBeEnabled();
    await screenshot('single-directory-auto-preview-1440x920');
    await page.locator('#batchCancel').click();
    await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    expect(fingerprint(libraryRoot)).toEqual(initialTree);
    assertSourceUnchanged();
    checks.push('one native directory selection discovers a root JSON and images in its child folder, automatically selects the sole manifest and previews all three records without a second picker or target write');
    await openBatch();
    await chooseUI(manifestPath);
    await previewUI();
    await expect(page.locator('#batchItems tbody tr[data-status="import"]')).toHaveCount(3);
    await expect(page.locator('#batchItems')).toContainText('702-702-beta.png');
    await expect(page.locator('#batchConfirm')).toBeEnabled();
    await screenshot('valid-preview-1440x920');
    await page.locator('#batchCancel').click();
    await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    expect(fingerprint(libraryRoot)).toEqual(initialTree);
    assertSourceUnchanged();
    checks.push('canceling the single native directory picker and canceling a fully populated preview leave index, images and archives unchanged; multiple JSON candidates require an explicit in-dialog selection');

    const validTokens = await selections();
    const validPreview = unwrap(await bridge('previewBatch', validTokens));
    previews.push({ phase: 'valid-before-import', data: validPreview });
    expect(validPreview.root).toBe(fs.realpathSync(libraryRoot));
    expect(validPreview.manifestSha256).toBe(manifestSha256);
    expect(validPreview.total).toBe(3);
    expect(validPreview.importable).toBe(3);
    expect(validPreview.items.filter(item => item.status === 'import').map(item => item.id).sort()).toEqual([701, 702, 703]);
    expect(validPreview.items.find(item => item.id === 702).sourceFileName).toBe('702-702-beta.png');
    expect(validPreview.items.find(item => item.id === 701).sourceFileName).toBe('701-alpha.png');
    const unconfirmed = await bridge('commitBatch', { previewId: validPreview.previewId, confirmed: false, expectedVersion: validPreview.revision });
    expect(unconfirmed.ok).toBe(false);
    const wrongVersion = await bridge('commitBatch', { previewId: validPreview.previewId, confirmed: true, expectedVersion: validPreview.revision + 1 });
    expect(wrongVersion.ok).toBe(false);
    expect(wrongVersion.error.code).toBe('CONFLICT');
    expect(fingerprint(libraryRoot)).toEqual(initialTree);
    for (const payload of [
      { directorySelectionId: sourceDirectory, manifestCandidateId: manifestPath, type: 'photo' },
      { directorySelectionId: crypto.randomUUID(), manifestCandidateId: crypto.randomUUID(), type: 'photo' },
      { directorySelectionId: validTokens.directorySelectionId, manifestCandidateId: crypto.randomUUID(), type: 'photo' },
      { directorySelectionId: validTokens.directorySelectionId, type: 'photo' },
      { imageSelectionId: sourceDirectory, manifestSelectionId: manifestPath, type: 'photo' },
      { ...validTokens, imageDirectory: '/etc', manifestPath: '/etc/passwd' },
    ]) expect((await bridge('previewBatch', payload)).ok).toBe(false);
    for (const payload of [
      { previewId: crypto.randomUUID(), confirmed: true, expectedVersion: validPreview.revision },
      { previewId: validPreview.previewId, confirmed: true, expectedVersion: validPreview.revision, targetRoot: '/tmp' },
    ]) expect((await bridge('commitBatch', payload)).ok).toBe(false);
    await cancelSelection({ previewId: validPreview.previewId, directorySelectionId: validTokens.directorySelectionId });
    expect((await bridge('previewBatch', validTokens)).ok).toBe(false);
    expect((await bridge('commitBatch', { previewId: validPreview.previewId, confirmed: true, expectedVersion: validPreview.revision })).ok).toBe(false);
    expect(fingerprint(libraryRoot)).toEqual(initialTree);
    checks.push('preview pairs shuffled records by exact filename or same-ID double prefix; unconfirmed or wrong-version commit, arbitrary paths, extra keys, forged and cancelled tokens are rejected without target changes');

    const exceptionTokens = await selections(exceptionPath);
    const exceptional = unwrap(await bridge('previewBatch', exceptionTokens));
    previews.push({ phase: 'partial-exceptions', data: exceptional });
    const issueCodes = exceptional.issues.map(issue => issue.code);
    for (const code of ['AMBIGUOUS_IMAGE', 'DUPLICATE_ID', 'MISSING_PROMPT_ZH']) expect(issueCodes).toContain(code);
    expect(exceptional.importable).toBe(1);
    expect(exceptional.items.filter(item => item.status === 'import').map(item => item.id)).toEqual([701]);
    expect(exceptional.items.find(item => item.id === 705).status).toBe('unmatched');
    expect(exceptional.items.find(item => item.id === 704).status).toBe('invalid');
    expect(exceptional.items.find(item => item.id === 704).sourceFileName).toBeUndefined();
    await cancelSelection({ previewId: exceptional.previewId, directorySelectionId: exceptionTokens.directorySelectionId });
    await openBatch();
    await chooseUI(exceptionPath);
    await previewUI();
    await expect(page.locator('#batchItems tbody tr[data-status="import"]')).toHaveCount(1);
    await expect(page.locator('#batchIssues')).toBeVisible();
    await expect(page.locator('#batchUnpaired')).toBeVisible();
    await expect(page.locator('#batchItems')).toContainText('缺图不能猜');
    await expect(page.locator('#batchItems')).toContainText('两个相同编号候选不能猜');
    await expect(page.locator('#batchItems img, #batchItems script')).toHaveCount(0);
    expect(await page.evaluate(() => globalThis.__batchInjected)).toBeUndefined();
    await screenshot('partial-errors-1440x920');
    await page.locator('#batchCancel').click();
    await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    expect(fingerprint(libraryRoot)).toEqual(initialTree);
    checks.push('missing image, duplicate IDs, absent Chinese and ambiguous same-ID candidates are visibly reported and never guessed; partial preview cancel writes nothing');

    const beforeCommit = await state();
    await openBatch();
    await chooseUI(path.join(singleDirectory, path.basename(manifestPath)), { directory: singleDirectory, automatic: true });
    await previewUI();
    await page.locator('#batchConfirm').click();
    await expect(page.locator('#batchReport')).toBeVisible();
    await expect.poll(async () => (await state()).items.length).toBe(3);
    const afterCommit = await state();
    expect(afterCommit.revision).toBe(beforeCommit.revision + 1);
    expect(afterCommit.items.map(item => item.id).sort()).toEqual([701, 702, 703]);
    importedItems = records.map(original => {
      const stored = storedItem(original.id);
      const sourceName = original.id === 702 ? '702-702-beta.png' : original.image;
      expect(stored.sha256).toBe(sourceHashes[sourceName]);
      expect(stored.bytes).toEqual(fs.readFileSync(path.join(sourceImageDirectory, sourceName)));
      expect(stored.item.prompts).toEqual({ en: original.prompt_en, zh: original.prompt_cn });
      expect(stored.item.type).toBe('photo');
      expect(stored.item.sourceMetadata).toEqual(original);
      expect(stored.item.sourceImport.manifestSha256).toBe(manifestSha256);
      expect(stored.item.sourceImport.sourceHash).toBe(sourceHashes[sourceName]);
      expect(stored.item.sourceImport.sourceFileName).toBe(sourceName);
      expect(stored.item.sourceImport.sourceRelativePath).toBe(`images/${sourceName}`);
      expect(stored.item.sourceImport.recordIndex).toBe(records.findIndex(record => record.id === original.id));
      expect(stored.item.sourceImport.typeOrigin).toBe('selected-default');
      expect(stored.item.sourceImport.matchMethod).toBe(original.id === 702 ? 'duplicate-leading-id-prefix' : 'exact');
      const archive = fs.realpathSync(path.join(libraryRoot, stored.item.sourceImport.archiveRel));
      expect(path.relative(fs.realpathSync(libraryRoot), archive).startsWith('..')).toBe(false);
      expect(fs.readFileSync(path.join(archive, 'manifest.json'))).toEqual(fs.readFileSync(manifestPath));
      for (const name of ['mapping.json', 'report.json', 'source.json']) expect(fs.existsSync(path.join(archive, name))).toBe(true);
      const mapping = JSON.parse(fs.readFileSync(path.join(archive, 'mapping.json'), 'utf8'));
      expect(JSON.stringify(mapping)).toContain(sourceName);
      expect(JSON.stringify(mapping)).toContain(`images/${sourceName}`);
      expect(JSON.stringify(mapping)).toContain(stored.item.image);
      expect(JSON.stringify(mapping)).toContain(sourceHashes[sourceName]);
      return { id: original.id, file: stored.file, sha256: stored.sha256, sourceMetadata: stored.item.sourceMetadata, sourceImport: stored.item.sourceImport };
    });
    expect(new Set(importedItems.map(item => item.sourceImport.archiveRel)).size).toBe(1);
    const archiveDirectory = path.join(libraryRoot, importedItems[0].sourceImport.archiveRel);
    commitReport = JSON.parse(fs.readFileSync(path.join(archiveDirectory, 'report.json'), 'utf8'));
    await screenshot('committed-report-1440x920');
    await page.locator('#batchClose').click();
    await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    await expect(page.locator('.portrait-card')).toHaveCount(3);
    assertSourceUnchanged();
    checks.push('one confirmed single-directory UI batch with an automatically selected root JSON atomically adds three child-folder images with one revision increment, exact original PNGs, both full prompts, all 11 source fields, immutable raw JSON and complete relative-path archive mapping');

    const idempotentBefore = fingerprint(libraryRoot);
    const repeatedTokens = await selections();
    const repeatedPreview = unwrap(await bridge('previewBatch', repeatedTokens));
    previews.push({ phase: 'repeat-all-skip', data: repeatedPreview });
    expect(repeatedPreview.importable).toBe(0);
    expect(repeatedPreview.skipped).toBe(3);
    expect(repeatedPreview.items.every(item => item.status === 'skip')).toBe(true);
    const repeatedCommit = unwrap(await bridge('commitBatch', { previewId: repeatedPreview.previewId, confirmed: true, expectedVersion: repeatedPreview.revision }));
    expect(repeatedCommit.report.imported).toBe(0);
    expect(repeatedCommit.report.skipped).toBe(3);
    expect(repeatedCommit.snapshot.revision).toBe(afterCommit.revision);
    await cancelSelection({ directorySelectionId: repeatedTokens.directorySelectionId });
    expect(fingerprint(libraryRoot)).toEqual(idempotentBefore);
    await openBatch();
    await chooseUI(manifestPath);
    await previewUI();
    await expect(page.locator('#batchItems tbody tr[data-status="skip"]')).toHaveCount(3);
    await expect(page.locator('#batchConfirm')).toBeDisabled();
    await screenshot('repeat-skip-1440x920');
    await page.locator('#batchCancel').click();
    expect(fingerprint(libraryRoot)).toEqual(idempotentBefore);
    checks.push('repeat preview explicitly shows three skips; confirmed repeat imports zero and changes no index, image or archive; UI disables an empty import');

    const conflictTokens = await selections(conflictPath);
    const conflictingPreview = unwrap(await bridge('previewBatch', conflictTokens));
    previews.push({ phase: 'existing-conflict', data: conflictingPreview });
    expect(conflictingPreview.importable).toBe(0);
    expect(conflictingPreview.conflicts).toBe(1);
    expect(conflictingPreview.items[0].status).toBe('conflict');
    await cancelSelection({ previewId: conflictingPreview.previewId, directorySelectionId: conflictTokens.directorySelectionId });
    await openBatch();
    await chooseUI(conflictPath);
    await previewUI();
    await expect(page.locator('#batchItems tbody tr[data-status="conflict"]')).toHaveCount(1);
    await expect(page.locator('#batchConfirm')).toBeDisabled();
    await screenshot('existing-conflict-1440x920');
    await page.locator('#batchCancel').click();
    expect(fingerprint(libraryRoot)).toEqual(idempotentBefore);
    checks.push('changed metadata for an existing ID is reported as a conflict and does not silently replace or skip that record');

    for (const language of ['en', 'zh']) {
      await setLanguage(language);
      for (const original of records) {
        const card = page.locator(`.portrait-card[data-id="${original.id}"]`);
        const prompt = original[language === 'zh' ? 'prompt_cn' : 'prompt_en'];
        await card.hover();
        await copy(() => card.locator('.copy-button').click(), prompt, `${original.id} ${language} card button`);
        await card.focus();
        await copy(() => page.keyboard.press('c'), prompt, `${original.id} ${language} card C`);
        await card.click();
        await expect.poll(() => page.locator('#detailPrompt').textContent()).toBe(prompt);
        await expect(page.locator('#detailTitle')).toHaveText(original.label);
        await expect(page.locator('#detailTitle img, #detailPrompt script')).toHaveCount(0);
        expect(await page.evaluate(() => globalThis.__batchInjected)).toBeUndefined();
        await copy(() => page.locator('#detailCopy').click(), prompt, `${original.id} ${language} detail button`);
        await copy(() => page.keyboard.press('Meta+Enter'), prompt, `${original.id} ${language} detail Cmd+Enter`);
        await page.keyboard.press('Escape');
      }
    }
    checks.push('all three imported records use exact complete bilingual text across four production copy IPC entry points captured in the test-owned main-process memory buffer; markup in labels/prompts remains inert text');

    await page.locator('#searchInput').fill('批导入完整条目 701');
    await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('.portrait-card').click();
    const beforeEdit = storedItem(701).item;
    await page.locator('#detailEdit').click();
    await expect(page.locator('#portraitEditor')).toBeVisible();
    await page.locator('#portraitLabel').fill('已编辑但保留来源 701');
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    const edited = storedItem(701).item;
    expect(edited.label).toBe('已编辑但保留来源 701');
    expect(edited.sourceMetadata).toEqual(beforeEdit.sourceMetadata);
    expect(edited.sourceImport).toEqual(beforeEdit.sourceImport);
    expect(edited.sha256).toBe(beforeEdit.sha256);
    expect(edited.prompts).toEqual(beforeEdit.prompts);
    await screenshot('edited-source-preserved-1440x920');
    await page.keyboard.press('Escape');
    await page.locator('#searchInput').fill('');
    const beforeRestart = readIndex();
    const beforeRestartTree = fingerprint(libraryRoot);
    await closeOwnedApp();
    await launch(false);
    await openLibraryMenu();
    await expect(page.locator('#libraryRoot')).toContainText(fs.realpathSync(libraryRoot));
    await closeLibraryMenu();
    await expect(page.locator('.portrait-card')).toHaveCount(3);
    expect(readIndex()).toEqual(beforeRestart);
    expect(fingerprint(libraryRoot)).toEqual(beforeRestartTree);
    const restarted = unwrap(await bridge('libraryGet', 701));
    expect(restarted.item.sourceMetadata).toEqual(beforeEdit.sourceMetadata);
    expect(restarted.item.sourceImport).toEqual(beforeEdit.sourceImport);
    await assertLanguage('zh');
    await page.locator('#searchInput').fill('已编辑但保留来源 701');
    await page.locator('.portrait-card').click();
    await expect.poll(() => page.locator('#detailPrompt').textContent()).toBe(records[1].prompt_cn);
    await copy(() => page.locator('#detailCopy').click(), records[1].prompt_cn, 'complete Chinese after edit and full process restart');
    await page.keyboard.press('Escape');
    await page.locator('#searchInput').fill('');
    assertSourceUnchanged();
    expect(errors).toEqual([]);
    checks.push('ordinary edit retains full source metadata and provenance; full process restart retains chosen root, collection, archive bytes, image hashes and Chinese preference');

    const report = { status: 'passed', version, kind, executable: executable || require('electron'), scope: 'isolated temporary fixtures only; real PhotoRepo and user profile untouched', testSubstitutions, temporary, sourceDirectory, sourceImageDirectory, singleDirectory, libraryRoot, profile, indexPath, sourceHashes, manifestSha256, security, directoryChecks, previews, commitReport, importedItems, clipboardChecks, screenshots, checks, errors };
    fs.writeFileSync(path.join(output, `${kind}-verification.json`), json(report));
    console.log(json({ status: report.status, kind, version, report: path.join(output, `${kind}-verification.json`), security, clipboardChecks: clipboardChecks.length, screenshots, checks, errors }));
  } catch (error) {
    fs.writeFileSync(path.join(output, `${kind}-verification.json`), json({ status: 'failed', version, kind, testSubstitutions, temporary, libraryRoot, profile, security, directoryChecks, previews, clipboardChecks, screenshots, checks, errors, error: error.stack }));
    throw error;
  } finally {
    await closeOwnedApp();
    // Keep only our isolated fixture/profile as supporting evidence. Never
    // close user apps, remove source data, change Git or manipulate Gatekeeper.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
