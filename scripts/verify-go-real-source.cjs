'use strict';

// This acceptance run can only mutate the explicitly named loopback /tmp copy.
// It never imports into the business server or the original Mac photo_repo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { RemoteClient, imageMime, safeRelativePath } = require('../remote-client.cjs');

const project = path.resolve(__dirname, '..');
const endpoint = 'http://127.0.0.1:44137/';
const label = 'real-source-copy-test-20261004';
const testRoot = '/private/tmp/portrait-go-real-source-copy-bigtil8l';
const dataRoot = path.join(testRoot, 'data');
const sourceRoot = '/Users/jie/Downloads/chinese_beauty_50_generated_images';
const originalRoot = path.join(project, 'photo_repo');
const reportPath = path.join(project, '.verification/go-real-source-import.json');
const verifyCompletedCopy = process.argv.length===3 && process.argv[2]==='--verify-completed-copy';
assert(process.argv.length===2 || verifyCompletedCopy,'Only the explicitly guarded verification command is supported.');
const manifestRelativePath = 'generated_portraits_manifest.json';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJSON = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const result = {
  schemaVersion: 1, status: 'prepared', startedAt: new Date().toISOString(),
  scope: { production: false, serverHost: 'this Mac', endpoint, label, testRoot, dataRoot, sourceRoot, originalRoot,
    realBusinessImportPerformed: false, originalSourceModified: false, originalPhotoRepoModified: false,
    usesActualGoHTTP: true, usesActualRemoteClient: true, serverResponsesMocked: false },
  phases: [], checks: [], images: [], blockers: []
};
let sourceBefore, originalBefore, previewID;
function save() { fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`); }
function phase(name, details = {}) { result.status = 'running'; result.stage = name; result.phases.push({ name, at: new Date().toISOString(), ...details }); save(); console.log(`${name}: ${JSON.stringify(details)}`); }
function checked(name, details = {}) { result.checks.push({ name, passed: true, ...details }); }

function pinnedRead(filename) {
  const before = fs.lstatSync(filename); assert(before.isFile() && !before.isSymbolicLink(), `ordinary file ${filename}`);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor); assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino);
    const bytes = fs.readFileSync(descriptor); const after = fs.fstatSync(descriptor), current = fs.lstatSync(filename);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) { assert.equal(after[key], opened[key]); assert.equal(current[key], opened[key]); }
    assert.equal(bytes.length, before.size); return bytes;
  } finally { fs.closeSync(descriptor); }
}
function fingerprint(root) {
  assert.equal(fs.realpathSync(root), root); const files = {};
  function visit(relative = '', depth = 0) {
    assert(depth <= 8); const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name; assert(!entry.isSymbolicLink(), `symlink rejected ${name}`);
      if (entry.isDirectory()) visit(name, depth + 1);
      else { assert(entry.isFile(), `ordinary file ${name}`); const bytes = pinnedRead(path.join(root, name)); const stat = fs.lstatSync(path.join(root, name)); files[name] = { sizeBytes: bytes.length, sha256: sha(bytes), mode: stat.mode & 0o777 }; }
      assert(Object.keys(files).length <= 5000);
    }
  }
  visit(); return files;
}
function baselineFiles(entries) { return Object.fromEntries(entries.map(file => [file.relative, { sizeBytes: file.sizeBytes, sha256: file.sha256, mode: file.mode }])); }
function ordered(value) { return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))); }
function treeSummary(files) { return { count: Object.keys(files).length, bytes: Object.values(files).reduce((sum,file)=>sum+file.sizeBytes,0), sha256: sha(JSON.stringify(ordered(files))) }; }
function sameTree(actual, expected, name) { assert.deepEqual(ordered(actual), ordered(expected), name); }
function cleanItem(item) { const value=clone(item); delete value.image_url; return value; }
function archiveRead(relative) {
  assert(safeRelativePath(relative)); assert(relative.startsWith('.portrait-studio/imports/'));
  const filename = path.join(dataRoot, relative); assert.equal(fs.realpathSync(filename), filename); return pinnedRead(filename);
}
function preservedSources() {
  const sourceAfter = fingerprint(sourceRoot), originalAfter = fingerprint(originalRoot);
  sameTree(sourceAfter, sourceBefore, 'all original source file bytes and modes unchanged');
  sameTree(originalAfter, originalBefore, 'all original photo_repo file bytes and modes unchanged');
  result.preservation = { source: { before: treeSummary(sourceBefore), after: treeSummary(sourceAfter), unchanged: true, files: sourceAfter },
    originalPhotoRepo: { before: treeSummary(originalBefore), after: treeSummary(originalAfter), unchanged: true, files: originalAfter } };
}

async function finishCompletedCopy() {
  // A completed import is never retried. This only corrects a false comparison of
  // original file modes with the copy creator's different initial file modes.
  const previous=readJSON(reportPath);
  assert.equal(previous.status,'failed');assert.equal(previous.scope.endpoint,endpoint);assert.equal(previous.scope.dataRoot,dataRoot);
  assert.equal(previous.error.name,'AssertionError');assert(previous.error.message.startsWith('original copied bytes preserved '));
  assert.equal(previous.commit.count,100);assert.equal(previous.commit.revision,3);assert.equal(previous.commit.report.imported,50);
  assert.equal(previous.repeat.report.imported,0);assert.equal(previous.repeat.report.skipped,50);assert.equal(previous.repeat.unchanged,true);
  assert.equal(previous.images.length,100);assert(previous.images.every(image=>image.fullBilingualPromptEqual===true));
  const baseline=readJSON(path.join(project,'.verification/single-directory-source-preservation.json'));
  sourceBefore=baselineFiles(baseline.source.files);originalBefore=baselineFiles(baseline.photoRepo.files);
  const client=new RemoteClient({baseURL:endpoint,allowLoopback:true});const current=await client.list();
  assert.equal(current.root,label);assert.equal(current.revision,3);assert.equal(current.items.length,100);
  const index=readJSON(path.join(originalRoot,'.portrait-studio/library.json'));assert.deepEqual(current.items.filter(item=>item.id<=50).map(cleanItem),index.items);
  for(const item of current.items){const evidence=previous.images.find(image=>image.id===item.id);assert(evidence);assert.equal(evidence.sha256,item.sha256);assert.equal(evidence.bytes,item.size);assert.equal(evidence.enCharacters,item.prompts.en.length);assert.equal(evidence.zhCharacters,item.prompts.zh.length)}
  const copiedAfter=fingerprint(dataRoot);assert.deepEqual(treeSummary(copiedAfter),previous.repeat.storeAfter,'no later changes after successful idempotence/image validation');
  for(const [relative,file]of Object.entries(originalBefore)){if(relative!=='.portrait-studio/library.json'){assert.equal(copiedAfter[relative].sha256,file.sha256);assert.equal(copiedAfter[relative].sizeBytes,file.sizeBytes)}}
  Object.assign(result,previous);result.verificationCorrections=[{at:new Date().toISOString(),previousError:previous.error,
    reason:'The copy creator used mode 0644 for some seed files whose original mode was 0600. The final seed-byte preservation assertion now compares SHA-256 and length. Every original file mode and hash, and all test-copy modes since the successful idempotence check, are verified unchanged.',
    mutationsDuringCorrection:0,method:'Read-only RemoteClient.list plus pinned file fingerprints; existing 100 actual API image/PNG/prompt results retained.'}];
  delete result.error;result.blockers=[];preservedSources();checked('54-original-copy-images-and-source-archive-file-bytes-unchanged');checked('all-52-source-and-55-original-photo-repo-files-remain-byte-and-mode-identical');
  result.final={count:100,revision:3,label,decodedImages:100,bilingualPromptPairs:100};result.status='passed';result.stage='complete';result.finishedAt=new Date().toISOString();save();
  console.log(`PASS: read-only completion confirms 100 portraits/revision 3 and unchanged original 107 files; ${reportPath}`);
}

async function main() {
  const setup = readJSON(path.join(project,'.verification/go-real-source-server.json'));
  assert.equal(setup.endpoint,endpoint); assert.equal(setup.label,label); assert.equal(setup.testRoot,testRoot); assert.equal(setup.dataRoot,dataRoot); assert.equal(setup.production,false);
  assert.equal(fs.realpathSync(testRoot),testRoot); assert.equal(fs.realpathSync(dataRoot),dataRoot);
  assert(dataRoot.startsWith('/private/tmp/portrait-go-real-source-copy-')); assert.notEqual(dataRoot,originalRoot);
  if(verifyCompletedCopy){await finishCompletedCopy();return;}
  const existingBaseline=readJSON(path.join(project,'.verification/single-directory-source-preservation.json'));
  sourceBefore=fingerprint(sourceRoot); originalBefore=fingerprint(originalRoot);
  sameTree(sourceBefore,baselineFiles(existingBaseline.source.files),'52 source files match existing frozen baseline');
  sameTree(originalBefore,baselineFiles(existingBaseline.photoRepo.files),'55 photo_repo files match existing frozen baseline');
  assert.equal(Object.keys(sourceBefore).length,52); assert.equal(Object.keys(originalBefore).length,55);
  checked('all-107-original-files-match-existing-baseline',{ source:52,photoRepo:55 });
  const originalIndex=readJSON(path.join(originalRoot,'.portrait-studio/library.json'));
  assert.equal(originalIndex.revision,2); assert.equal(originalIndex.items.length,50);
  const client=new RemoteClient({baseURL:endpoint,allowLoopback:true});
  const initial=await client.list(); assert.equal(initial.root,label); assert.equal(initial.revision,2); assert.equal(initial.items.length,50);
  assert.deepEqual(initial.items.map(cleanItem),originalIndex.items);
  result.initial={count:50,revision:2,label,itemsSha256:sha(JSON.stringify(initial.items.map(cleanItem)))};
  checked('exact-isolated-loopback-label-and-copy-baseline'); phase('guarded-copy',{items:50,revision:2});
  const manifestBytes=pinnedRead(path.join(sourceRoot,manifestRelativePath)); const manifest=JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest.images.length,50); const translationFile=path.join(project,'.verification/single-directory-translations.json'); const translations=readJSON(translationFile);
  assert.equal(translations.sourceManifestSha256,sha(manifestBytes)); assert.equal(translations.origin,'assistant-translation'); assert.equal(Object.keys(translations.translations).length,50);
  const imageInputs=[]; const sourceByID=new Map();
  for(const [index,row] of manifest.images.entries()) {
    assert.equal(row.id,index+1); assert.equal(typeof row.prompt,'string'); assert(row.prompt.length>1000); assert.equal(row.prompt_zh,undefined); assert.equal(row.prompt_cn,undefined);
    assert.equal(path.basename(row.image),row.image); const relativePath=`generated_portraits/${row.image}`; assert(safeRelativePath(relativePath));
    const bytes=pinnedRead(path.join(sourceRoot,relativePath)); assert.equal(sha(bytes),row.sha256); assert.equal(imageMime(bytes),'image/png');
    assert.equal(typeof translations.translations[row.id],'string'); assert(translations.translations[row.id].length>200);
    imageInputs.push({relativePath,bytes,mime:'image/png'}); sourceByID.set(row.id,{row,index,relativePath,sha256:sha(bytes)});
  }
  result.source={manifestRelativePath,manifestBytes:manifestBytes.length,manifestSha256:sha(manifestBytes),images:50,
    sourceEnglishOnly:50,chineseOrigin:'assistant-translation',translationFile,translationFileSha256:sha(pinnedRead(translationFile))};
  const upload={manifestRelativePath,manifestBytes,type:'photo',images:imageInputs,derivedChinesePrompts:translations.translations};
  phase('uploading-real-source-to-test-copy',{images:50,bytes:imageInputs.reduce((sum,image)=>sum+image.bytes.length,0)});
  const preview=await client.preview(upload); previewID=preview.previewId;
  assert.equal(preview.root,label); assert.equal(preview.revision,2); assert.equal(preview.total,50); assert.equal(preview.matched,50); assert.equal(preview.importable,50); assert.equal(preview.skipped,0); assert.equal(preview.conflicts,0); assert.equal(preview.counts.errors,0); assert.equal(preview.unpaired.length,0); assert.equal(preview.canImport,true);
  assert.deepEqual(preview.items.map(item=>item.targetId),Array.from({length:50},(_,index)=>index+51));
  assert.equal((await client.list()).items.length,50); checked('actual-preview-pairs-all-50-with-new-internal-ids',{firstTarget:51,lastTarget:100,errors:0});
  result.preview=preview; phase('preview-50-new',{matched:50,importable:50,targetIDs:'51–100'});
  const committed=await client.commit(previewID,{expectedVersion:2,confirmed:true}); previewID=undefined;
  assert.equal(committed.snapshot.root,label); assert.equal(committed.snapshot.revision,3); assert.equal(committed.snapshot.items.length,100); assert.equal(committed.report.imported,50); assert.equal(committed.report.skipped,0);
  assert.deepEqual(committed.snapshot.items.filter(item=>item.id<=50).map(cleanItem),originalIndex.items);
  for(const item of committed.snapshot.items.filter(item=>item.id>50)) {
    const source=sourceByID.get(item.sourceImport.sourceId); assert(source);
    assert.equal(item.id,source.row.id+50); assert.deepEqual(item.sourceMetadata,source.row);
    assert.equal(item.prompts.en,source.row.prompt); assert.equal(item.prompts.zh,translations.translations[source.row.id]); assert.equal(item.sha256,source.sha256);
    assert.equal(item.sourceImport.sourceRelativePath,source.relativePath); assert.equal(item.sourceImport.sourceFileName,source.row.image); assert.equal(item.sourceImport.manifestSha256,sha(manifestBytes));
    const expected={kind:'derived-translation',origin:'assistant-translation',sourceLanguage:'en',targetLanguage:'zh',sourcePromptField:'prompt',sourcePromptSha256:sha(Buffer.from(source.row.prompt)),translatedPromptSha256:sha(Buffer.from(translations.translations[source.row.id])),sourceId:source.row.id,recordIndex:source.index,manifestSha256:sha(manifestBytes)};
    assert.deepEqual(item.sourceImport.translationProvenance,expected); assert.equal(Object.keys(item.sourceImport.translationProvenance).length,10);
    assert.equal(item.sourceImport.derivedChinesePrompt,translations.translations[source.row.id]);
  }
  const archive=committed.report.archiveRel; assert.equal(sha(archiveRead(`${archive}/manifest.json`)),sha(manifestBytes)); assert(archiveRead(`${archive}/manifest.json`).equals(manifestBytes));
  checked('100-items-original-50-fields-preserved-new-50-all-source-fields-and-full-prompts-preserved');
  checked('all-50-translations-have-exact-10-key-derived-provenance');checked('raw-original-json-archive-is-byte-identical');
  result.commit={revision:committed.snapshot.revision,count:committed.snapshot.items.length,report:committed.report};phase('committed-test-copy-100',{imported:50,items:100,revision:3});
  const beforeRepeat=fingerprint(dataRoot); const repeated=await client.preview(upload);previewID=repeated.previewId;
  assert.equal(repeated.root,label);assert.equal(repeated.revision,3);assert.equal(repeated.importable,0);assert.equal(repeated.skipped,50);assert.equal(repeated.conflicts,0);assert.equal(repeated.canImport,false);
  const noop=await client.commit(previewID,{expectedVersion:3,confirmed:true});previewID=undefined;
  assert.equal(noop.snapshot.revision,3);assert.equal(noop.snapshot.items.length,100);assert.equal(noop.report.imported,0);assert.equal(noop.report.skipped,50);
  sameTree(fingerprint(dataRoot),beforeRepeat,'repeat changes no index, image or archive bytes');
  checked('repeat50-skips-and-atomic-noop-revision-index-image-archive-bytes');result.repeat={preview:repeated,report:noop.report,storeBefore:treeSummary(beforeRepeat),storeAfter:treeSummary(fingerprint(dataRoot)),unchanged:true};
  phase('checking-all-100-images',{bilingual:100});
  for(const item of noop.snapshot.items) {
    const bytes=await client.image(item);const picture=PNG.sync.read(bytes);assert.equal(sha(bytes),item.sha256);assert(picture.width>0&&picture.height>0);assert(item.prompts.en.length>0&&item.prompts.zh.length>0);
    const full=await client.get(item.id);assert.deepEqual(full.item.prompts,item.prompts);
    result.images.push({id:item.id,sha256:sha(bytes),bytes:bytes.length,width:picture.width,height:picture.height,enCharacters:item.prompts.en.length,zhCharacters:item.prompts.zh.length,fullBilingualPromptEqual:true});
  }
  checked('100-actual-api-images-hash-validated-png-decoded-and-full-bilingual-get-prompts',{count:100});
  // Existing image/archive bytes in the copied seed also remain unchanged.
  const copiedAfter=fingerprint(dataRoot);for(const [relative,file]of Object.entries(originalBefore)){if(relative!=='.portrait-studio/library.json'){assert.equal(copiedAfter[relative].sha256,file.sha256,`original copied bytes preserved ${relative}`);assert.equal(copiedAfter[relative].sizeBytes,file.sizeBytes,`original copied length preserved ${relative}`)}}
  checked('54-original-copy-images-and-source-archive-files-unchanged');preservedSources();checked('all-52-source-and-55-original-photo-repo-files-remain-byte-and-mode-identical');
  result.final={count:100,revision:3,label,decodedImages:100,bilingualPromptPairs:100};result.status='passed';result.stage='complete';result.finishedAt=new Date().toISOString();save();console.log(`PASS: isolated test copy has 100 portraits/revision 3; original 107 files unchanged; report ${reportPath}`);
}

main().catch(async error=>{
  if(previewID){try{await new RemoteClient({baseURL:endpoint,allowLoopback:true}).cancel(previewID)}catch(cleanup){result.blockers.push(`Preview cleanup: ${cleanup.code||cleanup.message}`)}}
  result.status='failed';result.finishedAt=new Date().toISOString();result.error={code:error.code,name:error.name,message:error.message,stack:error.stack};
  if(sourceBefore&&originalBefore){try{preservedSources()}catch(preservation){result.blockers.push(`Original-file preservation check: ${preservation.message}`)}}
  save();console.error(error);process.exitCode=1;
});
