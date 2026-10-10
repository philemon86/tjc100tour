'use strict';
const $ = (id) => document.getElementById(id);
const ui = { audio: $('audio'), status: $('viewer-status') };
let data, viewer, currentScene, currentTrack, rotating = false, loadFailed = false;
let sceneLoading = true, pendingScene = null;
let prefetchTimer = null, prefetchController = null, prefetchPath = null;
const prefetched = new Set();
const assetVersion = '20261010-quiet1';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = window.matchMedia('(max-width: 720px)').matches;
const panoramaPath = (scene) => mobile || navigator.connection?.saveData ? scene.lowImage : scene.image;
const formatTime = (n) => Number.isFinite(n) ? `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(Math.floor(n % 60)).padStart(2,'0')}` : '--:--';
const iconArrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6M12 8v12"/></svg>';
const iconInfo = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 10v7"/><circle cx="12" cy="6.5" r=".5" fill="currentColor"/></svg>';
const setText = (id,text) => { $(id).textContent = text; };

function showViewerStatus(message, state = 'loading') {
  ui.status.textContent = message;
  ui.status.dataset.state = state;
  ui.status.setAttribute('role',state === 'error' ? 'alert' : 'status');
  ui.status.hidden = false;
  $('panorama').setAttribute('aria-busy',String(state === 'loading'));
}

function clearViewerStatus() {
  ui.status.hidden = true;
  ui.status.dataset.state = 'ready';
  $('panorama').setAttribute('aria-busy','false');
}

function showFallbackPhoto(id, message) {
  const image = $('fallback-image');
  image.src = panoramaPath(data.scenes[id]);
  image.alt = data.scenes[id].title + '全景照片';
  image.hidden = false;
  showViewerStatus(message,'error');
}

function cancelPrefetch(nextPath) {
  clearTimeout(prefetchTimer);
  if (prefetchPath !== nextPath) prefetchController?.abort();
}

function prefetchNextScene(id) {
  cancelPrefetch();
  const connection = navigator.connection;
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')) return;
  const scene = data.scenes[id];
  const routeIndex = data.route.indexOf(scene.parent || id);
  const nextId = data.route[(routeIndex + 1) % data.route.length];
  const path = panoramaPath(data.scenes[nextId]);
  if (prefetched.has(path)) return;
  // Warm only the next stop after the current panorama is ready.
  prefetchTimer = setTimeout(async () => {
    if (sceneLoading || currentScene !== id || document.hidden || !ui.audio.paused) return;
    const controller = new AbortController();
    prefetchController = controller; prefetchPath = path;
    try {
      const response = await fetch(path,{cache:'force-cache',priority:'low',signal:controller.signal});
      if (response.ok) { await response.blob(); prefetched.add(path); }
    } catch (_) { /* Prefetch failure must not interrupt a visit. */ }
    finally { if (prefetchController === controller) { prefetchController = null; prefetchPath = null; } }
  },1200);
}

function showTab(name, writeHash = true) {
  name = name === 'history' ? 'history' : 'tour';
  document.body.dataset.page = name;
  $('tour-tab').hidden = name !== 'tour';
  $('history-tab').hidden = name !== 'history';
  document.querySelectorAll('[data-tab]').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  if (name === 'history') { ui.audio.pause(); stopRotation(); }
  else requestAnimationFrame(() => viewer?.resize());
  if (writeHash) history.replaceState(null,'',name === 'history' ? '#history' : '#tour/' + currentScene);
}

function openDialog(id) {
  stopRotation();
  const dialog = $(id);
  if (!dialog.open) dialog.showModal();
}
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click',event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click',() => showTab(button.dataset.tab)));
document.querySelectorAll('[data-go-tour]').forEach(button => button.addEventListener('click',() => { showTab('tour'); window.scrollTo({top:0,behavior:reducedMotion?'instant':'smooth'}); }));
$('help-button').addEventListener('click',() => openDialog('help-dialog'));
$('route-button').addEventListener('click',() => openDialog('route-dialog'));
$('track-selector').addEventListener('click',() => openDialog('audio-dialog'));
$('all-audio-button').addEventListener('click',() => openDialog('audio-dialog'));

function makeHotspot(div,args) {
  const button = document.createElement('button');
  button.setAttribute('aria-label',args.panel ? `閱讀${args.label.replace(/^閱讀/,'')}` : `前往${args.label}`);
  button.innerHTML = args.panel ? iconInfo : iconArrow;
  const label = document.createElement('span');
  label.className = 'hotspot-label'; label.textContent = args.label;
  div.append(button,label);
  button.addEventListener('click',event => { event.stopPropagation(); if (args.panel) openPanel(args.panel); else goToScene(args.target); });
}

function goToScene(id) {
  if (!data.scenes[id]) return;
  $('route-dialog').close();
  showTab('tour',false);
  ui.audio.pause(); stopRotation();
  if (sceneLoading && viewer && !loadFailed) { pendingScene = id; return; }
  if (id === currentScene && viewer && !loadFailed) return;
  cancelPrefetch(panoramaPath(data.scenes[id]));
  if (viewer && !loadFailed) {
    showViewerStatus('正在載入下一站…');
    sceneLoading = true;
    viewer.loadScene(id,data.scenes[id].pitch || 0,data.scenes[id].yaw,mobile ? 85 : 95);
  } else {
    showFallbackPhoto(id,'360°全景暫時無法顯示，目前顯示照片；可重新整理重試，或繼續選擇展區與聆聽語音。');
    sceneLoading = false;
    updateScene(id);
  }
}

function updateScene(id) {
  currentScene = id;
  const scene = data.scenes[id];
  const routeId = scene.parent || id;
  const routeIndex = Math.max(0,data.route.indexOf(routeId));
  setText('station-number',String(routeIndex + 1).padStart(2,'0'));
  setText('scene-location',scene.location);
  setText('scene-title',scene.title);
  setText('scene-subtitle',scene.subtitle || '拖曳環視，點擊移動點繼續探索');
  setText('story-title',scene.storyTitle || scene.title);
  setText('story-description',scene.description);
  const next = data.route[(routeIndex + 1) % data.route.length];
  setText('next-title',data.scenes[next].title);
  $('next-station').onclick = () => goToScene(next);
  document.querySelectorAll('[data-scene]').forEach(button => {
    const active = button.dataset.scene === routeId;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  });
  const alternate = scene.alternate || (scene.parent ? scene.parent : null);
  $('alternate-button').hidden = !alternate;
  if (alternate) $('alternate-button').onclick = () => goToScene(alternate);
  const panels = scene.panels || [];
  $('panel-button').hidden = !panels.length;
  $('panel-button').onclick = () => openPanel(panels[0]);
  setText('audio-status',scene.department === '文宣處' ? '可選聽文宣處各段語音；點擊播放開始聆聽。' : '此處尚無專屬語音，可另選聽文宣處或宣道處。');
  history.replaceState(null,'','#tour/' + id);
  const card = document.querySelector(`.scene-card[data-scene="${routeId}"]`);
  if (card) {
    const strip = $('scene-strip');
    const cardLeft = card.offsetLeft - strip.offsetLeft;
    if (cardLeft < strip.scrollLeft || cardLeft + card.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollTo({left:cardLeft,behavior:reducedMotion?'instant':'smooth'});
  }
}

function stopRotation() {
  if (viewer && rotating) viewer.stopAutoRotate();
  rotating = false;
  $('rotate-button').setAttribute('aria-pressed','false');
  $('rotate-button').setAttribute('aria-label','開始自動環視');
}
$('zoom-in').addEventListener('click',() => viewer?.setHfov(viewer.getHfov() - 12,200));
$('zoom-out').addEventListener('click',() => viewer?.setHfov(viewer.getHfov() + 12,200));
$('rotate-button').addEventListener('click',() => {
  if (!viewer || loadFailed) return;
  if (rotating) stopRotation();
  else { viewer.startAutoRotate(-1.3,viewer.getPitch()); rotating = true; $('rotate-button').setAttribute('aria-pressed','true'); $('rotate-button').setAttribute('aria-label','暫停自動環視'); }
});
$('fullscreen-button').addEventListener('click',async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('viewer-shell').requestFullscreen) await $('viewer-shell').requestFullscreen();
    else { openDialog('help-dialog'); setText('audio-status','此瀏覽器不支援全螢幕；可橫向持握手機放大觀看。'); }
  } catch (_) { setText('audio-status','此瀏覽器未能開啟全螢幕，可繼續使用全景導覽。'); }
});
document.addEventListener('fullscreenchange',() => { viewer?.resize(); $('fullscreen-button').setAttribute('aria-label',document.fullscreenElement?'離開全螢幕':'開啟全螢幕'); });
document.addEventListener('visibilitychange',() => { if (document.hidden) { ui.audio.pause(); stopRotation(); } });

function selectTrack(index,play = false) {
  const track = data.tracks[index];
  if (!track) return;
  ui.audio.pause();
  currentTrack = index;
  const playbackRate = ui.audio.playbackRate;
  ui.audio.defaultPlaybackRate = playbackRate;
  ui.audio.src = track.path;
  ui.audio.playbackRate = playbackRate;
  setText('audio-title',track.label);
  setText('audio-location',track.floor + ' · ' + (track.floor === '4F' ? '宣道處（獨立語音）' : '文宣處'));
  setText('duration',formatTime(track.seconds));
  setText('current-time','00:00');
  $('audio-seek').value = 0;
  document.querySelectorAll('[data-track]').forEach(button => button.classList.toggle('active',Number(button.dataset.track) === index));
  if (play) playAudio();
}
async function playAudio() {
  if (!data) return;
  cancelPrefetch();
  setText('audio-status','正在準備語音…');
  try { await ui.audio.play(); setText('audio-status','正在播放。您可以一邊聆聽，一邊環視展廳。'); }
  catch (_) { setText('audio-status','播放未能啟動，請再按一次播放；也請確認裝置音量。'); }
}
$('play-button').addEventListener('click',() => ui.audio.paused ? playAudio() : ui.audio.pause());
ui.audio.addEventListener('play',() => { $('play-icon').innerHTML = '<path d="M7 5h4v14H7Zm6 0h4v14h-4Z" fill="currentColor" stroke="none"/>'; $('play-button').setAttribute('aria-label','暫停語音'); });
ui.audio.addEventListener('pause',() => { $('play-icon').innerHTML = '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'; $('play-button').setAttribute('aria-label','播放語音'); if (ui.audio.currentTime > 0 && !ui.audio.ended) setText('audio-status','已暫停，按下播放即可繼續聆聽。'); });
ui.audio.addEventListener('loadedmetadata',() => setText('duration',formatTime(ui.audio.duration)));
ui.audio.addEventListener('timeupdate',() => { setText('current-time',formatTime(ui.audio.currentTime)); if (ui.audio.duration) $('audio-seek').value = ui.audio.currentTime / ui.audio.duration * 100; });
ui.audio.addEventListener('ended',() => setText('audio-status','這一段故事已播放完畢。您可以選擇下一段語音。'));
ui.audio.addEventListener('error',() => setText('audio-status','這段語音未能載入，請重試或選擇另一段。'));
$('audio-seek').addEventListener('input',event => { if (Number.isFinite(ui.audio.duration)) ui.audio.currentTime = Number(event.target.value) / 100 * ui.audio.duration; });
$('speed-button').addEventListener('click',() => { const rates = [1,1.25,1.5,.75]; const next = rates[(rates.indexOf(ui.audio.playbackRate)+1)%rates.length]; ui.audio.defaultPlaybackRate = next; ui.audio.playbackRate = next; $('speed-button').textContent = next + '×'; $('speed-button').setAttribute('aria-label','播放速度，' + next + '倍'); });

function openPanel(panelId) {
  const panel = data.panels.find(p => p.id === panelId);
  if (!panel) return;
  setText('panel-title',panel.title);
  $('panel-image').src = panel.path;
  $('panel-image').alt = panel.title + '完整展板';
  $('panel-select').value = panelId;
  $('panel-original').href = panel.path;
  $('panel-dialog').scrollTop = 0;
  openDialog('panel-dialog');
}

async function init() {
  const response = await fetch('data.json?v=' + assetVersion);
  if (!response.ok) throw new Error('無法讀取導覽資料');
  data = await response.json();
  // All paths are local; the site does not depend on Google Drive download tokens.
  data.route.forEach((id,index) => {
    const scene = data.scenes[id];
    const button = document.createElement('button');
    button.className = 'scene-card'; button.dataset.scene = id;
    const image = document.createElement('img'); image.src = scene.thumb; image.alt = scene.title + '實景縮圖'; image.loading = 'lazy'; image.decoding = 'async'; image.fetchPriority = 'low';
    const label = document.createElement('span'); label.className = 'scene-card-label';
    const number = document.createElement('span'); number.textContent = String(index+1).padStart(2,'0');
    const title = document.createElement('strong'); title.textContent = scene.title;
    label.append(title,number); button.append(image,label);
    button.addEventListener('click',() => goToScene(id)); $('scene-strip').append(button);
    const entry = document.createElement('button'); entry.className = 'route-entry'; entry.dataset.scene = id;
    const entryNumber = document.createElement('b'); entryNumber.textContent = String(index+1).padStart(2,'0');
    const copy = document.createElement('span'); const name = document.createElement('strong'); name.textContent = scene.title; const location = document.createElement('small'); location.textContent = scene.location;
    copy.append(name,location); entry.append(entryNumber,image.cloneNode(),copy); entry.addEventListener('click',() => goToScene(id)); $('route-list').append(entry);
  });
  setText('scene-count',`${data.route.length}個停留點 · 七樓實景`);
  data.tracks.forEach((track,index) => {
    const button = document.createElement('button'); button.className = 'audio-entry'; button.dataset.track = String(index);
    const icon = document.createElement('span'); icon.className = 'audio-entry-icon'; icon.textContent = '▷';
    const title = document.createElement('span'); const strong = document.createElement('strong'); strong.textContent = track.label; const small = document.createElement('small'); small.textContent = track.floor + ' · ' + (track.floor === '4F'?'宣道處 · 僅語音':'文宣處'); title.append(strong,small);
    const duration = document.createElement('span'); duration.textContent = formatTime(track.seconds); button.append(icon,title,duration);
    button.addEventListener('click',() => { selectTrack(index,true); $('audio-dialog').close(); }); $('audio-list').append(button);
  });
  data.history.forEach(item => { const entry = document.createElement('article'); entry.className = 'timeline-item'; const year = document.createElement('span'); year.className = 'timeline-year'; year.textContent = item.year; const text = document.createElement('div'); const h = document.createElement('h2'); h.textContent = item.title; text.append(h); if (item.description) { const p = document.createElement('p'); p.textContent = item.description; text.append(p); } entry.append(year,text); $('timeline').append(entry); });
  data.panels.forEach(panel => { const option = document.createElement('option'); option.value = panel.id; option.textContent = panel.title; $('panel-select').append(option); });
  $('panel-select').addEventListener('change',event => openPanel(event.target.value));
  const hashId = location.hash.startsWith('#tour/') ? decodeURIComponent(location.hash.slice(6)) : '';
  currentScene = data.scenes[hashId] ? hashId : data.firstScene;
  const startHistory = location.hash === '#history';
  const configScenes = {};
  for (const [id,scene] of Object.entries(data.scenes)) {
    configScenes[id] = { type:'equirectangular', panorama:panoramaPath(scene), yaw:scene.yaw, pitch:scene.pitch||0, hfov:mobile?85:95, hotSpots:(scene.links||[]).map(link => ({pitch:link.pitch ?? -17,yaw:link.yaw,cssClass:'tour-hotspot',createTooltipFunc:makeHotspot,createTooltipArgs:{label:data.scenes[link.target].title,target:link.target}})) };
    for (const hotspot of (scene.info || [])) configScenes[id].hotSpots.push({pitch:hotspot.pitch || 0,yaw:hotspot.yaw,cssClass:'tour-hotspot info-hotspot',createTooltipFunc:makeHotspot,createTooltipArgs:{label:hotspot.label,panel:hotspot.panel}});
  }
  selectTrack(0);
  showViewerStatus('正在載入360°實景…');
  try {
    if (!window.pannellum) throw new Error('全景元件未載入');
    // Native scene fading keeps the previous rendered perspective until the new
    // panorama is ready. A nearly instant fade retains this during reduced motion.
    viewer = pannellum.viewer('panorama',{default:{firstScene:currentScene,autoLoad:true,showControls:false,mouseZoom:true,sceneFadeDuration:reducedMotion?1:180,ignoreGPanoXMP:true,minHfov:45,maxHfov:115,escapeHTML:true,orientationOnByDefault:false,strings:{loadingLabel:'正在載入全景…',genericWebGLError:'此裝置暫時無法顯示360全景。',noWebGLError:'此瀏覽器不支援360全景。',textureSizeError:'裝置無法載入這張全景，請使用較新的瀏覽器。'}},scenes:configScenes});
    viewer.on('load',() => {
      clearViewerStatus(); loadFailed = false; sceneLoading = false; $('fallback-image').hidden = true;
      const next = pendingScene; pendingScene = null;
      if (next && next !== currentScene) goToScene(next);
      else prefetchNextScene(currentScene);
    });
    viewer.on('scenechange',id => { ui.audio.pause(); stopRotation(); updateScene(id); });
    viewer.on('error',message => { loadFailed = true; sceneLoading = false; pendingScene = null; showFallbackPhoto(currentScene,'360°全景暫時無法顯示，目前顯示照片；可重新整理重試，或繼續選擇展區與聆聽語音。'); console.warn(message); });
    viewer.on('mousedown',() => { stopRotation(); $('drag-tip').style.opacity = '.65'; });
    viewer.on('touchstart',stopRotation);
  } catch (error) { loadFailed = true; sceneLoading = false; showFallbackPhoto(currentScene,'360°全景暫時無法啟動，目前顯示照片；可重新整理重試，或以展區選單繼續參觀。'); console.error(error); }
  updateScene(currentScene);
  showTab(startHistory?'history':'tour');
}
window.addEventListener('hashchange',() => {
  if (!data) return;
  if (location.hash === '#history') showTab('history',false);
  else if (location.hash === '#tour') showTab('tour',false);
  else if (location.hash.startsWith('#tour/')) {
    const id = decodeURIComponent(location.hash.slice(6));
    if (id !== currentScene && data.scenes[id]) goToScene(id);
  }
});
init().catch(error => { sceneLoading = false; showViewerStatus('導覽資料未能載入，請重新整理頁面。','error'); console.error(error); });
