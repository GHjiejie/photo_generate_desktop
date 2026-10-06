const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/creative-lab.mjs');

test('prompt blocks preserve CRLF, Unicode, leading freeform and every continuation without rewriting', async () => {
  const { splitPromptBlocks, composeBlocks } = await model;
  const text = '  An unknown introduction 😀\r\nCustom field: keep this exactly\r\n\r\n主体：成年人\r\n  自然的手势，比例为 2:3\r\n\r\nLighting: soft window light\r\nCustom note: keep this continuation\r\n';
  const blocks = splitPromptBlocks(text, 17, 'zh');
  assert.deepEqual(blocks.map(block => block.category), ['other', 'subject', 'lighting']);
  assert.deepEqual(blocks.map(block => block.key), ['17:zh:0', '17:zh:1', '17:zh:2']);
  assert.ok(blocks[1].text.includes('  自然的手势，比例为 2:3\r\n'));
  assert.ok(blocks[2].text.endsWith('Custom note: keep this continuation\r\n'));
  assert.deepEqual(composeBlocks(blocks), { text });
  const freeform = '\nA soft scene\nwithout known labels\nlighting stays free text\n';
  assert.deepEqual(splitPromptBlocks(freeform, 2, 'en'), [{ key: '2:en:0', sourceId: 2, index: 0, category: 'other', text: freeform }]);
  assert.deepEqual(splitPromptBlocks('', 1, 'en'), []);
});

test('only explicit bilingual prefixes identify categories; ordinary descriptive keywords stay freeform', async () => {
  const { splitPromptBlocks, composeBlocks } = await model;
  for (const text of [
    'Use case: editorial\nSubject: adult\nStyle and scene: charcoal\nLighting: side light\nMood: reflective\nComposition: close portrait\nConstraints: no text',
    '用途：肖像\n主体：成年人\n风格与场景：炭笔\n光线：侧光\n氛围：若有所思\n构图：近景\n约束：无文字'
  ]) {
    const blocks = splitPromptBlocks(text, 9, 'en');
    assert.deepEqual(blocks.map(block => block.category), ['context', 'subject', 'style', 'lighting', 'mood', 'composition', 'constraints']);
    assert.deepEqual(composeBlocks(blocks), { text });
  }
  const formatted = '  **Subject:** adult\n- Composition: close portrait\n媒介优先要求：手绘';
  assert.deepEqual(splitPromptBlocks(formatted, 1, 'zh').map(block => block.category), ['subject', 'composition', 'constraints']);
  const unknown = 'The lighting: comes from the left\nStyle-ish: experimental\nUnusual instruction: preserve all of me';
  assert.equal(splitPromptBlocks(unknown, 1, 'en').length, 1);
  assert.equal(splitPromptBlocks(unknown, 1, 'en')[0].category, 'other');
  for (const label of ['Atmosphere', '气氛', '情绪']) {
    const text = `主体：成年人\r\n${label}：安静 😀\r\n  留下一点悬念\r\n`;
    const blocks = splitPromptBlocks(text, 3, 'zh');
    assert.deepEqual(blocks.map(block => block.category), ['subject', 'mood']);
    assert.deepEqual(composeBlocks(blocks), { text });
  }
});

test('all bundled full bilingual prompts round-trip without dropping any source content', async () => {
  const { splitPromptBlocks, composeBlocks } = await model;
  const originals = require('../assets/selected-prompts.json'), translations = require('../assets/prompts.zh.json');
  for (const item of originals) {
    for (const [language, text] of [['en', item.prompt], ['zh', translations[item.id]]]) {
      const blocks = splitPromptBlocks(text, item.id, language);
      assert.ok(blocks.length >= 6, `${item.id}/${language} has all original sections`);
      assert.deepEqual(composeBlocks(blocks), { text }, `${item.id}/${language} round-trips exactly`);
    }
  }
});

test('imported bilingual asset, style direction and lighting-mood labels remain independently selectable and lossless', async () => {
  const { splitPromptBlocks, composeBlocks } = await model;
  for (const [language, text] of [
    ['zh', '资产类型：单幅肖像\r\n风格定位：温柔炭笔\r\n  保留纸张纹理\r\n风格与场景：窗边\r\n光线与氛围：侧窗光，安静自然\r\n  眼睛保持清晰\r\n构图：肩部以上\r\n'],
    ['en', 'Asset type: standalone portrait\r\nStyle direction: gentle charcoal\r\n  Keep the paper texture\r\nStyle and scene: beside a window\r\nLighting and mood: side-window light, quiet and natural\r\n  Keep the eyes clear\r\nComposition: shoulders-up\r\n']
  ]) {
    const blocks = splitPromptBlocks(text, 81, language);
    assert.deepEqual(blocks.map(block => block.category), ['context', 'style', 'style', 'lighting', 'composition']);
    assert.ok(blocks[1].text.includes(language === 'zh' ? '  保留纸张纹理\r' : '  Keep the paper texture\r'));
    assert.ok(blocks[3].text.includes(language === 'zh' ? '  眼睛保持清晰\r' : '  Keep the eyes clear\r'));
    assert.deepEqual(composeBlocks([blocks[1], blocks[3]]), { text: `${blocks[1].text}\n${blocks[3].text}` });
    assert.deepEqual(composeBlocks(blocks), { text });
  }
  assert.deepEqual(splitPromptBlocks('Style positioning: calm editorial\nLighting and mood: gentle light', 82, 'en').map(block => block.category), ['style', 'lighting']);
});

test('composition preserves chosen order and complete paragraphs while deduplicating only identical source keys', async () => {
  const { composeBlocks, MAX_DRAFT_LENGTH } = await model;
  const a = { key: '1:en:0', text: 'Subject: adult\nwith the full continuation 😀' };
  const b = { key: '2:en:0', text: a.text };
  const c = { key: '1:en:1', text: 'Constraints: preserve this entire paragraph' };
  assert.deepEqual(composeBlocks([c, a, b, a]), { text: `${c.text}\n${a.text}\n${b.text}` });
  assert.deepEqual(composeBlocks([{ key: 'large', text: 'x'.repeat(MAX_DRAFT_LENGTH) }]), { text: 'x'.repeat(MAX_DRAFT_LENGTH) });
  assert.deepEqual(composeBlocks([{ key: 'large', text: 'x'.repeat(MAX_DRAFT_LENGTH) }, { key: 'extra', text: '' }]), { text: '', error: 'lab.tooLong' });
  assert.deepEqual(composeBlocks([{ key: 'emoji', text: '😀'.repeat(MAX_DRAFT_LENGTH / 2 + 1) }]), { text: '', error: 'lab.tooLong' });
  assert.deepEqual(composeBlocks([]), { text: '' });
  assert.deepEqual(composeBlocks([{ key: 'bad', text: 1 }]), { text: '', error: 'lab.invalidBlocks' });
});

test('creative dice keep locked choices, change every unlocked valid choice and never leave their option bounds', async () => {
  const { DICE_CATEGORIES, DICE_OPTIONS, rollDice, diceOption } = await model;
  const previous = rollDice({}, {}, () => 0);
  const locked = { lighting: true, composition: false, mood: true };
  const result = rollDice(previous, locked, () => 0);
  assert.equal(result.lighting, previous.lighting); assert.equal(result.mood, previous.mood);
  assert.notEqual(result.composition, previous.composition);
  for (const value of [0, 0.999, 1, -5, 5, NaN, Infinity, '0.5', undefined]) {
    const rolled = rollDice(previous, {}, () => value);
    for (const category of DICE_CATEGORIES) {
      assert.ok(DICE_OPTIONS[category].some(option => option.id === rolled[category]));
      assert.notEqual(rolled[category], previous[category]);
      assert.ok(DICE_OPTIONS[category].length >= 8 && DICE_OPTIONS[category].length <= 12);
    }
  }
  assert.deepEqual(rollDice(null, null, null), rollDice({}, {}, () => 0));
  assert.deepEqual(rollDice({ lighting: 'unknown' }, { lighting: true }, () => { throw new Error('broken random'); }), rollDice({}, {}, () => 0));
  assert.equal(diceOption('lighting', 'unknown').id, DICE_OPTIONS.lighting[0].id);
  assert.equal(diceOption('unknown', 'unknown').id, DICE_OPTIONS.lighting[0].id);
  assert.equal(diceOption('__proto__', 'unknown').id, DICE_OPTIONS.lighting[0].id);
  assert.equal(diceOption('constructor', 'unknown').id, DICE_OPTIONS.lighting[0].id);
});

test('dice directions have complete bilingual labels and produce a useful three-line prompt', async () => {
  const { DICE_CATEGORIES, DICE_OPTIONS, diceText, rollDice } = await model;
  for (const category of DICE_CATEGORIES) {
    assert.equal(new Set(DICE_OPTIONS[category].map(option => option.id)).size, DICE_OPTIONS[category].length);
    for (const option of DICE_OPTIONS[category]) {
      assert.match(option.zh, /\p{Script=Han}/u); assert.match(option.en, /[A-Za-z]/u);
      assert.ok(option.zh.trim() && option.en.trim());
    }
  }
  const result = rollDice({}, {}, () => 0.5);
  const zh = diceText(result, 'zh'), en = diceText(result, 'en');
  assert.equal(zh.split('\n').length, 3); assert.equal(en.split('\n').length, 3);
  assert.match(zh, /^光线：.+\n构图：.+\n氛围：.+$/u);
  assert.match(en, /^Lighting: .+\nComposition: .+\nMood: .+$/u);
});

test('draft preferences preserve language independence and exact text while discarding only damaged or oversized fields', async () => {
  const { sanitizeDrafts, MAX_DRAFT_LENGTH } = await model;
  const zh = '  中文\r\n😀\n  ', en = '  Subject: adult\ncomplete text  ';
  assert.deepEqual(sanitizeDrafts({ zh, en }), { zh, en });
  assert.deepEqual(sanitizeDrafts({ zh, en: null }), { zh, en: '' });
  assert.deepEqual(sanitizeDrafts({ zh: 'x'.repeat(MAX_DRAFT_LENGTH + 1), en }), { zh: '', en });
  assert.deepEqual(sanitizeDrafts({ zh: '😀'.repeat(MAX_DRAFT_LENGTH / 2), en }), { zh: '😀'.repeat(MAX_DRAFT_LENGTH / 2), en });
  assert.deepEqual(sanitizeDrafts(JSON.parse('{"zh":"safe","en":"safe","__proto__":{"polluted":true}}')), { zh: 'safe', en: 'safe' });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(sanitizeDrafts(Object.create({ zh: 'inherited', en: 'inherited' })), { zh: '', en: '' });
  for (const value of [null, [], 1, 'text']) assert.deepEqual(sanitizeDrafts(value), { zh: '', en: '' });
});
