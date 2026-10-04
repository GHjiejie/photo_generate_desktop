import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import uiMessages from './ui-messages.json';
import systemMessages from '../system-messages.json';

const I18nContext = createContext(null);
const validLanguage = value => value === 'zh' || value === 'en';
const validTheme = value => value === 'dark' || value === 'light';
const storage = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const persist = (key, value) => { try { localStorage.setItem(key, value); } catch { /* The session preference still works. */ } };
const interpolate = (text, params = {}) => text.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => params[key] == null ? '' : String(params[key]));
export function I18nProvider({ children }) {
  const [uiLanguage, setLanguage] = useState(() => {
    const saved = storage('portraitStudio.uiLanguage', 'zh');
    return validLanguage(saved) ? saved : 'zh';
  });
  const [theme, setCurrentTheme] = useState(() => {
    const saved = storage('portraitStudio.theme', 'dark');
    return validTheme(saved) ? saved : 'dark';
  });
  const t = useCallback((key, params = {}) => interpolate(uiMessages[uiLanguage]?.[key] ?? systemMessages[uiLanguage]?.[key] ?? uiMessages.en?.[key] ?? key, params), [uiLanguage]);
  const errorText = useCallback(error => {
    if (!error) return '';
    if (typeof error === 'object' && error.key) return t(error.key, error.params);
    const code = typeof error === 'object' ? error.code : error;
    return t(Object.hasOwn(systemMessages[uiLanguage], `errors.${code}`) ? `errors.${code}` : 'errors.IO_ERROR');
  }, [uiLanguage, t]);
  const issueText = useCallback(issue => {
    if (!issue) return '';
    const code = issue.code ?? issue.reasonCode ?? issue.issueCodes?.[0];
    const key = `issues.${code}`;
    if (Object.hasOwn(systemMessages[uiLanguage], key)) return t(key, issue.params ?? issue);
    const status = issue.status;
    if (status && Object.hasOwn(uiMessages[uiLanguage], `batch.status.${status}`)) return t(`batch.status.${status}`);
    return errorText({ code: code ?? 'INVALID_DATA' });
  }, [uiLanguage, t, errorText]);
  const setUILanguage = useCallback(value => { if (validLanguage(value)) { persist('portraitStudio.uiLanguage', value); setLanguage(value); } }, []);
  const setTheme = useCallback(value => { if (validTheme(value)) { persist('portraitStudio.theme', value); setCurrentTheme(value); } }, []);
  useEffect(() => {
    document.documentElement.lang = uiLanguage === 'zh' ? 'zh-CN' : 'en';
    document.title = t('app.title');
    const result = window.portraitStudio?.setUILanguage?.(uiLanguage);
    result?.catch?.(() => {});
  }, [uiLanguage, t]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    let color = document.querySelector('meta[name="theme-color"]');
    if (!color) { color = document.createElement('meta'); color.name = 'theme-color'; document.head.append(color); }
    color.content = theme === 'dark' ? '#0f1013' : '#f7f7fa';
  }, [theme]);
  const value = useMemo(() => ({ uiLanguage, setUILanguage, theme, setTheme, t, errorText, issueText }), [uiLanguage, setUILanguage, theme, setTheme, t, errorText, issueText]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() { return useContext(I18nContext); }
export function UILanguageControl({ id }) {
  const { t, uiLanguage, setUILanguage } = useI18n();
  return <div id={id} className="ui-language prompt-language" role="group" aria-label={t('ui.language')}><span className="language-label">{t('ui.language')}</span><button type="button" data-language="zh" aria-pressed={uiLanguage === 'zh'} onClick={() => setUILanguage('zh')}>中文</button><button type="button" data-language="en" aria-pressed={uiLanguage === 'en'} onClick={() => setUILanguage('en')}>English</button></div>;
}
