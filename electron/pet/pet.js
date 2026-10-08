'use strict';
const api = window.petAPI;
const pet = document.getElementById('pet');
const character = document.getElementById('character');
const bubble = document.getElementById('bubble');
let quiet = false;
let bubbleTimeout;
let actionTimeout;
let focusing = false;
let dragging = null;
let moved = false;
let lastInteractive;
let clickIndex = 0;
const player = new window.PetSpritePlayer(document.getElementById('sprite'), character.querySelector('img'), delta => api.move({ x: delta, y: 0 }));
const phrases = ['今天也一起长出一点新芽吧！', '先做一小步，时芽陪你。', '摸摸收到！给你一点专注能量 ✨', '书翻一页，进步一点点。', '喝口水，伸个懒腰再出发～'];

function restingAction() { return focusing ? 'read' : 'idle'; }
function playAction(action, duration = 6000, roam = false) {
  clearTimeout(actionTimeout);
  if (player.roam) api.moveEnd();
  player.play(action, { roam });
  if (duration > 0) actionTimeout = setTimeout(() => {
    if (roam) api.moveEnd();
    player.play(restingAction());
  }, duration);
}
function speak(text, action = 'wave', automatic = false) {
  if (automatic && quiet) return;
  clearTimeout(bubbleTimeout);
  playAction(action, action === 'read' && focusing ? 0 : 5500);
  bubble.textContent = text;
  bubble.hidden = false;
  bubbleTimeout = setTimeout(() => { bubble.hidden = true; }, 5500);
}
function setState(state) {
  document.documentElement.style.setProperty('--pet-scale', state.scale);
  quiet = state.quiet;
  if (quiet && player.roam) {
    api.moveEnd();
    playAction(restingAction(), 0);
  }
  player.pause(quiet);
  pet.classList.toggle('quiet', quiet);
  if (quiet) { clearTimeout(bubbleTimeout); bubble.hidden = true; }
}
api.onState(setState);
api.status().then(setState).catch(console.error);
api.onCue(cue => {
  if (cue === 'focus') focusing = true;
  else if (cue === 'pause' || cue === 'rest') focusing = false;
  const cues = {
    focus: ['专注开始！时芽和你一起看书。', 'read'],
    pause: ['休息一下，回来继续就好～', 'sleep'],
    rest: ['辛苦啦！喝口水，让新芽歇一会儿。', 'wave'],
    complete: ['又完成一件事！给努力的你一颗星 ✨', 'celebrate']
  };
  if (cues[cue]) speak(...cues[cue], true);
});
api.onAnimation(action => {
  if (dragging) return;
  playAction(action, action === 'idle' ? 0 : action === 'sleep' ? 12000 : 6500, action === 'walk');
});
setInterval(() => {
  if (quiet || focusing || dragging || document.hidden) return;
  const choices = ['wave', 'read', 'sleep', 'walk'];
  const action = choices[Math.floor(Math.random() * choices.length)];
  playAction(action, 6500, action === 'walk');
}, 20000);
character.addEventListener('click', () => {
  if (moved) { moved = false; return; }
  const index = clickIndex++;
  speak(phrases[index % phrases.length], index % 2 ? 'celebrate' : 'wave');
});
character.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  moved = false;
  clearTimeout(actionTimeout);
  player.roam = false;
  dragging = { x: event.screenX, y: event.screenY, startX: event.screenX, startY: event.screenY };
  character.setPointerCapture(event.pointerId);
});
character.addEventListener('pointermove', event => {
  if (!dragging) return;
  if (!moved && Math.hypot(event.screenX - dragging.startX, event.screenY - dragging.startY) < 5) return;
  moved = true;
  pet.classList.add('dragging');
  if (player.action !== 'walk') player.play('walk');
  api.move({ x: event.screenX - dragging.x, y: event.screenY - dragging.y });
  dragging.x = event.screenX; dragging.y = event.screenY;
});
function endDrag() {
  if (dragging) {
    api.moveEnd();
    player.play(restingAction());
  }
  dragging = null;
  pet.classList.remove('dragging');
}
character.addEventListener('pointerup', endDrag);
character.addEventListener('pointercancel', endDrag);
character.addEventListener('lostpointercapture', endDrag);
character.addEventListener('keydown', event => {
  const deltas = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12] };
  if (!deltas[event.key]) return;
  event.preventDefault();
  playAction('walk', 1200);
  api.move({ x: deltas[event.key][0], y: deltas[event.key][1] });
  api.moveEnd();
});
document.getElementById('menu').addEventListener('click', () => api.action('menu').catch(console.error));
document.getElementById('hide').addEventListener('click', () => api.action('hide').catch(console.error));
document.getElementById('name').addEventListener('click', () => api.action('open').catch(console.error));
document.addEventListener('contextmenu', event => { event.preventDefault(); api.action('menu').catch(console.error); });
function pointer(interactive) {
  if (interactive === lastInteractive) return;
  lastInteractive = interactive;
  api.pointer(interactive);
}
// Electron forwards mousemove while the transparent background ignores clicks.
document.addEventListener('mousemove', event => pointer(!!dragging || !!event.target.closest('button, #bubble')));
document.addEventListener('pointerleave', () => { if (!dragging) pointer(false); });
speak('我是时芽，今天也陪你学习 🌱', 'wave', true);
