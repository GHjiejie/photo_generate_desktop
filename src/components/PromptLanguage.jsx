export default function PromptLanguage({ language, onLanguage }) {
  return <div className="prompt-language" role="group" aria-label="提示词语言">
    <span className="language-label">提示词</span>
    <button type="button" aria-pressed={language === 'en'} onClick={() => onLanguage('en')}>English</button>
    <button type="button" aria-pressed={language === 'zh'} onClick={() => onLanguage('zh')}>中文</button>
  </div>;
}
