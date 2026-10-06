export const MAX_DRAFT_LENGTH = 65536;

const labelCategories = new Map([
  ...['context', 'use case', 'asset type', 'scene', 'setting', 'background', '用途', '素材类型', '资产类型', '场景', '环境', '背景', '情境'].map(label => [label, 'context']),
  ...['subject', 'character', '主体', '人物', '角色'].map(label => [label, 'subject']),
  ...['style', 'style direction', 'style positioning', 'style and scene', 'art style', 'medium', '风格', '风格定位', '风格与场景', '艺术风格', '媒介'].map(label => [label, 'style']),
  ...['lighting', 'lighting and mood', 'light', '光线', '光线与氛围', '光照', '照明', '灯光'].map(label => [label, 'lighting']),
  ...['mood', 'atmosphere', '氛围', '气氛', '情绪'].map(label => [label, 'mood']),
  ...['composition', 'framing', '构图', '取景'].map(label => [label, 'composition']),
  ...['constraints', 'restrictions', 'negative prompt', 'medium priority', '约束', '限制', '负面提示词', '禁用元素', '媒介优先要求'].map(label => [label, 'constraints'])
]);

function categoryForLine(line) {
  const match = /^[ \t]*(?:[-*•][ \t]+)?(?:\*\*)?([^:\r\n：]{1,48})[：:]/u.exec(line);
  if (!match) return null;
  const label = match[1].replace(/\*\*$/u, '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return labelCategories.get(label) ?? null;
}

export function splitPromptBlocks(text, sourceId, language = 'zh') {
  if (typeof text !== 'string' || !text.length) return [];
  const starts = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const lineEnd = newline < 0 ? text.length : newline;
    const category = categoryForLine(text.slice(offset, lineEnd));
    if (offset === 0 || category) starts.push({ offset, category: category ?? 'other' });
    if (newline < 0) break;
    offset = newline + 1;
  }
  return starts.map((start, index) => ({
    key: `${sourceId}:${language}:${index}`, sourceId, index, category: start.category,
    // The LF at a block boundary is supplied by composeBlocks. Keeping any
    // preceding CR lets a full composition reproduce CRLF input exactly.
    text: text.slice(start.offset, index + 1 < starts.length ? starts[index + 1].offset - 1 : text.length)
  }));
}

export function composeBlocks(blocks) {
  if (!Array.isArray(blocks)) return { text: '', error: 'lab.invalidBlocks' };
  const seen = new Set(), texts = [];
  let length = 0;
  for (const block of blocks) {
    if (!block || typeof block.key !== 'string' || !block.key || typeof block.text !== 'string') return { text: '', error: 'lab.invalidBlocks' };
    if (seen.has(block.key)) continue;
    seen.add(block.key);
    length += block.text.length + (texts.length ? 1 : 0);
    if (length > MAX_DRAFT_LENGTH) return { text: '', error: 'lab.tooLong' };
    texts.push(block.text);
  }
  return { text: texts.join('\n') };
}

export function sanitizeDrafts(value) {
  const drafts = { zh: '', en: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drafts;
  for (const language of ['zh', 'en']) {
    if (Object.hasOwn(value, language) && typeof value[language] === 'string' && value[language].length <= MAX_DRAFT_LENGTH) drafts[language] = value[language];
  }
  return drafts;
}

export const DICE_CATEGORIES = Object.freeze(['lighting', 'composition', 'mood']);
const options = entries => Object.freeze(entries.map(([id, zh, en]) => Object.freeze({ id, zh, en })));
export const DICE_OPTIONS = Object.freeze({
  lighting: options([
    ['window', '柔和侧窗光，面部阴影自然渐变', 'Soft side-window light with a natural gradient across the face'],
    ['golden', '落日暖光掠过发梢，保留柔和肤色', 'Warm sunset light grazing the hair while keeping skin tones gentle'],
    ['overcast', '阴天散射光，色彩清透而克制', 'Diffused overcast light with clear, restrained colors'],
    ['studio', '大面积柔光配细微轮廓光，突出面部层次', 'A large soft light and subtle rim light shaping the face'],
    ['neon', '青蓝与玫红的细轮廓光，面部保持清晰', 'Fine cyan and magenta rim lights with a clearly readable face'],
    ['lantern', '温暖纸灯笼光，背景缓缓隐入暗部', 'Warm paper-lantern light with the background fading gently into shadow'],
    ['blue-hour', '蓝调时刻的冷环境光，叠加一束暖色补光', 'Cool blue-hour ambient light with one warm fill light'],
    ['prism', '棱镜折射的淡彩光斑轻落在衣料上', 'Soft prism-colored light patches falling lightly on the clothing'],
    ['dappled', '树叶间的斑驳光影，眼睛留在柔光中', 'Dappled light through leaves with the eyes kept in soft light'],
    ['bounce', '浅色墙面反射的间接光，营造安静空间感', 'Indirect light reflected from a pale wall, creating a quiet sense of space']
  ]),
  composition: options([
    ['off-center', '人物偏离中心，留白与视线方向呼应', 'Place the subject off-center with negative space following the gaze'],
    ['close-up', '近距离面部特写，让微小表情成为焦点', 'Use a close facial portrait that makes subtle expression the focal point'],
    ['foreground', '以轻微虚化的前景形成自然框景', 'Frame the subject naturally with a softly blurred foreground'],
    ['low-angle', '略低机位，背景线条引向人物轮廓', 'Use a slightly low viewpoint with background lines leading toward the silhouette'],
    ['overhead', '轻微俯视，让姿态与地面纹理形成节奏', 'Use a gentle overhead viewpoint so the pose and ground texture create a rhythm'],
    ['environment', '拉远一点，让人物与周围空间共同叙事', 'Pull back so the subject and surrounding space tell the story together'],
    ['reflection', '用一处柔和倒影丰富画面，主体依旧鲜明', 'Add one soft reflection while keeping the main subject distinct'],
    ['diagonal', '以轻微对角线安排肩线，带来流动感', 'Arrange the shoulder line on a subtle diagonal for a sense of flow'],
    ['geometry', '借助简单几何背景，让人物轮廓更利落', 'Use a simple geometric background to give the silhouette a cleaner shape'],
    ['doorway', '以门框或窗框构成层次分明的空间', 'Use a doorway or window frame to build clearly layered space']
  ]),
  mood: options([
    ['quiet', '安静而亲近，像一段未说出口的对话', 'Quiet and intimate, like a conversation that has not yet been spoken'],
    ['wonder', '带一点发现新事物的好奇与惊喜', 'A trace of curiosity and delight at discovering something new'],
    ['determined', '目光坚定，姿态放松，传达从容力量', 'A steady gaze and relaxed pose conveying composed strength'],
    ['playful', '轻松俏皮，捕捉笑意将起的瞬间', 'Light and playful, catching the moment just before a smile'],
    ['nostalgic', '温柔怀旧，像被珍藏的一页生活片段', 'Tender and nostalgic, like a carefully kept page from everyday life'],
    ['dreamlike', '梦境般轻盈，细节清晰而气氛朦胧', 'Airy and dreamlike, with clear details and a hazy atmosphere'],
    ['serene', '舒展平和，让画面有缓慢呼吸的节奏', 'Open and serene, giving the image the rhythm of a slow breath'],
    ['mysterious', '含蓄神秘，通过眼神留下一点悬念', 'Quietly mysterious, leaving a little intrigue in the eyes'],
    ['celebratory', '明亮而有庆祝感，像一个值得记住的日子', 'Bright and celebratory, like a day worth remembering'],
    ['reflective', '若有所思，让注意力落在自然的小动作上', 'Reflective, drawing attention to a small and natural gesture']
  ])
});

export function diceOption(category, id) {
  const choices = Object.hasOwn(DICE_OPTIONS, category) ? DICE_OPTIONS[category] : DICE_OPTIONS.lighting;
  return choices.find(option => option.id === id) ?? choices[0];
}

export function rollDice(previous = {}, locked = {}, random = Math.random) {
  const result = {};
  for (const category of DICE_CATEGORIES) {
    const choices = DICE_OPTIONS[category];
    const current = choices.find(option => option.id === previous?.[category]);
    if (locked?.[category] === true && current) { result[category] = current.id; continue; }
    const candidates = current && choices.length > 1 ? choices.filter(option => option.id !== current.id) : choices;
    let sample = 0;
    try { sample = typeof random === 'function' ? random() : 0; } catch { /* A faulty random source selects the first valid alternative. */ }
    const fraction = typeof sample === 'number' && Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
    result[category] = candidates[Math.min(candidates.length - 1, Math.floor(fraction * candidates.length))].id;
  }
  return result;
}

export function diceText(result, language = 'zh') {
  const labels = language === 'en' ? { lighting: 'Lighting', composition: 'Composition', mood: 'Mood' } : { lighting: '光线', composition: '构图', mood: '氛围' };
  const locale = language === 'en' ? 'en' : 'zh', separator = locale === 'en' ? ': ' : '：';
  return DICE_CATEGORIES.map(category => `${labels[category]}${separator}${diceOption(category, result?.[category])[locale]}`).join('\n');
}
