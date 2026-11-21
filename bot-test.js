// 봇 3명이 접속해 서로 박치기하며 라운드가 끝까지 도는지 확인
// P2P 구조라 게임은 방장 브라우저가 돌림 → 브라우저로 먼저 접속해 방장이 된 뒤 실행. 봇은 서버 중계로 방장과 주고받음
const WebSocket = require('ws');
const URL = process.argv[2] || 'ws://localhost:3000';
const log = []; const phases = new Set(); let wins = [], falls = 0, bumps = 0, lastState = null;
function bot(name) {
  const ws = new WebSocket(URL); let id = 0, host = 0;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name })));
  ws.on('message', raw => {
    let m = JSON.parse(raw);
    if (m.t === 'welcome') { id = m.id; return; }
    if (m.t === 'host') { host = m.id; return; }
    if (m.t !== 'rl') return;
    m = m.d;
    if (m.t === 's' && id) {
      if (name === 'bot1') { phases.add(m.ph); lastState = m; }
      const me = m.p.find(p => p.i === id), others = m.p.filter(p => p.i !== id && p.s === 0);
      if (!me || me.s !== 0 || !others.length) return;
      const t = others[0], dx = t.x - me.x, dy = t.y - me.y, l = Math.hypot(dx, dy) || 1;
      ws.send(JSON.stringify({ t: 'rl', to: host, d: { t: 'in', x: dx / l, y: dy / l, d: l < 120 && Math.random() < .3 ? 1 : 0 } }));
    }
    if (m.t === 'e' && name === 'bot1') {
      if (m.k === 'win') wins.push(m.n || '(무승부)');
      if (m.k === 'fall') falls++;
      if (m.k === 'bump') bumps++;
    }
  });
  return ws;
}
const bots = ['bot1', 'bot2', 'bot3'].map(bot);
const start = Date.now();
const iv = setInterval(() => {
  if (wins.length >= (+process.argv[3] || 2) || Date.now() - start > 90000) {
    clearInterval(iv); bots.forEach(b => b.close());
    console.log('phases seen:', [...phases].join(','));
    console.log('bumps:', bumps, 'falls:', falls, 'wins:', wins.join(' / '));
    console.log('scores:', lastState.p.map(p => `${p.n}=${p.sc}승 ${p.ko}떨굼`).join(', '));
    console.log('elapsed:', ((Date.now() - start) / 1000).toFixed(1) + 's');
    process.exit(0);
  }
}, 200);
