import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const ARENA_RADIUS = 28;
const MOVE_SPEED = 8;
const NETWORK_RATE_MS = 50;
const KILL_RADIUS = 2.2; // must match server's KILL_RADIUS, duplicated here for offline (bot) mode
const HUNTER_SPEED_MULTIPLIER = 1.15;

// ---------- DOM ----------
const timerEl = document.getElementById('timer');
const roleEl = document.getElementById('role');
const statusEl = document.getElementById('status');
const killfeedEl = document.getElementById('killfeed');
const lobbyEl = document.getElementById('lobby');
const lobbyStatusEl = document.getElementById('lobbyStatus');
const playerListEl = document.getElementById('playerList');
const nameInput = document.getElementById('nameInput');
const endScreenEl = document.getElementById('endScreen');
const endTitleEl = document.getElementById('endTitle');
const endReasonEl = document.getElementById('endReason');
const crosshairEl = document.getElementById('crosshair');
const offlineBtn = document.getElementById('offlineBtn');
const offlineControlsEl = document.getElementById('offlineControls');
const offlineExitBtn = document.getElementById('offlineExitBtn');

nameInput.value = localStorage.getItem('cvrName') || '';

// ---------- Networking ----------
const socket = io();
let myId = null;
let myRole = 'spectator';
let alive = true;
let gameState = 'lobby';
let offlineMode = false;

// ---------- Three.js setup ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e14);
scene.fog = new THREE.Fog(0x0a0e14, 20, 60);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.6, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0x8899aa, 0x223344, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(20, 30, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -35;
sun.shadow.camera.right = 35;
sun.shadow.camera.top = 35;
sun.shadow.camera.bottom = -35;
scene.add(sun);

// Ground
const groundGeo = new THREE.CircleGeometry(ARENA_RADIUS, 48);
const groundMat = new THREE.MeshStandardMaterial({ color: 0x1c2a38 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Boundary wall (visual)
const wallGeo = new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS, 4, 48, 1, true);
const wallMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, side: THREE.BackSide, transparent: true, opacity: 0.6 });
const wall = new THREE.Mesh(wallGeo, wallMat);
wall.position.y = 2;
scene.add(wall);

// Fixed obstacle layout (deterministic: identical position/size for every client and for collision)
const OBSTACLES = [
  { x: 8, z: 3, size: 3.4 }, { x: -9, z: 5, size: 2.6 }, { x: 5, z: -10, size: 3.0 },
  { x: -6, z: -8, size: 2.4 }, { x: 14, z: -4, size: 3.2 }, { x: -14, z: -2, size: 2.8 },
  { x: 0, z: 12, size: 3.6 }, { x: 2, z: -16, size: 2.6 }, { x: -3, z: 15, size: 3.0 },
  { x: 10, z: 10, size: 2.4 }, { x: -11, z: 11, size: 3.4 }, { x: -16, z: -12, size: 2.8 },
  { x: 16, z: 6, size: 3.0 }, { x: -4, z: -18, size: 2.6 }, { x: 6, z: 17, size: 3.2 }
];
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const boxMat = new THREE.MeshStandardMaterial({ color: 0x3a4f63 });
for (const o of OBSTACLES) {
  const height = o.size * 1.6;
  const box = new THREE.Mesh(boxGeo, boxMat);
  box.scale.set(o.size, height, o.size);
  box.position.set(o.x, height / 2, o.z);
  box.castShadow = true;
  box.receiveShadow = true;
  scene.add(box);
}

// ---------- Collision ----------
const PLAYER_RADIUS = 0.5;

function collidesAt(x, z) {
  for (const o of OBSTACLES) {
    const half = o.size / 2 + PLAYER_RADIUS;
    if (Math.abs(x - o.x) < half && Math.abs(z - o.z) < half) return true;
  }
  const distFromCenter = Math.sqrt(x * x + z * z);
  return distFromCenter > ARENA_RADIUS - 1;
}

// ---------- Controls ----------
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

const keys = { forward: false, back: false, left: false, right: false };
document.addEventListener('keydown', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.forward = true; break;
    case 'KeyS': case 'ArrowDown': keys.back = true; break;
    case 'KeyA': case 'ArrowLeft': keys.left = true; break;
    case 'KeyD': case 'ArrowRight': keys.right = true; break;
  }
});
document.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.forward = false; break;
    case 'KeyS': case 'ArrowDown': keys.back = false; break;
    case 'KeyA': case 'ArrowLeft': keys.left = false; break;
    case 'KeyD': case 'ArrowRight': keys.right = false; break;
  }
});

renderer.domElement.addEventListener('click', () => {
  if (gameState === 'running' && alive) {
    controls.lock();
  }
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (gameState !== 'running' || !alive || myRole !== 'hunter') return;
  if (!controls.isLocked) return;
  if (offlineMode) {
    attackOfflineBots();
  } else {
    socket.emit('attack');
  }
});

controls.addEventListener('lock', () => { crosshairEl.style.display = 'block'; });
controls.addEventListener('unlock', () => { crosshairEl.style.display = 'none'; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Remote players ----------
const remotePlayers = new Map(); // id -> { mesh, role }
const knownPlayers = new Map(); // id -> { name, color, role, alive } (latest authoritative info from server)

function buildAvatar(color, role) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 1.0, 4, 8), bodyMat);
  body.position.y = 1;
  body.castShadow = true;
  group.add(body);

  if (role === 'hunter') {
    const spikeMat = new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0x550000 });
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 8), spikeMat);
    spike.position.y = 1.95;
    group.add(spike);
  }
  return group;
}

// ---------- Offline mode (solo, vs bots — for testing changes without a second player) ----------
const OFFLINE_RUNNER_BOT_COUNT = 3;
const BOT_RUNNER_SPEED = MOVE_SPEED * 0.7;
const BOT_HUNTER_SPEED = MOVE_SPEED * HUNTER_SPEED_MULTIPLIER;
let offlineBots = [];

function randomArenaPoint() {
  let x = 0, z = 0;
  for (let tries = 0; tries < 20; tries++) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * (ARENA_RADIUS - 3);
    x = Math.cos(angle) * r;
    z = Math.sin(angle) * r;
    if (!collidesAt(x, z)) break;
  }
  return { x, z };
}

function clearOfflineBots() {
  for (const bot of offlineBots) scene.remove(bot.mesh);
  offlineBots = [];
}

function spawnOfflineBots() {
  clearOfflineBots();
  if (myRole === 'hunter') {
    for (let i = 0; i < OFFLINE_RUNNER_BOT_COUNT; i++) {
      const pos = randomArenaPoint();
      const mesh = buildAvatar(0x3fa9f5, 'runner');
      mesh.position.set(pos.x, 0, pos.z);
      scene.add(mesh);
      offlineBots.push({ mesh, x: pos.x, z: pos.z, alive: true, role: 'runner', wanderTarget: randomArenaPoint() });
    }
  } else {
    const pos = randomArenaPoint();
    const mesh = buildAvatar(0xff3030, 'hunter');
    mesh.position.set(pos.x, 0, pos.z);
    scene.add(mesh);
    offlineBots.push({ mesh, x: pos.x, z: pos.z, alive: true, role: 'hunter' });
  }
}

function moveBotToward(bot, tx, tz, step) {
  const dx = tx - bot.x, dz = tz - bot.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return;
  const moveX = (dx / dist) * Math.min(step, dist);
  const moveZ = (dz / dist) * Math.min(step, dist);
  if (!collidesAt(bot.x + moveX, bot.z)) bot.x += moveX;
  if (!collidesAt(bot.x, bot.z + moveZ)) bot.z += moveZ;
  bot.mesh.rotation.y = Math.atan2(moveX, moveZ);
}

function updateOfflineBots(delta) {
  const obj = controls.getObject();
  for (const bot of offlineBots) {
    if (!bot.alive) continue;
    if (bot.role === 'runner') {
      if (Math.hypot(bot.wanderTarget.x - bot.x, bot.wanderTarget.z - bot.z) < 1) {
        bot.wanderTarget = randomArenaPoint();
      }
      moveBotToward(bot, bot.wanderTarget.x, bot.wanderTarget.z, BOT_RUNNER_SPEED * delta);
    } else if (alive) {
      moveBotToward(bot, obj.position.x, obj.position.z, BOT_HUNTER_SPEED * delta);
      const dist = Math.hypot(obj.position.x - bot.x, obj.position.z - bot.z);
      if (dist <= KILL_RADIUS) {
        alive = false;
        controls.unlock();
        statusEl.textContent = '[HORS LIGNE] Le bot chasseur t\'a attrapé ! Touche R pour réessayer.';
      }
    }
    bot.mesh.position.set(bot.x, 0, bot.z);
  }
}

function attackOfflineBots() {
  const obj = controls.getObject();
  for (const bot of offlineBots) {
    if (!bot.alive) continue;
    const dist = Math.hypot(obj.position.x - bot.x, obj.position.z - bot.z);
    if (dist <= KILL_RADIUS) {
      bot.alive = false;
      bot.mesh.visible = false;
      addKillfeed('💀 [HORS LIGNE] Bot éliminé');
      setTimeout(() => {
        const pos = randomArenaPoint();
        bot.x = pos.x; bot.z = pos.z;
        bot.mesh.position.set(pos.x, 0, pos.z);
        bot.mesh.visible = true;
        bot.alive = true;
      }, 3000);
    }
  }
}

function offlineRoleStatusText() {
  const base = myRole === 'hunter'
    ? 'Clique pour attaquer les bots runners (bleus). Touche R pour changer de rôle.'
    : 'Fuis le bot chasseur (rouge) — il te rattrape s\'il te touche. Touche R pour changer de rôle.';
  return `${base} — Clique sur l'écran pour activer les contrôles.`;
}

function applyOfflineRole() {
  alive = true;
  controls.getObject().position.set(0, 1.6, 0);
  spawnOfflineBots();
  roleEl.textContent = myRole === 'hunter' ? '🔴 [HORS LIGNE] Chasseur (test)' : '🏃 [HORS LIGNE] Runner (test)';
  statusEl.textContent = offlineRoleStatusText();
}

function toggleOfflineRole() {
  myRole = myRole === 'hunter' ? 'runner' : 'hunter';
  applyOfflineRole();
}

function startOfflineMode() {
  offlineMode = true;
  socket.disconnect();
  myRole = Math.random() < 0.5 ? 'hunter' : 'runner';
  gameState = 'running';
  lobbyEl.classList.add('hidden');
  endScreenEl.classList.add('hidden');
  offlineControlsEl.classList.remove('hidden');
  clearAllRemotes();
  controls.getObject().rotation.y = 0;
  applyOfflineRole();
  timerEl.textContent = '∞';
}

function exitOfflineMode() {
  location.reload();
}

offlineBtn.addEventListener('click', startOfflineMode);
offlineExitBtn.addEventListener('click', exitOfflineMode);
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && offlineMode) toggleOfflineRole();
});

function addOrUpdateRemote(p, snap = false) {
  if (p.id === myId) return;
  const known = knownPlayers.get(p.id);
  const color = known ? known.color : 0xffffff;
  const role = known ? known.role : 'runner';
  const alive = known ? known.alive : true;

  let entry = remotePlayers.get(p.id);
  let isNew = false;
  if (!entry || entry.role !== role) {
    if (entry) scene.remove(entry.mesh);
    const mesh = buildAvatar(color, role);
    scene.add(mesh);
    entry = { mesh, role, target: { x: p.x, z: p.z, ry: p.ry } };
    remotePlayers.set(p.id, entry);
    isNew = true;
  }
  entry.target.x = p.x;
  entry.target.z = p.z;
  entry.target.ry = p.ry;
  entry.mesh.visible = alive;
  if (snap || isNew) {
    entry.mesh.position.set(p.x, 0, p.z);
    entry.mesh.rotation.y = p.ry;
  }
}

function interpolateRemotes(delta) {
  const t = 1 - Math.pow(0.001, delta); // framerate-independent smoothing
  for (const entry of remotePlayers.values()) {
    entry.mesh.position.x += (entry.target.x - entry.mesh.position.x) * t;
    entry.mesh.position.z += (entry.target.z - entry.mesh.position.z) * t;
    let dRy = entry.target.ry - entry.mesh.rotation.y;
    dRy = ((dRy + Math.PI) % (Math.PI * 2)) - Math.PI; // shortest angular path
    entry.mesh.rotation.y += dRy * t;
  }
}

function updateRemoteVisibility(id, alive) {
  const entry = remotePlayers.get(id);
  if (entry) entry.mesh.visible = alive;
}

function removeRemote(id) {
  const entry = remotePlayers.get(id);
  if (entry) {
    scene.remove(entry.mesh);
    remotePlayers.delete(id);
  }
}

function clearAllRemotes() {
  for (const id of Array.from(remotePlayers.keys())) removeRemote(id);
}

// ---------- Game state / UI ----------
let allPlayers = new Map(); // id -> data, used for lobby list

function renderLobbyUI(payload) {
  const { state, countdown, players: list } = payload;
  gameState = state;
  allPlayers = new Map(list.map((p) => [p.id, p]));
  for (const p of list) knownPlayers.set(p.id, p);

  if (state === 'running' || state === 'ended') {
    lobbyEl.classList.add('hidden');
  } else {
    lobbyEl.classList.remove('hidden');
    endScreenEl.classList.add('hidden');
    if (state === 'countdown') {
      lobbyStatusEl.textContent = `La partie démarre dans ${countdown}s...`;
    } else {
      const need = Math.max(0, 2 - list.length);
      lobbyStatusEl.textContent = need > 0
        ? `En attente de joueurs... (${list.length} connecté(s), encore ${need} requis)`
        : `En attente...`;
    }
    playerListEl.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      li.textContent = p.name;
      li.style.color = `#${p.color.toString(16).padStart(6, '0')}`;
      playerListEl.appendChild(li);
    }
  }
}

function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function addKillfeed(text) {
  const div = document.createElement('div');
  div.textContent = text;
  killfeedEl.appendChild(div);
  setTimeout(() => div.remove(), 5000);
}

// ---------- Socket events ----------
socket.on('connect', () => {
  myId = socket.id;
  const savedName = localStorage.getItem('cvrName');
  if (savedName) socket.emit('setName', savedName);
});

socket.on('init', (payload) => {
  myId = payload.id;
  gameState = payload.state;
  renderLobbyUI({ state: payload.state, countdown: payload.countdown, players: payload.players });
  roundRemaining = payload.roundRemaining || 0;
  timerEl.textContent = formatTime(roundRemaining);
  clearAllRemotes();
  for (const p of payload.players) addOrUpdateRemote(p);
});

socket.on('lobby', (payload) => {
  renderLobbyUI(payload);
});

let roundRemaining = 0;

socket.on('roundStart', (payload) => {
  gameState = 'running';
  roundRemaining = payload.duration;
  endScreenEl.classList.add('hidden');
  clearAllRemotes();
  for (const p of payload.players) knownPlayers.set(p.id, p);
  for (const p of payload.players) {
    if (p.id === myId) {
      myRole = p.role;
      alive = true;
      controls.getObject().position.set(p.x, 1.6, p.z);
      controls.getObject().rotation.y = p.ry;
      roleEl.textContent = myRole === 'hunter' ? '🔴 Tu es le CHASSEUR' : '🏃 Tu es un RUNNER';
      statusEl.textContent = myRole === 'hunter' ? 'Clique pour attaquer les runners proches' : 'Survis jusqu\'à la fin du chrono !';
    } else {
      addOrUpdateRemote(p);
    }
  }
  statusEl.textContent += ' — Clique sur l\'écran pour jouer';
});

socket.on('timer', (payload) => {
  roundRemaining = payload.remaining;
  timerEl.textContent = formatTime(roundRemaining);
});

socket.on('playerJoined', (p) => {
  knownPlayers.set(p.id, p);
  allPlayers.set(p.id, p);
  if (gameState === 'running') addOrUpdateRemote(p);
});

socket.on('playerLeft', ({ id }) => {
  removeRemote(id);
});

socket.on('playerMoved', (p) => {
  if (!knownPlayers.has(p.id)) return;
  addOrUpdateRemote(p);
});

socket.on('killed', ({ id }) => {
  const known = knownPlayers.get(id);
  if (known) known.alive = false;
  const name = allPlayers.get(id)?.name || 'Un runner';
  updateRemoteVisibility(id, false);
  if (id === myId) {
    alive = false;
    statusEl.textContent = 'Tu as été éliminé. Tu observes la fin de la partie...';
    controls.unlock();
  } else {
    addKillfeed(`💀 ${name} a été éliminé`);
  }
});

socket.on('roundEnd', ({ winner, reason }) => {
  gameState = 'ended';
  controls.unlock();
  endTitleEl.textContent = winner === 'hunter' ? 'Le chasseur gagne !' : 'Les runners gagnent !';
  endTitleEl.style.color = winner === 'hunter' ? '#ff5050' : '#50ff8a';
  endReasonEl.textContent = reason;
  endScreenEl.classList.remove('hidden');
});

nameInput.addEventListener('change', () => {
  const val = nameInput.value.trim();
  if (val) {
    localStorage.setItem('cvrName', val);
    socket.emit('setName', val);
  }
});

// ---------- Movement loop ----------
let lastSent = 0;
const clock = new THREE.Clock();

const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();

function updateMovement(delta) {
  if (gameState !== 'running' || !alive || !controls.isLocked) return;

  const speedMultiplier = myRole === 'hunter' ? HUNTER_SPEED_MULTIPLIER : 1.0;
  const speed = MOVE_SPEED * speedMultiplier * delta;
  const forwardInput = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const rightInput = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

  const obj = controls.getObject();

  if (forwardInput !== 0 || rightInput !== 0) {
    _right.setFromMatrixColumn(camera.matrix, 0);
    _forward.crossVectors(camera.up, _right);

    const dx = (_forward.x * forwardInput + _right.x * rightInput) * speed;
    const dz = (_forward.z * forwardInput + _right.z * rightInput) * speed;

    // Resolve X and Z separately so the player slides along obstacle edges instead of stopping dead.
    if (!collidesAt(obj.position.x + dx, obj.position.z)) obj.position.x += dx;
    if (!collidesAt(obj.position.x, obj.position.z + dz)) obj.position.z += dz;
  }

  obj.position.y = 1.6;

  if (offlineMode) return;

  const now = performance.now();
  if (now - lastSent > NETWORK_RATE_MS) {
    lastSent = now;
    socket.emit('move', {
      x: obj.position.x,
      y: obj.position.y,
      z: obj.position.z,
      ry: obj.rotation.y
    });
  }
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  updateMovement(delta);
  if (offlineMode) updateOfflineBots(delta);
  interpolateRemotes(delta);
  renderer.render(scene, camera);
}
animate();
