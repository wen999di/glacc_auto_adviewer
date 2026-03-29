/**
 * ad-viewer — main.js (Electron 主进程)
 *
 * 给梨加速器独立广告 WebView 查看器。
 * 支持持久化 Token，无需每次手动提取 access_token。
 *
 * 启动方式：
 *   npm start -- --accountfile [path]   （推荐：读取持久化 access_token；不再支持 refresh_token）
 */

'use strict';

// 该工具为了对齐原版行为，会在 WebView 中开启 nodeIntegration/关闭 webSecurity。
// Electron 在开发态会持续打印安全警告（DevTools 里刷屏）。这里仅关闭“警告输出”，不改变实际行为。
// 如需保留警告用于排查：可在启动前自行 unset 该环境变量。
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const { screen } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const url = require('url');

// --- account-utils.js INLINED START ---
const ACCOUNT_KEY = 'XUNLEIACCOUNT123';

function decryptAccountDat(buffer) {
  try {
    const decipher = crypto.createDecipheriv('aes-128-ecb', ACCOUNT_KEY, '');
    return Buffer.concat([decipher.update(buffer), decipher.final()]);
  } catch {
    return null;
  }
}

function getDefaultAccountPaths() {
  const paths = [];
  if (process.platform === 'win32') {
    const appDataLocal = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appDataRoaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    for (const base of [appDataLocal, appDataRoaming]) {
      paths.push(path.join(base, 'glacc', 'profiles', 'glaccount', 'account.dat'));
      paths.push(path.join(base, 'glacc', 'profiles', 'xlaccount', 'account.dat'));
    }
  } else {
    paths.push(path.join(os.homedir(), '.config', 'glacc', 'profiles', 'glaccount', 'account.dat'));
  }
  paths.push(path.join(os.homedir(), '.glacc-client', 'account.json'));
  return paths;
}

function extractSdkValue(sdkData, keyPattern) {
  if (!sdkData) return null;
  for (const [key, val] of Object.entries(sdkData)) {
    if (keyPattern.test(key) && typeof val === 'string' && val.length > 20) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && parsed.value) return parsed.value;
        if (typeof parsed === 'string') return parsed;
      } catch {
        return val;
      }
    }
  }
  return null;
}

function extractCredentialsNewFormat(sdkData) {
  if (!sdkData) return null;

  const PREFIX = 'credentials_';
  const currentSub = typeof sdkData.current_sub === 'string' ? sdkData.current_sub : null;

  const entries = [];
  for (const [key, val] of Object.entries(sdkData)) {
    if (!key.startsWith(PREFIX)) continue;
    if (typeof val !== 'string' || val.length < 10) continue;
    let creds;
    try { creds = JSON.parse(val); } catch { continue; }
    if (!creds || typeof creds !== 'object') continue;
    if (!creds.access_token) continue;
    entries.push({ key, creds });
  }

  if (!entries.length) return null;

  let chosen = null;
  if (currentSub) {
    chosen = entries.find((e) => e.key.endsWith('@' + currentSub)) ||
             entries.find((e) => e.creds.sub === currentSub);
  }
  if (!chosen) chosen = entries[0];

  const { creds } = chosen;
  return {
    accessToken:  creds.access_token  || null,
    userId:       creds.sub           || currentSub || null,
  };
}

function extractFromAccountFile(filePath) {
  const candidates = filePath ? [filePath] : getDefaultAccountPaths();

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    if (candidate.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (data && data.accessToken) {
          return {
            accessToken:  data.accessToken  || null,
            userId:       data.userId       || null,
            sourceFile:   candidate,
          };
        }
      } catch { /* skip */ }
      continue;
    }

    const buffer = fs.readFileSync(candidate);
    const decrypted = decryptAccountDat(buffer);
    if (!decrypted) continue;

    let data;
    try {
      data = JSON.parse(decrypted.toString('utf8'));
    } catch {
      continue;
    }

    const userId = (data.lastLoginData && data.lastLoginData.userId) || null;

    if (data.sdkDataVersion && data.sdkData) {
      const newCreds = extractCredentialsNewFormat(data.sdkData);
      if (newCreds && newCreds.accessToken) {
        return {
          accessToken:  newCreds.accessToken,
          userId:       userId || newCreds.userId || null,
          sourceFile:   candidate,
        };
      }
    }

    if (!userId) continue;

    let accessToken = extractSdkValue(data.sdkData, /access.?token/i);
    if (!accessToken && data.sdkData) {
      for (const val of Object.values(data.sdkData)) {
        if (typeof val !== 'string') continue;
        const raw = (() => { try { return JSON.parse(val); } catch { return val; } })();
        const rawStr = typeof raw === 'object' ? (raw && raw.value) : raw;
        if (typeof rawStr === 'string' && rawStr.startsWith('ey') && rawStr.length > 100) {
          accessToken = rawStr;
          break;
        }
      }
    }

    if (!accessToken) continue;

    return {
      accessToken:  accessToken  || null,
      userId,
      sourceFile:   candidate,
    };
  }

  return null;
}
// --- account-utils.js INLINED END ---
const args = process.argv.slice(2);
let ACCESS_TOKEN = null;

// 默认静音终端输出（保留 DevTools/浏览器 console 输出）。
// 如需查看主进程日志：传 --verbose 或设置环境变量 GLACC_VERBOSE=1。
const VERBOSE = args.includes('--verbose') || process.env.GLACC_VERBOSE === '1';
if (!VERBOSE) {
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
}

const accountFileIdx = args.findIndex(arg => arg === '--accountfile');
let ACCOUNT_FILE_ARG;
if (accountFileIdx >= 0) {
  const nextArg = args[accountFileIdx + 1];
  ACCOUNT_FILE_ARG = (nextArg && !nextArg.startsWith('--')) ? nextArg : '';
} else {
  ACCOUNT_FILE_ARG = undefined; // undefined 表示未指定该选项
}

const envIdx = args.indexOf('--env');
const ENV = envIdx >= 0 ? args[envIdx + 1] : 'prod';
const IS_TEST = ENV === 'test';

// ─── API 常量 ────────────────────────────────────────────────────────────────
const XACC_ORIGIN = IS_TEST
  ? 'https://game-test-xacc.xunlei.com'
  : 'https://game-xacc.xunlei.com';

const XBASE_ORIGIN = IS_TEST
  ? 'https://34qhwely564uz2boqrd.xbase.xyz'
  : 'https://user.geilijiasu.net';

const AD_CONFIG_URL  = `${XACC_ORIGIN}/xlppc.gacs/api/gxsdn/act/advert/config/list`;
const AD_STATS_URL   = `${XACC_ORIGIN}/xlppc.gacs/api/gxsdn/act/advert/stats`;
const USER_WALLET_URL= `${XACC_ORIGIN}/xlppc.gacs/api/gxsdn/gold/get_user_wallet`;
// 对齐原项目默认广告入口（基础 URL）；原版会在渲染器运行时额外追加 height=340 与 style=new。
const AD_DEFAULT_URL = 'https://mercuryh5.ixiaochuan.cn/gsAccelerator?adnum=10&app=geili&retry=1';
const SIGN_KEY       = '07f21229eab0bb7d7c4';

const WEBVIEW_DEFAULT_UA = 'glacc/1.0.0.100 Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.215 Electron/22.3.27 Safari/537.36';

// ─── 设备标识（尽量对齐原项目；无法加载 Native 时降级）────────────────────
let ThunderHelper = null;
let _peerIdCache = null;
let _deviceIdCache = null;
let _stableSystemInfoCache = null;

function md5(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
}

function tryLoadThunderHelper() {
  if (ThunderHelper) return;
  const thPath = path.join(__dirname, '../../glacc-client/backend/bin/ThunderHelper.node');
  if (!fs.existsSync(thPath)) return;
  try {
    ThunderHelper = require(thPath);
    console.log('[ad-viewer] ThunderHelper.node loaded');
  } catch (e) {
    console.warn('[ad-viewer] ThunderHelper.node load failed, using fallback:', e.message);
    ThunderHelper = null;
  }
}

function getPeerId() {
  if (_peerIdCache) return _peerIdCache;

  tryLoadThunderHelper();
  if (ThunderHelper) {
    const fn = ThunderHelper.getPeerID || ThunderHelper.getPeerId;
    if (typeof fn === 'function') {
      try {
        const v = fn.call(ThunderHelper);
        if (v) {
          _peerIdCache = String(v);
          return _peerIdCache;
        }
      } catch (e) {
        console.warn('[ad-viewer] ThunderHelper.getPeerID failed, fallback:', e.message);
      }
    }
  }

  const seed = os.hostname() + os.platform() + (os.cpus()[0]?.model || '');
  _peerIdCache = md5(seed);
  return _peerIdCache;
}

function getStableDeviceId(storageDir) {
  if (_deviceIdCache) return _deviceIdCache;

  const filePath = storageDir
    ? path.join(storageDir, 'deviceid.rand.txt')
    : null;

  if (filePath && fs.existsSync(filePath)) {
    try {
      const v = fs.readFileSync(filePath, 'utf8').trim();
      if (/^[0-9a-f]{32}$/i.test(v)) {
        _deviceIdCache = v.toLowerCase();
        return _deviceIdCache;
      }
    } catch {
      // ignore
    }
  }

  _deviceIdCache = crypto.randomBytes(16).toString('hex');
  if (filePath) {
    try {
      fs.writeFileSync(filePath, _deviceIdCache, 'utf8');
    } catch (e) {
      console.warn('[ad-viewer] Failed to persist random deviceid:', e.message);
    }
  }
  return _deviceIdCache;
}

function safeReadJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function safeWriteJsonFile(filePath, obj) {
  try {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[ad-viewer] Failed to persist systeminfo:', e.message);
  }
}

function randomChoice(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = crypto.randomInt(0, list.length);
  return list[idx];
}

function generateStableRandomMac() {
  // Generate a locally-administered unicast MAC.
  const b = crypto.randomBytes(6);
  b[0] = (b[0] & 0b11111110) | 0b00000010;
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(':');
}

function generateStableRandomOsRelease() {
  // Must match original format: os.release() (e.g. 10.0.19045)
  if (os.platform() === 'win32') {
    const candidates = [
      '10.0.19041',
      '10.0.19042',
      '10.0.19043',
      '10.0.19044',
      '10.0.19045',
      '10.0.22621',
      '10.0.22631',
    ];
    return randomChoice(candidates) || '10.0.19045';
  }
  // For non-Windows, fall back to actual release (already matches format).
  return os.release();
}

function generateStableRandomAppDir() {
  // Must look like a directory path string (original returns dirname(__outDir)).
  const drive = process.env.SystemDrive || 'C:';
  const folder = randomChoice(['Program Files', 'Program Files (x86)', 'ProgramData']) || 'Program Files';
  const leaf = randomChoice(['Thunder Network', 'glacc', 'Xunlei', 'Accelerator']) || 'glacc';
  return path.join(drive + path.sep, folder, leaf);
}

function generateStableRandomHardwareInfo() {
  // Keep shape aligned with AccHelper.GetHardwareInfo(): { model, brand }
  const brands = ['Lenovo', 'Dell', 'HP', 'ASUS', 'Acer', 'MSI', 'HUAWEI', 'GIGABYTE'];
  const models = ['Desktop', 'Laptop', 'MiniPC', 'Workstation', 'PC'];
  return {
    brand: randomChoice(brands) || 'PC',
    model: randomChoice(models) || 'PC',
  };
}

function getStableRandomSystemInfo(storageDir) {
  if (_stableSystemInfoCache) return _stableSystemInfoCache;

  const filePath = storageDir ? path.join(storageDir, 'systeminfo.rand.json') : null;
  const saved = safeReadJsonFile(filePath) || {};

  const mac = (typeof saved.mac === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(saved.mac))
    ? saved.mac.toLowerCase()
    : generateStableRandomMac();

  const osRelease = (typeof saved.osRelease === 'string' && /^\d+\.\d+\.\d+$/.test(saved.osRelease))
    ? saved.osRelease
    : generateStableRandomOsRelease();

  const appDir = (typeof saved.appDir === 'string' && saved.appDir.trim())
    ? saved.appDir
    : generateStableRandomAppDir();

  const hardware = (saved.hardware && typeof saved.hardware === 'object')
    ? {
        brand: String(saved.hardware.brand || ''),
        model: String(saved.hardware.model || ''),
      }
    : generateStableRandomHardwareInfo();

  _stableSystemInfoCache = { mac, osRelease, appDir, hardware };
  safeWriteJsonFile(filePath, _stableSystemInfoCache);
  return _stableSystemInfoCache;
}

// ─── 签名算法（guangshanSignParams）─────────────────────────────────────────
function signParams(params) {
  const p = Object.assign({}, params, { key: SIGN_KEY });
  const str = Object.keys(p)
    .sort()
    .map((k, i) => `${i === 0 ? '' : '&'}${k}=${p[k]}`)
    .join('');
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
}

// ─── HTTP 请求封装 ────────────────────────────────────────────────────────────
function headerExists(headers, keyLower) {
  if (!headers || typeof headers !== 'object') return false;
  return Object.keys(headers).some((k) => String(k).toLowerCase() === keyLower);
}

function isFirstPartyHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'game-xacc.xunlei.com' ||
    h === 'game-test-xacc.xunlei.com' ||
    h.endsWith('.xunlei.com') ||
    h === 'user.geilijiasu.net' ||
    h.endsWith('.geilijiasu.net') ||
    h.endsWith('.xbase.xyz')
  );
}

function sanitizeRequestHeaders(headers) {
  const out = { ...(headers || {}) };
  const drop = new Set([
    'host',
    'content-length',
    'connection',
    'transfer-encoding',
    'keep-alive',
    'proxy-connection',
    'upgrade',
  ]);
  for (const k of Object.keys(out)) {
    if (drop.has(String(k).toLowerCase())) delete out[k];
  }
  return out;
}

function pickResponseHint(data) {
  if (!data || typeof data !== 'object') return null;
  const keys = ['code', 'errcode', 'errCode', 'reason', 'msg', 'message'];
  const hint = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) hint[k] = data[k];
  }
  return Object.keys(hint).length ? hint : null;
}

function deleteHeaderCaseInsensitive(headers, headerNameLower) {
  if (!headers) return;
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === headerNameLower) delete headers[k];
  }
}

function makeRequest(reqUrl, method, body, extraHeaders = {}, requestOptions = {}) {
  return new Promise((resolve, reject) => {
    // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const parsed = new URL(reqUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const methodLower = String(method || 'get').toLowerCase();

    // 组装请求 body
    let requestBody = null;
    if (methodLower === 'get') {
      if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
        const qs = new URLSearchParams(parsed.search);
        for (const [k, v] of Object.entries(body)) {
          qs.set(k, v);
        }
        parsed.search = qs.toString();
      }
    } else if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body)) {
        requestBody = body;
      } else if (typeof body === 'string') {
        requestBody = Buffer.from(body, 'utf8');
      } else if (typeof body === 'object') {
        requestBody = Buffer.from(JSON.stringify(body), 'utf8');
      }
    }

    const deviceId = getStableDeviceId(app.isReady() ? app.getPath('userData') : null);
    const peerId = getPeerId();

    const {
      includeAuthHeaders = true,
      includeAppHeaders = true,
      timeoutMs = 15000,
      logPrefix = '[api]',
      logResponseBody = true,
      responseBodyLimit = 1200,
    } = requestOptions || {};

    const sanitizedExtra = sanitizeRequestHeaders(extraHeaders);

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method.toUpperCase(),
      // 解决内网或代理下的自签名证书 handshake failed 错误 (-100)
      rejectUnauthorized: false, 
      headers: {
        ...(headerExists(sanitizedExtra, 'content-type') ? {} : { 'content-type': 'application/json' }),
        ...(headerExists(sanitizedExtra, 'user-agent') ? {} : { 'user-agent': WEBVIEW_DEFAULT_UA }),
        ...(includeAppHeaders ? {
          'package-name': 'glacc',
          'device-id': deviceId,
          'peerid': peerId,
          'app-version': '1.0.0.100',
          'x-channel-id': 'glacc_pc',
          'install-channel': 'glacc_pc',
        } : {}),
        ...(includeAuthHeaders && ACCESS_TOKEN ? { Authorization: `Bearer ${ACCESS_TOKEN}` } : {}),
        ...(includeAuthHeaders ? {
          'userid': currentUserId || '0',
          'user-id': currentUserId || '0',
          'is-login': ACCESS_TOKEN ? '1' : '0',
          'is-vip': '0',
        } : {}),
        ...sanitizedExtra,
      },
    };

    if (requestBody) reqOptions.headers['content-length'] = requestBody.length;

    console.log(`${logPrefix} ${method.toUpperCase()} ${parsed.href}`);
    const req = transport.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedBody;
        try { parsedBody = JSON.parse(data); } catch { parsedBody = data; }
        const hint = pickResponseHint(parsedBody);
        if (logResponseBody) {
          let bodyPreview;
          try {
            bodyPreview = typeof parsedBody === 'string'
              ? parsedBody.slice(0, responseBodyLimit)
              : JSON.stringify(parsedBody).slice(0, responseBodyLimit);
          } catch {
            bodyPreview = '[unserializable]';
          }
          console.log(`${logPrefix} Response: ${res.statusCode}`, hint ? JSON.stringify(hint) : '', bodyPreview);
        } else {
          console.log(`${logPrefix} Response: ${res.statusCode}`, hint ? JSON.stringify(hint) : '');
        }
        resolve({ status: res.statusCode, data: parsedBody, headers: res.headers || {} });
      });
    });

    req.on('error', (e) => {
      console.error(`${logPrefix} Request error for ${method.toUpperCase()} ${parsed.href}:`, e.message);
      reject(e);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

// ─── 获取广告任务列表 ─────────────────────────────────────────────────────────
async function getAdConfig() {
  return makeRequest(AD_CONFIG_URL, 'GET', {});
}

// ─── 提交广告统计数据 ─────────────────────────────────────────────────────────
async function postAdStats(statsData) {
  // 原程序做了 reduce 合并操作，支持前端可能发送的数据数组的情况
  const taskArray = Array.isArray(statsData) ? statsData : [statsData];
  
  const merged = taskArray.reduce((acc, curr) => {
    let newId = acc.advert_id;
    if (newId && curr.advert_id) newId += ',';
    newId += (curr.advert_id || '');
    return {
      ...acc,
      ...curr,
      advert_id: newId,
      ts: (acc.ts || 0) + (curr.ts || 0),
      count: (acc.count || 0) + 1
    };
  }, { advert_id: '', ts: 0, count: 0 });

  // 重点：必须严格只保留这 6 个属性，防止多余字段污染导致签名校验失败
  const body = {
    advert_id: merged.advert_id || '',
    advert_type: String(merged.advert_type || ''),
    event_type: String(merged.event_type || ''),
    ts: merged.ts || 0,
    count: merged.count || 0,
    timestamp: Math.ceil(Date.now() / 1000)
  };
  
  body.sign = signParams(body);
  return makeRequest(AD_STATS_URL, 'POST', body);
}

function toStatsCompatResult({ response, taskId }) {
  const status = response?.status ?? 0;
  const data = response?.data;

  // 对齐原项目 b() 的 code 语义：
  // - http 200: code = data.code
  // - http 408: code = 3
  // - 其他: code = 4
  // - 异常: code = 2（由调用方处理）
  let code;
  if (status === 200) code = Number(data?.code);
  else if (status === 408) code = 3;
  else code = 4;

  return {
    code: Number.isFinite(code) ? code : 4,
    taskId: taskId || 0,
    status,
    data,
  };
}

async function postAdStatsCompat(statsData, taskId = 0) {
  let lastResponse = null;
  try {
    // 原项目 withRetry：最多 3 次，直到 data.code === 0
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postAdStats(statsData);
      lastResponse = res;

      const ok = res?.status === 200 && Number(res?.data?.code) === 0;
      if (ok) break;
    }
    return toStatsCompatResult({ response: lastResponse, taskId });
  } catch (e) {
    console.log('[ad-viewer] postAdStatsCompat error:', e?.message || e);
    return {
      code: 2,
      taskId: taskId || 0,
      status: lastResponse?.status ?? 0,
      data: lastResponse?.data ?? { error: e?.message || String(e) },
    };
  }
}

// ─── 转发 transferFetch 请求 ──────────────────────────────────────────────────
function isEmptyField(v) {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
}

function tryParseJsonObject(maybeJson) {
  if (typeof maybeJson !== 'string') return null;
  const s = maybeJson.trim();
  if (!s) return null;
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseSetCookie(setCookieValue) {
  if (typeof setCookieValue !== 'string' || !setCookieValue.includes('=')) return null;
  const parts = setCookieValue.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const [nameValue, ...attrs] = parts;
  const eqIdx = nameValue.indexOf('=');
  if (eqIdx <= 0) return null;
  const name = nameValue.slice(0, eqIdx).trim();
  const value = nameValue.slice(eqIdx + 1);
  if (!name) return null;

  const cookie = { name, value };
  for (const attr of attrs) {
    const [rawK, rawV] = attr.split('=');
    const k = String(rawK || '').trim().toLowerCase();
    const v = rawV !== undefined ? String(rawV).trim() : '';
    if (!k) continue;
    if (k === 'domain') cookie.domain = v;
    else if (k === 'path') cookie.path = v;
    else if (k === 'expires') {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) cookie.expirationDate = Math.floor(d.getTime() / 1000);
    } else if (k === 'max-age') {
      const sec = Number(v);
      if (Number.isFinite(sec)) cookie.expirationDate = Math.floor(Date.now() / 1000) + sec;
    } else if (k === 'secure') cookie.secure = true;
    else if (k === 'httponly') cookie.httpOnly = true;
    else if (k === 'samesite') {
      const sv = v.toLowerCase();
      if (sv === 'lax') cookie.sameSite = 'lax';
      else if (sv === 'strict') cookie.sameSite = 'strict';
      else if (sv === 'none') cookie.sameSite = 'no_restriction';
    }
  }

  return cookie;
}

async function persistSetCookieToSession(electronSession, reqUrl, responseHeaders) {
  if (!electronSession?.cookies?.set) return;
  const setCookieHeader = responseHeaders?.['set-cookie'] || responseHeaders?.['Set-Cookie'];
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : (typeof setCookieHeader === 'string' ? [setCookieHeader] : []);
  if (!list.length) return;

  for (const item of list) {
    const parsed = parseSetCookie(item);
    if (!parsed) continue;
    const details = {
      url: reqUrl,
      name: parsed.name,
      value: parsed.value,
      path: parsed.path,
      domain: parsed.domain,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      expirationDate: parsed.expirationDate,
      sameSite: parsed.sameSite,
    };
    // 删除 undefined，避免 Electron cookies.set 报错
    for (const k of Object.keys(details)) {
      if (details[k] === undefined) delete details[k];
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await electronSession.cookies.set(details);
    } catch (e) {
      console.warn('[ad-viewer] cookies.set failed:', e?.message || e);
    }
  }
}

function patchAdActionsBodyIfNeeded(reqUrl, body) {
  let parsedUrl;
  try {
    parsedUrl = new URL(reqUrl);
  } catch {
    return body;
  }

  if (parsedUrl.hostname !== 'adapi.izuiyou.com') return body;
  if (!parsedUrl.pathname.endsWith('/ad/ad_actions_pc')) return body;

  const storageDir = app.isReady() ? app.getPath('userData') : null;
  const deviceId = getStableDeviceId(storageDir);
  const peerId = getPeerId();
  const uid = currentUserId ? String(currentUserId) : '';

  // 兼容 body 形态：object / JSON string / querystring / Buffer
  const originalBody = body;
  const isBuf = Buffer.isBuffer(originalBody);
  const bodyStr = isBuf
    ? originalBody.toString('utf8')
    : (typeof originalBody === 'string' ? originalBody : null);

  // 1) JSON object 或 JSON string
  let bodyObj = originalBody;
  let wasJsonString = false;
  if (typeof bodyObj === 'string') {
    const parsed = tryParseJsonObject(bodyObj);
    if (parsed && typeof parsed === 'object') {
      bodyObj = parsed;
      wasJsonString = true;
    }
  } else if (isBuf && bodyStr) {
    const parsed = tryParseJsonObject(bodyStr);
    if (parsed && typeof parsed === 'object') {
      bodyObj = parsed;
      wasJsonString = true;
    }
  }

  if (bodyObj && typeof bodyObj === 'object' && !Buffer.isBuffer(bodyObj)) {
    const before = {
      uid: bodyObj.uid,
      h_uid: bodyObj.h_uid,
      did: bodyObj.did,
      h_did: bodyObj.h_did,
    };

    if (uid && isEmptyField(bodyObj.uid)) bodyObj.uid = uid;
    if (uid && isEmptyField(bodyObj.h_uid)) bodyObj.h_uid = uid;
    if (deviceId && isEmptyField(bodyObj.did)) bodyObj.did = deviceId;
    // 原版 commonConfig 里 h_did 更像 peerId（而不是 device-id）；这里缺省优先填 peerId。
    if (isEmptyField(bodyObj.h_did)) bodyObj.h_did = peerId || deviceId;

    const after = {
      uid: bodyObj.uid,
      h_uid: bodyObj.h_uid,
      did: bodyObj.did,
      h_did: bodyObj.h_did,
    };

    console.log('[ad-viewer][ad_actions_pc] patch(JSON):', { before, after });
    const out = wasJsonString ? JSON.stringify(bodyObj) : bodyObj;
    return isBuf && typeof out === 'string' ? Buffer.from(out, 'utf8') : out;
  }

  // 2) QueryString（例如 application/x-www-form-urlencoded）
  if (bodyStr && bodyStr.includes('=') && !bodyStr.trim().startsWith('{') && !bodyStr.trim().startsWith('[')) {
    try {
      const qs = new URLSearchParams(bodyStr.startsWith('?') ? bodyStr.slice(1) : bodyStr);
      const before = {
        uid: qs.get('uid'),
        h_uid: qs.get('h_uid'),
        did: qs.get('did'),
        h_did: qs.get('h_did'),
      };
      if (uid && isEmptyField(qs.get('uid'))) qs.set('uid', uid);
      if (uid && isEmptyField(qs.get('h_uid'))) qs.set('h_uid', uid);
      if (deviceId && isEmptyField(qs.get('did'))) qs.set('did', deviceId);
      if (isEmptyField(qs.get('h_did'))) qs.set('h_did', peerId || deviceId);

      const outStr = qs.toString();
      const after = {
        uid: qs.get('uid'),
        h_uid: qs.get('h_uid'),
        did: qs.get('did'),
        h_did: qs.get('h_did'),
      };
      console.log('[ad-viewer][ad_actions_pc] patch(QS):', { before, after });
      return isBuf ? Buffer.from(outStr, 'utf8') : outStr;
    } catch (e) {
      console.warn('[ad-viewer][ad_actions_pc] patch(QS) failed:', e.message);
      return body;
    }
  }

  // 兜底：不认识的 body 类型，保持原样
  console.log('[ad-viewer][ad_actions_pc] patch skipped: unrecognized body type');
  return body;
}

async function buildCookieHeaderFromSession(electronSession, reqUrl) {
  if (!electronSession?.cookies?.get) return '';
  try {
    const list = await electronSession.cookies.get({ url: reqUrl });
    if (!Array.isArray(list) || list.length === 0) return '';
    return list
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch (e) {
    console.warn('[ad-viewer] cookies.get failed:', e?.message || e);
    return '';
  }
}

function isAdActionsPcUrl(reqUrl) {
  try {
    const u = new URL(reqUrl);
    return u.hostname === 'adapi.izuiyou.com' && u.pathname.endsWith('/ad/ad_actions_pc');
  } catch {
    return false;
  }
}

async function handleTransferFetch(requests, context = {}) {
  const reqObj = Array.isArray(requests) ? requests[0] : requests;
  if (!reqObj || !reqObj.url) return { status: -1, data: null };

  const { url: reqUrl, method = 'get', body = {}, headers = {} } = reqObj;

  let currentUrl = reqUrl;
  let currentMethod = String(method || 'get').toLowerCase();
  let currentBody = body;
  let redirectsLeft = 5;

  // Base headers from H5
  const baseHeaders = sanitizeRequestHeaders(headers || {});

  const ua = context?.userAgent || WEBVIEW_DEFAULT_UA;
  const pageUrl = context?.pageUrl || '';
  const referer = context?.referer || pageUrl || '';

  // Follow redirects manually so we can persist cookies hop-by-hop.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { status: 400, data: { error: 'Invalid URL', url: currentUrl } };
    }

    const isFirstParty = isFirstPartyHost(parsed.hostname);
    const isAdActions = isAdActionsPcUrl(currentUrl);

    const extraHeaders = { ...baseHeaders };

    // 统一补齐：UA / Referer / Origin（仅当调用方没提供）
    if (!headerExists(extraHeaders, 'user-agent')) extraHeaders['user-agent'] = ua;
    if (referer && !headerExists(extraHeaders, 'referer')) extraHeaders.referer = referer;
    try {
      const origin = referer ? new URL(referer).origin : '';
      if (origin && !headerExists(extraHeaders, 'origin')) extraHeaders.origin = origin;
    } catch {
      // ignore
    }

    // 对第三方域名：不要夹带业务私有头（避免风控/异常）
    if (!isFirstParty) {
      const block = [
        'authorization',
        'userid',
        'user-id',
        'is-login',
        'is-vip',
        'package-name',
        'device-id',
        'peerid',
        'app-version',
        'x-channel-id',
        'install-channel',
      ];
      for (const k of block) deleteHeaderCaseInsensitive(extraHeaders, k);
    }

    // 统一补齐：Cookie（仅当调用方没提供）
    if (!headerExists(extraHeaders, 'cookie') && context?.electronSession) {
      const cookieHeader = await buildCookieHeaderFromSession(context.electronSession, currentUrl);
      if (cookieHeader) extraHeaders.cookie = cookieHeader;
    }

    // ad_actions_pc: 注入 uid/did（兼容 body 形态）
    if (isAdActions) {
      const contentTypeKey = Object.keys(extraHeaders || {}).find((k) => String(k).toLowerCase() === 'content-type');
      console.log('[ad-viewer][ad_actions_pc] transferFetch:', {
        url: currentUrl,
        method: currentMethod,
        contentType: contentTypeKey ? extraHeaders[contentTypeKey] : undefined,
        bodyType: Buffer.isBuffer(currentBody) ? 'buffer' : typeof currentBody,
      });
      currentBody = patchAdActionsBodyIfNeeded(currentUrl, currentBody);
    }

    console.log('[ad-viewer][transferFetch] ->', {
      url: currentUrl,
      method: currentMethod,
      firstParty: isFirstParty,
      hasCookie: headerExists(extraHeaders, 'cookie'),
    });

    // 发起请求；TransferFetch 的超时应更贴近原版（5s），避免 H5 侧判定失败
    // eslint-disable-next-line no-await-in-loop
    const resp = await makeRequest(
      currentUrl,
      currentMethod,
      currentBody,
      extraHeaders,
      {
        includeAuthHeaders: isFirstParty,
        includeAppHeaders: isFirstParty,
        timeoutMs: 5000,
        logPrefix: '[ad-viewer][transferFetch]',
        logResponseBody: false,
      }
    );

    if (context?.electronSession) {
      // eslint-disable-next-line no-await-in-loop
      await persistSetCookieToSession(context.electronSession, currentUrl, resp?.headers);
    }

    const status = Number(resp?.status) || 0;
    const location = resp?.headers?.location || resp?.headers?.Location;
    const isRedirect = [301, 302, 303, 307, 308].includes(status) && !!location;

    if (isRedirect && redirectsLeft > 0) {
      redirectsLeft -= 1;
      const nextUrl = (() => {
        try {
          return new URL(location, currentUrl).toString();
        } catch {
          return location;
        }
      })();

      console.log('[ad-viewer][transferFetch] redirect', { status, from: currentUrl, to: nextUrl });

      // 301/302/303: 通常会变更为 GET（对齐浏览器/axios 常见行为）
      if ([301, 302, 303].includes(status) && currentMethod !== 'get' && currentMethod !== 'head') {
        currentMethod = 'get';
        currentBody = undefined;
        deleteHeaderCaseInsensitive(baseHeaders, 'content-type');
      }

      currentUrl = nextUrl;
      // Cookie 需要按新 URL 重新取；如果之前我们注入过 cookie，就清掉让下一跳重建。
      deleteHeaderCaseInsensitive(baseHeaders, 'cookie');
      continue;
    }

    return resp;
  }
}

function setupWebRequestDebugging() {
  const ses = session.defaultSession;
  if (!ses) return;

  // 打印 WebView/Chromium 侧网络错误（例如 ssl_client_socket_impl handshake failed）
  ses.webRequest.onErrorOccurred((details) => {
    const reqUrl = details?.url || '';
    if (!reqUrl) return;
    if (
      reqUrl.includes('adapi.izuiyou.com') ||
      reqUrl.includes('ixiaochuan.cn') ||
      reqUrl.includes('geilijiasu') ||
      reqUrl.includes('xunlei.com')
    ) {
      console.warn('[webRequest:error]', {
        error: details.error,
        errorCode: details.errorCode,
        url: reqUrl,
        method: details.method,
        resourceType: details.resourceType,
        webContentsId: details.webContentsId,
      });
    }
  });
}

// ─── 解析 token 获取 userId ───────────────────────────────────────────────────
function getUserIdFromToken(token) {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return decoded.sub || decoded.user_id || null;
  } catch {
    return null;
  }
}

// ─── 全局状态 ─────────────────────────────────────────────────────────────────
let mainWindow = null;
let currentUserId = ACCESS_TOKEN ? getUserIdFromToken(ACCESS_TOKEN) : null;
// 当前宿主选择的任务 ID（供 WebView 侧 GetCurrentTaskId 获取）。
// 注意：不再通过 H5 URL query 传 task_id，以减少布局/模式差异。
let currentTaskId = 0;

// stats 成功后触发“任务状态变更”事件（对齐原版 500ms 广播），并做简单去抖，避免频繁刷新导致限流。
let _taskChangedTimer = null;
function scheduleTaskChangedBroadcast() {
  if (_taskChangedTimer) return;
  _taskChangedTimer = setTimeout(() => {
    _taskChangedTimer = null;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ad:taskChanged');
      }
    } catch (e) {
      console.warn('[ad-viewer] taskChanged broadcast failed:', e?.message || e);
    }
  }, 500);
}

// ─── Electron 主窗口 ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'glacc — Ad Task Viewer',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      preload: path.join(__dirname, 'preload-host.js'),
    },
  });

  mainWindow.removeMenu();

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  if (args.includes('--auto')) {
    mainWindow.maximize();
  }

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 开发模式打开 DevTools
  if (args.includes('--devtools')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── IPC 处理器 ───────────────────────────────────────────────────────────────

/** 获取初始化信息 */
ipcMain.handle('ad:init', () => {
  let timeout = null;
  const timeoutIdx = args.indexOf('--timeout');
  if (timeoutIdx >= 0 && args.length > timeoutIdx + 1) {
    timeout = args[timeoutIdx + 1];
  }
  return {
    token: ACCESS_TOKEN,
    userId: currentUserId,
    env: ENV,
    adDefaultUrl: AD_DEFAULT_URL,
    autoMode: args.includes('--auto'),
    timeout: timeout
  };
});

/** 获取广告任务配置 */
ipcMain.handle('ad:getConfig', async () => {
  if (!ACCESS_TOKEN) return { error: 'No access_token provided. Use --accountfile or select an account file in the UI.' };
  try {
    return await getAdConfig();
  } catch (e) {
    return { error: e.message };
  }
});

/** 获取用户钱包与时长 */
ipcMain.handle('ad:getWallet', async () => {
  if (!ACCESS_TOKEN) return { error: 'No access_token provided.' };
  try {
    return await makeRequest(USER_WALLET_URL, 'GET', {});
  } catch (e) {
    return { error: e.message };
  }
});

/** 转发 transferFetch（来自广告 H5 页面） */
ipcMain.handle('ad:transferFetch', async (event, requestsJson) => {
  try {
    const requests = typeof requestsJson === 'string'
      ? JSON.parse(requestsJson)
      : requestsJson;

    const sender = event?.sender;
    const electronSession = sender?.session || session.defaultSession;
    const userAgent = typeof sender?.getUserAgent === 'function' ? sender.getUserAgent() : '';
    const pageUrl = typeof sender?.getURL === 'function' ? sender.getURL() : '';

    return await handleTransferFetch(requests, {
      electronSession,
      userAgent,
      pageUrl,
      referer: pageUrl,
    });
  } catch (e) {
    return { status: 500, data: { error: e.message } };
  }
});

/** 提交广告统计（clickWebView / exposeWebView / completeWebview） */
ipcMain.handle('ad:stats', async (_event, statsDataJson) => {
  try {
    const raw = typeof statsDataJson === 'string'
      ? JSON.parse(statsDataJson)
      : statsDataJson;

    // 兼容原项目的入参形态：对象 / 数组对象 / 字符串数组（safeJsonParse）。
    let normalized;
    if (Array.isArray(raw)) {
      normalized = raw
        .map((x) => {
          if (typeof x === 'string') {
            const parsed = tryParseJsonObject(x);
            return parsed && typeof parsed === 'object' ? parsed : null;
          }
          return (x && typeof x === 'object') ? x : null;
        })
        .filter(Boolean);
    } else {
      normalized = raw;
    }

    if (!normalized || (Array.isArray(normalized) && normalized.length === 0)) {
      return { code: 4, taskId: 0, status: 0, data: { error: 'Invalid stats payload' } };
    }

    const payloadTaskId = (() => {
      const anyItem = Array.isArray(normalized) ? normalized[0] : normalized;
      return Number(anyItem?.task_id || anyItem?.taskId || 0) || 0;
    })();

    // H5 在部分实现里不会把 task_id 放进 stats payload（而是通过 GetCurrentTaskId 获取），
    // 这里提供 fallback，避免 taskId=0 导致服务端侧无法正确归属。
    const effectiveTaskId = payloadTaskId || Number(currentTaskId || 0) || 0;

    const result = await postAdStatsCompat(normalized, effectiveTaskId);
    if (Number(result?.code) === 0) scheduleTaskChangedBroadcast();
    return result;
  } catch (e) {
    return { code: 2, taskId: 0, status: 500, data: { error: e.message } };
  }
});

// 宿主页面选择任务后同步当前 taskId（供 WebView preload 查询）。
ipcMain.on('ad:setCurrentTaskId', (_event, taskId) => {
  const n = Number(taskId);
  currentTaskId = Number.isFinite(n) ? n : 0;
});

ipcMain.on('ad:exit', (event, message) => {
  if (message && message.startsWith('error:')) {
    // 使用 console.error 会被部分进程管理器捕获，直接写 stdout
    process.stdout.write(message + '\n');
    process.exit(0);
  } else {
    process.stdout.write(message + '\n');
    process.exit(0);
  }
});

ipcMain.on('ad:log', (event, message) => {
  process.stdout.write(message + '\n');
});

ipcMain.handle('ad:getCurrentTaskId', () => Number(currentTaskId || 0) || 0);

ipcMain.handle('ad:resizeTo', (event, payload) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;

    const width = Number(payload?.width);
    const height = Number(payload?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;

    const minW = 360;
    const minH = 240;

    const display = screen.getDisplayMatching(win.getBounds());
    const workArea = display?.workArea || { width: 1920, height: 1080 };
    const maxW = Math.max(minW, workArea.width);
    const maxH = Math.max(minH, workArea.height);

    const clampedW = Math.max(minW, Math.min(Math.round(width), maxW));
    const clampedH = Math.max(minH, Math.min(Math.round(height), maxH));

    // 允许调整大小（有的窗口可能被设置为不可 resize）
    const wasResizable = win.isResizable();
    if (!wasResizable) win.setResizable(true);
    win.setSize(clampedW, clampedH);
    if (!wasResizable) win.setResizable(false);
    return true;
  } catch (e) {
    console.warn('[ad-viewer] ad:resizeTo failed:', e.message);
    return false;
  }
});

ipcMain.handle('ad:closeSelfTab', (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    win.close();
    return true;
  } catch (e) {
    console.warn('[ad-viewer] ad:closeSelfTab failed:', e.message);
    return false;
  }
});

ipcMain.handle('ad:bringToTop', (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (!win.isVisible()) win.show();
    win.focus();
    win.moveTop();
    return true;
  } catch (e) {
    console.warn('[ad-viewer] ad:bringToTop failed:', e.message);
    return false;
  }
});

/** 获取用户 Token（供 webview preload 使用） */
ipcMain.handle('ad:getToken', () => ACCESS_TOKEN);

ipcMain.handle('ad:getDeviceInfo', () => {
  const storageDir = app.isReady() ? app.getPath('userData') : null;
  return {
    deviceId: getStableDeviceId(storageDir),
    peerId: getPeerId(),
  };
});

ipcMain.handle('ad:getSystemInfo', () => {
  const storageDir = app.isReady() ? app.getPath('userData') : null;
  const deviceId = getStableDeviceId(storageDir);
  const peerId = getPeerId();
  const stable = getStableRandomSystemInfo(storageDir);

  // Format alignment with original:
  // - GetOSVersion: os.release() style string
  // - GetMac: xx:xx:xx:xx:xx:xx
  // - GetAppDir: directory-like path
  const mac = stable.mac;
  const osVersion = stable.osRelease;
  const appDir = stable.appDir;

  return { deviceId, peerId, mac, osVersion, appDir };
});

ipcMain.handle('ad:getHardwareInfo', () => {
  const storageDir = app.isReady() ? app.getPath('userData') : null;
  const stable = getStableRandomSystemInfo(storageDir);
  return stable.hardware;
});

// 对齐 original：GetADCompletionInfo 实际调用 config/list
ipcMain.handle('ad:getADCompletionInfo', async () => {
  try {
    if (!ACCESS_TOKEN) return { status: 401, data: { code: -1, msg: 'No access_token' } };
    const resp = await makeRequest(AD_CONFIG_URL, 'GET', {}, {}, {
      includeAuthHeaders: true,
      includeAppHeaders: true,
      timeoutMs: 15000,
      logPrefix: '[ad-completion]'
    });
    return resp;
  } catch (e) {
    return { status: 500, data: { code: -1, msg: e.message } };
  }
});

/** 检查应用是否安装（isAppInstalled）— 直接返回 false */
ipcMain.handle('ad:isAppInstalled', () => false);

/** 创建子窗口（createWnd） */
ipcMain.handle('ad:createWnd', (_event, configJson) => {
  try {
    const config = typeof configJson === 'string' ? JSON.parse(configJson) : configJson;
    const win = new BrowserWindow({
      width: config.width || 400,
      height: config.height || 300,
      title: config.title || 'Ad',
      show: true,
    });
    
    win.removeMenu();
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        win.webContents.toggleDevTools();
      }
    });

    if (config.url) win.loadURL(config.url);
    return win.id;
  } catch {
    return 0;
  }
});

/** 刷新 token */
ipcMain.on('ad:setToken', (_event, token) => {
  ACCESS_TOKEN = token;
  currentUserId = getUserIdFromToken(token);
});

/** 打开账号文件选择对话框，提取 access_token */
ipcMain.handle('ad:openAccountFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Account File',
    filters: [
      { name: 'Account Files', extensions: ['dat', 'json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { error: 'Cancelled' };

  const creds = extractFromAccountFile(filePaths[0]);
  if (!creds) return { error: 'Could not extract credentials from the selected file' };

  if (creds.accessToken) {
    ACCESS_TOKEN = creds.accessToken;
    currentUserId = getUserIdFromToken(ACCESS_TOKEN);
  } else {
    return { error: 'No access_token found in account file' };
  }

  if (creds.userId && !currentUserId) currentUserId = creds.userId;
  return { token: ACCESS_TOKEN, userId: currentUserId };
});

// ─── Electron 应用事件 ─────────────────────────────────────────────────────────

// 取消沙盒等机制以规避网吧、代理、加速器等环境下的各类网络阻断或兼容问题
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('no-sandbox');

// 忽略任何证书错误
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault();
  callback(true);
});

app.whenReady().then(async () => {
  setupWebRequestDebugging();

  // 初始化一次 deviceId/peerId，便于日志与 ad_actions_pc 兜底注入
  try {
    const storageDir = app.getPath('userData');
    const deviceId = getStableDeviceId(storageDir);
    const peerId = getPeerId();
    console.log('[ad-viewer] deviceId=', deviceId);
    console.log('[ad-viewer] peerId=', peerId);
  } catch (e) {
    console.warn('[ad-viewer] Device identity init failed:', e.message);
  }

  // ── 解析持久化 Token ──
  if (ACCOUNT_FILE_ARG !== undefined) {
    // --accountfile [path] 模式
    const filePath = ACCOUNT_FILE_ARG || null;
    console.log('[ad-viewer] Reading persistent credentials from account file...');
    const creds = extractFromAccountFile(filePath);
    if (creds && creds.accessToken) {
      ACCESS_TOKEN = creds.accessToken;
      currentUserId = getUserIdFromToken(ACCESS_TOKEN);
    } else {
      console.error('[ad-viewer] No valid account file found (no access_token).');
    }
    if (creds && creds.userId && !currentUserId) currentUserId = creds.userId;
  }

  if (!ACCESS_TOKEN) {
    console.warn('[ad-viewer] Warning: could not obtain access_token. Use --accountfile or select an account file in the UI.');
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
