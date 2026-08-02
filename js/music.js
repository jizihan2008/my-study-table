// ═══════════ Music Player Module ═══════════

let musicList = loadData('study_music_list') || [];
let currentMusicIdx = -1;
let musicAudio = null;

function saveMusicData() {
  saveData('study_music_list', musicList);
}

function renderMusic() {
  const container = document.getElementById('musicContainer');
  if (!container) return;
  
  const current = currentMusicIdx >= 0 && currentMusicIdx < musicList.length ? musicList[currentMusicIdx] : null;
  
  container.innerHTML = `
    <div class="music-player">
      <div class="music-now">
        <div class="music-cover">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="music-info">
          <div class="music-title">${current ? escapeHtml(current.title) : '未播放'}</div>
          <div class="music-artist">${current ? escapeHtml(current.artist || '未知艺术家') : ''}</div>
        </div>
        <div class="music-progress-wrap">
          <input type="range" class="music-progress" id="musicProgress" value="0" min="0" max="100" step="0.1"
            oninput="onMusicSeek(this)" title="进度">
          <div class="music-time" id="musicTime">0:00 / 0:00</div>
        </div>
        <div class="music-controls">
          <button class="music-btn" onclick="musicPrev()" title="上一首">⏮</button>
          <button class="music-btn music-play-btn" id="musicPlayBtn" onclick="musicToggle()" title="播放/暂停">▶</button>
          <button class="music-btn" onclick="musicNext()" title="下一首">⏭</button>
        </div>
        <div class="music-volume-wrap">
          <span class="music-vol-icon">🔊</span>
          <input type="range" class="music-volume" id="musicVolume" value="80" min="0" max="100"
            oninput="onMusicVolume(this)" title="音量">
        </div>
      </div>
    </div>
    <div class="music-list-header">
      <span class="music-list-title">🎵 播放列表（${musicList.length} 首）</span>
      <div class="music-list-actions">
        <button class="music-import-btn" onclick="importMusic()">📥 导入音乐</button>
      </div>
    </div>
    <div class="music-list" id="musicList">
      ${musicList.length === 0 ? '<div class="empty-state" style="padding:40px 0;"><p>暂无音乐，点击「导入音乐」添加吧 🎶</p></div>' : ''}
      ${musicList.map((item, idx) => `
        <div class="music-item${idx === currentMusicIdx ? ' active' : ''}" onclick="musicPlay(${idx})">
          <span class="music-item-idx">${idx + 1}</span>
          <span class="music-item-info">
            <span class="music-item-title">${escapeHtml(item.title)}</span>
            <span class="music-item-artist">${escapeHtml(item.artist || '未知艺术家')}</span>
          </span>
          <span class="music-item-duration" id="musicDuration${idx}">${item.duration || '--:--'}</span>
          <button class="music-item-del" onclick="event.stopPropagation();deleteMusic(${idx})" title="删除">✕</button>
        </div>
      `).join('')}
    </div>
  `;
  
  // Set volume
  const volInput = document.getElementById('musicVolume');
  if (volInput && musicAudio) musicAudio.volume = volInput.value / 100;
}

// ── Player Logic ──

async function musicPlay(idx) {
  if (idx < 0 || idx >= musicList.length) return;
  const item = musicList[idx];
  
  // If already playing this song, just toggle
  if (currentMusicIdx === idx && musicAudio && !musicAudio.paused) return;
  
  // Stop current
  if (musicAudio) { musicAudio.pause(); musicAudio = null; }
  
  currentMusicIdx = idx;
  
  // Read audio file
  let dataUrl = null;
  if (window.electronAPI && window.electronAPI.readAudioFile && item.filePath) {
    dataUrl = await window.electronAPI.readAudioFile(item.filePath);
  } else if (item._dataUrl) {
    dataUrl = item._dataUrl;
  }
  
  if (!dataUrl) {
    // Fallback: prompt user to select file again
    importMusic();
    return;
  }
  
  try {
    musicAudio = new Audio(dataUrl);
    musicAudio.volume = parseFloat(document.getElementById('musicVolume')?.value || 80) / 100;
    
    musicAudio.addEventListener('loadedmetadata', () => {
      const total = musicAudio.duration;
      const mins = Math.floor(total / 60);
      const secs = Math.floor(total % 60);
      const durStr = `${mins}:${secs.toString().padStart(2, '0')}`;
      item.duration = durStr;
      saveMusicData();
      const durEl = document.getElementById('musicDuration' + idx);
      if (durEl) durEl.textContent = durStr;
      document.getElementById('musicProgress').max = total;
    });
    
    musicAudio.addEventListener('timeupdate', () => {
      const cur = musicAudio.currentTime;
      const total = musicAudio.duration || 1;
      document.getElementById('musicProgress').value = cur;
      document.getElementById('musicTime').textContent = formatTime(cur) + ' / ' + formatTime(total);
      // Update floating ball
      const tEl = document.getElementById('mfTime');
      if (tEl) tEl.textContent = formatTime(cur);
      const pf = document.getElementById('mfProgressFill');
      if (pf) pf.style.width = (cur / total * 100) + '%';
    });
    
    musicAudio.addEventListener('ended', () => musicNext());
    
    musicAudio.addEventListener('error', () => {
      alert('无法播放此音频文件，文件可能已损坏或格式不支持。');
    });
    
    await musicAudio.play();
    updateMusicPlayBtn();
    renderMusic();
  } catch (e) {
    console.error('Playback error:', e);
    alert('播放失败：' + e.message);
  }
}

function musicToggle() {
  if (!musicAudio) {
    if (musicList.length > 0) musicPlay(0);
    return;
  }
  if (musicAudio.paused) {
    musicAudio.play();
  } else {
    musicAudio.pause();
  }
  updateMusicPlayBtn();
}

function musicPrev() {
  if (musicList.length === 0) return;
  let idx = currentMusicIdx - 1;
  if (idx < 0) idx = musicList.length - 1;
  musicPlay(idx);
}

function musicNext() {
  if (musicList.length === 0) return;
  let idx = currentMusicIdx + 1;
  if (idx >= musicList.length) idx = 0;
  musicPlay(idx);
}

function updateMusicPlayBtn() {
  const btn = document.getElementById('musicPlayBtn');
  if (!btn) return;
  btn.textContent = musicAudio && !musicAudio.paused ? '⏸' : '▶';
}

function onMusicSeek(el) {
  if (musicAudio) {
    musicAudio.currentTime = parseFloat(el.value);
  }
}

function onMusicVolume(el) {
  if (musicAudio) {
    musicAudio.volume = parseFloat(el.value) / 100;
  }
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + s.toString().padStart(2, '0');
}

// ── Import & Delete ──

async function importMusic() {
  try {
    let filePaths = [];
    let files = [];
    
    if (window.electronAPI && window.electronAPI.openAudioDialog) {
      // Electron: use native file dialog
      filePaths = await window.electronAPI.openAudioDialog();
      if (!filePaths || filePaths.length === 0) return;
      
      for (const fp of filePaths) {
        const name = fp.split(/[\\/]/).pop() || '未知';
        const baseName = name.replace(/\.[^.]+$/, '');
        musicList.push({
          id: genId(),
          title: baseName,
          artist: '',
          filePath: fp,
          duration: ''
        });
      }
    } else {
      // Browser fallback: use file input
      files = await new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.multiple = true;
        input.onchange = () => resolve(Array.from(input.files || []));
        input.click();
      });
      if (!files || files.length === 0) return;
      
      for (const file of files) {
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        musicList.push({
          id: genId(),
          title: baseName,
          artist: '',
          _dataUrl: dataUrl,
          duration: ''
        });
      }
    }
    
    saveMusicData();
    renderMusic();
    if (musicList.length > 0 && currentMusicIdx < 0) {
      musicPlay(0);
    }
  } catch (e) {
    console.error('Import error:', e);
    alert('导入失败：' + e.message);
  }
}

function deleteMusic(idx) {
  if (idx < 0 || idx >= musicList.length) return;
  const wasCurrent = idx === currentMusicIdx;
  
  musicList.splice(idx, 1);
  saveMusicData();
  
  if (wasCurrent) {
    if (musicAudio) { musicAudio.pause(); musicAudio = null; }
    currentMusicIdx = -1;
    if (musicList.length > 0) {
      const nextIdx = Math.min(idx, musicList.length - 1);
      musicPlay(nextIdx);
    }
  } else if (idx < currentMusicIdx) {
    currentMusicIdx--;
  }
  
  renderMusic();
  updateMusicFloat();
}

// ═══════════ Floating Ball ═══════════

function updateMusicFloat() {
  let ball = document.getElementById('musicFloat');
  const current = currentMusicIdx >= 0 && currentMusicIdx < musicList.length ? musicList[currentMusicIdx] : null;
  const isActive = musicAudio && current;
  
  if (!ball && isActive) {
    ball = document.createElement('div');
    ball.id = 'musicFloat';
    ball.className = 'music-float';
    ball.innerHTML = `
      <div class="mf-body" onclick="musicFloatClick()">
        <span class="mf-icon">🎵</span>
        <span class="mf-info">
          <span class="mf-title" id="mfTitle">${escapeHtml(current.title)}</span>
          <span class="mf-artist" id="mfArtist">${escapeHtml(current.artist || '')}</span>
        </span>
        <span class="mf-time" id="mfTime">0:00</span>
        <button class="mf-play" id="mfPlayBtn" onclick="event.stopPropagation();musicToggle()">⏸</button>
      </div>
      <div class="mf-progress" id="mfProgress"><div class="mf-progress-fill" id="mfProgressFill"></div></div>
    `;
    document.body.appendChild(ball);
    makeFloatDraggable(ball);
  }
  
  if (!ball) return;
  
  if (!isActive) {
    ball.style.display = 'none';
    return;
  }
  
  ball.style.display = 'flex';
  document.getElementById('mfTitle').textContent = current.title;
  document.getElementById('mfArtist').textContent = current.artist || '';
  document.getElementById('mfPlayBtn').textContent = musicAudio.paused ? '▶' : '⏸';
}

function musicFloatClick() {
  switchTab('music');
}

function makeFloatDraggable(el) {
  let isDragging = false, startX, startY, origX, origY;
  const header = el.querySelector('.mf-body');
  
  function onStart(e) {
    const touch = e.touches ? e.touches[0] : e;
    isDragging = true;
    startX = touch.clientX;
    startY = touch.clientY;
    const rect = el.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;
    el.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
  }
  
  function onMove(e) {
    if (!isDragging) return;
    const touch = e.touches ? e.touches[0] : e;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    el.style.left = (origX + dx) + 'px';
    el.style.top = (origY + dy) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  
  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    el.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  }
  
  header.addEventListener('mousedown', onStart);
  header.addEventListener('touchstart', onStart, { passive: true });
}

// Patch existing functions to update float
const _origMusicPlay = musicPlay;
musicPlay = async function(idx) {
  await _origMusicPlay(idx);
  updateMusicFloat();
};

const _origMusicToggle = musicToggle;
musicToggle = function() {
  _origMusicToggle();
  updateMusicFloat();
};

const _origMusicNext = musicNext;
musicNext = function() {
  _origMusicNext();
  updateMusicFloat();
};

const _origMusicPrev = musicPrev;
musicPrev = function() {
  _origMusicPrev();
  updateMusicFloat();
};
