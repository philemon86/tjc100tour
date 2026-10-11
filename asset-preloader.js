(function (root) {
  'use strict';

  // Keep downloaded files encoded. Image decoding remains in the bounded image
  // cache, so preparing a visit does not retain every panorama as RGBA pixels.
  function createStore({concurrency = 3, timeoutMs = 30000} = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Download concurrency must be a positive integer.');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Download timeout must be positive.');
    const entries = new Map();
    let currentRun = null, disposed = false;

    function abortError(signal) {
      return signal.reason || new DOMException('Download was cancelled.','AbortError');
    }

    function abortable(promise,signal) {
      if (signal.aborted) {
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(abortError(signal));
      }
      return new Promise((resolve,reject) => {
        const cancelled = () => { signal.removeEventListener('abort',cancelled); reject(abortError(signal)); };
        signal.addEventListener('abort',cancelled,{once:true});
        Promise.resolve(promise).then(value => {
          signal.removeEventListener('abort',cancelled); resolve(value);
        },error => {
          signal.removeEventListener('abort',cancelled); reject(error);
        });
      });
    }

    function snapshot(run) {
      let loaded = 0, total = 0, completed = 0;
      for (const entry of run.entries) {
        loaded += entry.received;
        total += entry.expected;
        if (entry.state === 'ready') ++completed;
      }
      return {loaded,total,completed,count:run.entries.length};
    }

    function notify(run) {
      if (disposed) return;
      const progress = snapshot(run);
      for (const observer of run.observers) {
        try { observer(progress); } catch (error) { console.warn('Download progress callback failed.',error); }
      }
    }

    async function download(entry,run) {
      const controller = new AbortController();
      const cancel = () => controller.abort(abortError(run.controller.signal));
      run.controller.signal.addEventListener('abort',cancel,{once:true});
      if (run.controller.signal.aborted) cancel();
      let timer, reader;
      const armTimeout = () => {
        clearTimeout(timer);
        // This is an inactivity timeout. A slow download keeps going while
        // receiving bytes; a stalled response cannot leave preparation stuck.
        timer = setTimeout(() => controller.abort(new DOMException('Asset download timed out: ' + entry.path,'TimeoutError')),timeoutMs);
      };
      entry.state = 'loading';
      entry.received = 0;
      armTimeout();
      try {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const response = await abortable(fetch(entry.path,{cache:'force-cache',signal:controller.signal}),controller.signal);
        if (!response.ok) throw new Error('Asset could not be downloaded: ' + entry.path + ' (' + response.status + ')');
        armTimeout();
        let blob;
        if (response.body && typeof response.body.getReader === 'function') {
          reader = response.body.getReader();
          const chunks = [];
          while (true) {
            const {done,value} = await abortable(reader.read(),controller.signal);
            if (done) break;
            chunks.push(value);
            entry.received += value.byteLength;
            // The manifest is the initial denominator; actual received bytes
            // take precedence if its size is stale or a server header differs.
            entry.expected = Math.max(entry.expected,entry.received);
            armTimeout();
            notify(run);
          }
          blob = new Blob(chunks,{type:response.headers?.get('Content-Type') || ''});
          chunks.length = 0;
        } else {
          blob = await abortable(response.blob(),controller.signal);
        }
        if (controller.signal.aborted) throw abortError(controller.signal);
        if (!blob.size) throw new Error('Downloaded asset was empty: ' + entry.path);
        const url = URL.createObjectURL(blob);
        entry.url = url;
        entry.expected = entry.received = blob.size;
        entry.state = 'ready';
        notify(run);
      } catch (error) {
        entry.received = 0;
        entry.state = 'pending';
        // Cancel a response reader without awaiting it: some failed or stalled
        // transports cannot finish cancellation, but our workers must settle.
        if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {} }
        throw error;
      } finally {
        clearTimeout(timer);
        run.controller.signal.removeEventListener('abort',cancel);
        try { reader?.releaseLock(); } catch (_) {}
      }
    }

    function normalize(assets) {
      if (!Array.isArray(assets)) throw new TypeError('Assets must be an array.');
      const unique = new Map();
      for (const asset of assets) {
        if (!asset || typeof asset.path !== 'string' || !asset.path) throw new TypeError('Asset paths must be non-empty strings.');
        if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw new TypeError('Asset byte sizes must be non-negative integers.');
        if (!unique.has(asset.path)) unique.set(asset.path,{path:asset.path,bytes:asset.bytes});
      }
      return [...unique.values()];
    }

    function preload(assets,onProgress) {
      if (disposed) throw new Error('Asset store has been disposed.');
      const unique = normalize(assets);
      const key = JSON.stringify(unique.map(asset => [asset.path,asset.bytes]).sort((a,b) => a[0].localeCompare(b[0])));
      if (currentRun) {
        if (currentRun.key !== key) throw new Error('A different asset download is already running.');
        if (typeof onProgress === 'function') {
          currentRun.observers.add(onProgress);
          try { onProgress(snapshot(currentRun)); } catch (error) { console.warn('Download progress callback failed.',error); }
        }
        return currentRun.promise;
      }
      const run = {key,controller:new AbortController(),observers:new Set(),entries:[],promise:null};
      if (typeof onProgress === 'function') run.observers.add(onProgress);
      for (const asset of unique) {
        let entry = entries.get(asset.path);
        if (!entry) { entry = {path:asset.path,state:'pending',received:0,expected:asset.bytes,url:null}; entries.set(asset.path,entry); }
        if (entry.state !== 'ready') { entry.expected = asset.bytes; entry.received = 0; }
        run.entries.push(entry);
      }
      currentRun = run;
      run.promise = Promise.resolve().then(async () => {
        notify(run);
        const pending = run.entries.filter(entry => entry.state !== 'ready');
        let index = 0, failure = null;
        const worker = async () => {
          while (!failure && index < pending.length) {
            const entry = pending[index++];
            try { await download(entry,run); }
            catch (error) {
              if (!failure) { failure = error; run.controller.abort(error); }
            }
          }
        };
        await Promise.allSettled(Array.from({length:Math.min(concurrency,pending.length)},worker));
        notify(run);
        if (failure) throw failure;
        if (run.controller.signal.aborted) throw abortError(run.controller.signal);
        return snapshot(run);
      }).finally(() => { if (currentRun === run) currentRun = null; });
      // A caller can keep the store for retry even if it ignores a speculative
      // preload promise. Awaiters still receive the original rejection.
      run.promise.catch(() => {});
      return run.promise;
    }

    function source(path) { return entries.get(path)?.url || path; }
    function ready(path) { return entries.get(path)?.state === 'ready'; }
    function dispose() {
      if (disposed) return;
      disposed = true;
      currentRun?.controller.abort(new DOMException('Asset store was disposed.','AbortError'));
      for (const entry of entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
      entries.clear();
    }
    return {preload,source,ready,dispose};
  }

  root.TourAssets = {createStore};
})(window);
