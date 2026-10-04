export const promptFor = (item, language) => item?.prompts?.[language] ?? (language === 'en' ? item?.prompt ?? '' : '');
export const isPhoto = item => item.type === 'photo';
export const portraitNumber = item => String(item.id).padStart(3, '0');
export const labelFor = (item, language) => {
  const values = [item?.labels?.[language], item?.sourceMetadata?.[language === 'en' ? 'label_en' : 'label_cn'], item?.label];
  return values.find(value => typeof value === 'string' && value.trim()) ?? '';
};
