const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static client
app.use(express.static(path.join(__dirname, 'public')));

// Game constants
const TICK_RATE = 20; // 20 updates per second
const BROADCAST_RATE = 20; // 20 sends per second
const MAP_W = 2000;
const MAP_H = 2000;
const MIN_PLAYERS = 10;

let nextId = 1;
const sockets = new Map();
const players = new Map();
const bullets = new Map();
let nextBulletId = 1;

let obstacles = [
  { x: 700, y: 400, w: 200, h: 50 },
  { x: 300, y: 1200, w: 50, h: 300 },
  { x: 1100, y: 900, w: 300, h: 50 },
  { x: 1500, y: 400, w: 60, h: 400 }
];

function createPlayer(isBot = false) {
  const id = (nextId++).toString();
  const p = {
    id,
    x: Math.random() * MAP_W,
    y: Math.random() * MAP_H,
    vx: 0,
    vy: 0,
    speed: 160 + (Math.random() * 40),
    hp: 100,
    maxHp: 100,
    score: 0,
    angle: 0,
    input: { up:false,down:false,left:false,right:false,shoot:false, mx:0, my:0, special:false, build:false, buildAt:null, jump:false, slide:false },
    isBot,
    name: isBot ? `Bot${id}` : `Player${id}`,
    spectator: false,
    jumping: 0,
    sliding: 0,
    cooldowns: { special:0, slide:0, jump:0, build:0 }
  };
  players.set(id, p);
  return p;
}

function spawnBot() {
  const bot = createPlayer(true);
  console.log('spawn bot', bot.id);
  return bot;
}

function ensureMinPlayers() {
  const humanCount = Array.from(players.values()).filter(p=>!p.isBot).length;
  const total = players.size;
  while (players.size < MIN_PLAYERS) {
    spawnBot();
  }
}

function distance(a,b){
  const dx = a.x - b.x; const dy = a.y - b.y; return Math.hypot(dx,dy);
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

// Bot AI: chase nearest enemy
function updateBots(dt){
  const arr = Array.from(players.values());
  for (const bot of arr) {
    if (!bot.isBot || bot.hp<=0) continue;
    // find nearest other (alive)
    let nearest = null; let nd = Infinity;
    for (const other of arr) {
      if (other.id === bot.id) continue;
      // skip dead or spectators
      if (other.hp<=0 || other.spectator) continue;
      const d = distance(bot, other);
      if (d < nd) { nd = d; nearest = other; }
    }
    if (nearest) {
      // set velocity toward nearest
      const dx = nearest.x - bot.x;
      const dy = nearest.y - bot.y;
      const len = Math.hypot(dx,dy) || 1;
      const nx = dx/len; const ny = dy/len;
      // simple movement
      bot.vx = nx * bot.speed;
      bot.vy = ny * bot.speed;
      bot.angle = Math.atan2(ny, nx);
      // occasionally shoot if close
      if (nd < 450 && Math.random() < 0.05) {
        shootBullet(bot, nx, ny);
      }
    } else {
      // wander
      if (Math.random() < 0.02) {
        bot.vx = (Math.random()*2-1) * bot.speed;
        bot.vy = (Math.random()*2-1) * bot.speed;
      }
    }
  }
}

function shootBullet(player, nx, ny) {
  const id = (nextBulletId++).toString();
  bullets.set(id, {
    id,
    x: player.x + nx*20,
    y: player.y + ny*20,
    vx: nx*600,
    vy: ny*600,
    owner: player.id,
    life: 2.0,
    power: 30,
    type: 'bullet'
  });
}

// special shot variant
function shootSpecial(player, nx, ny){
  const id = (nextBulletId++).toString();
  bullets.set(id, {
    id,
    x: player.x + nx*20,
    y: player.y + ny*20,
    vx: nx*900,
    vy: ny*900,
    owner: player.id,
    life: 2.0,
    power: 70,
    type: 'special'
  });
}

function update(dt){
  // bots AI
  updateBots(dt);

  // apply inputs and update players
  for (const p of players.values()){
    // cooldown timers
    if (p.cooldowns){
      p.cooldowns.special = Math.max(0, (p.cooldowns.special || 0) - dt);
      p.cooldowns.slide = Math.max(0, (p.cooldowns.slide || 0) - dt);
      p.cooldowns.jump = Math.max(0, (p.cooldowns.jump || 0) - dt);
      p.cooldowns.build = Math.max(0, (p.cooldowns.build || 0) - dt);
    }
    if (p.sliding) p.sliding = Math.max(0, p.sliding - dt);
    if (p.jumping) p.jumping = Math.max(0, p.jumping - dt);

    if (p.hp<=0) {
      // mark spectator while dead
      p.spectator = true;
      // do not process inputs or movement while spectating
      p.vx = 0; p.vy = 0;
      continue;
    }
    // if revived ensure spectator flag is cleared
    if (p.spectator) p.spectator = false;
    if (!p.isBot) {
      // inputs come in p.input
      const inpt = p.input;
      // actions: special
      if (inpt.special && p.cooldowns && p.cooldowns.special <= 0){
        // fire special
        const ang = Math.atan2(inpt.my - p.y, inpt.mx - p.x);
        shootSpecial(p, Math.cos(ang), Math.sin(ang));
        p.cooldowns.special = 5.0; // 5s cooldown
      }
      // build wall
      if (inpt.build && inpt.buildAt && p.cooldowns && p.cooldowns.build <= 0){
        const ba = inpt.buildAt;
        const wall = { id: `w${Date.now()}${Math.floor(Math.random()*999)}`, x: ba.x - 30, y: ba.y - 10, w: 60, h: 20, owner: p.id, life: 20 };
        obstacles.push(wall);
        p.cooldowns.build = 5.0; // 5s
      }
      // jump
      if (inpt.jump && p.cooldowns && p.cooldowns.jump <= 0){
        p.jumping = 0.7; p.cooldowns.jump = 3.0;
      }
      // slide
      if (inpt.slide && p.cooldowns && p.cooldowns.slide <= 0){
        p.sliding = 0.6; p.cooldowns.slide = 2.0;
      }
      let vx = 0, vy = 0;
      if (inpt.up) vy -= 1;
      if (inpt.down) vy += 1;
      if (inpt.left) vx -= 1;
      if (inpt.right) vx += 1;
      const len = Math.hypot(vx, vy) || 1;
      let spd = p.speed;
      if (p.sliding && p.sliding > 0) spd *= 1.9;
      p.vx = (vx/len) * spd;
      p.vy = (vy/len) * spd;
      // angle towards mouse
      const mx = inpt.mx, my = inpt.my;
      if (mx!==undefined && my!==undefined) {
        p.angle = Math.atan2(my - (p.y), mx - (p.x));
      }
      if (inpt.shoot && Math.random() < 0.5) {
        // shoot towards angle
        const nx = Math.cos(p.angle);
        const ny = Math.sin(p.angle);
        shootBullet(p, nx, ny);
      }
    }
    // apply velocity
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    // clamp to map
    p.x = clamp(p.x, 0, MAP_W);
    p.y = clamp(p.y, 0, MAP_H);
  }

  // update bullets
  for (const [id, b] of bullets){
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) { bullets.delete(id); continue; }
    // collision with players
    for (const p of players.values()){
      if (p.hp<=0) continue;
      if (p.id === b.owner) continue;
      // if target is jumping (short invul), ignore
      if (p.jumping && p.jumping > 0) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < 20){
        const dmg = b.power || 30;
        p.hp -= dmg;
        if (p.hp <= 0) {
          p.hp = 0;
          const owner = players.get(b.owner);
          if (owner) owner.score += 1;
          // respawn after a short delay handled below
        }
        bullets.delete(id);
        break;
      }
    }
  }

  // simple respawn for dead players
  for (const p of players.values()){
    if (p.hp<=0) {
      // slowly respawn
      p.hp += 10 * dt; // regen
      if (p.hp > 0) {
        p.x = Math.random()*MAP_W; p.y = Math.random()*MAP_H;
      }
    }
  }

  // update obstacle lifetimes
  obstacles = obstacles.filter(o=>{
    if (!o.life) return true;
    o.life -= dt;
    return o.life > 0;
  });

  // ensure min players
  ensureMinPlayers();
}

// Connections
wss.on('connection', function connection(ws) {
  const clientId = (nextId++).toString();
  sockets.set(clientId, ws);
  const player = createPlayer(false);
  player.id = clientId; // ensure id maps to socket id for pairing
  players.set(clientId, player);

  ws.send(JSON.stringify({ type:'init', id: clientId, map:{w:MAP_W,h:MAP_H}, obstacles }));

  ws.on('message', function incoming(message) {
    try {
      const data = JSON.parse(message);
      if (data.type === 'input'){
        const p = players.get(clientId);
        if (p){
          p.input = data.input;
        }
      } else if (data.type === 'setName'){
        const p = players.get(clientId);
        if (p && typeof data.name === 'string'){
          p.name = data.name.substring(0, 32);
        }
      }
    } catch (e){}
  });

  ws.on('close', function(){
    sockets.delete(clientId);
    // remove player; if bots exceed MIN_PLAYERS after removal, we'll adjust in ensureMinPlayers
    players.delete(clientId);
  });
});

// Game loop
let last = Date.now()/1000;
setInterval(()=>{
  const now = Date.now()/1000;
  const dt = Math.min(0.1, now - last);
  last = now;
  update(dt);
}, 1000 / TICK_RATE);

// Broadcast
setInterval(()=>{
  const snapshot = {
    type: 'snapshot',
    t: Date.now(),
    players: Array.from(players.values()).map(p=>({ id:p.id, x:p.x, y:p.y, hp:p.hp, score:p.score, angle:p.angle, isBot:p.isBot, spectator: !!p.spectator, name: p.name, jumping: !!p.jumping, sliding: !!p.sliding })),
    bullets: Array.from(bullets.values()).map(b=>({ id:b.id, x:b.x, y:b.y, type: b.type })),
    obstacles: obstacles.map(o=>({ id:o.id, x:o.x, y:o.y, w:o.w, h:o.h }))
  };
  const str = JSON.stringify(snapshot);
  wss.clients.forEach(function each(client){
    if (client.readyState === WebSocket.OPEN) client.send(str);
  });
}, 1000 / BROADCAST_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Battle Area server running on http://localhost:${PORT}`);
});
