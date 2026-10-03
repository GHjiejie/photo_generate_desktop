const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const originals = require('../assets/selected-prompts.json');
const translations = require('../assets/prompts.zh.json');

// Captured from the pre-bilingual HEAD. The test also works in source archives
// without a Git checkout, and catches accidental edits to any English prompt.
const originalDigests = {
  1: '505fc4f61ea5a898fde315ce2ffaa09e2f1f38dd7563d402b4cfcf6ff8ed8c00',
  3: '4649b7648131ce702542c8d6a54e0882b2be2f831a02fdad20fb899fac6764ad',
  12: '544a819c67f21513bc0064a1f592518a4f4b255e8709ca8387ddd5c6fec7953c',
  13: 'de9b7485db3ff0f2255215bb6f80eb4f20d4661ce942c9f49dbfb800129fca78',
  31: '1f48cfc6f4e358ac7e2d9a458a5feb9301a5796d0e8ce59f7511915f582a2547',
  32: 'a1ac4ae054694d2cea715b3baec7c12f6c9bdf42f75898b01bf1e5b064ba1bc1',
  33: '944668ed91ae9bab83e520e0f5bb8183e798cc3f5f4a38a8329aed369e29259e',
  43: '4802816a6865f5743dcb62eb075a319d8cd4d831370d6eddc9560ce1d880cb5c',
  51: '0636f7fe8e782e49c218ac3c576d4bc9c766f068e0cdd55b24fb0cbb7bcb1ade',
  52: '79ec406c1fa934a2257d6ab99a6b30ee35be1102248a9564a670ba51d4d9e5e6',
  53: 'e895189affdb98cadbbbcf3d5f9442135f65ec086cab575938efdc5825c5afa1',
  91: '056e416c2186dde17e59662d6f9e54300fb1a2862830208f1952fc92facf3c56',
  93: 'a2f3743018d19608b3d7f36ec50161fb86844148c4e3343a2b9a732d27de9632',
};
const paragraphs = text => text.split(/\r?\n/).filter(line => line.trim());

test('the original 13 English prompts retain their exact pre-bilingual contents', () => {
  assert.deepEqual(originals.map(item => item.id), [1,3,12,13,31,32,33,43,51,52,53,91,93]);
  for (const item of originals) {
    assert.equal(createHash('sha256').update(item.prompt).digest('hex'), originalDigests[item.id], `English ${item.id} changed`);
  }
});

test('every original has a separate full Chinese translation with all sections and numeric constraints', () => {
  assert.deepEqual(Object.keys(translations).sort(), originals.map(item => String(item.id)).sort());
  const sections = ['用途：','素材类型：','主体：','风格与场景：','构图：','约束：'];
  for (const item of originals) {
    const translated = translations[String(item.id)];
    assert.equal(typeof translated, 'string', `Chinese ${item.id} must be text`);
    assert.ok(translated.trim(), `Chinese ${item.id} cannot be empty`);
    const lines = paragraphs(translated);
    assert.equal(lines.length, paragraphs(item.prompt).length, `Chinese ${item.id} loses a prompt paragraph`);
    for (const [index, section] of sections.entries()) {
      assert.ok(lines[index].startsWith(section), `Chinese ${item.id} loses ${section}`);
      assert.match(lines[index], /\p{Script=Han}/u);
    }
    assert.deepEqual(translated.match(/\d+(?::\d+)?/g), item.prompt.match(/\d+(?::\d+)?/g), `Chinese ${item.id} changes an age, collection size, or aspect ratio`);
    assert.match(translated, /25岁或以上/);
    assert.match(translated, /仅一位女性/);
    for (const constraint of ['文字','标志','水印','接触印相表','多幅肖像拼贴','多面板']) {
      assert.ok(lines[5].includes(constraint), `Chinese ${item.id} loses the ${constraint} constraint`);
    }
  }
});

test('Chinese 053 preserves the appended hand-drawn medium priority and camera prohibition', () => {
  const medium = paragraphs(translations['53'])[6];
  assert.ok(medium.startsWith('媒介优先要求：'));
  for (const constraint of ['手绘','粉彩','绝不是照片','脸','头发','衬衫','背景','笔触','纸张','成年人','摄影般的皮肤','相机成像效果']) {
    assert.ok(medium.includes(constraint), `Chinese 053 loses ${constraint}`);
  }
});
