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
  const playerNameInput = document.getElementById('playerName');
  let selectedMode = null; // 'cpu' or 'online'
  let playerName = '';

  let lastSend = 0;

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
      if (playerName) ws.send(JSON.stringify({ type:'setName', name: playerName }));
    });
    ws.onmessage = (msg)=>{
      try{
        const data = JSON.parse(msg.data);
        if (data.type === 'init'){
          myId = data.id; map = data.map; obstacles = data.obstacles || [];
        }
        if (data.type === 'snapshot'){
          state.players = data.players;
          state.bullets = data.bullets;
          // dynamic obstacle updates
          if (data.obstacles) obstacles = data.obstacles;
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

  function draw(){
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0,0,W,H);

    const me = state.players.find(x=>x.id===myId) || { x:W/2, y:H/2 };
    // camera translate so that me is center
    const ox = W/2 - me.x;
    const oy = H/2 - me.y;

    // draw map background grid
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
      // body
      ctx.fillStyle = p.isBot ? '#aa66ff' : (isMe? '#66ccff' : '#88ff88');
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

    ctx.restore();

    // HUD
    const my = state.players.find(x=>x.id===myId);
    if (my){ info.textContent = `ID: ${myId} ${my.isBot? '(bot?)':''} HP:${Math.round(my.hp)} `; scoreEl.textContent = `Score: ${my.score || 0}`; }

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
  });
  window.addEventListener('keyup', (e)=>{
    if (e.key === 'q' || e.key === 'Q') keys.special = false;
    if (e.code === 'Space') keys.jump = false;
    if (e.key === 'Shift') keys.slide = false;
  });

  // draw map overlay when showMap is true
  const origDraw = draw;

  // start drawing immediately (home overlay will hide when mode selected)
  requestAnimationFrame(draw);

  // input send loop (only transmits when connected)
  setInterval(()=>{ sendInput(); }, 50);

  // home button handlers
  btnCpu.addEventListener('click', ()=>{
    playerName = (playerNameInput && playerNameInput.value) ? playerNameInput.value : '';
    home.style.display = 'none';
    connect('cpu');
  });
  btnOnline.addEventListener('click', ()=>{
    playerName = (playerNameInput && playerNameInput.value) ? playerNameInput.value : '';
    home.style.display = 'none';
    connect('online');
  });
})();
