(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const info = document.getElementById('info');
  const scoreEl = document.getElementById('score');
  let W = window.innerWidth, H = window.innerHeight;
  canvas.width = W; canvas.height = H;

  window.addEventListener('resize', ()=>{ W = window.innerWidth; H = window.innerHeight; canvas.width = W; canvas.height = H; });

  let ws = null;
  let myId = null;
  let map = { w:2000, h:2000 };
  let obstacles = [];
  const state = { players: [], bullets: [] };
  const keys = { w:false,a:false,s:false,d:false };
  let mouse = { x:0,y:0, down:false };
  let showMap = false;

  // UI: home screen
  const home = document.getElementById('home');
  const btnCpu = document.getElementById('btnCpu');
  const btnOnline = document.getElementById('btnOnline');
  const gameModeSelect = document.getElementById('gameModeSelect');
  const playerNameInput = document.getElementById('playerName');
  const weaponSelect = document.getElementById('weaponSelect');
  const costumeSelect = document.getElementById('costumeSelect');
  const noBotsCheckbox = document.getElementById('noBotsCheckbox');
  const teamMatchCheckbox = document.getElementById('teamMatchCheckbox');
  const roundsCheckbox = document.getElementById('roundsCheckbox');
  const returnHomeBtn = document.getElementById('returnHomeBtn');
  let selectedMode = null; // 'cpu' or 'online'
  let playerName = '';
  let playerWeapon = 'smg';
  let playerCostume = 'default';
  let followId = null; // spectator follow target
  let currentWeaponSlot = 1; // 1 or 2

  let lastSend = 0;
  let prevRoundWinner = null;
  state.match = { inRound:false, roundWinner: null, targetKills: 9 };
  let winnerDisplayUntil = 0;
  let winnerNameLocal = '';
  let killedDisplayUntil = 0;
  let killedByNameLocal = '';
  let lastKillT = 0;
  const chatLog = document.getElementById('chatLog');
  // FPS meter
  let frameCount = 0; let fps = 0; let lastFpsTime = Date.now();

  function appendChatMessage(text){
    try{
      if (!chatLog) return;
      const el = document.createElement('div');
      el.textContent = text;
      el.style.padding = '4px 6px';
      el.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
      chatLog.appendChild(el);
      chatLog.scrollTop = chatLog.scrollHeight;
    }catch(e){}
  }

  canvas.addEventListener('mousemove', (e)=>{
    mouse.x = e.clientX; mouse.y = e.clientY;
  });
  canvas.addEventListener('mousedown', (e)=>{ mouse.down=true; });
  canvas.addEventListener('mouseup', (e)=>{ mouse.down=false; });

  window.addEventListener('keydown', (e)=>{ if (e.key==='w') keys.w=true; if (e.key==='s') keys.s=true; if (e.key==='a') keys.a=true; if (e.key==='d') keys.d=true; });
  window.addEventListener('keyup', (e)=>{ if (e.key==='w') keys.w=false; if (e.key==='s') keys.s=false; if (e.key==='a') keys.a=false; if (e.key==='d') keys.d=false; });

  function connect(mode){
    if (ws) try{ ws.close(); }catch(e){}
    ws = new WebSocket((location.protocol === 'https:'? 'wss://' : 'ws://') + location.host);
    selectedMode = mode;
    ws.onopen = ()=>{ info.textContent = 'Connected (' + (mode==='cpu'? 'CPU戦' : 'オンライン') +')'; };
    // send chosen player name right after open
    ws.addEventListener('open', ()=>{
      if (playerName) ws.send(JSON.stringify({ type:'setName', name: playerName, weapon: playerWeapon, costume: playerCostume }));
      // send options like noBots/team/rounds for online mode
      const noBots = !!(noBotsCheckbox && noBotsCheckbox.checked);
      const teamMatch = !!(teamMatchCheckbox && teamMatchCheckbox.checked);
        const rounds = !!(roundsCheckbox && roundsCheckbox.checked);
        const modeSelectVal = (gameModeSelect && gameModeSelect.value) ? gameModeSelect.value : 'deathmatch';
        ws.send(JSON.stringify({ type:'setOptions', options: { noBots, teamMatch, rounds, mode: modeSelectVal } }));
    });
    ws.onmessage = (msg)=>{
      try{
        const data = JSON.parse(msg.data);
        if (data.type === 'init'){
          myId = data.id; map = data.map; obstacles = data.obstacles || [];
        }
        if (data.type === 'snapshot'){
          // Update snapshot state: players, bullets, obstacles, match
          // Keep match.flags from server if provided (some servers send flags at top-level)
          state.players = data.players;
          state.bullets = data.bullets;
          if (data.match) {
            state.match = data.match;
          }
          // flags may be provided either in data.flags or data.match.flags; prefer match.flags
          if (data.match && data.match.flags) state.match.flags = data.match.flags;
          else if (data.flags) state.match.flags = data.flags;
          // if round ended, and we haven't processed it yet, show winner message (do NOT disconnect)
          if (data.match && data.match.roundWinner){
            const winnerId = data.match.roundWinner;
            if (prevRoundWinner !== winnerId){
              prevRoundWinner = winnerId;
              const w = (data.players || []).find(p=>p.id===winnerId);
              const winnerName = w ? (w.name || w.id) : winnerId;
              info.textContent = `ラウンド終了 - 勝者: ${winnerName} （次ラウンドへ移行します）`;
              // show winner prominently for 2 seconds before showing countdown
              winnerNameLocal = winnerName;
              winnerDisplayUntil = (Date.now()/1000) + 2;
            }
          }
          // dynamic obstacle updates
          if (data.obstacles) obstacles = data.obstacles;
          // process recent kills and show chat messages
          if (data.match && data.match.kills && Array.isArray(data.match.kills)){
            // sort by timestamp to process in order
            const sorted = data.match.kills.slice().sort((a,b)=>a.t - b.t);
            for (const k of sorted){
              if (!k.t) continue;
              if (k.t <= lastKillT) continue;
              lastKillT = Math.max(lastKillT, k.t);
              const vName = k.victimName || k.victim;
              const kName = k.killerName || k.killer;
              appendChatMessage(`${vName}が${kName}によってキルされました`);
              // if I'm the victim, show local killed overlay for 2 seconds
              if (myId && k.victim === myId){
                killedByNameLocal = kName;
                killedDisplayUntil = (Date.now()/1000) + 2;
              }
            }
          }
          // update our team id for UI
          const me = state.players.find(x=>x.id===myId);
          state.myTeam = (me && ('team' in me)) ? me.team : null;
        }
      }catch(e){}
    };
    ws.onclose = ()=>{ info.textContent = '切断されました'; };
  }

  function sendInput(){
    if (!myId || !ws || ws.readyState !== WebSocket.OPEN) return;
    // find my player to center view
    const p = state.players.find(x=>x.id===myId);
    const worldMouse = { x:0, y:0 };
    if (p){
      // screen center -> player
      const cx = W/2, cy = H/2;
      worldMouse.x = p.x + (mouse.x - cx);
      worldMouse.y = p.y + (mouse.y - cy);
    }
    const input = {
      up: keys.w,
      down: keys.s,
      left: keys.a,
      right: keys.d,
      shoot: mouse.down,
      mx: worldMouse.x,
      my: worldMouse.y,
      mode: selectedMode
      , special: keys.special || false
      , build: keys.build || false
      , buildAt: keys.buildAt || null
      , jump: keys.jump || false
      , slide: keys.slide || false
    };
    const payload = { type:'input', input };
    try{ ws.send(JSON.stringify(payload)); }catch(e){}
    // one-shot actions: clear build after send so it is not repeated
    keys.build = false; keys.buildAt = null;
  }

  // weapon slot switching: 1 = selected weapon (from dropdown), 2 = knife
  window.addEventListener('keydown', (e)=>{
    if (e.key === '1'){
      currentWeaponSlot = 1;
      playerWeapon = (weaponSelect && weaponSelect.value) ? weaponSelect.value : 'smg';
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'setWeapon', weapon: playerWeapon }));
    }
    if (e.key === '2'){
      currentWeaponSlot = 2;
      playerWeapon = 'knife';
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'setWeapon', weapon: 'knife' }));
    }
  });

  function draw(){
    // If tab is hidden, throttle rendering to save CPU
    if (document.hidden) { setTimeout(()=>{ requestAnimationFrame(draw); }, 500); return; }

    // === 1) clear screen ===
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0,0,W,H);

    // FPS counter (update once per 500ms)
    frameCount++;
    const nowMs = Date.now();
    if (nowMs - lastFpsTime >= 500){ fps = Math.round((frameCount*1000)/(nowMs - lastFpsTime)); frameCount = 0; lastFpsTime = nowMs; }

    const me = state.players.find(x=>x.id===myId) || { x:W/2, y:H/2 };
    // decide camera target: if spectator follow selected player
    let cameraTarget = me;
    if (me && me.spectator){
      // ensure followId exists
      if (!followId){
        const alive = state.players.filter(p=>!p.spectator && p.hp>0);
        if (alive.length) followId = alive[0].id;
      }
      const f = state.players.find(x=>x.id===followId);
      if (f) cameraTarget = f;
    }
    // camera translate so that cameraTarget is center
    const ox = W/2 - cameraTarget.x;
    const oy = H/2 - cameraTarget.y;

  // === 2) world transform: translate so cameraTarget is centered ===
  ctx.save();
  ctx.translate(ox, oy);

    // grid
    ctx.strokeStyle = '#102233'; ctx.lineWidth = 1;
    for (let gx=0; gx<map.w; gx+=200){ ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,map.h); ctx.stroke(); }
    for (let gy=0; gy<map.h; gy+=200){ ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(map.w,gy); ctx.stroke(); }

    // obstacles
    ctx.fillStyle = '#444';
    for (const ob of obstacles){ ctx.fillRect(ob.x, ob.y, ob.w, ob.h); }

    // bullets
    ctx.fillStyle = '#ffd700';
    for (const b of state.bullets){ ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI*2); ctx.fill(); }

    // players
    for (const p of state.players){
      const isMe = p.id === myId;
      // render spectator differently
      if (p.spectator) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle || 0);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath(); ctx.rect(-12, -12, 24, 24); ctx.fill();
        ctx.restore();
        // small spectator label
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '12px Arial';
        ctx.fillText('Spectator', p.x-20, p.y+26);
        continue;
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle || 0);
      // body color by team when teamMatch active
      let bodyColor = '#88ff88';
      if (state.match && state.match.playerCount && ('players' in state.match)){
        // team mode
        if (typeof p.team === 'number'){
          const myTeam = state.myTeam;
          const teamColors = ['#66ccff', '#ff6b6b'];
          if (myTeam !== null && myTeam !== undefined){
            bodyColor = (p.team === myTeam) ? teamColors[0] : teamColors[1];
          } else {
            // no local team known: color by team id
            bodyColor = (p.team === 0) ? teamColors[0] : teamColors[1];
          }
        } else {
          // fallback to costume/bot/own coloring
          if (p.costume === 'red') bodyColor = '#ff6b6b';
          else if (p.costume === 'blue') bodyColor = '#6b9cff';
          else if (p.isBot) bodyColor = '#aa66ff';
          else if (isMe) bodyColor = '#66ccff';
        }
      }
      ctx.fillStyle = bodyColor;
      ctx.beginPath(); ctx.rect(-12, -12, 24, 24); ctx.fill();
      // barrel
      ctx.fillStyle = '#222'; ctx.fillRect(0, -4, 20, 8);
      ctx.restore();

      // name
      if (p.name){
        ctx.fillStyle = '#fff'; ctx.font = '12px Arial';
        ctx.fillText(p.name, p.x - (p.name.length * 3), p.y - 36);
      }

      // hp bar
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x-20, p.y-28, 40, 6);
      ctx.fillStyle = '#0f0';
      const w = Math.max(0, (p.hp/ (p.maxHp || 100)) * 40);
      ctx.fillRect(p.x-20, p.y-28, w, 6);
    }
    // === 3) draw flags (if any) in world space ===
    try{
      if (state.match && state.match.flags && Array.isArray(state.match.flags)){
        const flagRadius = (state.match.flagRadius !== undefined) ? state.match.flagRadius : 72;
        for (const f of state.match.flags){
          const fx = f.x, fy = f.y;
          // outer capture radius (stroke)
          ctx.beginPath(); ctx.arc(fx, fy, flagRadius, 0, Math.PI*2);
          ctx.strokeStyle = 'rgba(200,200,200,0.08)'; ctx.lineWidth = 2; ctx.stroke();
          // flag base circle
          ctx.beginPath(); ctx.arc(fx, fy, 18, 0, Math.PI*2);
          const teamColors = ['#66ccff', '#ff6b6b'];
          if (f.ownerTeam === 0) ctx.fillStyle = teamColors[0];
          else if (f.ownerTeam === 1) ctx.fillStyle = teamColors[1];
          else ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fill();
          // capture progress arc just outside base
          if (f.captureTeam !== undefined && f.captureTeam !== null){
            const pct = Math.min(1, (f.captureTimer || 0) / (state.match.flagCaptureTime || 3));
            ctx.strokeStyle = (f.captureTeam === state.myTeam) ? '#66ccff' : '#ff6b6b';
            ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(fx, fy, 26, -Math.PI/2, -Math.PI/2 + Math.PI*2*pct); ctx.stroke();
          }
        }
      }
    }catch(e){}

    // restore world transform
    ctx.restore();

    // HUD
    const my = state.players.find(x=>x.id===myId);
    if (my){
      let txt = `ID: ${myId} ${my.isBot? '(bot?)':''} HP:${Math.round(my.hp)} `;
      if (my.spectator){
        const f = state.players.find(x=>x.id===followId);
        if (f) txt += ` | Following: ${f.name || f.id}`;
      }
      // remaining enemies (alive and not spectator) excluding self
      const alive = state.players.filter(p=>p.hp>0 && !p.spectator);
      const remaining = Math.max(0, alive.length - 1);
      txt += ` | 残り: ${remaining}`;
      info.textContent = txt;
      scoreEl.textContent = `Score: ${my.score || 0}`;
    }

    // Show return-to-home button when we are a spectator
    try {
      if (returnHomeBtn) {
        if (my && my.spectator) returnHomeBtn.style.display = 'block';
        else returnHomeBtn.style.display = 'none';
      }
    } catch(e){}

    // winner display (2s) then inter-round countdown overlay (center)
    try {
      const nowSec = Date.now()/1000;
      // if team winner present, show team winner overlay
      if (state.match && state.match.roundWinnerTeam !== undefined && state.match.roundWinnerTeam !== null){
        const team = state.match.roundWinnerTeam;
        const teamNames = ['あなたのチーム', '相手チーム'];
        const teamColors = ['#66ccff', '#ff6b6b'];
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        const bw = 480, bh = 140;
        ctx.fillRect((W-bw)/2, (H-bh)/2, bw, bh);
        ctx.fillStyle = teamColors[team] || '#fff'; ctx.font = '22px Arial'; ctx.textAlign='center';
        ctx.fillText('ラウンド勝者 (チーム)', W/2, (H-bh)/2 + 38);
        ctx.fillStyle = '#fff'; ctx.font = '48px Arial'; ctx.fillText(team === state.myTeam ? 'あなたのチーム' : '敵チーム', W/2, H/2 + 10);
        ctx.restore();
      } else if (winnerDisplayUntil && nowSec < winnerDisplayUntil){
        // show winner overlay
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        const bw = 480, bh = 140;
        ctx.fillRect((W-bw)/2, (H-bh)/2, bw, bh);
        ctx.fillStyle = '#ffd700'; ctx.font = '22px Arial'; ctx.textAlign='center';
        ctx.fillText('ラウンド勝者', W/2, (H-bh)/2 + 38);
        ctx.fillStyle = '#fff'; ctx.font = '48px Arial'; ctx.fillText(winnerNameLocal, W/2, H/2 + 10);
        ctx.restore();
      } else if (state.match && state.match.roundTimeLeft && state.match.roundTimeLeft > 0){
        const secs = Math.ceil(state.match.roundTimeLeft);
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        const bw = 360, bh = 120;
        ctx.fillRect((W-bw)/2, (H-bh)/2, bw, bh);
        ctx.fillStyle = '#fff'; ctx.font = '20px Arial'; ctx.textAlign='center';
        ctx.fillText('次のラウンド開始まで', W/2, (H-bh)/2 + 36);
        ctx.font = '64px Arial'; ctx.fillText(String(secs), W/2, H/2 + 22);
        ctx.restore();
      }
    } catch(e){}

    // show killed-by overlay for the local player (2s)
    try{
      const nowSec2 = Date.now()/1000;
      if (killedDisplayUntil && nowSec2 < killedDisplayUntil){
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        const bw = 420, bh = 80;
        ctx.fillRect((W-bw)/2, (H-bh)/2 + 120, bw, bh);
        ctx.fillStyle = '#ff6b6b'; ctx.font = '20px Arial'; ctx.textAlign='center';
        ctx.fillText(`あなたは ${killedByNameLocal} によってキルされました`, W/2, (H-bh)/2 + 160);
        ctx.restore();
      }
    }catch(e){}

    // === 5) draw FPS meter ===
    try{
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(8,8,72,28);
      ctx.fillStyle = '#fff'; ctx.font = '12px Arial'; ctx.textAlign = 'left'; ctx.fillText(`FPS: ${fps}`, 14, 26);
      ctx.restore();
    }catch(e){}

    drawMapOverlay();
    requestAnimationFrame(draw);
  }

  // overlay map rendering outside main world render
  function drawMapOverlay(){
    if (!showMap) return;
    // semi-transparent panel
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const pad = 20;
    const w = Math.min(W - pad*2, 600);
    const h = Math.min(H - pad*2, 600);
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    ctx.fillRect(x,y,w,h);
    // map content scaled to w,h
    const scaleX = w / map.w;
    const scaleY = h / map.h;
    // obstacles
    ctx.fillStyle = '#666';
    for (const ob of obstacles){ ctx.fillRect(x + ob.x*scaleX, y + ob.y*scaleY, ob.w*scaleX, ob.h*scaleY); }
    // players
    for (const p of state.players){
      const px = x + p.x*scaleX; const py = y + p.y*scaleY;
      ctx.fillStyle = p.isBot ? '#aa66ff' : (p.id===myId? '#66ccff' : '#88ff88');
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI*2); ctx.fill();
      if (p.spectator){ ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText('S', px+6, py+4); }
    }
    ctx.restore();
  }

  // small minimap always shown at top-right
  function drawMiniMap(){
    try{
      const mw = Math.min(200, Math.max(120, Math.floor(Math.min(W, H) * 0.18)));
      const mh = Math.min(200, Math.max(120, Math.floor(Math.min(W, H) * 0.18)));
      const pad = 12;
      const x = W - mw - pad;
      const y = pad;
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x,y,mw,mh);
      const sx = mw / map.w;
      const sy = mh / map.h;
      // draw obstacles
      ctx.fillStyle = '#666';
      for (const ob of obstacles){ ctx.fillRect(x + ob.x*sx, y + ob.y*sy, Math.max(1, ob.w*sx), Math.max(1, ob.h*sy)); }
      // draw bullets
      ctx.fillStyle = '#ffd700';
      for (const b of state.bullets){ const bx = x + b.x*sx; const by = y + b.y*sy; ctx.fillRect(bx-1, by-1, 2, 2); }
      // draw players
      for (const p of state.players){
        const px = x + p.x*sx; const py = y + p.y*sy;
        let miniColor = '#88ff88';
        if (typeof p.team === 'number'){
          const myTeam = state.myTeam;
          const teamColors = ['#66ccff', '#ff6b6b'];
          miniColor = (myTeam !== null && myTeam !== undefined) ? (p.team === myTeam ? teamColors[0] : teamColors[1]) : (p.team === 0 ? teamColors[0] : teamColors[1]);
        } else {
          miniColor = p.isBot ? '#aa66ff' : (p.id===myId ? '#66ccff' : '#88ff88');
        }
        ctx.fillStyle = miniColor;
        ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI*2); ctx.fill();
        if (p.spectator){ ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText('S', px+4, py+4); }
      }
      // border
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(x,y,mw,mh);
      ctx.restore();
    }catch(e){}
  }

  // toggle map view with 'm'
  window.addEventListener('keydown', (e)=>{
    if (e.key === 'm' || e.key === 'M'){
      showMap = !showMap;
    }
  });

  // action keys: special (q), build (e), jump (space), slide (Shift)
  window.addEventListener('keydown', (e)=>{
    if (e.key === 'q' || e.key === 'Q') keys.special = true;
    if (e.key === 'e' || e.key === 'E'){
      // build at mouse world position (one-shot)
      const p = state.players.find(x=>x.id===myId);
      if (p){ keys.build = true; keys.buildAt = { x: p.x + (mouse.x - W/2), y: p.y + (mouse.y - H/2) }; }
    }
    if (e.code === 'Space') keys.jump = true;
    if (e.key === 'Shift') keys.slide = true;
    // spectator follow cycle
    if (e.key === 'ArrowRight') cycleFollow(1);
    if (e.key === 'ArrowLeft') cycleFollow(-1);
  });
  window.addEventListener('keyup', (e)=>{
    if (e.key === 'q' || e.key === 'Q') keys.special = false;
    if (e.code === 'Space') keys.jump = false;
    if (e.key === 'Shift') keys.slide = false;
  });

  function cycleFollow(dir){
    const me = state.players.find(x=>x.id===myId);
    const alive = state.players.filter(p=>!p.spectator && p.hp>0);
    if (!alive.length) return;
    let idx = alive.findIndex(p=>p.id===followId);
    if (idx === -1) idx = 0;
    idx = (idx + dir + alive.length) % alive.length;
    followId = alive[idx].id;
  }

  // draw map overlay when showMap is true
  const origDraw = draw;

  // start drawing immediately (home overlay will hide when mode selected)
  requestAnimationFrame(draw);

  // input send loop (only transmits when connected)
  setInterval(()=>{ sendInput(); }, 50);

  // home button handlers
  btnCpu.addEventListener('click', ()=>{
    playerName = (playerNameInput && playerNameInput.value) ? playerNameInput.value : '';
    playerWeapon = (weaponSelect && weaponSelect.value) ? weaponSelect.value : 'smg';
    playerCostume = (costumeSelect && costumeSelect.value) ? costumeSelect.value : 'default';
    home.style.display = 'none';
    connect('cpu');
  });
  btnOnline.addEventListener('click', ()=>{
    playerName = (playerNameInput && playerNameInput.value) ? playerNameInput.value : '';
    playerWeapon = (weaponSelect && weaponSelect.value) ? weaponSelect.value : 'smg';
    playerCostume = (costumeSelect && costumeSelect.value) ? costumeSelect.value : 'default';
    home.style.display = 'none';
    connect('online');
  });

  // return-to-home button handler (for spectators)
  if (returnHomeBtn) {
    returnHomeBtn.addEventListener('click', ()=>{
      // show home overlay so player can choose mode and rejoin
      home.style.display = 'flex';
      // close current connection if any (this will remove the old player on server)
      try{ if (ws) ws.close(); }catch(e){}
      ws = null;
      // reset local state so UI doesn't show stale players
      state.players = [];
      state.bullets = [];
      followId = null;
      info.textContent = 'ホームに戻りました';
      // hide the button until spectator state is detected again
      returnHomeBtn.style.display = 'none';
    });
  }
})();