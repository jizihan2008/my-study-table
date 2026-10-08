'use strict';
(function () {
  const definitions = {
    idle: { frames: [0, 0, 0, 0, 1, 2, 3, 0], interval: 260 },
    walk: { frames: [0, 1, 2, 3], interval: 160 },
    wave: { frames: [0, 1, 2, 3, 2, 1], interval: 190 },
    read: { frames: [0, 1, 2, 3, 3, 3], interval: 480 },
    sleep: { frames: [0, 1, 2, 3, 3, 1], interval: 650 },
    celebrate: { frames: [0, 1, 2, 3], interval: 210 }
  };
  class PetSpritePlayer {
    constructor(canvas, fallback, onWalk) {
      this.canvas = canvas;
      this.fallback = fallback;
      this.context = canvas.getContext('2d');
      this.onWalk = onWalk;
      this.images = new Map();
      this.action = 'idle';
      this.started = performance.now();
      this.lastWalk = this.started;
      this.frame = -1;
      this.paused = false;
      this.direction = -1;
      this.roam = false;
      this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
      this.ready = Promise.all(Object.keys(definitions).map(action => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { this.images.set(action, img); resolve(); };
        img.onerror = () => reject(new Error('动作素材加载失败：' + action));
        img.src = '../../icons/pet/actions/' + action + '.png';
      }))).then(() => {
        fallback.hidden = true;
        canvas.hidden = false;
        canvas.dataset.ready = 'true';
        this.draw(0);
      });
      this.ready.catch(console.error);
      this.tick = this.tick.bind(this);
      requestAnimationFrame(this.tick);
      document.addEventListener('visibilitychange', () => { this.lastWalk = performance.now(); });
    }
    play(action, { roam = false } = {}) {
      if (!definitions[action]) return;
      if (action === 'walk' && roam) this.direction *= -1;
      this.action = action;
      this.roam = roam;
      this.started = performance.now();
      this.lastWalk = this.started;
      this.frame = -1;
      this.draw(0);
    }
    pause(paused) { this.paused = paused; this.frame = -1; }
    draw(frame) {
      const img = this.images.get(this.action);
      if (!img) return;
      const width = img.naturalWidth / 2;
      const height = img.naturalHeight / 2;
      const context = this.context;
      context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      context.save();
      if (this.action === 'walk' && this.direction < 0) {
        context.translate(this.canvas.width, 0); context.scale(-1, 1);
      }
      const ratio = Math.min(this.canvas.width / width, this.canvas.height / height);
      const targetWidth = width * ratio;
      const targetHeight = height * ratio;
      context.drawImage(img, (frame % 2) * width, Math.floor(frame / 2) * height,
        width, height, (this.canvas.width - targetWidth) / 2, this.canvas.height - targetHeight, targetWidth, targetHeight);
      context.restore();
      this.canvas.dataset.action = this.action;
      this.canvas.dataset.frame = String(frame);
    }
    tick(now) {
      if (!document.hidden && this.images.has(this.action)) {
        const definition = definitions[this.action];
        const frozen = this.paused || this.reducedMotion.matches;
        // A RAF timestamp can slightly precede an action started in that frame.
        // Clamp the elapsed time so it cannot produce a negative frame index.
        const elapsed = Math.max(0, now - this.started);
        const index = frozen ? 0 : Math.floor(elapsed / definition.interval) % definition.frames.length;
        const frame = definition.frames[index];
        if (frame !== this.frame) { this.frame = frame; this.draw(frame); }
        if (this.action === 'walk' && this.roam && !frozen && now - this.lastWalk >= 120) {
          this.onWalk(this.direction * 2);
          this.lastWalk = now;
        }
      }
      requestAnimationFrame(this.tick);
    }
  }
  window.PetSpritePlayer = PetSpritePlayer;
})();
