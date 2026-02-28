# Battle Area

Simple top-down 2D battle prototype with online play and CPU bots.

Features
- Top-down 2D view (HTML5 Canvas)
- Online play: one authoritative Node.js server using WebSocket
- CPU bots: server ensures at least 10 participants by spawning bots
- Simple bot AI: chase nearest alive enemy and occasionally shoot

Quick start
1. Install dependencies

```bash
cd /path/to/repo
npm install
```

2. Start server

```bash
npm start
```

3. Open multiple browsers at `http://localhost:3000` to join. If there are fewer than 10 human players, bots will be spawned to reach 10 participants.

Notes
- This is a minimal prototype intended as a starting point. You can extend it by adding authentication, lag-compensation, better physics, animations, sound, and matchmaking.
- Server is authoritative: all game state is computed on server.

Enjoy!
