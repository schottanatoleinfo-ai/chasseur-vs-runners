const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 5;
const ROUND_SECONDS = 150;
const KILL_RADIUS = 2.2;
const ARENA_RADIUS = 45; // must match client's ARENA_RADIUS
const ORB_COUNT = 3;
const ORB_COLLECT_RADIUS = 2.5;

const COLORS = [0x3fa9f5, 0xf5a93f, 0x7cf53f, 0xf53f9e, 0x3ff5d8, 0xd83ff5, 0xf5f13f, 0xf53f3f];

/** @type {Map<string, {id:string,name:string,color:number,role:string,alive:boolean,x:number,y:number,z:number,ry:number}>} */
const players = new Map();

let state = 'lobby'; // lobby | countdown | running | ended
let countdownTimer = null;
let countdownRemaining = 0;
let roundTimer = null;
let roundRemaining = 0;
let tickInterval = null;
let orbs = []; // {x, z, collected} — random pickups runners can go collect during a round

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, role: p.role, alive: p.alive, x: p.x, y: p.y, z: p.z, ry: p.ry };
}

function broadcastLobby() {
  io.emit('lobby', {
    state,
    countdown: countdownRemaining,
    players: Array.from(players.values()).map(publicPlayer)
  });
}

function resetToLobby() {
  clearInterval(tickInterval);
  clearTimeout(roundTimer);
  clearInterval(countdownTimer);
  state = 'lobby';
  countdownRemaining = 0;
  for (const p of players.values()) {
    p.role = 'spectator';
    p.alive = true;
  }
  broadcastLobby();
  maybeStartCountdown();
}

function maybeStartCountdown() {
  if (state !== 'lobby') return;
  if (players.size < MIN_PLAYERS) return;
  state = 'countdown';
  countdownRemaining = COUNTDOWN_SECONDS;
  broadcastLobby();
  countdownTimer = setInterval(() => {
    countdownRemaining -= 1;
    if (players.size < MIN_PLAYERS) {
      state = 'lobby';
      countdownRemaining = 0;
      clearInterval(countdownTimer);
      broadcastLobby();
      return;
    }
    if (countdownRemaining <= 0) {
      clearInterval(countdownTimer);
      startRound();
      return;
    }
    broadcastLobby();
  }, 1000);
}

function spawnPosition(index, total, isHunter) {
  if (isHunter) return { x: 0, y: 1, z: 0, ry: 0 };
  const radius = 30;
  const angle = (index / Math.max(1, total)) * Math.PI * 2;
  return { x: Math.cos(angle) * radius, y: 1, z: Math.sin(angle) * radius, ry: angle + Math.PI };
}

function generateOrbs() {
  const list = [];
  for (let i = 0; i < ORB_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * (ARENA_RADIUS - 9);
    list.push({ x: Math.cos(angle) * r, z: Math.sin(angle) * r, collected: false });
  }
  return list;
}

function startRound() {
  const ids = Array.from(players.keys());
  const hunterId = ids[Math.floor(Math.random() * ids.length)];
  let runnerIndex = 0;
  const runnerCount = ids.length - 1;
  for (const id of ids) {
    const p = players.get(id);
    p.alive = true;
    if (id === hunterId) {
      p.role = 'hunter';
      const pos = spawnPosition(0, 1, true);
      Object.assign(p, pos);
    } else {
      p.role = 'runner';
      const pos = spawnPosition(runnerIndex, runnerCount, false);
      Object.assign(p, pos);
      runnerIndex += 1;
    }
  }

  state = 'running';
  roundRemaining = ROUND_SECONDS;
  orbs = generateOrbs();

  io.emit('roundStart', {
    duration: ROUND_SECONDS,
    players: Array.from(players.values()).map(publicPlayer),
    orbs: orbs.map((o) => ({ x: o.x, z: o.z }))
  });

  tickInterval = setInterval(() => {
    roundRemaining -= 1;
    io.emit('timer', { remaining: roundRemaining });
    if (roundRemaining <= 0) {
      endRound('runners', 'Le temps est écoulé, les runners survivent !');
    }
  }, 1000);
}

function endRound(winner, reason) {
  if (state !== 'running') return;
  state = 'ended';
  clearInterval(tickInterval);
  clearTimeout(roundTimer);
  io.emit('roundEnd', { winner, reason });
  setTimeout(resetToLobby, 8000);
}

function checkHunterWin() {
  const anyRunnerAlive = Array.from(players.values()).some(p => p.role === 'runner' && p.alive);
  if (!anyRunnerAlive) {
    endRound('hunter', 'Tous les runners ont été éliminés !');
  }
}

io.on('connection', (socket) => {
  const color = COLORS[players.size % COLORS.length];
  const player = {
    id: socket.id,
    name: `Joueur-${socket.id.slice(0, 4)}`,
    color,
    role: 'spectator',
    alive: true,
    x: (Math.random() - 0.5) * 10,
    y: 1,
    z: (Math.random() - 0.5) * 10,
    ry: 0
  };
  players.set(socket.id, player);

  socket.emit('init', {
    id: socket.id,
    state,
    countdown: countdownRemaining,
    roundRemaining,
    players: Array.from(players.values()).map(publicPlayer)
  });
  socket.broadcast.emit('playerJoined', publicPlayer(player));
  broadcastLobby();
  maybeStartCountdown();

  socket.on('setName', (name) => {
    if (typeof name !== 'string') return;
    const clean = name.trim().slice(0, 16);
    if (!clean) return;
    player.name = clean;
    broadcastLobby();
  });

  socket.on('move', (data) => {
    if (state !== 'running') return;
    if (!player.alive) return;
    if (typeof data !== 'object' || data === null) return;
    const { x, y, z, ry } = data;
    if ([x, y, z, ry].some((v) => typeof v !== 'number' || !isFinite(v))) return;
    player.x = x; player.y = y; player.z = z; player.ry = ry;
    socket.broadcast.emit('playerMoved', { id: socket.id, x, y, z, ry });
  });

  socket.on('attack', () => {
    if (state !== 'running') return;
    if (player.role !== 'hunter' || !player.alive) return;
    for (const other of players.values()) {
      if (other.role !== 'runner' || !other.alive) continue;
      const dx = other.x - player.x;
      const dz = other.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= KILL_RADIUS) {
        other.alive = false;
        io.emit('killed', { id: other.id, by: player.id });
      }
    }
    checkHunterWin();
  });

  socket.on('collectOrb', (index) => {
    if (state !== 'running') return;
    if (player.role !== 'runner' || !player.alive) return;
    if (typeof index !== 'number' || !orbs[index] || orbs[index].collected) return;
    const dx = player.x - orbs[index].x;
    const dz = player.z - orbs[index].z;
    if (Math.sqrt(dx * dx + dz * dz) > ORB_COLLECT_RADIUS) return;
    orbs[index].collected = true;
    io.emit('orbCollected', { index, by: player.id });
  });

  socket.on('disconnect', () => {
    const wasHunter = player.role === 'hunter';
    players.delete(socket.id);
    io.emit('playerLeft', { id: socket.id });

    if (state === 'running') {
      if (wasHunter) {
        endRound('runners', 'Le chasseur a quitté la partie, les runners gagnent !');
        return;
      }
      checkHunterWin();
    } else if (state === 'countdown' && players.size < MIN_PLAYERS) {
      clearInterval(countdownTimer);
      state = 'lobby';
      countdownRemaining = 0;
    }
    broadcastLobby();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
