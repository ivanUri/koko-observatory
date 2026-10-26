/**
 * A deliberately bounded, page-local runtime collector. It is installed only
 * in an explicitly started Reverse Inspector automation session. It records
 * facts observed in the page and never serializes passwords, headers, or full
 * response bodies.
 */
export const REVERSE_RUNTIME_PROBE = String.raw`(() => {
  if (window.__kokoReverseRuntime) return true;
  const MAX_RECORDS = 400;
  const records = [];
  let sequence = 0;
  const contextStack = [];
  const eventRecords = new WeakMap();
  const listeners = new WeakMap();
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;

  const redactUrl = (value) => {
    try {
      const url = new URL(String(value), location.href);
      for (const key of [...url.searchParams.keys()]) {
        if (/token|auth|secret|password|session|cookie|key/i.test(key)) url.searchParams.set(key, '<redacted>');
      }
      url.hash = '';
      return url.href;
    } catch { return String(value).slice(0, 2048); }
  };
  const target = (value) => {
    const element = value && value.nodeType === 1 ? value : null;
    if (!element) return { type: value?.constructor?.name || typeof value };
    return {
      tag: String(element.tagName || '').toLowerCase(),
      id: String(element.id || '').slice(0, 120),
      role: String(element.getAttribute?.('role') || '').slice(0, 120),
      testId: String(element.getAttribute?.('data-testid') || '').slice(0, 120),
      text: String(element.innerText || element.textContent || '').trim().slice(0, 160),
    };
  };
  const stack = () => String(new Error().stack || '').split('\n').slice(2, 9).join('\n');
  const activeRecordId = () => contextStack.length ? contextStack[contextStack.length - 1].recordId : undefined;
  const withContext = (record, callback) => {
    if (!record) return callback();
    contextStack.push(record);
    try { return callback(); } finally { contextStack.pop(); }
  };
  const push = (kind, data, extra = {}) => {
    if (records.length >= MAX_RECORDS) return null;
    const recordId = 'probe-' + (++sequence);
    const parentRecordId = extra.parentRecordId ?? data?.parentRecordId ?? activeRecordId();
    const contextId = extra.contextId ?? recordId;
    const enrichedData = {
      ...(data || {}),
      recordId,
      ...(parentRecordId ? { parentRecordId } : {}),
      contextId,
    };
    const record = { recordId, sequence, timestamp: Date.now(), kind, data: enrichedData, contextId, ...(parentRecordId ? { parentRecordId } : {}), ...extra };
    records.push(record);
    return record;
  };
  const listenerName = (listener) => String(listener?.name || listener?.handleEvent?.name || 'anonymous').slice(0, 160);
  const wrappedFor = (targetObject, type, listener, options) => {
    const map = listeners.get(targetObject);
    if (!map) return undefined;
    const key = String(type);
    const entries = map.get(key) || [];
    return entries.find((entry) => entry.listener === listener && entry.options === options);
  };

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (!listener) return originalAdd.call(this, type, listener, options);
    let map = listeners.get(this);
    if (!map) { map = new Map(); listeners.set(this, map); }
    const key = String(type);
    const entries = map.get(key) || [];
    if (entries.some((entry) => entry.listener === listener && entry.options === options)) return;
    const owner = this;
    const wrapped = function(...args) {
      const started = performance.now();
      const eventRecord = args[0] && typeof args[0] === 'object' ? eventRecords.get(args[0]) : undefined;
      const entered = push('event-listener-enter', { eventType: key, listenerName: listenerName(listener), target: target(owner), registrationStack: entry.registrationStack, stack: stack() }, { parentRecordId: eventRecord?.recordId });
      return withContext(entered, () => {
        try {
          if (typeof listener === 'function') return listener.apply(this, args);
          if (listener && typeof listener.handleEvent === 'function') return listener.handleEvent.apply(listener, args);
        } finally {
          push('event-listener-exit', { eventType: key, listenerName: listenerName(listener), target: target(owner) }, { durationMs: performance.now() - started, parentRecordId: entered?.recordId });
        }
      });
    };
    const entry = { listener, options, wrapped, registrationStack: stack() };
    entries.push(entry);
    map.set(key, entries);
    return originalAdd.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const entry = wrappedFor(this, type, listener, options);
    return originalRemove.call(this, type, entry?.wrapped || listener, options);
  };

  const eventTypes = ['click', 'dblclick', 'input', 'change', 'submit', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'focus', 'blur', 'scroll'];
  for (const type of eventTypes) {
    originalAdd.call(document, type, (event) => {
      const record = push('dom-event', { eventType: type, target: target(event.target), defaultPrevented: event.defaultPrevented, phase: event.eventPhase });
      if (record && event && typeof event === 'object') eventRecords.set(event, record);
    }, true);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations.slice(0, 40)) {
      push('dom-mutation', {
        mutationType: mutation.type,
        target: target(mutation.target),
        attributeName: mutation.attributeName || undefined,
        addedNodes: mutation.addedNodes?.length || 0,
        removedNodes: mutation.removedNodes?.length || 0,
        textChanged: mutation.type === 'characterData',
      });
    }
  });
  if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function(input, init) {
      const requestId = 'fetch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const url = redactUrl(typeof input === 'string' ? input : input?.url || '');
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const started = performance.now();
      const requestRecord = push('network-request', { requestId, protocol: 'fetch', method, url, stack: stack() });
      return originalFetch.apply(this, arguments).then((response) => {
        push('network-response', { requestId, protocol: 'fetch', method, url, status: response.status, ok: response.ok }, { durationMs: performance.now() - started, parentRecordId: requestRecord?.recordId });
        return response;
      }, (error) => {
        push('network-response', { requestId, protocol: 'fetch', method, url, status: 0, ok: false, error: String(error).slice(0, 240) }, { durationMs: performance.now() - started, parentRecordId: requestRecord?.recordId });
        throw error;
      });
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR?.prototype) {
    const open = OriginalXHR.prototype.open;
    const send = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function(method, url) {
      this.__kokoReverseRequest = { method: String(method || 'GET').toUpperCase(), url: redactUrl(url) };
      return open.apply(this, arguments);
    };
    OriginalXHR.prototype.send = function() {
      const meta = this.__kokoReverseRequest || { method: 'GET', url: '' };
      const requestId = 'xhr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const started = performance.now();
      const requestRecord = push('network-request', { requestId, protocol: 'xhr', method: meta.method, url: meta.url, stack: stack() });
      originalAdd.call(this, 'loadend', () => push('network-response', { requestId, protocol: 'xhr', method: meta.method, url: meta.url, status: this.status, ok: this.status >= 200 && this.status < 400 }, { durationMs: performance.now() - started, parentRecordId: requestRecord?.recordId }), { once: true });
      return send.apply(this, arguments);
    };
  }

  const originalSetTimeout = window.setTimeout;
  window.setTimeout = function(callback, delay, ...args) {
    const taskId = 'timer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const scheduled = push('async-task', { taskId, taskType: 'timeout', delay: Number(delay) || 0, callbackName: callback?.name || 'anonymous', phase: 'scheduled' });
    return originalSetTimeout.call(this, (...callbackArgs) => {
      const started = push('async-task', { taskId, taskType: 'timeout', callbackName: callback?.name || 'anonymous', phase: 'started' }, { parentRecordId: scheduled?.recordId });
      return withContext(started, () => typeof callback === 'function' ? callback(...callbackArgs) : undefined);
    }, delay, ...args);
  };

  window.__kokoReverseRuntime = {
    schemaVersion: 1,
    drain() { const output = records.splice(0, records.length); return JSON.stringify(output); },
    dispose() { observer.disconnect(); window.fetch = originalFetch; window.XMLHttpRequest = OriginalXHR; window.setTimeout = originalSetTimeout; delete window.__kokoReverseRuntime; },
  };
  return true;
})()`;
