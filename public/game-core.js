// 꽈당 아레나 — 게임 계산 (방장 브라우저의 웹 워커에서 실행)
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

const clamp1 = v => Math.max(-1, Math.min(1, +v || 0));
function radius(p) { return p.bigT > 0 ? BIG_R : PR; }
function mass(p) { return p.bigT > 0 ? 3 : 1; }

class Sim {
  constructor() {
    this.players = new Map();
    this.time = 0; this.tickN = 0;
    this.phase = 'lobby'; this.phaseT = 0; this.arenaR = ARENA_R0; this.roundT = 0;
    this.powerups = []; this.nextPowerAt = 5; this.nextPuId = 1;
    this.events = [];
  }
  event(k, data) { this.events.push({ t: 'e', k, ...data }); }
  freeColor() {
    const used = new Set([...this.players.values()].map(p => p.color));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 0;
  }
  resetBody(p, x, y) {
    Object.assign(p, { x, y, vx: 0, vy: 0, state: 0, fallT: 0, dashT: 0, dashCd: 0, bigT: 0, lastHitBy: 0, lastHitAt: -9 });
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
  setPhase(ph) {
    this.phase = ph;
    if (ph === 'countdown') {
      this.phaseT = COUNTDOWN; this.arenaR = ARENA_R0; this.powerups = [];
      const list = [...this.players.values()];
      list.forEach(p => { p.inRound = true; });
      this.placeRing(list);
    } else if (ph === 'playing') {
      this.roundT = 0; this.nextPowerAt = 4;
    } else if (ph === 'roundover') {
      this.phaseT = ROUNDOVER;
    } else if (ph === 'lobby') {
      this.arenaR = ARENA_R0; this.powerups = [];
      for (const p of this.players.values()) { p.inRound = true; if (p.state !== 0) this.spawnRandom(p); }
    }
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
        this.powerups.push({ i: this.nextPuId++, k: Math.random() < 0.5 ? 'big' : 'boom', x: Math.cos(a) * d, y: Math.sin(a) * d });
        this.nextPowerAt = this.roundT + 5 + Math.random() * 4;
      }
      const alive = [...players.values()].filter(p => p.inRound && p.state !== 2);
      if (alive.length <= 1) {
        const w = alive[0];
        if (w) { w.score++; this.event('win', { i: w.id, n: w.name }); }
        else this.event('win', { i: 0, n: '' });
        this.setPhase('roundover');
      }
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

    // ---- 이동 ----
    for (const p of list) {
      if (p.bigT > 0) p.bigT -= DT;
      if (p.dashCd > 0) p.dashCd -= DT;
      if (p.dashT > 0) p.dashT -= DT;
      if (p.state === 1) { // 떨어지는 중
        p.fallT += DT; p.x += p.vx * DT * 0.4; p.y += p.vy * DT * 0.4;
        if (p.fallT > 0.7) {
          if (this.phase === 'lobby') this.spawnRandom(p); else p.state = 2;
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
          this.event('dash', { i: p.id });
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
      if (A.dashT > 0) { B.vx += nx * 420 / mB; B.vy += ny * 420 / mB; }
      if (B.dashT > 0) { A.vx -= nx * 420 / mA; A.vy -= ny * 420 / mA; }
      const force = Math.abs(vn);
      if (force > 60) {
        A.lastHitBy = B.id; A.lastHitAt = this.time;
        B.lastHitBy = A.id; B.lastHitAt = this.time;
        this.event('bump', { x: Math.round(A.x + nx * radius(A)), y: Math.round(A.y + ny * radius(A)), f: Math.round(force + (A.dashT > 0 || B.dashT > 0 ? 400 : 0)) });
      }
    }

    // ---- 파워업 획득 ----
    for (const p of solid) {
      for (let k = this.powerups.length - 1; k >= 0; k--) {
        const u = this.powerups[k];
        if (Math.hypot(u.x - p.x, u.y - p.y) > radius(p) + 18) continue;
        this.powerups.splice(k, 1);
        if (u.k === 'big') { p.bigT = 6; this.event('pick', { i: p.id, k: 'big' }); }
        else {
          this.event('boom', { x: Math.round(p.x), y: Math.round(p.y), i: p.id });
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

    // ---- 링 아웃 판정 ----
    for (const p of solid) {
      if (Math.hypot(p.x, p.y) > this.arenaR) {
        p.state = 1; p.fallT = 0;
        const by = this.time - p.lastHitAt < 3 && players.get(p.lastHitBy) ? players.get(p.lastHitBy) : null;
        if (by && this.phase === 'playing') by.kos++;
        this.event('fall', { i: p.id, n: p.name, by: by ? by.id : 0, bn: by ? by.name : '', practice: this.phase === 'lobby' ? 1 : 0 });
      }
    }

    // ---- 상태 ----
    let snap = null;
    if (++this.tickN % SEND_EVERY === 0) {
      snap = {
        t: 's', tm: Math.round(performance.now()), ph: this.phase, pt: Math.max(0, Math.round(this.phaseT * 10) / 10), ar: Math.round(this.arenaR),
        p: [...players.values()].map(p => ({
          i: p.id, n: p.name, c: p.color, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), q: p.q, bf: p.bf, gq: p.gq,
          r: radius(p), s: p.inRound ? p.state : 2, f: Math.round(p.face * 100) / 100,
          d: p.dashT > 0 ? 1 : 0, cd: Math.max(0, Math.round(p.dashCd / DASH_CD * 100) / 100),
          sc: p.score, ko: p.kos, ft: Math.round(p.fallT * 100) / 100,
        })),
        u: this.powerups,
      };
    }
    const events = this.events;
    this.events = [];
    return { snap, events };
  }
}

root.GameCore = { Sim, TICK, MAX_PLAYERS };
})(self);
