// 꽈당 아레나 — 서버 권한형 실시간 멀티플레이 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HTML_PATH = path.join(__dirname, 'public', 'index.html');

// ---- 게임 상수 ----
const TICK = 60, DT = 1 / TICK, SEND_EVERY = 2;
const ARENA_R0 = 420, ARENA_MIN = 150;
const SHRINK_DELAY = 6, SHRINK_TIME = 35;
const PR = 24, BIG_R = 40;
const ACC = 1500, FRICTION = 4;
const DASH_SPEED = 820, DASH_CD = 1.4, DASH_TIME = 0.22, DASH_STEPS = Math.round(DASH_CD * TICK);
const RESTITUTION = 1.25;
const MAX_PLAYERS = 8;
const COUNTDOWN = 3, ROUNDOVER = 4;
const MAX_INPUT_BUF = 12, TARGET_INPUT_BUF = 2; // 입력 버퍼: 12개(200ms) 넘게 밀리면 최근 2개만 남기고 건너뜀

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(HTML_PATH));
  } else if (req.url === '/stats') { // 접속자별 회선 기록 (실전 테스트 분석용)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(netLog));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });

let nextId = 1, time = 0, tickN = 0;
const players = new Map(); // id -> player
const netLog = []; // 접속자별 회선 기록, 최근 500줄
let phase = 'lobby', phaseT = 0, arenaR = ARENA_R0, roundT = 0;
let powerups = [], nextPowerAt = 5, nextPuId = 1;

function freeColor() {
  const used = new Set([...players.values()].map(p => p.color));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s);
}
function event(k, data) { broadcast({ t: 'e', k, ...data }); }

function placeRing(list) {
  const n = list.length, off = Math.random() * Math.PI * 2;
  list.forEach((p, i) => {
    const a = off + (i / n) * Math.PI * 2;
    resetBody(p, Math.cos(a) * 250, Math.sin(a) * 250);
    p.face = a + Math.PI;
  });
}
function resetBody(p, x, y) {
  Object.assign(p, { x, y, vx: 0, vy: 0, state: 0, fallT: 0, dashT: 0, dashCd: 0, bigT: 0, lastHitBy: 0, lastHitAt: -9 });
}
function spawnRandom(p) {
  const a = Math.random() * Math.PI * 2, d = Math.random() * arenaR * 0.5;
  resetBody(p, Math.cos(a) * d, Math.sin(a) * d);
}

function setPhase(ph) {
  phase = ph;
  if (ph === 'countdown') {
    phaseT = COUNTDOWN; arenaR = ARENA_R0; powerups = [];
    const list = [...players.values()];
    list.forEach(p => { p.inRound = true; });
    placeRing(list);
  } else if (ph === 'playing') {
    roundT = 0; nextPowerAt = 4;
  } else if (ph === 'roundover') {
    phaseT = ROUNDOVER;
  } else if (ph === 'lobby') {
    arenaR = ARENA_R0; powerups = [];
    for (const p of players.values()) { p.inRound = true; if (p.state !== 0) spawnRandom(p); }
  }
}

function radius(p) { return p.bigT > 0 ? BIG_R : PR; }
function mass(p) { return p.bigT > 0 ? 3 : 1; }

function step() {
  time += DT;
  const count = players.size;

  // ---- 페이즈 진행 ----
  if (phase === 'lobby') {
    if (count >= 2) setPhase('countdown');
  } else if (phase === 'countdown') {
    phaseT -= DT;
    if (count < 2) setPhase('lobby');
    else if (phaseT <= 0) setPhase('playing');
  } else if (phase === 'playing') {
    roundT += DT;
    if (roundT > SHRINK_DELAY) {
      const k = Math.min(1, (roundT - SHRINK_DELAY) / SHRINK_TIME);
      arenaR = ARENA_R0 - (ARENA_R0 - ARENA_MIN) * k;
    }
    // 파워업 생성
    if (roundT > nextPowerAt && powerups.length < 2) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * arenaR * 0.65;
      powerups.push({ i: nextPuId++, k: Math.random() < 0.5 ? 'big' : 'boom', x: Math.cos(a) * d, y: Math.sin(a) * d });
      nextPowerAt = roundT + 5 + Math.random() * 4;
    }
    const alive = [...players.values()].filter(p => p.inRound && p.state !== 2);
    if (alive.length <= 1) {
      const w = alive[0];
      if (w) { w.score++; event('win', { i: w.id, n: w.name }); }
      else event('win', { i: 0, n: '' });
      setPhase('roundover');
    }
  } else if (phase === 'roundover') {
    phaseT -= DT;
    if (phaseT <= 0) setPhase(count >= 2 ? 'countdown' : 'lobby');
  }

  // ---- 입력 버퍼 소비: 프레임 번호 순서대로 틱마다 정확히 1개 (Overwatch·Rocket League 방식) ----
  // 제때 안 온 번호는 '직전 키를 계속 누르고 있다'고 가정해 처리하고, 그 번호를 처리했다고 알린다 → 클라이언트 보정이 같은 프레임끼리 비교됨
  for (const p of players.values()) {
    if (!p.inq) continue;
    if (p.inq.size > MAX_INPUT_BUF) {
      const keep = [...p.inq.keys()].sort((a, b) => a - b).slice(-TARGET_INPUT_BUF);
      for (const k of p.inq.keys()) if (k < keep[0]) p.inq.delete(k);
      p.nextQ = keep[0];
    }
    const q = p.nextQ++, inp = p.inq.get(q);
    p.inq.delete(q);
    let dash = null;
    if (inp) { p.ix = inp.x; p.iy = inp.y; if (inp.d) dash = { q, x: inp.x, y: inp.y }; }
    if (!dash && p.lateDash) dash = p.lateDash; // 추정으로 이미 지나간 프레임에 있던 대시는 지금 반영
    p.lateDash = null;
    if (dash && (!p.lastDashQ || dash.q - p.lastDashQ >= DASH_STEPS)) {
      p.wantDash = true; p.dashQ = dash.q; p.dashX = dash.x; p.dashY = dash.y;
    }
    p.q = q; p.bf = p.inq.size;
    p.nsBf = (p.nsBf || 0) + p.bf; p.nsTicks = (p.nsTicks || 0) + 1; if (!inp) p.nsGuess = (p.nsGuess || 0) + 1;
  }

  const frozen = phase === 'countdown' || phase === 'roundover';
  const list = [...players.values()].filter(p => p.inRound && p.state !== 2);

  // ---- 이동 ----
  for (const p of list) {
    if (p.bigT > 0) p.bigT -= DT;
    if (p.dashCd > 0) p.dashCd -= DT;
    if (p.dashT > 0) p.dashT -= DT;
    if (p.state === 1) { // 떨어지는 중
      p.fallT += DT; p.x += p.vx * DT * 0.4; p.y += p.vy * DT * 0.4;
      if (p.fallT > 0.7) {
        if (phase === 'lobby') spawnRandom(p); else p.state = 2;
      }
      p.wantDash = false;
      continue;
    }
    if (!frozen) {
      let ix = p.ix, iy = p.iy;
      const l = Math.hypot(ix, iy);
      if (l > 1) { ix /= l; iy /= l; }
      p.vx += ix * ACC * DT; p.vy += iy * ACC * DT;
      if (l > 0.1) p.face = Math.atan2(iy, ix);
      // 번호 붙은 입력은 메시지 도착 순서대로 쿨타임을 판정해 둔 대시를 그 순간의 방향으로 실행 (실시간 쿨타임은 0.4초까지 봐줌)
      if (p.wantDash && p.dashCd <= (p.dashQ ? 0.4 : 0)) {
        let ddx = ix, ddy = iy, dl0 = l;
        if (p.dashQ) {
          p.lastDashQ = p.dashQ; ddx = p.dashX; ddy = p.dashY; dl0 = Math.hypot(ddx, ddy);
          if (dl0 > 1) { ddx /= dl0; ddy /= dl0; }
        }
        const dx = dl0 > 0.1 ? ddx / Math.min(1, dl0) : Math.cos(p.face);
        const dy = dl0 > 0.1 ? ddy / Math.min(1, dl0) : Math.sin(p.face);
        const dl = Math.hypot(dx, dy) || 1;
        p.vx = dx / dl * DASH_SPEED; p.vy = dy / dl * DASH_SPEED;
        p.dashT = DASH_TIME; p.dashCd = DASH_CD;
        event('dash', { i: p.id });
      }
    } else { p.vx *= 0.8; p.vy *= 0.8; }
    p.wantDash = false;
    const f = Math.exp(-FRICTION * DT);
    p.vx *= f; p.vy *= f;
    p.x += p.vx * DT; p.y += p.vy * DT;
  }

  // ---- 충돌 ----
  const solid = list.filter(p => p.state === 0);
  for (let a = 0; a < solid.length; a++) for (let b = a + 1; b < solid.length; b++) {
    const A = solid[a], B = solid[b];
    const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 0.01;
    const rs = radius(A) + radius(B);
    if (d >= rs) continue;
    const nx = dx / d, ny = dy / d, mA = mass(A), mB = mass(B);
    const ov = rs - d, tot = mA + mB;
    A.x -= nx * ov * mB / tot; A.y -= ny * ov * mB / tot;
    B.x += nx * ov * mA / tot; B.y += ny * ov * mA / tot;
    const vn = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
    if (vn >= 0) continue;
    const j = -(1 + RESTITUTION) * vn / (1 / mA + 1 / mB);
    A.vx -= j / mA * nx; A.vy -= j / mA * ny;
    B.vx += j / mB * nx; B.vy += j / mB * ny;
    // 대시 중이면 상대를 추가로 날려버림
    if (A.dashT > 0) { B.vx += nx * 420 / mB; B.vy += ny * 420 / mB; }
    if (B.dashT > 0) { A.vx -= nx * 420 / mA; A.vy -= ny * 420 / mA; }
    const force = Math.abs(vn);
    if (force > 60) {
      A.lastHitBy = B.id; A.lastHitAt = time;
      B.lastHitBy = A.id; B.lastHitAt = time;
      event('bump', { x: Math.round(A.x + nx * radius(A)), y: Math.round(A.y + ny * radius(A)), f: Math.round(force + (A.dashT > 0 || B.dashT > 0 ? 400 : 0)) });
    }
  }

  // ---- 파워업 획득 ----
  for (const p of solid) {
    for (let k = powerups.length - 1; k >= 0; k--) {
      const u = powerups[k];
      if (Math.hypot(u.x - p.x, u.y - p.y) > radius(p) + 18) continue;
      powerups.splice(k, 1);
      if (u.k === 'big') { p.bigT = 6; event('pick', { i: p.id, k: 'big' }); }
      else {
        event('boom', { x: Math.round(p.x), y: Math.round(p.y), i: p.id });
        for (const q of solid) {
          if (q === p) continue;
          const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
          if (d > 260) continue;
          const s = 1100 * (1 - d / 260) + 300;
          q.vx += dx / d * s / mass(q); q.vy += dy / d * s / mass(q);
          q.lastHitBy = p.id; q.lastHitAt = time;
        }
      }
    }
  }

  // ---- 링 아웃 판정 ----
  for (const p of solid) {
    if (Math.hypot(p.x, p.y) > arenaR) {
      p.state = 1; p.fallT = 0;
      const by = time - p.lastHitAt < 3 && players.get(p.lastHitBy) ? players.get(p.lastHitBy) : null;
      if (by && phase === 'playing') by.kos++;
      event('fall', { i: p.id, n: p.name, by: by ? by.id : 0, bn: by ? by.name : '', practice: phase === 'lobby' ? 1 : 0 });
    }
  }

  // ---- 상태 전송 ----
  if (++tickN % SEND_EVERY === 0) {
    broadcast({
      t: 's', tm: Math.round(performance.now()), ph: phase, pt: Math.max(0, Math.round(phaseT * 10) / 10), ar: Math.round(arenaR),
      p: [...players.values()].map(p => ({
        i: p.id, n: p.name, c: p.color, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), q: p.q, bf: p.bf,
        r: radius(p), s: p.inRound ? p.state : 2, f: Math.round(p.face * 100) / 100,
        d: p.dashT > 0 ? 1 : 0, cd: Math.max(0, Math.round(p.dashCd / DASH_CD * 100) / 100),
        sc: p.score, ko: p.kos, ft: Math.round(p.fallT * 100) / 100,
      })),
      u: powerups,
    });
  }
}
// 정확히 초당 60틱: 다음 틱 예정 시각 기준으로 돌리고, 밀리면 따라잡음 (0.25초 넘게 밀리면 포기하고 현재 시각부터)
let nextTickAt = performance.now();
(function loop() {
  const now = performance.now();
  if (now - nextTickAt > 250) nextTickAt = now;
  while (nextTickAt <= now) { step(); nextTickAt += 1000 / TICK; }
  setTimeout(loop, Math.max(0, nextTickAt - performance.now()));
})();

wss.on('connection', (ws) => {
  let me = null;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !me) {
      if (players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); return; }
      const name = String(m.name || '').trim().slice(0, 10) || '이름없음';
      me = { id: nextId++, name, color: freeColor(), score: 0, kos: 0, ix: 0, iy: 0, face: 0, q: 0, wantDash: false, inRound: phase === 'lobby' || phase === 'countdown' };
      spawnRandom(me);
      if (!me.inRound) me.state = 2;
      players.set(me.id, me);
      ws.send(JSON.stringify({ t: 'welcome', id: me.id }));
      event('join', { n: name });
    } else if (me && m.t === 'in') {
      const x = Math.max(-1, Math.min(1, +m.x || 0)), y = Math.max(-1, Math.min(1, +m.y || 0)), q = m.q | 0;
      if (!q) { // 번호 없는 입력(봇 등): 받는 즉시 반영
        me.ix = x; me.iy = y;
        if (m.d) { me.wantDash = true; me.dashQ = 0; }
        return;
      }
      const now = Date.now();
      if (me.nsLastIn) { const g = now - me.nsLastIn; if (g > 100) me.nsUpGaps = (me.nsUpGaps || 0) + 1; me.nsUpMax = Math.max(me.nsUpMax || 0, g); }
      me.nsLastIn = now;
      if (!me.inq) { me.inq = new Map(); me.nextQ = q; }
      if (q >= me.nextQ) me.inq.set(q, { x, y, d: m.d ? 1 : 0 });
      else { me.nsLate = (me.nsLate || 0) + 1; if (m.d) me.lateDash = { q, x, y }; }
    } else if (me && m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: m.c }));
    } else if (me && m.t === 'nst') { // 클라이언트가 10초마다 보내는 회선 상태 + 서버가 센 값 → 한 줄 기록
      const num = v => Math.max(0, Math.min(1e6, Math.round(+v || 0)));
      const line = {
        t: new Date().toISOString(), 이름: me.name, 인원: players.size,
        핑평균ms: num(m.ra), 핑최대ms: num(m.rm), 받기끊김: num(m.g), 받기최대끊김ms: num(m.m),
        보내기끊김: me.nsUpGaps || 0, 보내기최대끊김ms: me.nsUpMax || 0, 추정한프레임: me.nsGuess || 0, 늦은입력: me.nsLate || 0,
        서버버퍼평균: me.nsTicks ? Math.round(me.nsBf / me.nsTicks * 10) / 10 : null, 보간지연ms: num(m.d), fps: num(m.f),
      };
      netLog.push(line); if (netLog.length > 500) netLog.shift();
      console.log('NET ' + JSON.stringify(line));
      me.nsUpGaps = me.nsUpMax = me.nsGuess = me.nsLate = me.nsBf = me.nsTicks = 0;
    }
  });
  ws.on('close', () => {
    if (me) { players.delete(me.id); event('leave', { n: me.name }); }
  });
});

server.listen(PORT, () => console.log(`꽈당 아레나 서버 실행 중: http://localhost:${PORT}`));
