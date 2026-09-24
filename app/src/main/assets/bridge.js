(() => {
  'use strict';
  if (window.__SANGA_ANDROID_BRIDGE__) return;
  window.__SANGA_ANDROID_BRIDGE__ = true;

  const BRIDGE_TOKEN = '__SANGA_BRIDGE_TOKEN__';
  const safeParse = (s, fallback={}) => { try { return JSON.parse(s); } catch(e) { return fallback; } };
  const loadStore = () => safeParse(SangaNative.getStorageJson(BRIDGE_TOKEN), {});
  const saveStore = o => SangaNative.setStorageJson(BRIDGE_TOKEN, JSON.stringify(o || {}));

  window.chrome = window.chrome || {};
  chrome.runtime = chrome.runtime || {};
  chrome.runtime.lastError = null;
  chrome.runtime.getURL = function(name){
    try { return SangaNative.assetDataUrl(BRIDGE_TOKEN, String(name || '')); }
    catch(e) { return ''; }
  };
  chrome.runtime.sendMessage = function(message, callback){
    chrome.runtime.lastError = null;
    try {
      if (message && message.type === 'SANGA_FETCH' && message.url) {
        const raw = SangaNative.httpGet(BRIDGE_TOKEN, String(message.url));
        const result = safeParse(raw, {ok:false,error:'Android bridge response parse error'});
        if (callback) callback(result);
        return;
      }
      if (callback) callback({ok:false,error:'지원하지 않는 메시지입니다.'});
    } catch(e) {
      chrome.runtime.lastError = {message:String(e && e.message || e)};
      if (callback) callback({ok:false,error:chrome.runtime.lastError.message});
    }
  };

  chrome.storage = chrome.storage || {};
  chrome.storage.local = {
    get(keys, callback){
      const store = loadStore();
      let out = {};
      if (keys == null) out = {...store};
      else if (Array.isArray(keys)) keys.forEach(k => { if (Object.prototype.hasOwnProperty.call(store,k)) out[k]=store[k]; });
      else if (typeof keys === 'string') { if (Object.prototype.hasOwnProperty.call(store,keys)) out[keys]=store[keys]; }
      else if (typeof keys === 'object') {
        Object.keys(keys).forEach(k => out[k] = Object.prototype.hasOwnProperty.call(store,k) ? store[k] : keys[k]);
      }
      if (callback) callback(out);
    },
    set(values, callback){
      const store = loadStore();
      Object.assign(store, values || {});
      saveStore(store);
      if (callback) callback();
    },
    remove(keys, callback){
      const store = loadStore();
      (Array.isArray(keys)?keys:[keys]).filter(Boolean).forEach(k => delete store[k]);
      saveStore(store);
      if (callback) callback();
    },
    clear(callback){ saveStore({}); if(callback) callback(); }
  };

  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText(text){ SangaNative.copyText(BRIDGE_TOKEN, String(text ?? '')); return Promise.resolve(); } }
    });
  } catch(e) {}
})();
