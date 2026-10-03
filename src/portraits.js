import data from '../assets/selected-prompts.json';
import translations from '../assets/prompts.zh.json';

const images = import.meta.glob('../assets/images/*.png', {
  eager: true, query: '?url', import: 'default',
});
export const portraits = data.map(item => ({
  ...item, image_url: images[`../assets/images/${item.image}`],
  prompts: { en: item.prompt, zh: translations[String(item.id)] },
}));
export const promptFor = (item, language) => item?.prompts[language] ?? '';
export const isPhoto = item => [1, 3, 12, 13, 31, 32, 33, 91].includes(item.id);
export const portraitNumber = item => String(item.id).padStart(3, '0');
