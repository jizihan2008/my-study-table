// Desktop-only controls; position and visibility are local to this computer.
(function () {
  'use strict';
  const api = window.electronAPI;
  if (!api || !api.petStatus) return;
  const panel = document.getElementById('desktopPetSettings');
  const button = document.getElementById('desktopPetToggle');
  panel.hidden = false;
  const update = state => { button.checked = state.enabled; };
  api.petStatus().then(update).catch(console.error);
  api.onPetState(update);
  window.toggleDesktopPet = async function (enabled) {
    button.disabled = true;
    try { update(await api.petSetEnabled(enabled)); }
    catch (error) {
      console.error('[desktop-pet]', error);
      try { update(await api.petStatus()); } catch (_) { button.checked = !enabled; }
      if (typeof showToast === 'function') showToast('桌宠暂时无法打开，请重试');
    } finally { button.disabled = false; }
  };
  window.notifyDesktopPet = cue => { api.petCue(cue); };
})();
