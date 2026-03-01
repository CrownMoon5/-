const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static client
app.use(express.static(path.join(__dirname, 'public')));

// Game constants
const TICK_RATE = 20; // 20 updates per second
const BROADCAST_RATE = 20; // 20 sends per second
let MAP_W = 4000;
let MAP_H = 4000;
const MIN_PLAYERS = 10;

let nextId = 1;
const sockets = new Map();
const players = new Map();
const bullets = new Map();
let nextBulletId = 1;
// match state for rounds/teams
const match = {
  roundsEnabled: false,
  roundsTotal: 3,
  roundDuration: 180, // seconds
  currentRound: 0,
  roundTimeLeft: 0,
  inRound: false,
  teamMatch: false,
  teamScores: [0,0]
};
// mode: 'deathmatch' or 'flagHill'
match.mode = 'deathmatch';
// for flag hill mode
match.flags = [];
match.flagRadius = 72; // ~3 blocks
match.flagCaptureTime = 3; // seconds required to capture
match.allFlagsHoldTimer = [0,0]; // time each team holds all flags continuously
match.roundWinnerTeam = null;
// additional round fields
match.roundWinner = null; // id of winner when round ends
match.targetKills = 9; // number of kills required to win (default 9)
match.initialPlayers = [];
match.nextRoundTimeout = null;
// simple bot learning/stats
const botStats = new Map();
// options per client (e.g., noBots)
const clientOptions = new Map();
let allowBots = true; // if false, do not spawn bots in ensureMinPlayers
// recent kills buffer (kept short)
const recentKills = [];

function recomputeAllowBots(){
  // Disable bots if any connected human requests online mode or noBots
  for (const [id, opts] of clientOptions.entries()){
    const pl = players.get(id);
    if (pl && !pl.isBot && opts){
      if (opts.noBots || opts.mode === 'online') {
        // disable bots and remove any existing bot players
        allowBots = false;
        for (const [pid, pp] of players.entries()){
          if (pp.isBot) players.delete(pid);
        }
        return;
      }
    }
  }
  // if we reach here, bots are allowed
  const was = allowBots;
  allowBots = true;
  // no-op when already allowed; if we changed from false->true, ensure min players
  if (!was && allowBots) ensureMinPlayers();
}

let obstacles = [
  { x: 700, y: 400, w: 200, h: 50 },
  { x: 300, y: 1200, w: 50, h: 300 },
  { x: 1100, y: 900, w: 300, h: 50 },
  { x: 1500, y: 400, w: 60, h: 400 }
];

// spawn points will be computed from current MAP_W / MAP_H
let spawnPoints = [];

function computeSpawnPoints(){
  const margin = Math.min(200, Math.floor(Math.min(MAP_W, MAP_H) * 0.1));
  spawnPoints = [
    { x: margin, y: margin },
    { x: MAP_W - margin, y: margin },
    { x: margin, y: MAP_H - margin },
    { x: MAP_W - margin, y: MAP_H - margin },
    { x: Math.floor(MAP_W/2), y: margin },
    { x: Math.floor(MAP_W/2), y: MAP_H - margin },
    { x: margin, y: Math.floor(MAP_H/2) },
    { x: MAP_W - margin, y: Math.floor(MAP_H/2) }
  ];
}
computeSpawnPoints();

function setMapSize(label){
  // Accepts 'small','medium','large' or numeric value
  const mapSizes = { small: 1000, medium: 2000, large: 3000 };
  if (typeof label === 'string' && mapSizes[label]){
    MAP_W = mapSizes[label]; MAP_H = mapSizes[label];
  } else if (typeof label === 'number'){
    MAP_W = Math.max(600, Math.floor(label)); MAP_H = Math.max(600, Math.floor(label));
  }
  computeSpawnPoints();
  console.log('Map size set to', MAP_W, MAP_H);
}

function getSpawnPosition(){
  // try spawn points first, pick one with enough distance from other players and not inside obstacle
  const MIN_DIST = 120;
  const shuffled = spawnPoints.slice().sort(()=>Math.random()-0.5);
  for (const sp of shuffled){
    let ok = true;
    for (const p of players.values()){
      if (Math.hypot(p.x - sp.x, p.y - sp.y) < MIN_DIST) { ok = false; break; }
    }
    if (!ok) continue;
    let bad = false;
    for (const ob of obstacles){ if (pointInRect(sp.x, sp.y, ob)) { bad = true; break; } }
    if (bad) continue;
    return { x: sp.x, y: sp.y };
  }
  // fallback: random position not inside obstacle
  for (let i=0;i<20;i++){
    const rx = Math.random() * MAP_W; const ry = Math.random() * MAP_H;
    let bad = false;
    for (const ob of obstacles){ if (pointInRect(rx, ry, ob)) { bad = true; break; } }
    if (bad) continue;
    return { x: rx, y: ry };
  }
  return { x: Math.random() * MAP_W, y: Math.random() * MAP_H };
}

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
    cooldowns: { special:0, slide:0, jump:0, build:0, shoot:0 },
    weapon: isBot ? (Math.random()<0.7? 'smg' : 'sniper') : 'smg',
    costume: 'default'
  };
  p.team = null; // team id (0 or 1) when teamMatch active
  p.coins = isBot ? 0 : 50; // starting coins for humans
  if (isBot) p.botStats = { shots:0, hits:0, kills:0 };
  // bot targeting state
  if (isBot){ p.currentTargetId = null; p.targetSince = 0; }
  players.set(id, p);
  return p;
}

function spawnBot() {
  const bot = createPlayer(true);
  // assign team if teamMatch enabled
  if (match.teamMatch) assignTeamToPlayer(bot);
  console.log('spawn bot', bot.id, 'team=', bot.team);
  return bot;
}

function assignTeamToPlayer(p){
  // balance team sizes (humans+bots)
  const counts = [0,0];
  for (const pl of players.values()){
    if (pl.team === 0) counts[0]++; else if (pl.team === 1) counts[1]++;
  }
  // choose smaller team (or random if equal)
  if (counts[0] <= counts[1]) p.team = 0; else p.team = 1;
}

function assignTeams(){
  // assign all players to teams balancing humans and bots
  const arr = Array.from(players.values());
  // reset counts
  let c0 = 0, c1 = 0;
  for (const p of arr){
    if (p.team === null) {
      if (c0 <= c1){ p.team = 0; c0++; } else { p.team = 1; c1++; }
    } else {
      if (p.team === 0) c0++; else c1++;
    }
  }
}

function ensureMinPlayers() {
  // Ensure at least MIN_PLAYERS *alive* participants by spawning bots as needed.
  // respect client option to disable bots, and do not auto-spawn bots during an active round
  if (!allowBots) return;
  if (match.inRound) return;
  let alive = Array.from(players.values()).filter(p => p.hp > 0).length;
  while (alive < MIN_PLAYERS) {
    spawnBot();
    alive += 1;
  }
}

function startRoundIfNeeded() {
  if (match.inRound) return;
  // ensure bots are present if allowed
  ensureMinPlayers();
  // determine whether we can start: if bots allowed require MIN_PLAYERS total alive, otherwise require at least 2 humans
  const humanCount = Array.from(players.values()).filter(p => !p.isBot).length;
  let canStart = false;
  if (allowBots) {
    const alive = Array.from(players.values()).filter(p => p.hp > 0).length;
    if (alive >= MIN_PLAYERS) canStart = true;
  } else {
    if (humanCount >= 2) canStart = true;
  }
  if (!canStart) return;

  // revive/reset all players for new round
  for (const p of players.values()){
    p.hp = p.maxHp || 100;
    p.spectator = false;
    p.vx = 0; p.vy = 0;
    p.x = Math.random() * MAP_W;
    p.y = Math.random() * MAP_H;
    p.score = 0;
  }
  // if team match enabled, assign teams now
  if (match.teamMatch) assignTeams();
  // initialize flags if flagHill mode
  if (match.mode === 'flagHill' && (!match.flags || match.flags.length === 0)){
    match.flags = [
      { id: 'f1', x: MAP_W*0.5, y: MAP_H*0.25, ownerTeam: null, captureTeam: null, captureTimer: 0 },
      { id: 'f2', x: MAP_W*0.25, y: MAP_H*0.75, ownerTeam: null, captureTeam: null, captureTimer: 0 },
      { id: 'f3', x: MAP_W*0.75, y: MAP_H*0.75, ownerTeam: null, captureTeam: null, captureTimer: 0 }
    ];
    match.allFlagsHoldTimer = [0,0];
    match.roundWinnerTeam = null;
  }
  // clear bullets and temporary obstacles
  bullets.clear();
  obstacles = obstacles.filter(o=>!o.owner);

  match.inRound = true;
  match.roundWinner = null;
  match.initialPlayers = Array.from(players.values()).filter(p=>p.hp>0).map(p=>p.id);
  // targetKills is 9 or the number of other players if fewer
  match.targetKills = 1
  // reset scores for all players at start
  for (const p of players.values()) p.score = 0;
  console.log('Round started, targetKills=', match.targetKills, 'players=', match.initialPlayers.length);
}

function endRound(winnerId){
  if (!match.inRound) return;
  match.inRound = false;
  match.roundWinner = winnerId || null;
  // if team victory, set roundWinnerTeam already set by logic
  console.log('Round ended. winner=', match.roundWinner);
  // mark everyone as spectator so they stop playing until home/next round
  for (const p of players.values()){
    p.spectator = true;
    p.vx = 0; p.vy = 0;
  }
  // schedule next round after a short delay (5s)
  if (match.nextRoundTimeout) clearTimeout(match.nextRoundTimeout);
  match.roundTimeLeft = 5; // inform clients of 5s countdown
  match.nextRoundTimeout = setTimeout(()=>{
    // prepare players and start next round
    // revive players and reset HP/position/score
    for (const p of players.values()){
      p.hp = p.maxHp || 100;
      p.spectator = false;
      p.vx = 0; p.vy = 0;
      const sp = getSpawnPosition();
      p.x = sp.x; p.y = sp.y;
      p.score = 0;
    }
    // clear bullets
    bullets.clear();
    // optionally clear temporary obstacles (walls created by players)
    obstacles = obstacles.filter(o=>!o.owner);
    // ensure bots to fill up and then set up round
    ensureMinPlayers();
    // start new round
    match.roundWinner = null;
    match.currentRound = (match.currentRound || 0) + 1;
    match.inRound = true;
    match.initialPlayers = Array.from(players.values()).filter(p=>p.hp>0).map(p=>p.id);
    match.targetKills = 1;
    match.roundTimeLeft = 0;
    console.log('Next round started, targetKills=', match.targetKills, 'players=', match.initialPlayers.length);
    match.nextRoundTimeout = null;
  }, 5000);
}

function distance(a,b){
  const dx = a.x - b.x; const dy = a.y - b.y; return Math.hypot(dx,dy);
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function pointInRect(x,y,rect){
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function circleRectCollide(cx, cy, r, rect){
  // closest point on rect to circle center
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx*dx + dy*dy) <= (r*r);
}

// Bot AI: chase nearest enemy
function updateBots(dt){
  const arr = Array.from(players.values());
  const nowSec = Date.now()/1000;
  for (const bot of arr) {
    if (!bot.isBot || bot.hp<=0) continue;
    // if previously targeted player is gone, clear target
    if (bot.currentTargetId){
      const prev = players.get(bot.currentTargetId);
      if (!prev || prev.hp <= 0) { bot.currentTargetId = null; bot.targetSince = 0; }
    }
    // determine if we should temporarily exclude the long-targeted player
    let excludeId = null;
    if (bot.currentTargetId && bot.targetSince && (nowSec - bot.targetSince) > 60){
      const prev = players.get(bot.currentTargetId);
      // only exclude if the target is still alive (not killed)
      if (prev && prev.hp > 0){ excludeId = bot.currentTargetId; }
    }
    // find nearest other (alive) that is not on same team; try excluding the old target when applicable
    let nearest = null; let nd = Infinity;
    for (const other of arr) {
      if (other.id === bot.id) continue;
      // skip excludeId if set (forces change of target)
      if (excludeId && other.id === excludeId) continue;
      // skip dead or spectators
      if (other.hp<=0 || other.spectator) continue;
      // skip teammates when teamMatch
      if (match.teamMatch && bot.team !== null && other.team === bot.team) continue;
      const d = distance(bot, other);
      if (d < nd) { nd = d; nearest = other; }
    }
    // if we couldn't find any when excluding, fall back to allowing previous target (if any)
    if (!nearest && excludeId){
      for (const other of arr) {
        if (other.id === bot.id) continue;
        if (other.hp<=0 || other.spectator) continue;
        if (match.teamMatch && bot.team !== null && other.team === bot.team) continue;
        const d = distance(bot, other);
        if (d < nd) { nd = d; nearest = other; }
      }
    }
    if (nearest) {
      // if target changed, reset timer
      if (bot.currentTargetId !== nearest.id){ bot.currentTargetId = nearest.id; bot.targetSince = nowSec; }
      // set velocity toward nearest
      const dx = nearest.x - bot.x;
      const dy = nearest.y - bot.y;
      const len = Math.hypot(dx,dy) || 1;
      const nx = dx/len; const ny = dy/len;
      // simple movement with obstacle avoidance (try small angle offsets)
      const tryOffsets = [0, 0.35, -0.35, 0.75, -0.75, 1.4, -1.4];
      let chosen = null;
      for (const offs of tryOffsets){
        const ang = Math.atan2(ny, nx) + offs;
        const tx = Math.cos(ang);
        const ty = Math.sin(ang);
        // simulate a short step to check collision
        const step = Math.min(60, bot.speed * dt * 2 || 30);
        const nxpos = bot.x + tx * step;
        const nypos = bot.y + ty * step;
        // check collision with obstacles (point-in-rect)
        let coll = false;
        for (const ob of obstacles){
          if (nxpos > ob.x && nxpos < ob.x + ob.w && nypos > ob.y && nypos < ob.y + ob.h){ coll = true; break; }
        }
        if (!coll){ chosen = {tx,ty,ang}; break; }
      }
      if (chosen){
        bot.vx = chosen.tx * bot.speed;
        bot.vy = chosen.ty * bot.speed;
        bot.angle = chosen.ang;
      } else {
        // cannot avoid, stop
        bot.vx = 0; bot.vy = 0;
      }
      // shooting according to weapon and cooldown
      if (bot.cooldowns && (bot.cooldowns.shoot || 0) <= 0) {
        // fire
        shootBullet(bot, nx, ny);
        // set shoot cooldown from weapon
        bot.cooldowns.shoot = (bot.weapon === 'sniper') ? 1.2 : 0.12;
      }
      // occasionally use special if close
      if (nd < 350 && bot.cooldowns && bot.cooldowns.special <= 0 && Math.random() < 0.03){
        shootSpecial(bot, nx, ny);
        bot.cooldowns.special = 5.0;      
      }
      // sometimes build a wall between bot and target
      if (bot.cooldowns && bot.cooldowns.build <= 0 && Math.random() < 0.01){
        const wx = bot.x + nx * 60;
        const wy = bot.y + ny * 60;
        const wall = { id: `w${Date.now()}${Math.floor(Math.random()*999)}`, x: wx - 30, y: wy - 10, w: 60, h: 20, owner: bot.id, life: 15 };
        obstacles.push(wall);
        bot.cooldowns.build = 6.0;
      }
      // jump occasionally
      if (bot.cooldowns && bot.cooldowns.jump <= 0 && Math.random() < 0.02){ bot.jumping = 0.7; bot.cooldowns.jump = 3.0; }
      // slide occasionally
      if (bot.cooldowns && bot.cooldowns.slide <= 0 && Math.random() < 0.03){ bot.sliding = 0.6; bot.cooldowns.slide = 2.0; }
    } else {
      // wander
      if (Math.random() < 0.02) {
        bot.vx = (Math.random()*2-1) * bot.speed;
        bot.vy = (Math.random()*2-1) * bot.speed;
      }
    }
  }
}

function shootBullet(player, nx, ny, opts = {}) {
  const params = {
    speed: opts.speed || (player.weapon === 'sniper' ? 1400 : 700),
    power: opts.power || (player.weapon === 'sniper' ? 100 : 15),
    life: opts.life || (player.weapon === 'sniper' ? 2.5 : 1.2),
    type: opts.type || 'bullet'
  };
  // reduce bot bullet power to make CPUs less lethal
  if (player.isBot){
    params.power = params.power * 0.45; // bots deal ~45% damage
  }
  const id = (nextBulletId++).toString();
  bullets.set(id, {
    id,
    x: player.x + nx*20,
    y: player.y + ny*20,
    vx: nx * params.speed,
    vy: ny * params.speed,
    owner: player.id,
    life: params.life,
    power: params.power,
    type: params.type
  });
  // record bot shot
  if (player.isBot && player.botStats) player.botStats.shots += 1;
}

// special shot variant
function shootSpecial(player, nx, ny){
  shootBullet(player, nx, ny, { speed: 900, power: 70, life: 2.0, type: 'special' });
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
      p.cooldowns.shoot = Math.max(0, (p.cooldowns.shoot || 0) - dt);
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
      // If client provides moveVec (direction from player to cursor), use it to orient movement
      if (inpt.moveVec && typeof inpt.moveVec.x === 'number' && typeof inpt.moveVec.y === 'number'){
        const mvx = inpt.moveVec.x; const mvy = inpt.moveVec.y;
        // forward/back and right/left inputs modulate movement along and across mv
        const forward = (inpt.up ? 1 : 0) - (inpt.down ? 1 : 0);
        const right = (inpt.right ? 1 : 0) - (inpt.left ? 1 : 0);
        // perpendicular (right) vector to mv: (-mvy, mvx)
        const px = -mvy; const py = mvx;
        vx = mvx * forward + px * right;
        vy = mvy * forward + py * right;
      } else {
        if (inpt.up) vy -= 1;
        if (inpt.down) vy += 1;
        if (inpt.left) vx -= 1;
        if (inpt.right) vx += 1;
      }
      const vlen = Math.hypot(vx, vy);
      let spd = p.speed;
      if (p.sliding && p.sliding > 0) spd *= 1.9;
      if (vlen > 0.0001){
        p.vx = (vx / vlen) * spd;
        p.vy = (vy / vlen) * spd;
      } else {
        p.vx = 0; p.vy = 0;
      }
      // angle towards mouse
      const mx = inpt.mx, my = inpt.my;
      if (mx!==undefined && my!==undefined) {
        p.angle = Math.atan2(my - (p.y), mx - (p.x));
      }
      if (inpt.shoot && p.cooldowns && (p.cooldowns.shoot || 0) <= 0) {
        // shoot towards angle according to weapon fire rate
        const nx = Math.cos(p.angle);
        const ny = Math.sin(p.angle);
        shootBullet(p, nx, ny);
        p.cooldowns.shoot = (p.weapon === 'sniper') ? 1.2 : 0.12;
      }
    }
    // apply velocity; if jumping, allow bypassing obstacles
    const radius = 12;
    if (p.jumping && p.jumping > 0) {
      // jumping players pass through obstacles
      p.x = clamp(p.x + p.vx * dt, 0, MAP_W);
      p.y = clamp(p.y + p.vy * dt, 0, MAP_H);
    } else {
      // attempt X move with collision
      const nextX = p.x + p.vx * dt;
      let collideX = false;
      for (const ob of obstacles){
        if (pointInRect(nextX, p.y, ob)) { collideX = true; break; }
        if (circleRectCollide(nextX, p.y, radius, ob)) { collideX = true; break; }
      }
      if (!collideX) p.x = clamp(nextX, 0, MAP_W);
      else p.vx = 0;
      // attempt Y move with collision
      const nextY = p.y + p.vy * dt;
      let collideY = false;
      for (const ob of obstacles){
        if (pointInRect(p.x, nextY, ob)) { collideY = true; break; }
        if (circleRectCollide(p.x, nextY, radius, ob)) { collideY = true; break; }
      }
      if (!collideY) p.y = clamp(nextY, 0, MAP_H);
      else p.vy = 0;
    }
  }

  // update bullets
  for (const [id, b] of bullets){
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) { bullets.delete(id); continue; }
    // bullet collision with obstacles (point-in-rect)
    let hitObstacle = false;
    for (const ob of obstacles){
      if (b.x > ob.x && b.x < ob.x + ob.w && b.y > ob.y && b.y < ob.y + ob.h){
        bullets.delete(id); hitObstacle = true; break;
      }
    }
    if (hitObstacle) continue;
    // collision with players
    for (const p of players.values()){
      if (p.hp<=0) continue;
      if (p.id === b.owner) continue;
      // friendly fire: ignore if same team (when team info exists)
      const ownerP = players.get(b.owner);
      if (ownerP && match.teamMatch && ownerP.team !== null && p.team === ownerP.team){
        // bullet passes through teammate
        continue;
      }
      // if target is jumping (short invul), ignore
      if (p.jumping && p.jumping > 0) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d < 20){
        const dmg = b.power || 30;
        p.hp -= dmg;
        if (p.hp <= 0) {
          p.hp = 0;
              const owner = players.get(b.owner);
            if (owner) {
              owner.score += 1;
                // record kill event (timestamp ms)
                const ev = { victim: p.id, victimName: p.name, killer: owner.id, killerName: owner.name, t: Date.now() };
                recentKills.push(ev);
                // trim old kills (keep last 20)
                if (recentKills.length > 40) recentKills.splice(0, recentKills.length - 40);
                // compute current alive count and store in match
                const aliveCountNow = Array.from(players.values()).filter(x=>x.hp>0).length;
                match.aliveCount = aliveCountNow;
                // if team match, compute per-team alive counts and decide winner when one team is wiped
                if (match.teamMatch){
                  let blueAlive = 0, redAlive = 0;
                  for (const pl of players.values()){
                    if (pl.hp>0 && !pl.spectator){
                      if (pl.team === 0) blueAlive++; else if (pl.team === 1) redAlive++;
                    }
                  }
                  match.blueTeamAliveCount = blueAlive;
                  match.redTeamAliveCount = redAlive;
                  if (match.inRound && !match.roundWinnerTeam){
                    if (blueAlive === 0 && redAlive > 0){
                      match.roundWinnerTeam = 1; // red wins
                      endRound(null);
                    } else if (redAlive === 0 && blueAlive > 0){
                      match.roundWinnerTeam = 0; // blue wins
                      endRound(null);
                    }
                  }
                } else {
                  // New win condition for free-for-all: aliveCount < 2 AND owner is present and alive
                  if (match.inRound && !match.roundWinner && match.aliveCount < 2 && players.has(owner.id) && owner.hp > 0){
                    endRound(owner.id);
                  }
                }
            }
          // respawn after a short delay handled below
        }
        bullets.delete(id);
        break;
      }
    }
  }

  // No respawn: players with hp<=0 become permanent spectators until server restart
  for (const p of players.values()){
    if (p.hp<=0){
      p.spectator = true;
      p.vx = 0; p.vy = 0;
    }
  }

  // update obstacle lifetimes
  obstacles = obstacles.filter(o=>{
    if (!o.life) return true;
    o.life -= dt;
    return o.life > 0;
  });

  // flag hill mode: capture logic and all-flags hold timer
  if (match.mode === 'flagHill'){
    // for each flag, check presence of teams in radius
    for (const flag of match.flags){
      let teamsPresent = new Set();
      for (const p of players.values()){
        if (p.hp<=0 || p.spectator) continue;
        if (!p.team && p.team !== 0) continue;
        const d = Math.hypot(p.x - flag.x, p.y - flag.y);
        if (d <= match.flagRadius){ teamsPresent.add(p.team); }
      }
      if (teamsPresent.size === 1){
        const team = Array.from(teamsPresent)[0];
        if (flag.ownerTeam === team){
          // already owned
          flag.captureTeam = null; flag.captureTimer = 0;
        } else {
          // attempt capture
          if (flag.captureTeam === team){
            flag.captureTimer += dt;
            if (flag.captureTimer >= match.flagCaptureTime){
              flag.ownerTeam = team;
              flag.captureTeam = null; flag.captureTimer = 0;
            }
          } else {
            flag.captureTeam = team; flag.captureTimer = dt;
          }
        }
      } else {
        // contested or empty
        flag.captureTeam = null; flag.captureTimer = 0;
      }
    }
    // check if a team holds all flags
    for (let t=0;t<2;t++){
      const allOwned = match.flags.every(f => f.ownerTeam === t);
      if (allOwned){ match.allFlagsHoldTimer[t] += dt; } else { match.allFlagsHoldTimer[t] = 0; }
      // if held >= 180 sec, end round with team victory
      if (match.allFlagsHoldTimer[t] >= 180 && match.inRound){
        match.roundWinnerTeam = t;
        // end round indicating team win
        endRound(null);
      }
    }
  }

  // update inter-round countdown timer if any
  if (!match.inRound && match.roundTimeLeft && match.roundTimeLeft > 0){
    match.roundTimeLeft = Math.max(0, match.roundTimeLeft - dt);
  }

  // ensure min players
  ensureMinPlayers();
}

// Connections
wss.on('connection', function connection(ws) {
  // create a player and bind socket to that player's id
  const player = createPlayer(false);
  if (match.teamMatch) assignTeamToPlayer(player);
  const clientId = player.id;
  sockets.set(clientId, ws);

  ws.send(JSON.stringify({ type:'init', id: clientId, map:{w:MAP_W,h:MAP_H}, obstacles }));

  // attempt to fill bots immediately and then start a round if we have enough players
  ensureMinPlayers();
  startRoundIfNeeded();

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
        if (p){
          if (typeof data.name === 'string') p.name = data.name.substring(0, 32);
          if (typeof data.weapon === 'string') p.weapon = (data.weapon === 'sniper') ? 'sniper' : 'smg';
          if (typeof data.costume === 'string') p.costume = data.costume.substring(0, 32);
        }
      } else if (data.type === 'setWeapon'){
        const p = players.get(clientId);
        if (p && typeof data.weapon === 'string'){
          // allow 'knife', 'smg', 'sniper' as valid values
          const w = data.weapon;
          if (w === 'knife' || w === 'smg' || w === 'sniper') p.weapon = w;
        }
      } else if (data.type === 'setOptions'){
        // store client options like { noBots: true }
        clientOptions.set(clientId, data.options || {});
        // recompute allowBots using centralized logic (online mode or noBots disables bots)
        recomputeAllowBots();
        // team match and mode handling: take global decision from any client request
        const opts = data.options || {};
        if (typeof opts.teamMatch === 'boolean'){
          match.teamMatch = !!opts.teamMatch;
          if (match.teamMatch) assignTeams();
        }
        if (typeof opts.mode === 'string'){
          if (opts.mode === 'flagHill'){
            match.mode = 'flagHill';
            match.teamMatch = true; // flag hill requires teams
            assignTeams();
          } else {
            match.mode = 'deathmatch';
          }
        }
        // map size requested by client (e.g., 'small'|'medium'|'large' or numeric)
        if (opts.mapSize !== undefined){
          try {
            setMapSize(opts.mapSize);
          } catch (e){ console.log('setMapSize error', e); }
        }
      }
      // purchase via websocket
      if (data.type === 'purchase'){
        const p = players.get(clientId);
        const item = data.item;
        const prices = { sniper: 150, smg: 0, knife: 0 };
        const cost = prices[item] || 0;
        if (p){
          if ((p.coins || 0) >= cost){
            p.coins = (p.coins || 0) - cost;
            // apply purchase (weapon)
            if (item === 'sniper' || item === 'smg' || item === 'knife') p.weapon = item;
            // ack
            try{ ws.send(JSON.stringify({ type:'purchaseResult', success:true, item, coins: p.coins })); }catch(e){}
          } else {
            try{ ws.send(JSON.stringify({ type:'purchaseResult', success:false, item, reason:'not_enough_coins', coins: p.coins || 0 })); }catch(e){}
          }
        }
      }
      // upload costume via websocket (dataURL)
      if (data.type === 'uploadCostume'){
        const p = players.get(clientId);
        const dataUrl = data.data;
        if (p && typeof dataUrl === 'string' && dataUrl.indexOf('data:') === 0){
          try{
            // parse base64
            const matches = dataUrl.match(/^data:(image\/png|image\/(jpeg|jpg));base64,(.+)$/);
            if (matches){
              const ext = (matches[1].indexOf('png')>=0) ? 'png' : 'jpg';
              const b64 = matches[3];
              const buf = Buffer.from(b64, 'base64');
              const fname = `c_${clientId}_${Date.now()}.${ext}`;
              const outPath = path.join(__dirname, 'public', 'uploads', fname);
              fs.writeFileSync(outPath, buf);
              // set player's costume to URL path
              p.costume = `/uploads/${fname}`;
              try{ ws.send(JSON.stringify({ type:'uploadResult', success:true, path: p.costume })); }catch(e){}
            } else {
              try{ ws.send(JSON.stringify({ type:'uploadResult', success:false, reason:'invalid_data' })); }catch(e){}
            }
          }catch(e){ try{ ws.send(JSON.stringify({ type:'uploadResult', success:false, reason:'save_error' })); }catch(e){} }
        }
      }
    } catch (e){}
  });

  ws.on('close', function(){
    sockets.delete(clientId);
    // remove player; if bots exceed MIN_PLAYERS after removal, we'll adjust in ensureMinPlayers
    players.delete(clientId);
    clientOptions.delete(clientId);
    // recompute allowBots when a client disconnects
    recomputeAllowBots();
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
  const playersArr = Array.from(players.values());
  const snapshot = {
    type: 'snapshot',
    t: Date.now(),
    players: playersArr.map(p=>({ id:p.id, x:p.x, y:p.y, hp:p.hp, score:p.score, angle:p.angle, isBot:p.isBot, spectator: !!p.spectator, name: p.name, jumping: !!p.jumping, sliding: !!p.sliding, weapon: p.weapon, costume: p.costume, coins: p.coins || 0 })),
    flags: match.flags || [],
    bullets: Array.from(bullets.values()).map(b=>({ id:b.id, x:b.x, y:b.y, type: b.type })),
    obstacles: obstacles.map(o=>({ id:o.id, x:o.x, y:o.y, w:o.w, h:o.h })),
    map: { w: MAP_W, h: MAP_H },
    match: {
      inRound: !!match.inRound,
      roundWinner: match.roundWinner,
      roundWinnerTeam: match.roundWinnerTeam,
      blueTeamAliveCount: match.blueTeamAliveCount || 0,
      redTeamAliveCount: match.redTeamAliveCount || 0,
      targetKills: match.targetKills,
      flagCaptureTime: match.flagCaptureTime,
      flagRadius: match.flagRadius,
      roundTimeLeft: match.roundTimeLeft || 0,
      playerCount: playersArr.length,
      aliveCount: playersArr.filter(p=>p.hp>0).length,
      humanCount: playersArr.filter(p=>!p.isBot).length,
      players: playersArr.map(p=>({ id:p.id, x:p.x, y:p.y, hp:p.hp, score:p.score, angle:p.angle, isBot:p.isBot, spectator: !!p.spectator, name: p.name, jumping: !!p.jumping, sliding: !!p.sliding, weapon: p.weapon, costume: p.costume, team: p.team })),
      kills: recentKills.slice(-20)
    }
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
