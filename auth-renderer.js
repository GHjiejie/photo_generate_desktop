'use strict';

const strings = {
  zh: { title: '平台登录', description: '内置账号 admin。使用平台管理员初始化的密码；会话只保留在当前应用内存中。', username: '内置账号', password: '密码', cancel: '取消', submit: '登录', pending: '正在验证平台登录…', invalid: '请输入有效的 admin 密码。', rejected: 'admin 密码未通过验证，请重试。', expired: '会话已过期，请重新登录。', uninitialized: '平台尚未初始化 admin 密码。请管理员通过服务器本地安全入口设置密码。', rateLimited: '登录尝试过于频繁，请稍后重试。', gateway: '此地址仍受旧站点登录保护。请管理员配置平台专用路由。', authUnavailable: '此地址未提供平台登录接口，请检查服务版本和路由。', forbidden: '服务器拒绝访问，请检查账号权限。', routeMissing: '此地址未找到图库 API 路由，请检查地址和服务器配置。', serviceUnavailable: '服务器或网关暂时无法提供服务，请稍后重试。', timeout: '服务器连接超时，请检查网络后重试。', invalidResponse: '服务器返回的数据无效，请检查图库服务。', unavailable: '暂时无法连接服务器，请检查网络后重试。' },
  en: { title: 'Platform sign in', description: 'Built-in account: admin. Use the password initialized by the platform administrator. The session stays in memory for this app only.', username: 'Built-in account', password: 'Password', cancel: 'Cancel', submit: 'Sign in', pending: 'Checking platform sign-in…', invalid: 'Enter a valid admin password.', rejected: 'The admin password was not accepted. Try again.', expired: 'Your session expired. Sign in again.', uninitialized: 'The admin password has not been initialized. Ask the administrator to use the secure local server setup.', rateLimited: 'Too many sign-in attempts. Try again later.', gateway: 'This address still requires the previous site login. Ask the administrator to configure the platform route.', authUnavailable: 'This address does not provide the platform sign-in API. Check the service version and route.', forbidden: 'The server denied access. Check the account permissions.', routeMissing: 'The library API route was not found. Check the address and server configuration.', serviceUnavailable: 'The server or gateway is temporarily unavailable. Try again later.', timeout: 'The server connection timed out. Check the network and retry.', invalidResponse: 'The server returned invalid data. Check the library service.', unavailable: 'The server could not be reached. Check the network and retry.' }
};
const errorKeys = { INVALID_CREDENTIALS: 'rejected', AUTH_REQUIRED: 'expired', SESSION_EXPIRED: 'expired', AUTH_NOT_INITIALIZED: 'uninitialized', AUTH_RATE_LIMITED: 'rateLimited', REMOTE_GATEWAY_AUTH_REQUIRED: 'gateway', PLATFORM_AUTH_UNAVAILABLE: 'authUnavailable', REMOTE_AUTH_REQUIRED: 'gateway', REMOTE_FORBIDDEN: 'forbidden', REMOTE_ROUTE_MISSING: 'routeMissing', REMOTE_SERVICE_UNAVAILABLE: 'serviceUnavailable', REMOTE_TIMEOUT: 'timeout', REMOTE_INVALID_RESPONSE: 'invalidResponse', INVALID_INPUT: 'invalid' };
const username = document.getElementById('authUsername'), password = document.getElementById('authPassword'), status = document.getElementById('authStatus'), submit = document.getElementById('authSubmit');
let table = strings.zh;
function clear() { username.value = ''; password.value = ''; }
window.addEventListener('beforeunload', clear);
document.getElementById('authCancel').addEventListener('click', () => { clear(); window.portraitAuthentication.cancel().catch(() => {}); });
document.getElementById('authForm').addEventListener('submit', async event => {
  event.preventDefault(); if (submit.disabled) return;
  const value = { username: 'admin', password: password.value }; password.value = '';
  submit.disabled = true; status.textContent = table.pending;
  try {
    const result = await window.portraitAuthentication.submit(value);
    if (!result?.ok) status.textContent = table[errorKeys[result?.error?.code] || 'unavailable'];
    else clear();
  } catch { status.textContent = table.unavailable; }
  finally { value.username = ''; value.password = ''; submit.disabled = false; }
});
window.portraitAuthentication.state().then(result => {
  if (!result?.ok) return;
  const locale = result.data.locale === 'en' ? 'en' : 'zh'; table = strings[locale]; document.documentElement.lang = locale;
  for (const [id, key] of [['authTitle', 'title'], ['authDescription', 'description'], ['authUsernameLabel', 'username'], ['authPasswordLabel', 'password'], ['authCancel', 'cancel'], ['authSubmit', 'submit']]) document.getElementById(id).textContent = table[key];
  document.getElementById('authEndpoint').textContent = result.data.endpoint;
}).catch(() => { status.textContent = table.unavailable; });
