const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { trustedSender, resolvePortraitImage } = require('../electron-security.cjs');

test('IPC accepts only the expected document in the main frame', () => {
  const frame = { url: 'file:///renderer/index.html' };
  assert.equal(trustedSender({senderFrame:frame,sender:{mainFrame:frame}},frame.url),true);
  assert.equal(trustedSender({senderFrame:{url:frame.url},sender:{mainFrame:frame}},frame.url),false);
  assert.equal(trustedSender({senderFrame:frame,sender:{mainFrame:frame}},'https://example.com'),false);
  assert.equal(trustedSender({senderFrame:null,sender:{mainFrame:frame}},frame.url),false);
});
test('image IPC rejects traversal, unlisted files, missing files, directories and escaping symlinks', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'portrait-security-'));
  try {
    const images=path.join(temp,'images');
    await fs.mkdir(images);
    await fs.writeFile(path.join(images,'known.png'),'image bytes');
    await fs.writeFile(path.join(temp,'outside.png'),'outside');
    await fs.symlink(path.join(temp,'outside.png'),path.join(images,'linked.png'));
    await fs.mkdir(path.join(images,'directory.png'));
    const names = new Set(['known.png','linked.png','missing.png','directory.png','../outside.png']);
    assert.equal(await resolvePortraitImage('known.png',images,names),await fs.realpath(path.join(images,'known.png')));
    for (const name of ['../outside.png','linked.png','missing.png','directory.png','unknown.png',null,{},'/tmp/file.png']) {
      assert.equal(await resolvePortraitImage(name,images,names),null);
    }
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});
