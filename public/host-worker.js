// 꽈당 아레나 — 방장 브라우저에서 게임을 돌리는 워커 (탭을 내려 둬도 메인 화면보다 덜 멈춤)
importScripts('game-core.js');
const sim = new GameCore.Sim();

onmessage = e => {
  const m = e.data;
  if (m.t === 'add') sim.addPlayer(m.id, m.name);
  else if (m.t === 'remove') sim.removePlayer(m.id);
  else if (m.t === 'in') sim.input(m.id, m.m);
  else if (m.t === 'bot') { if (m.op === 'add') sim.addBot(); else sim.removeBot(); }
};

// 정확히 초당 60틱: 다음 틱 예정 시각 기준으로 돌리고, 밀리면 따라잡음 (0.25초 넘게 밀리면 현재 시각부터)
let nextAt = performance.now();
(function loop() {
  const now = performance.now();
  if (now - nextAt > 250) nextAt = now;
  while (nextAt <= now) {
    const { snap, events } = sim.step();
    for (const ev of events) postMessage(ev);
    if (snap) postMessage(snap);
    nextAt += 1000 / GameCore.TICK;
  }
  setTimeout(loop, Math.max(0, nextAt - performance.now()));
})();
