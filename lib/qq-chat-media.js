(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QQChatMedia = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function imageKey(image) {
    return String(image.filename || image.md5 || image.localPath || image.url || image.dataUrl || '');
  }
  function mergeImages(oldImages, newImages) {
    const map = new Map();
    for (const image of (oldImages || []).concat(newImages || [])) {
      const key = imageKey(image).toLowerCase();
      if (!key) continue;
      const previous = map.get(key) || {};
      const next = Object.assign({}, previous);
      for (const [field, value] of Object.entries(image)) if (value !== '' && value != null) next[field] = value;
      if (next.cacheKey) delete next.error;
      map.set(key, next);
    }
    return Array.from(map.values());
  }
  function extractImages(message) {
    const content = message.content || {};
    const resources = Array.isArray(content.resources) ? content.resources : (Array.isArray(message.resources) ? message.resources : []);
    const elements = Array.isArray(content.elements) ? content.elements : (Array.isArray(message.elements) ? message.elements : []);
    const candidates = resources.filter(r => r && r.type === 'image').concat(elements.filter(e => e && e.type === 'image').map(e => e.data || {}));
    if (Array.isArray(message.images)) candidates.unshift.apply(candidates, message.images);
    const images = candidates.map(r => {
      const image = { type: 'image' };
      for (const key of ['filename', 'md5', 'localPath', 'url', 'cacheKey', 'dataUrl', 'error']) if (typeof r[key] === 'string') image[key] = r[key];
      if (!image.dataUrl && /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(image.url || '')) image.dataUrl = image.url;
      for (const key of ['width', 'height', 'size']) if (Number(r[key]) > 0) image[key] = Number(r[key]);
      return image;
    });
    // QCE resource records and image elements describe the same file; filename is shared.
    return mergeImages([], images.map(image => Object.assign({}, image, { md5: image.md5 || '' })));
  }
  return { extractImages, mergeImages, imageKey };
});
