// 꽈당 아레나 — 게임 계산 (방장 브라우저의 웹 워커에서 실행, 이동 함수는 내 화면 예측에서도 같이 씀)
(function (root) {
const TICK = 60, DT = 1 / TICK, SEND_EVERY = 2;
const ARENA_R0 = 420, ARENA_MIN = 150;
const SHRINK_DELAY = 6, SHRINK_TIME = 35;
const SUDDEN_DELAY = 8, SUDDEN_TIME = 12; // 서든데스: 최소 링에서 8초 지나면 12초 동안 0까지 줄어 라운드가 반드시 끝남
const PR = 24, BIG_R = 40;
const ACC = 1500, FRICTION = 4;
const DASH_SPEED = 820, DASH_CD = 1.4, DASH_TIME = 0.22, DASH_STEPS = Math.round(DASH_CD * TICK);
const RESTITUTION = 1.25;
const MAX_PLAYERS = 8;
const COUNTDOWN = 3, ROUNDOVER = 4;
const MAX_INPUT_BUF = 12, TARGET_INPUT_BUF = 2; // 입력 버퍼: 12개(200ms) 넘게 밀리면 최근 2개만 남기고 건너뜀

// ---- 필드(라운드마다 2개) ----
const ICE_R = 105, ICE_ACC = 0.35, ICE_FRICTION = 0.5;   // 빙판: 가속 35%, 마찰 1/8
const WIND_R = 120, WIND_F = 900, WIND_TURN = 4;          // 바람: 초당 900 가속, 4초마다 방향 바뀜
const BUMP_R = 28, BUMP_MIN = 650;                        // 범퍼 기둥: 닿으면 최소 650 속도로 튕김
const HOLE_R = 46;                                        // 낙하 구멍
// ---- 위험 요소(라운드마다 1~2개) ----
const MT_WARN = 1.5, MT_R = 95;                           // 운석: 경고 1.5초 후 반지름 95 충격
const SW_LEN = 300, SW_HALF = 9, SW_W = 1.0, SW_KICK = 380; // 회전 막대
const BOMB_T = 7;                                         // 폭탄: 7초 뒤 폭발
const QK_WARN = 1.2, QK_ON = 3, QK_F = 650;               // 지진: 경고 1.2초, 3초간 한쪽으로 쏠림
const CONF_T = 4;                                         // 혼란파: 4초간 방향키 반대
const FIELD_KINDS = ['ice', 'bump', 'wind', 'hole'], HAZARD_KINDS = ['meteor', 'sweep', 'bomb', 'quake'];
const THEMES = ['night', 'lava', 'space', 'snow']; // 판마다 바뀌는 테마(색·분위기). 로비는 밤 경기장

const clamp1 = v => Math.max(-1, Math.min(1, +v || 0));
const rnd = (a, b) => a + Math.random() * (b - a);
const r0 = v => Math.round(v), r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;
function radius(p) { return p.bigT > 0 ? BIG_R : PR; }
function mass(p) { return p.bigT > 0 ? 3 : 1; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 한 명의 한 틱 이동. 방장 계산과 내 화면 예측이 같은 함수를 써서 빙판·바람·지진·혼란·범퍼에서도 예측이 어긋나지 않게 한다.
// env = { frozen, map: { ice:[{x,y,r}], wind:[{x,y,r,a}], bump:[{x,y,r}] }, quake: 기울어진 방향(라디안) 또는 null }
// dashDir = 이번 틱에 대시하면 그 순간의 입력 {x,y}, 아니면 null. 반환: 부딪힌 범퍼 번호(없으면 -1)
function moveBody(p, ix, iy, dashDir, env, rad) {
  const map = env.map || {};
  const onIce = (map.ice || []).some(z => Math.hypot(p.x - z.x, p.y - z.y) < z.r);
  if (!env.frozen) {
    if (p.confT > 0) { ix = -ix; iy = -iy; }
    const l = Math.hypot(ix, iy);
    if (l > 1) { ix /= l; iy /= l; }
    const acc = onIce ? ACC * ICE_ACC : ACC;
    p.vx += ix * acc * DT; p.vy += iy * acc * DT;
    if (l > 0.1) p.face = Math.atan2(iy, ix);
    if (dashDir) {
      let ddx = dashDir.x, ddy = dashDir.y;
      if (p.confT > 0) { ddx = -ddx; ddy = -ddy; }
      const dl0 = Math.hypot(ddx, ddy);
      if (dl0 > 1) { ddx /= dl0; ddy /= dl0; }
      const dx = dl0 > 0.1 ? ddx / Math.min(1, dl0) : Math.cos(p.face);
      const dy = dl0 > 0.1 ? ddy / Math.min(1, dl0) : Math.sin(p.face);
      const dl = Math.hypot(dx, dy) || 1;
      p.vx = dx / dl * DASH_SPEED; p.vy = dy / dl * DASH_SPEED;
      p.dashT = DASH_TIME; p.dashCd = DASH_CD;
    }
    for (const w of map.wind || []) if (Math.hypot(p.x - w.x, p.y - w.y) < w.r) { p.vx += Math.cos(w.a) * WIND_F * DT; p.vy += Math.sin(w.a) * WIND_F * DT; }
    if (env.quake != null) { p.vx += Math.cos(env.quake) * QK_F * DT; p.vy += Math.sin(env.quake) * QK_F * DT; }
  } else { p.vx *= 0.8; p.vy *= 0.8; }
  const f = Math.exp(-(onIce ? ICE_FRICTION : FRICTION) * DT);
  p.vx *= f; p.vy *= f;
  p.x += p.vx * DT; p.y += p.vy * DT;
  let hit = -1;
  (map.bump || []).forEach((b, k) => { // 범퍼 기둥: 밀어내고 핀볼처럼 튕김
    const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy) || 0.01;
    if (d >= rad + b.r) return;
    const nx = dx / d, ny = dy / d;
    p.x = b.x + nx * (rad + b.r); p.y = b.y + ny * (rad + b.r);
    const vn = p.vx * nx + p.vy * ny;
    if (vn < 0) { p.vx -= 2 * vn * nx; p.vy -= 2 * vn * ny; }
    const out = p.vx * nx + p.vy * ny;
    if (out < BUMP_MIN) { p.vx += nx * (BUMP_MIN - out); p.vy += ny * (BUMP_MIN - out); }
    hit = k;
  });
  return hit;
}

class Sim {
  constructor() {
    this.players = new Map();
    this.time = 0; this.tickN = 0;
    this.phase = 'lobby'; this.phaseT = 0; this.arenaR = ARENA_R0; this.roundT = 0;
    this.powerups = []; this.nextPowerAt = 5; this.nextPuId = 1;
    this.events = [];
    this.clearRound();
  }
  event(k, data) { this.events.push({ t: 'e', k, ...data }); }
  freeColor() {
    const used = new Set([...this.players.values()].map(p => p.color));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 0;
  }
  resetBody(p, x, y) {
    Object.assign(p, { x, y, vx: 0, vy: 0, state: 0, fallT: 0, dashT: 0, dashCd: 0, bigT: 0, confT: 0, bmpCd: 0, lastHitBy: 0, lastHitAt: -9 });
  }
  spawnRandom(p) {
    const a = Math.random() * Math.PI * 2, d = Math.random() * this.arenaR * 0.5;
    this.resetBody(p, Math.cos(a) * d, Math.sin(a) * d);
  }
  placeRing(list) {
    const n = list.length, off = Math.random() * Math.PI * 2;
    list.forEach((p, i) => {
      const a = off + (i / n) * Math.PI * 2;
      this.resetBody(p, Math.cos(a) * 250, Math.sin(a) * 250);
      p.face = a + Math.PI;
    });
  }
  clearRound() {
    this.map = { ice: [], wind: [], bump: [], hole: [] };
    this.fieldKinds = []; this.hz = []; this.theme = 'night';
    this.sw = null; this.meteors = []; this.bomb = null; this.quake = null;
  }
  // 라운드 시작: 필드 2개 + 위험 요소 1~2개를 무작위로 고르고 겹치지 않게 배치
  genRound() {
    const prevTheme = this.theme;
    this.clearRound();
    const themes = THEMES.filter(t => t !== prevTheme); // 직전 판과 다른 테마
    this.theme = themes[Math.floor(Math.random() * themes.length)];
    this.fieldKinds = shuffle(FIELD_KINDS.slice()).slice(0, 2);
    this.hz = shuffle(HAZARD_KINDS.slice()).slice(0, Math.random() < 0.5 ? 1 : 2);
    const taken = [];
    const place = (dMin, dMax, size) => {
      for (let k = 0; k < 60; k++) {
        const a = Math.random() * Math.PI * 2, d = rnd(dMin, dMax), x = Math.cos(a) * d, y = Math.sin(a) * d;
        if (taken.every(t => Math.hypot(t.x - x, t.y - y) > t.s + size + 20)) { taken.push({ x, y, s: size }); return { x, y }; }
      }
      return null;
    };
    const F = this.fieldKinds, m = this.map;
    if (F.includes('hole')) for (let i = 0, n = Math.random() < 0.5 ? 1 : 2; i < n; i++) { const q = place(70, 170, HOLE_R); if (q) m.hole.push({ ...q, r: HOLE_R }); }
    if (F.includes('bump')) for (let i = 0, n = Math.random() < 0.5 ? 2 : 3; i < n; i++) { const q = place(80, 190, BUMP_R + 30); if (q) m.bump.push({ ...q, r: BUMP_R }); }
    if (F.includes('ice')) { const q = place(30, 260, ICE_R); if (q) m.ice.push({ ...q, r: ICE_R }); }
    if (F.includes('wind')) { const q = place(30, 240, WIND_R); if (q) m.wind.push({ ...q, r: WIND_R, a: Math.random() * Math.PI * 2 }); }
    this.windTurnAt = WIND_TURN;
    if (this.hz.includes('sweep')) this.sw = { a: Math.random() * Math.PI, w: SW_W * (Math.random() < 0.5 ? 1 : -1), flipAt: rnd(6, 10) };
    this.nextMeteorAt = 3; this.nextBombAt = 4; this.nextQuakeAt = rnd(5, 8);
  }
  setPhase(ph) {
    this.phase = ph;
    if (ph === 'countdown') {
      this.phaseT = COUNTDOWN; this.arenaR = ARENA_R0; this.powerups = [];
      this.genRound();
      const list = [...this.players.values()];
      list.forEach(p => { p.inRound = true; });
      this.placeRing(list);
    } else if (ph === 'playing') {
      this.roundT = 0; this.nextPowerAt = 4;
    } else if (ph === 'roundover') {
      this.phaseT = ROUNDOVER; this.meteors = []; this.bomb = null; this.quake = null;
    } else if (ph === 'lobby') {
      this.arenaR = ARENA_R0; this.powerups = []; this.clearRound();
      for (const p of this.players.values()) { p.inRound = true; if (p.state !== 0) this.spawnRandom(p); }
    }
  }
  envNow(frozen) {
    const q = this.quake;
    return { frozen, map: this.map, quake: q && q.w <= 0 && q.on > 0 ? q.a : null };
  }

  addPlayer(id, name) {
    if (this.players.has(id)) return;
    const p = { id, name, color: this.freeColor(), score: 0, kos: 0, ix: 0, iy: 0, face: 0, q: 0, gq: 0, wantDash: false,
      inRound: this.phase === 'lobby' || this.phase === 'countdown', guessed: new Set() };
    this.spawnRandom(p);
    if (!p.inRound) p.state = 2;
    this.players.set(id, p);
    this.event('join', { n: name });
  }
  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.bomb && this.bomb.h === id) { this.bomb = null; this.nextBombAt = this.roundT + 4; }
    this.event('leave', { n: p.name });
  }
  // 입력: 번호(q) 붙은 입력은 버퍼에 쌓고, UDP라 빠질 수 있어 같이 실려 온 최근 입력(h)으로 빈 번호를 메운다
  input(id, m) {
    const p = this.players.get(id);
    if (!p) return;
    const q = m.q | 0;
    if (!q) { // 번호 없는 입력(봇 등): 받는 즉시 반영
      p.ix = clamp1(m.x); p.iy = clamp1(m.y);
      if (m.d) { p.wantDash = true; p.dashQ = 0; }
      return;
    }
    if (Array.isArray(m.h)) for (const h of m.h) if (Array.isArray(h)) this.putInput(p, h[0] | 0, clamp1(h[1]), clamp1(h[2]), h[3] ? 1 : 0);
    this.putInput(p, q, clamp1(m.x), clamp1(m.y), m.d ? 1 : 0);
  }
  putInput(p, q, x, y, d) {
    if (!q) return;
    if (!p.inq) { p.inq = new Map(); p.nextQ = q; }
    if (q >= p.nextQ) { if (!p.inq.has(q)) p.inq.set(q, { x, y, d }); }
    else if (d && p.guessed.has(q)) { p.guessed.delete(q); p.lateDash = { q, x, y }; } // 추정으로 지나간 프레임의 대시만 늦게라도 반영 (중복 방지)
  }

  // ---- 위험 요소 진행 (경기 중에만) ----
  updateHazards(alive) {
    const t = this.roundT;
    // 바람 방향 전환
    if (this.map.wind.length && (this.windTurnAt -= DT) <= 0) { for (const w of this.map.wind) w.a = Math.random() * Math.PI * 2; this.windTurnAt = WIND_TURN; }
    // 회전 막대
    if (this.sw) {
      this.sw.a += this.sw.w * DT;
      if ((this.sw.flipAt -= DT) <= 0) { this.sw.w = -this.sw.w; this.sw.flipAt = rnd(6, 10); }
    }
    // 운석: 60%는 누군가의 발밑 근처, 나머지는 아무 데나
    if (this.hz.includes('meteor') && t >= this.nextMeteorAt) {
      let x, y;
      if (alive.length && Math.random() < 0.6) { const v = alive[Math.floor(Math.random() * alive.length)]; x = v.x + rnd(-50, 50); y = v.y + rnd(-50, 50); }
      else { const a = Math.random() * Math.PI * 2, d = Math.random() * this.arenaR * 0.8; x = Math.cos(a) * d; y = Math.sin(a) * d; }
      this.meteors.push({ x, y, t: MT_WARN });
      this.nextMeteorAt = t + rnd(3.5, 5.5);
    }
    for (let k = this.meteors.length - 1; k >= 0; k--) {
      const mt = this.meteors[k];
      if ((mt.t -= DT) > 0) continue;
      this.meteors.splice(k, 1);
      this.event('meteor', { x: r0(mt.x), y: r0(mt.y) });
      for (const p of alive) {
        const dx = p.x - mt.x, dy = p.y - mt.y, d = Math.hypot(dx, dy) || 1;
        if (d > MT_R + radius(p)) continue;
        const s = 1000 * Math.max(0, 1 - d / (MT_R + radius(p))) + 350;
        p.vx += dx / d * s / mass(p); p.vy += dy / d * s / mass(p);
        p.lastHitBy = 0; p.lastHitAt = -9;
      }
    }
    // 폭탄 돌리기
    if (this.hz.includes('bomb')) {
      if (!this.bomb && t >= this.nextBombAt && alive.length >= 2) {
        const h = alive[Math.floor(Math.random() * alive.length)];
        this.bomb = { h: h.id, t: BOMB_T, cd: 0.6 };
        this.event('bomb', { i: h.id, n: h.name });
      }
      if (this.bomb) {
        const b = this.bomb, h = this.players.get(b.h);
        if (!h || h.state !== 0) { this.bomb = null; this.nextBombAt = t + 4; }
        else {
          b.cd -= DT;
          if ((b.t -= DT) <= 0) { // 폭발: 들고 있던 사람은 바깥쪽으로 크게 날아가고, 주변도 밀림
            const d0 = Math.hypot(h.x, h.y), a = d0 > 1 ? Math.atan2(h.y, h.x) : Math.random() * Math.PI * 2;
            h.vx = Math.cos(a) * 1300; h.vy = Math.sin(a) * 1300;
            for (const p of alive) {
              if (p === h) continue;
              const dx = p.x - h.x, dy = p.y - h.y, d = Math.hypot(dx, dy) || 1;
              if (d > 150) continue;
              const s = 800 * (1 - d / 150) + 250;
              p.vx += dx / d * s / mass(p); p.vy += dy / d * s / mass(p);
            }
            this.event('bombx', { i: h.id, n: h.name, x: r0(h.x), y: r0(h.y) });
            this.bomb = null; this.nextBombAt = t + 5;
          }
        }
      }
    }
    // 지진: 경고 후 3초간 모두 한쪽으로 쏠림
    if (this.hz.includes('quake')) {
      if (!this.quake && t >= this.nextQuakeAt) { this.quake = { a: Math.random() * Math.PI * 2, w: QK_WARN, on: QK_ON }; this.event('quake', {}); }
      if (this.quake) {
        const q = this.quake;
        if (q.w > 0) q.w -= DT; else if ((q.on -= DT) <= 0) { this.quake = null; this.nextQuakeAt = t + rnd(9, 13); }
      }
    }
  }

  step() {
    const players = this.players;
    this.time += DT;
    const count = players.size;

    // ---- 페이즈 진행 ----
    if (this.phase === 'lobby') {
      if (count >= 2) this.setPhase('countdown');
    } else if (this.phase === 'countdown') {
      this.phaseT -= DT;
      if (count < 2) this.setPhase('lobby');
      else if (this.phaseT <= 0) this.setPhase('playing');
    } else if (this.phase === 'playing') {
      this.roundT += DT;
      if (this.roundT > SHRINK_DELAY) {
        const k = Math.min(1, (this.roundT - SHRINK_DELAY) / SHRINK_TIME);
        this.arenaR = ARENA_R0 - (ARENA_R0 - ARENA_MIN) * k;
      }
      const sd = this.roundT - SHRINK_DELAY - SHRINK_TIME - SUDDEN_DELAY;
      if (sd > 0) this.arenaR = ARENA_MIN * Math.max(0, 1 - sd / SUDDEN_TIME);
      if (this.roundT > this.nextPowerAt && this.powerups.length < 2) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * this.arenaR * 0.65;
        const kinds = ['big', 'boom', 'conf'];
        this.powerups.push({ i: this.nextPuId++, k: kinds[Math.floor(Math.random() * kinds.length)], x: Math.cos(a) * d, y: Math.sin(a) * d });
        this.nextPowerAt = this.roundT + 5 + Math.random() * 4;
      }
      const alive = [...players.values()].filter(p => p.inRound && p.state !== 2);
      if (alive.length <= 1) {
        const w = alive[0];
        if (w) { w.score++; this.event('win', { i: w.id, n: w.name }); }
        else this.event('win', { i: 0, n: '' });
        this.setPhase('roundover');
      } else this.updateHazards(alive.filter(p => p.state === 0));
    } else if (this.phase === 'roundover') {
      this.phaseT -= DT;
      if (this.phaseT <= 0) this.setPhase(count >= 2 ? 'countdown' : 'lobby');
    }

    // ---- 입력 버퍼 소비: 프레임 번호 순서대로 틱마다 정확히 1개 (Overwatch·Rocket League 방식) ----
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
      else { // 입력이 제때 안 옴 → 직전 키를 계속 누르고 있다고 가정
        p.gq++; p.guessed.add(q);
        if (p.guessed.size > 300) p.guessed.delete(p.guessed.values().next().value);
      }
      if (!dash && p.lateDash) dash = p.lateDash;
      p.lateDash = null;
      if (dash && (!p.lastDashQ || dash.q - p.lastDashQ >= DASH_STEPS)) {
        p.wantDash = true; p.dashQ = dash.q; p.dashX = dash.x; p.dashY = dash.y;
      }
      p.q = q; p.bf = p.inq.size;
    }

    const frozen = this.phase === 'countdown' || this.phase === 'roundover';
    const list = [...players.values()].filter(p => p.inRound && p.state !== 2);
    const env = this.envNow(frozen);

    // ---- 이동 (공용 이동 함수) ----
    for (const p of list) {
      if (p.bigT > 0) p.bigT -= DT;
      if (p.dashCd > 0) p.dashCd -= DT;
      if (p.dashT > 0) p.dashT -= DT;
      if (p.confT > 0) p.confT -= DT;
      if (p.bmpCd > 0) p.bmpCd -= DT;
      if (p.state === 1) { // 떨어지는 중
        p.fallT += DT; p.x += p.vx * DT * 0.4; p.y += p.vy * DT * 0.4;
        if (p.fallT > 0.7) {
          if (this.phase === 'lobby') this.spawnRandom(p); else p.state = 2;
        }
        p.wantDash = false;
        continue;
      }
      let dashDir = null;
      if (!frozen && p.wantDash && p.dashCd <= (p.dashQ ? 0.4 : 0)) {
        if (p.dashQ) p.lastDashQ = p.dashQ;
        dashDir = p.dashQ ? { x: p.dashX, y: p.dashY } : { x: p.ix, y: p.iy };
        this.event('dash', { i: p.id });
      }
      p.wantDash = false;
      const hit = moveBody(p, p.ix, p.iy, dashDir, env, radius(p));
      if (hit >= 0 && p.bmpCd <= 0) { p.bmpCd = 0.2; const b = this.map.bump[hit]; this.event('bmp', { b: hit, x: r0(b.x), y: r0(b.y) }); }
    }

    const solid = list.filter(p => p.state === 0);

    // ---- 회전 막대 (방장만 계산, 맞으면 막대가 도는 방향으로 날아감) ----
    if (this.sw && this.phase === 'playing') {
      const a = this.sw.a, c = Math.cos(a), s = Math.sin(a), L = Math.min(SW_LEN, this.arenaR - 15);
      for (const p of solid) {
        const t = p.x * c + p.y * s, perp = -p.x * s + p.y * c, rr = radius(p) + SW_HALF;
        if (Math.abs(t) > L + radius(p) * 0.5 || Math.abs(perp) >= rr) continue;
        const side = perp >= 0 ? 1 : -1, nx = -s * side, ny = c * side;
        p.x += nx * (rr - Math.abs(perp)); p.y += ny * (rr - Math.abs(perp));
        const barV = this.sw.w * t * side; // 막대가 이 사람 쪽으로 다가오는 속도
        if (barV > 0) {
          const vn = p.vx * nx + p.vy * ny, want = barV + SW_KICK;
          if (vn < want) { p.vx += nx * (want - vn); p.vy += ny * (want - vn); this.event('swh', { x: r0(p.x), y: r0(p.y) }); }
        }
        p.lastHitBy = 0; p.lastHitAt = -9;
      }
    }

    // ---- 충돌 ----
    for (let a = 0; a < solid.length; a++) for (let b = a + 1; b < solid.length; b++) {
      const A = solid[a], B = solid[b];
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 0.01;
      const rs = radius(A) + radius(B);
      if (d >= rs) continue;
      // 폭탄 넘기기: 들고 있는 사람이 부딪히면 상대에게 넘어감
      if (this.bomb && this.bomb.cd <= 0 && (this.bomb.h === A.id || this.bomb.h === B.id)) {
        const to = this.bomb.h === A.id ? B : A;
        this.bomb.h = to.id; this.bomb.cd = 0.6;
        this.event('bomb', { i: to.id, n: to.name, pass: 1 });
      }
      const nx = dx / d, ny = dy / d, mA = mass(A), mB = mass(B);
      const ov = rs - d, tot = mA + mB;
      A.x -= nx * ov * mB / tot; A.y -= ny * ov * mB / tot;
      B.x += nx * ov * mA / tot; B.y += ny * ov * mA / tot;
      const vn = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (vn >= 0) continue;
      const j = -(1 + RESTITUTION) * vn / (1 / mA + 1 / mB);
      A.vx -= j / mA * nx; A.vy -= j / mA * ny;
      B.vx += j / mB * nx; B.vy += j / mB * ny;
      if (A.dashT > 0) { B.vx += nx * 420 / mB; B.vy += ny * 420 / mB; }
      if (B.dashT > 0) { A.vx -= nx * 420 / mA; A.vy -= ny * 420 / mA; }
      const force = Math.abs(vn);
      if (force > 60) {
        A.lastHitBy = B.id; A.lastHitAt = this.time;
        B.lastHitBy = A.id; B.lastHitAt = this.time;
        this.event('bump', { x: r0(A.x + nx * radius(A)), y: r0(A.y + ny * radius(A)), f: r0(force + (A.dashT > 0 || B.dashT > 0 ? 400 : 0)) });
      }
    }

    // ---- 파워업 획득 ----
    for (const p of solid) {
      for (let k = this.powerups.length - 1; k >= 0; k--) {
        const u = this.powerups[k];
        if (Math.hypot(u.x - p.x, u.y - p.y) > radius(p) + 18) continue;
        this.powerups.splice(k, 1);
        if (u.k === 'big') { p.bigT = 6; this.event('pick', { i: p.id }); }
        else if (u.k === 'conf') { // 혼란파: 나를 뺀 모두의 방향키가 4초간 반대
          for (const o of solid) if (o !== p) o.confT = CONF_T;
          this.event('conf', { i: p.id, n: p.name, x: r0(p.x), y: r0(p.y) });
        } else {
          this.event('boom', { x: r0(p.x), y: r0(p.y), i: p.id });
          for (const o of solid) {
            if (o === p) continue;
            const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy) || 1;
            if (d > 260) continue;
            const s = 1100 * (1 - d / 260) + 300;
            o.vx += dx / d * s / mass(o); o.vy += dy / d * s / mass(o);
            o.lastHitBy = p.id; o.lastHitAt = this.time;
          }
        }
      }
    }

    // ---- 링 아웃·구멍 판정 ----
    for (const p of solid) {
      const inHole = this.map.hole.some(h => Math.hypot(p.x - h.x, p.y - h.y) < h.r);
      if (Math.hypot(p.x, p.y) > this.arenaR || inHole) {
        p.state = 1; p.fallT = 0;
        if (inHole) { p.vx *= 0.3; p.vy *= 0.3; }
        const by = this.time - p.lastHitAt < 3 && players.get(p.lastHitBy) ? players.get(p.lastHitBy) : null;
        if (by && this.phase === 'playing') by.kos++;
        this.event('fall', { i: p.id, n: p.name, by: by ? by.id : 0, bn: by ? by.name : '', practice: this.phase === 'lobby' ? 1 : 0, hole: inHole ? 1 : 0 });
      }
    }

    // ---- 상태 ----
    let snap = null;
    if (++this.tickN % SEND_EVERY === 0) {
      const m = this.map, sw = this.sw;
      snap = {
        t: 's', tm: Math.round(performance.now()), ph: this.phase, pt: Math.max(0, r1(this.phaseT)), ar: r0(this.arenaR),
        p: [...players.values()].map(p => ({
          i: p.id, n: p.name, c: p.color, x: r0(p.x), y: r0(p.y), vx: r0(p.vx), vy: r0(p.vy), q: p.q, bf: p.bf, gq: p.gq,
          r: radius(p), s: p.inRound ? p.state : 2, f: r2(p.face),
          d: p.dashT > 0 ? 1 : 0, cd: Math.max(0, r2(p.dashCd / DASH_CD)), cf: Math.max(0, r1(p.confT || 0)),
          sc: p.score, ko: p.kos, ft: r2(p.fallT),
        })),
        u: this.powerups,
        mp: {
          k: [...this.fieldKinds, ...this.hz], th: this.theme,
          ice: m.ice.map(z => [r0(z.x), r0(z.y), z.r]), wind: m.wind.map(z => [r0(z.x), r0(z.y), z.r, r2(z.a)]),
          bump: m.bump.map(z => [r0(z.x), r0(z.y), z.r]), hole: m.hole.map(z => [r0(z.x), r0(z.y), z.r]),
          sw: sw ? [Math.round(sw.a * 1000) / 1000, r0(Math.min(SW_LEN, this.arenaR - 15))] : null,
          mt: this.meteors.map(o => [r0(o.x), r0(o.y), r2(o.t)]),
          bomb: this.bomb ? [this.bomb.h, r1(this.bomb.t)] : null,
          qk: this.quake ? [r2(this.quake.a), r2(this.quake.w), r2(this.quake.on)] : null,
        },
      };
    }
    const events = this.events;
    this.events = [];
    return { snap, events };
  }
}

root.GameCore = { Sim, moveBody, TICK, DT, MAX_PLAYERS, DASH_CD, DASH_STEPS, MT_R, MT_WARN, BOMB_T, CONF_T };
})(self);
