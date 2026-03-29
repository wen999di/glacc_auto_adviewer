/**
 * webview-preload.js — 广告 WebView 内的 preload 脚本
 *
 * 在广告 H5 页面的 JS 上下文中注入 window.native API，
 * 将广告页面的原生调用桥接到 Electron 宿主进程。
 *
 * 广告 H5 页面的调用方式：
 *   window.native.CallNativeFunction('transferFetch', requestsJsonStr, callback)
 *   window.native.CallNativeFunction('clickWebView', statsJsonStr, callback)
 *   window.native.CallNativeFunction('exposeWebView', statsJsonStr, callback)
 *   window.native.CallNativeFunction('completeWebview', statsJsonStr, callback)
 *   window.native.CallNativeFunction('isAppInstalled', argsJsonStr, callback)
 *   window.native.CallNativeFunction('GetUserInfo', '', callback)
 *   window.native.CallNativeFunction('GetAccessToken', '', callback)
 *   window.native.CheckNativeFunction(funcName, callback)
 *   window.native.AttachNativeEvent(eventName, callback)
 */

'use strict';

// 某些广告 H5 会尝试 `require('C:\\ProgramData\\Xunlei\\zx_sdk\\bin\\ZX_sdk.node')`。
// 独立 ad-viewer 环境通常没有该文件，导致“Cannot find module ... ZX_sdk.node”刷屏。
// 这里提供一个最小 stub：避免直接抛错（不承诺 SDK 功能可用）。
try {
  // eslint-disable-next-line node/no-deprecated-api
  const Module = require('module');
  const crypto = require('crypto');
  const os = require('os');
  const normalizeWinPath = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
  const ZX_SDK_SUFFIX = normalizeWinPath('\\programdata\\xunlei\\zx_sdk\\bin\\zx_sdk.node');

  if (!Module.__glaccZxSdkStubPatched) {
    Module.__glaccZxSdkStubPatched = true;
    const originalLoad = Module._load;
    let warned = false;

    const stableQimei = (() => {
      try {
        const seed = `${os.hostname()}|${process.env.USERNAME || ''}|glacc_zx_stub`;
        return crypto.createHash('sha1').update(seed, 'utf8').digest('hex');
      } catch {
        return `glacc_zx_${Date.now()}`;
      }
    })();

    const zxStub = new Proxy(function zx_stub_call() { return 0; }, {
      get(_target, prop) {
        if (prop === '__isGlaccZxStub') return true;
        if (prop === 'default') return zxStub;
        if (prop === 'toString') return () => '[glacc zx_sdk stub]';

        const name = String(prop || '');
        // 常见：页面尝试从 ZX SDK 拿 qimei 作为设备标识；拿不到会进入快速重试。
        // 这里返回一个“稳定的占位值”来避免死循环（不承诺是真实 qimei）。
        if (name && name.toLowerCase().includes('qimei')) {
          return function zx_stub_qimei() { return stableQimei; };
        }

        return function zx_stub_method() { return 0; };
      },
      apply() {
        return 0;
      },
    });

    // eslint-disable-next-line func-names
    Module._load = function (request, parent, isMain) {
      try {
        const reqNorm = normalizeWinPath(request);
        if (reqNorm.endsWith(ZX_SDK_SUFFIX)) {
          if (!warned) {
            warned = true;
            try {
              console.log('[webview-preload] ZX_sdk.node not found; using stub');
            } catch {
              // ignore
            }
          }
          return zxStub;
        }
      } catch {
        // ignore
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  }
} catch {
  // ignore
}

const { ipcRenderer } = require('electron');

// 注册的 JS 函数（供原生层调用）
const jsCallbacks = {};
// 注册的原生事件监听器
const nativeEventListeners = {};

// 原生函数可用性列表（广告页面会先 CheckNativeFunction 确认函数存在）
const SUPPORTED_FUNCTIONS = new Set([
  'transferFetch',
  'TransferFetch',
  'clickWebView',
  'ClickWebView',
  'exposeWebView',
  'ExposeWebView',
  'completeWebview',
  'CompleteWebview',
  'isAppInstalled',
  'IsAppInstalled',
  'isInstalledWechat',
  // 打开网页/窗口（广告点击落地页）
  'openBrowser',
  'OpenBrowser',
  'OpenNewWin',
  'openNewTab',
  'createWnd',
  'CreateWnd',
  'getADHwnd',
  'GetADHwnd',
  'showWebview',
  'ShowWebview',
  'GetUserInfo',
  'GetAccessToken',
  'GetPeerID',
  'GetPeerId',
  'GetDeviceID',
  'GetDeviceId',
  'GetMac',
  'GetOSVersion',
  'GetAppDir',
  // 兼容：部分页面会用大写/变体
  'GetPeerID',
  'GetDeviceID',
  'GetMac',
  'GetOSVersion',
  'GetAppDir',
  'SDKInit',
  'GetADCompletionInfo',
  'SDKInit',
  'GetADCompletionInfo',
  'getADCompletionInfo',
  'CheckIsVip',
  'GetWallet',
  'GetHardwareInfo',
  'ResizeTo',
  'CloseSelfTab',
  'BringWebWndToTop',
  'GetCurrentTaskId',
]);

const NativeFunctionErrorCode = {
  // 对齐 original: NativeFunctionErrorCode
  Success: 0,
  FunctionUnExist: 1,
  ParamError: 2,
  CallFailed: 3,
  NotAllowed: 4,
};

// 对齐 original：NativeReady 在收到 embeded-webview-dom-ready 之前应处于 pending。
let _nativeReadyResolve = null;
let _nativeReadyPromise = new Promise((resolve) => {
  _nativeReadyResolve = resolve;
});

let _windowBridgeInstalled = false;

function resolveNativeReadyOnce() {
  if (typeof _nativeReadyResolve !== 'function') return;
  try {
    _nativeReadyResolve(0);
  } finally {
    _nativeReadyResolve = null;
  }
}

ipcRenderer.on('embeded-webview-dom-ready', (_event, webviewId, isNewPath, hwnd) => {
  // IMPORTANT: host 侧通过 webview console-message 只能稳定抓到单字符串。
  // 用 logLine 确保握手日志可观测（避免 console.log 多参数丢失）。
  try {
    logLine('[webview-preload] embeded-webview-dom-ready', { webviewId, isNewPath, hwnd });
  } catch {
    // ignore
  }

  // 原版是在握手后才覆写 window.resizeTo/close/moveTop（需幂等）。
  if (!_windowBridgeInstalled) {
    _windowBridgeInstalled = true;
    try {
      installWindowResizeBridge();
    } catch {
      // ignore
    }
  }

  // 回传 ack：宿主可用来判断是否需要重发握手。
  try {
    ipcRenderer.sendToHost('ad:handshakeAck', {
      webviewId,
      isNewPath,
      hwnd,
      ts: Date.now(),
    });
  } catch {
    // ignore
  }

  resolveNativeReadyOnce();
});

function safeStringify(value, { maxLen = 2000 } = {}) {
  const seen = new WeakSet();
  let out;
  try {
    out = JSON.stringify(value, (k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + '…';
      return v;
    });
  } catch {
    try {
      out = String(value);
    } catch {
      out = '[Unserializable]';
    }
  }
  if (typeof out === 'string' && out.length > maxLen) return out.slice(0, maxLen) + '…';
  return out;
}

function logLine(prefix, payload) {
  // IMPORTANT: the host captures only a single string via webview console-message.
  console.log(`${prefix} ${safeStringify(payload)}`);
}

function summarizeTransferFetchArg(arg) {
  try {
    const reqs = typeof arg === 'string' ? (tryParseJson(arg) || []) : arg;
    const first = Array.isArray(reqs) ? reqs[0] : reqs;
    if (!first || typeof first !== 'object') return { kind: typeof arg };
    return {
      url: first.url,
      method: first.method,
      hasHeaders: !!first.headers,
      bodyType: typeof first.body,
    };
  } catch {
    return { kind: typeof arg };
  }
}

function pickErrorHint(data) {
  if (!data || typeof data !== 'object') return null;
  const hint = {};
  const keys = ['code', 'errcode', 'errCode', 'reason', 'msg', 'message'];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) hint[k] = data[k];
  }
  return Object.keys(hint).length ? hint : null;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tryParseJson(maybeJson) {
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

function parseResizeArgs(args) {
  // 支持多种形态：
  // - (width, height)
  // - ([width, height])
  // - ({width,height}) / ({w,h})
  // - ("{\"width\":..,\"height\":..}")
  // - ("[w,h]")
  const a0 = args?.[0];
  const a1 = args?.[1];

  // 直接两个数
  const w1 = safeNumber(a0);
  const h1 = safeNumber(a1);
  if (w1 !== null && h1 !== null) return { width: w1, height: h1 };

  // 单参数：数组 / 对象 / JSON 字符串
  let obj = a0;
  if (typeof obj === 'string') {
    const parsed = tryParseJson(obj);
    if (parsed !== null) obj = parsed;
  }

  if (Array.isArray(obj) && obj.length >= 2) {
    const w = safeNumber(obj[0]);
    const h = safeNumber(obj[1]);
    if (w !== null && h !== null) return { width: w, height: h };
  }

  if (obj && typeof obj === 'object') {
    const w = safeNumber(obj.width ?? obj.w);
    const h = safeNumber(obj.height ?? obj.h);
    if (w !== null && h !== null) return { width: w, height: h };
  }

  return null;
}

function installWindowResizeBridge() {
  // 覆写 window API：原版 preload 会把这些桥接到 Native。
  try {
    const originalResizeTo = window.resizeTo?.bind(window);
    window.resizeTo = function (width, height) {
      // 不阻塞；失败则回退原实现
      ipcRenderer.invoke('ad:resizeTo', { width, height }).catch(() => {
        if (typeof originalResizeTo === 'function') {
          try { originalResizeTo(width, height); } catch { /* ignore */ }
        }
      });
    };
  } catch { /* ignore */ }

  try {
    const originalClose = window.close?.bind(window);
    window.close = function () {
      ipcRenderer.invoke('ad:closeSelfTab').catch(() => {
        if (typeof originalClose === 'function') {
          try { originalClose(); } catch { /* ignore */ }
        }
      });
    };
  } catch { /* ignore */ }

  // 原版里是 window.moveTop -> BringWebWndToTop
  try {
    window.moveTop = function () {
      ipcRenderer.invoke('ad:bringToTop').catch(() => {});
    };
  } catch { /* ignore */ }
}

function shouldShimAdApiFetch(reqUrl) {
  if (!reqUrl || typeof reqUrl !== 'string') return false;
  let u;
  try {
    u = new URL(reqUrl, window.location.href);
  } catch {
    return false;
  }
  return u.hostname === 'adapi.izuiyou.com' && u.pathname.endsWith('/ad/ad_actions_pc');
}

function headersToPlainObject(headers) {
  if (!headers) return {};
  try {
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      const out = {};
      headers.forEach((v, k) => { out[k] = v; });
      return out;
    }
  } catch { /* ignore */ }

  if (Array.isArray(headers)) {
    const out = {};
    for (const [k, v] of headers) out[k] = v;
    return out;
  }
  if (typeof headers === 'object') return { ...headers };
  return {};
}

function createResponse(bodyText, status) {
  // 在 WebView 环境中 Response 通常可用；若不可用则返回最小兼容对象
  try {
    if (typeof Response !== 'undefined') {
      return new Response(bodyText, {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  } catch { /* ignore */ }
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    json: async () => {
      try { return JSON.parse(bodyText); } catch { return bodyText; }
    },
  };
}

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

function installAdApiFetchShim() {
  if (typeof window.fetch !== 'function') return;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    // 仅 shim 字符串 URL（覆盖最常见的 fetch(url, {..}) 形式）
    if (typeof input === 'string' && shouldShimAdApiFetch(input)) {
      // 走宿主转发，统一在 main.js 中补齐 uid/did 并绕过 ssl handshake 问题
      const method = String(init?.method || 'POST').toLowerCase();
      const headers = headersToPlainObject(init?.headers);

      let body = init?.body;
      if (body instanceof URLSearchParams) body = body.toString();
      if (body && typeof body !== 'string') {
        try {
          if (body instanceof ArrayBuffer) body = Buffer.from(body).toString('utf8');
          else if (ArrayBuffer.isView(body)) body = Buffer.from(body.buffer).toString('utf8');
          else body = JSON.stringify(body);
        } catch {
          return nativeFetch(input, init);
        }
      }

      console.log('[webview-preload] fetch shim -> transferFetch:', input);
      const result = await ipcRenderer.invoke('ad:transferFetch', JSON.stringify([
        { url: input, method, body: body ?? '', headers },
      ]));

      const status = result?.status ?? 500;
      const data = result?.data;
      const text = (typeof data === 'string') ? data : JSON.stringify(data ?? null);
      return createResponse(text, status);
    }
    return nativeFetch(input, init);
  };
}

/**
 * 调用主进程处理原生函数
 * @param {string} funcName - 函数名
 * @param {Array} args - 参数列表
 * @returns {Promise<{errCode: number, ret: any}>}
 */
async function callNative(funcName, args) {
  const firstArg = args[0];
  const argStr = typeof firstArg === 'string' ? firstArg : JSON.stringify(firstArg);

  switch (funcName) {
    case 'transferFetch':
    case 'TransferFetch': {
      // args[0] 是 JSON 字符串数组，每个元素是 {url, method, body, headers}
      // 广告页面传来的格式：可能是 JSON 字符串，也可能已经是对象
      let requests;
      try {
        requests = typeof firstArg === 'string' ? JSON.parse(firstArg) : firstArg;
      } catch {
        requests = firstArg;
      }
      const result = await ipcRenderer.invoke('ad:transferFetch', JSON.stringify(requests));
      return { errCode: 0, ret: result };
    }

    case 'clickWebView':
    case 'ClickWebView':
    case 'exposeWebView':
    case 'ExposeWebView':
    case 'completeWebview':
    case 'CompleteWebview': {
      let statsData;
      try {
        statsData = typeof firstArg === 'string' ? JSON.parse(firstArg) : firstArg;
      } catch {
        statsData = {};
      }
      const result = await ipcRenderer.invoke('ad:stats', JSON.stringify(statsData));
      return { errCode: 0, ret: result };
    }

    case 'isAppInstalled':
    case 'IsAppInstalled':
    case 'isInstalledWechat': {
      return { errCode: 0, ret: false };
    }

    case 'GetAccessToken': {
      const token = await ipcRenderer.invoke('ad:getToken');
      return { errCode: 0, ret: token || '' };
    }

    case 'GetUserInfo': {
      // original 常见行为：返回 JSON 字符串；部分页面会对返回值 JSON.parse。
      // 同时 original 允许传入 mode（0/1/2/3），返回 user/vip 的不同组合。
      const modeRaw = args?.[0];
      const mode = Number.isFinite(Number(modeRaw)) ? Number(modeRaw) : 0;

      const token = await ipcRenderer.invoke('ad:getToken');
      const deviceInfo = await ipcRenderer.invoke('ad:getDeviceInfo').catch(() => ({}));

      let userId = '';
      if (token) {
        try {
          const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
          userId = String(payload.sub || payload.user_id || payload.userid || payload.uid || '') || '';
        } catch {
          userId = '';
        }
      }

      const userInfo = {
        userID: userId,
        userId,
        userid: userId,
        token: token || '',
        deviceid: deviceInfo?.deviceId || '',
        deviceId: deviceInfo?.deviceId || '',
        peerid: deviceInfo?.peerId || '',
        peerId: deviceInfo?.peerId || '',
        sessionid: '',
        sessionID: '',
        secureKey: '',
        loginkey: '',
        isVip: false,
      };

      const vipInfo = {
        isVip: false,
        vipExpireTime: '',
        vip_info: null,
      };

      // 尽量贴近 original：mode 0/3 返回 {1:userInfoStr,2:vipInfoStr}
      let out;
      if (mode === 2) {
        out = JSON.stringify(vipInfo);
      } else if (mode === 1) {
        out = JSON.stringify(userInfo);
      } else {
        out = JSON.stringify({
          1: JSON.stringify(userInfo),
          2: JSON.stringify(vipInfo),
        });
      }

      return { errCode: 0, ret: out };
    }

    case 'GetPeerID':
    case 'GetPeerId': {
      const deviceInfo = await ipcRenderer.invoke('ad:getDeviceInfo').catch(() => ({}));
      return { errCode: 0, ret: String(deviceInfo?.peerId || '') };
    }

    case 'GetDeviceID':
    case 'GetDeviceId': {
      const deviceInfo = await ipcRenderer.invoke('ad:getDeviceInfo').catch(() => ({}));
      return { errCode: 0, ret: String(deviceInfo?.deviceId || '') };
    }

    case 'GetMac': {
      const sys = await ipcRenderer.invoke('ad:getSystemInfo').catch(() => ({}));
      return { errCode: 0, ret: String(sys?.mac || '') };
    }

    case 'GetOSVersion': {
      const sys = await ipcRenderer.invoke('ad:getSystemInfo').catch(() => ({}));
      return { errCode: 0, ret: String(sys?.osVersion || '') };
    }

    case 'GetAppDir': {
      const sys = await ipcRenderer.invoke('ad:getSystemInfo').catch(() => ({}));
      return { errCode: 0, ret: String(sys?.appDir || '') };
    }

    case 'SDKInit': {
      // original: delegate 里实际是 ipcRenderer.invoke('SDKInit', ...)
      // ad-viewer 最小实现：永远成功（避免页面因 init 失败进入 500ms 轮询/降级）
      return { errCode: 0, ret: 0 };
    }

    case 'GetADCompletionInfo':
    case 'getADCompletionInfo': {
      const resp = await ipcRenderer.invoke('ad:getADCompletionInfo');
      return { errCode: 0, ret: resp };
    }

    case 'GetHardwareInfo': {
      try {
        const info = await ipcRenderer.invoke('ad:getHardwareInfo');
        if (info && typeof info === 'object') {
          const model = String(info.model || 'PC');
          const brand = String(info.brand || 'PC');
          return { errCode: 0, ret: { model, brand } };
        }
      } catch {
        // ignore
      }
      return { errCode: 0, ret: { model: 'PC', brand: 'PC' } };
    }

    case 'CheckIsVip':
    case 'GetWallet': {
      return { errCode: 0, ret: null };
    }

    case 'createWnd':
    case 'CreateWnd': {
      // 广告落地页：不再弹窗，转交宿主下半部分 frame 加载
      try {
        const cfg = typeof firstArg === 'string' ? (tryParseJson(firstArg) || {}) : (firstArg || {});
        const url = cfg.url || cfg.href || cfg.link || '';
        if (url) ipcRenderer.sendToHost('ad:openLanding', String(url));
      } catch {}
      return { errCode: 0, ret: 0 };
    }

    case 'openBrowser':
    case 'OpenBrowser':
    case 'OpenNewWin':
    case 'openNewTab': {
      // 常见打开网页入口：把 URL 转到宿主 frame。
      let url = '';
      try {
        if (typeof firstArg === 'string') {
          const parsed = tryParseJson(firstArg);
          if (parsed && typeof parsed === 'object') url = parsed.url || parsed.href || '';
          else url = firstArg;
        } else if (firstArg && typeof firstArg === 'object') {
          url = firstArg.url || firstArg.href || '';
        }
      } catch {}
      if (url) ipcRenderer.sendToHost('ad:openLanding', String(url));
      return { errCode: 0, ret: null };
    }

    case 'getADHwnd':
    case 'GetADHwnd': {
      return { errCode: 0, ret: 0 };
    }

    case 'showWebview':
    case 'ShowWebview':
    case 'ResizeTo':
    case 'CloseSelfTab':
    case 'BringWebWndToTop': {
      if (funcName === 'ResizeTo') {
        const parsed = parseResizeArgs(args);
        if (parsed) {
          await ipcRenderer.invoke('ad:resizeTo', parsed);
        } else {
          console.warn('[webview-preload] ResizeTo args not parsed:', args);
        }
        return { errCode: 0, ret: null };
      }

      if (funcName === 'CloseSelfTab') {
        await ipcRenderer.invoke('ad:closeSelfTab');
        return { errCode: 0, ret: null };
      }

      // BringWebWndToTop / showWebview：最小实现直接置顶聚焦
      await ipcRenderer.invoke('ad:bringToTop');
      return { errCode: 0, ret: null };
    }

    case 'GetCurrentTaskId': {
      const taskId = await ipcRenderer.invoke('ad:getCurrentTaskId');
      return { errCode: 0, ret: Number(taskId || 0) || 0 };
    }

    default: {
      console.warn('[webview-preload] Unknown native function:', funcName);
      return { errCode: NativeFunctionErrorCode.FunctionUnExist, ret: undefined };
    }
  }
}

// 暴露给广告 H5 页面的 window.native API
window.native = {
  /** 等待 native 初始化完成 */
  NativeReady() {
    return _nativeReadyPromise;
  },

  /**
   * 调用原生函数
   * @param {string} funcName - 函数名
   * @param {...any} rest - 参数，最后一个可能是回调函数
   */
  CallNativeFunction(funcName, ...rest) {
    // 最后一个参数可能是回调
    const lastArg = rest[rest.length - 1];
    let callback = null;
    let funcArgs = rest;
    if (typeof lastArg === 'function') {
      callback = lastArg;
      funcArgs = rest.slice(0, -1);
    }

    if (funcName === 'TransferFetch' || funcName === 'transferFetch') {
      logLine('[webview-preload] CallNativeFunction TransferFetch', summarizeTransferFetchArg(funcArgs?.[0]));
    } else {
      logLine('[webview-preload] CallNativeFunction', { funcName, argc: funcArgs.length });
    }

    callNative(funcName, funcArgs)
      .then(({ errCode, ret }) => {
        if (funcName === 'TransferFetch' || funcName === 'transferFetch') {
          logLine('[webview-preload] Result TransferFetch', {
            errCode,
            status: ret?.status,
            hint: pickErrorHint(ret?.data) || undefined,
          });
        } else if (
          funcName === 'completeWebview' || funcName === 'CompleteWebview' ||
          funcName === 'clickWebView' || funcName === 'ClickWebView' ||
          funcName === 'exposeWebView' || funcName === 'ExposeWebView'
        ) {
          logLine('[webview-preload] Result Stats', {
            funcName,
            errCode,
            code: ret?.code,
            taskId: ret?.taskId,
            status: ret?.status,
          });
        } else {
          logLine('[webview-preload] Result', { funcName, errCode });
        }

        if (callback) callback(errCode, ret);
      })
      .catch((err) => {
        console.error('[webview-preload] Error:', funcName, err);
        if (callback) callback(NativeFunctionErrorCode.CallFailed, undefined);
      });
  },

  /**
   * 检查原生函数是否存在
   * @param {string} funcName
   * @param {function} callback(errorCode)
   */
  CheckNativeFunction(funcName, callback) {
    const exists = SUPPORTED_FUNCTIONS.has(funcName);
    if (callback) {
      callback(exists ? NativeFunctionErrorCode.Success : NativeFunctionErrorCode.FunctionUnExist);
    }
  },

  /**
   * 注册原生事件监听器
   * @param {string} eventName
   * @param {function} handler
   * @returns {number} listenerId
   */
  AttachNativeEvent(eventName, handler) {
    if (!nativeEventListeners[eventName]) {
      nativeEventListeners[eventName] = [];
    }
    nativeEventListeners[eventName].push(handler);
    return nativeEventListeners[eventName].length - 1;
  },

  /**
   * 注销原生事件监听器
   * @param {string} eventName
   * @param {number} listenerId
   */
  DetachNativeEvent(eventName, listenerId) {
    if (nativeEventListeners[eventName]) {
      nativeEventListeners[eventName].splice(listenerId, 1);
    }
  },

  /**
   * 注册供原生层回调的 JS 函数
   * @param {string} funcName
   * @param {function} handler
   * @returns {number} -1（固定值）
   */
  RegisterJSFunction(funcName, handler) {
    jsCallbacks[funcName] = handler;
    return -1;
  },
};

// 对齐 original：宿主可通过 webview.send('CallJSFunction', name, ...args)
// 调用广告页注册的 JS 函数（RegisterJSFunction）
ipcRenderer.on('CallJSFunction', (_event, funcName, ...args) => {
  try {
    const name = String(funcName || '');
    if (!name) return;
    const fn = jsCallbacks[name] || window[name];
    if (typeof fn === 'function') {
      fn(...args);
    }
  } catch (e) {
    console.warn('[webview-preload] CallJSFunction failed:', e?.message || e);
  }
});

// 兜底：如果广告 H5 直接用 fetch 请求 adapi（而不是走 window.native.transferFetch），
// 这里强制把 ad_actions_pc 改走宿主转发，以绕开 Chromium 的 SSL handshake failed。
installAdApiFetchShim();

// 监听登录/登出事件（来自宿主页面）
ipcRenderer.on('native:OnUserLogin', (_event, data) => {
  const handlers = nativeEventListeners['OnUserLogin'] || [];
  handlers.forEach((h) => { if (typeof h === 'function') h(data); });
});

ipcRenderer.on('native:OnUserLogout', (_event, data) => {
  const handlers = nativeEventListeners['OnUserLogout'] || [];
  handlers.forEach((h) => { if (typeof h === 'function') h(data); });
});

// --- 注入内部虚拟小红点 (跟随真实和模拟的鼠标轨迹) ---
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    let incursor;
    const ensureCursor = () => {
      incursor = document.getElementById('ad-inner-virtual-mouse');
      if (!incursor) {
        incursor = document.createElement('div');
        incursor.id = 'ad-inner-virtual-mouse';
        incursor.style.cssText = 'position: fixed; width: 16px; height: 16px; background-color: rgba(255, 0, 0, 0.7); border: 2px solid white; border-radius: 50%; pointer-events: none; z-index: 2147483647; transform: translate(-50%, -50%); transition: transform 0.05s ease-out, background-color 0.1s; box-shadow: 0 0 4px rgba(0,0,0,0.6);';
        document.body.appendChild(incursor);
      }
      return incursor;
    };

    window.addEventListener('mousemove', (e) => {
      const c = ensureCursor();
      c.style.left = e.clientX + 'px';
      c.style.top = e.clientY + 'px';
    }, { passive: true, capture: true });

    window.addEventListener('mousedown', (e) => {
      const c = ensureCursor();
      c.style.left = e.clientX + 'px';
      c.style.top = e.clientY + 'px';
      c.style.backgroundColor = 'rgba(0, 255, 0, 0.9)';
      c.style.transform = 'translate(-50%, -50%) scale(0.7)';
    }, { passive: true, capture: true });

    window.addEventListener('mouseup', (e) => {
      const c = ensureCursor();
      c.style.left = e.clientX + 'px';
      c.style.top = e.clientY + 'px';
      c.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
      c.style.transform = 'translate(-50%, -50%) scale(1)';
    }, { passive: true, capture: true });
    
    window.addEventListener('wheel', (e) => {
      const c = ensureCursor();
      c.style.backgroundColor = 'rgba(0, 150, 255, 0.8)';
      c.style.transform = 'translate(-50%, -50%) scale(1.2)';
      setTimeout(() => {
        if (c && c.style.backgroundColor === 'rgba(0, 150, 255, 0.8)') {
          c.style.backgroundColor = 'rgba(255, 0, 0, 0.7)';
          c.style.transform = 'translate(-50%, -50%) scale(1)';
        }
      }, 150);
    }, { passive: true, capture: true });
  });
}

console.log('[webview-preload] window.native is ready');
