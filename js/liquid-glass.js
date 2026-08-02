// ═══════════ Apple Liquid Glass — SVG Displacement Refraction ═══════════
// Uses feDisplacementMap as backdrop-filter to genuinely bend background
// pixels at glass panel edges, simulating lens refraction.
// Chrome/Electron only (backdrop-filter: url(#filter)).

(function() {
  const FILTER_ID = 'liquid-glass-filter';
  const SVG_ID = 'liquid-glass-svg';
  const MAP_SIZE = 256;
  let cachedMapUrl = null;
  let cachedEdgeRatio = -1;

  // ── Displacement Map Generation ──
  // R = X displacement, G = Y displacement. 128 = neutral.
  // At edges: sampling shifts outward → content appears pulled toward center
  // (convex lens bulge). Center: no displacement.
  function generateDisplacementMap(edgeRatio) {
    if (cachedMapUrl && Math.abs(edgeRatio - cachedEdgeRatio) < 0.001) {
      return cachedMapUrl;
    }
    const size = MAP_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(size, size);
    const d = imageData.data;
    const ew = edgeRatio;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = x / (size - 1);
        const fy = y / (size - 1);

        let dx = 0;
        if (fx < ew) {
          dx = -edgeCurve(1 - fx / ew);
        } else if (fx > 1 - ew) {
          dx = edgeCurve((fx - (1 - ew)) / ew);
        }

        let dy = 0;
        if (fy < ew) {
          dy = -edgeCurve(1 - fy / ew);
        } else if (fy > 1 - ew) {
          dy = edgeCurve((fy - (1 - ew)) / ew);
        }

        const i = (y * size + x) * 4;
        d[i]     = clamp128(dx);
        d[i + 1] = clamp128(dy);
        d[i + 2] = 128;
        d[i + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    cachedMapUrl = canvas.toDataURL('image/png');
    cachedEdgeRatio = edgeRatio;
    return cachedMapUrl;
  }

  // Cubic curve: displacement concentrated near the very edge
  // t=0 (zone boundary) → 0, t=1 (panel edge) → 1
  // Most of the zone has minimal displacement; strong bend only at edge
  function edgeCurve(t) {
    t = Math.max(0, Math.min(1, t));
    return t * t * t;
  }

  function clamp128(v) {
    return Math.max(0, Math.min(255, Math.round(128 + v * 127)));
  }

  // ── SVG Filter: create once, update in place ──
  function ensureFilter() {
    let svg = document.getElementById(SVG_ID);
    if (svg) return svg;

    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = SVG_ID;
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
    svg.setAttribute('aria-hidden', 'true');

    const mapUrl = generateDisplacementMap(0.18);
    svg.innerHTML =
      '<defs>' +
        '<filter id="' + FILTER_ID + '" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">' +
          '<feImage id="lg-feimage" href="' + mapUrl + '" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="dmap"/>' +
          '<feDisplacementMap id="lg-fedm" in="SourceGraphic" in2="dmap" scale="40" xChannelSelector="R" yChannelSelector="G"/>' +
        '</filter>' +
      '</defs>';

    document.body.appendChild(svg);
    return svg;
  }

  // ── Public API ──
  // scale: max pixel displacement at edges (0 = none, ~30 = strong)
  // edgeRatio: edge zone width as fraction (0.1~0.5, default 0.18)
  window.updateLiquidGlass = function(scale, edgeRatio) {
    ensureFilter();
    if (scale !== undefined) {
      const fedm = document.getElementById('lg-fedm');
      if (fedm) fedm.setAttribute('scale', String(scale));
    }
    // Only regenerate map if edgeRatio changed
    if (edgeRatio !== undefined && Math.abs(edgeRatio - cachedEdgeRatio) > 0.001) {
      const mapUrl = generateDisplacementMap(edgeRatio);
      const feimg = document.getElementById('lg-feimage');
      if (feimg) feimg.setAttribute('href', mapUrl);
    }
  };

  // Initialize
  function init() { ensureFilter(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
