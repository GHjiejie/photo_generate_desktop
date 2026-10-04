const messages = require('./system-messages.json');
for (const table of Object.values(messages)) Object.freeze(table);
Object.freeze(messages);

const localeTable = locale => messages[locale === 'en' ? 'en' : 'zh'];
const has = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);
function messageText(key, locale = 'zh') {
  const table = localeTable(locale);
  return has(table, key) ? table[key] : table['errors.IO_ERROR'];
}
function errorCode(value) {
  const raw = typeof value === 'string' ? value : value?.code;
  if (['EACCES', 'EPERM', 'EROFS'].includes(raw)) return 'PERMISSION_DENIED';
  return typeof raw === 'string' && has(messages.zh, `errors.${raw}`) ? raw : 'IO_ERROR';
}
function errorText(code, locale = 'zh') { return messageText(`errors.${errorCode(code)}`, locale); }
function errorResult(error, locale = 'zh') {
  const code = errorCode(error);
  return { ok: false, error: { code, message: errorText(code, locale) } };
}
function issueCode(code) { return typeof code === 'string' && has(messages.zh, `issues.${code}`) ? code : 'IO_ERROR'; }
function publicIssue(issue) {
  return { code: issueCode(issue?.code),
    ...(Number.isSafeInteger(issue?.recordIndex) ? { recordIndex: issue.recordIndex } : {}),
    ...(Number.isSafeInteger(issue?.id) ? { id: issue.id } : {}),
    ...(typeof issue?.sourceFileName === 'string' ? { sourceFileName: issue.sourceFileName } : {}),
    severity: issue?.severity === 'info' ? 'info' : 'error' };
}
function publicUnpaired(item) {
  return { sourceFileName: item.sourceFileName, reasonCode: issueCode(item.reasonCode || item.reason) };
}
function publicBatchRow(row, target, source) {
  const issueCodes = [...new Set([...(row.issueCodes || []), ...(target?.code ? [target.code] : [])].map(issueCode))];
  return { recordIndex: row.index, id: row.id, label: row.label,
    sourceFileName: row.sourceFileName || source?.sourceFileName,
    targetFileName: target?.targetFileName,
    status: row.status === 'unmatched' ? 'unmatched' : target?.status || 'invalid',
    code: target?.code ? issueCode(target.code) : issueCodes[0] || null,
    issueCodes,
    ...(row.matchMethod || source?.matchMethod ? { matchMethod: row.matchMethod || source.matchMethod } : {}) };
}

module.exports = { messages, messageText, errorText, errorResult, publicIssue, publicUnpaired, publicBatchRow };
