(function (root) {
  'use strict';

  function createCache({limit = 3, onEvict} = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Image cache limit must be a positive integer.');
    const entries = new Map();
    let protectedPath = null;

    function touch(entry) {
      entries.delete(entry.path);
      entries.set(entry.path,entry);
    }

    function prune() {
      let readyCount = 0;
      for (const entry of entries.values()) if (entry.state === 'ready') ++readyCount;
      for (const [path,entry] of entries) {
        if (readyCount <= limit) break;
        if (entry.state !== 'ready' || path === protectedPath) continue;
        entries.delete(path);
        --readyCount;
        // The consumer may still use this decoded Image; only release our reference.
        try { onEvict?.(path); } catch (error) { console.warn('Image cache eviction callback failed.',error); }
      }
    }

    function active(entry) {
      return entries.get(entry.path) === entry && entry.state !== 'cancelled';
    }

    function detach(entry) {
      entry.image.onload = null;
      entry.image.onerror = null;
    }

    function fail(entry,error) {
      if (!active(entry) || entry.state === 'ready') return;
      entries.delete(entry.path);
      detach(entry);
      entry.state = 'failed';
      entry.reject(error);
    }

    async function decoded(entry) {
      if (!active(entry) || entry.state !== 'loading') return;
      entry.state = 'decoding';
      try {
        if (typeof entry.image.decode === 'function') await entry.image.decode();
        if (!active(entry)) return;
        entry.state = 'ready';
        detach(entry);
        touch(entry);
        entry.resolve(entry.image);
        prune();
      } catch (error) { fail(entry,error); }
    }

    function load(path,priority = 'high') {
      if (typeof path !== 'string' || !path) throw new TypeError('Image path must be a non-empty string.');
      const existing = entries.get(path);
      if (existing) {
        touch(existing);
        if (priority === 'high') existing.image.fetchPriority = 'high';
        return existing.promise;
      }
      const image = new Image();
      image.loading = 'eager';
      image.decoding = 'async';
      image.fetchPriority = priority;
      const entry = {path,image,state:'loading'};
      entry.promise = new Promise((resolve,reject) => { entry.resolve = resolve; entry.reject = reject; });
      // Prefetch callers may intentionally ignore the returned promise. Keep the
      // original rejection available to awaiters without an unhandled rejection.
      entry.promise.catch(() => {});
      entries.set(path,entry);
      image.onload = () => { void decoded(entry); };
      image.onerror = () => fail(entry,new Error('Image could not be loaded: ' + path));
      image.src = path;
      return entry.promise;
    }

    function protect(path) {
      protectedPath = path || null;
      const entry = entries.get(protectedPath);
      if (entry) touch(entry);
      prune();
    }

    function cancelExcept(paths = []) {
      const keep = new Set(typeof paths === 'string' ? [paths] : paths);
      for (const [path,entry] of entries) {
        if (entry.state === 'ready' || keep.has(path)) continue;
        entries.delete(path);
        entry.state = 'cancelled';
        detach(entry);
        entry.image.removeAttribute('src');
        entry.reject(new DOMException('Image request was cancelled.','AbortError'));
      }
    }

    return {load,protect,cancelExcept};
  }

  root.TourImages = {createCache};
})(window);
