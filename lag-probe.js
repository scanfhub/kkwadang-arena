// 렉 측정: ① 방장이 보낸 상태 패킷 도착 간격 ② 내 입력 → 반영까지 걸리는 시간
// P2P 구조라 방장 브라우저가 먼저 접속해 있어야 함. 이 스크립트는 서버 중계 경로로 방장과 주고받음
const WebSocket = require('ws');
const URL = process.argv[2] || 'ws://localhost:3000';
const ws = new WebSocket(URL);
let id = 0, host = 0, arrivals = [], sent = [], lastX = null, probe = null, results = [];
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'probe' })));
ws.on('message', raw => {
  const now = performance.now(); let m = JSON.parse(raw);
  if (m.t === 'welcome') { id = m.id; return; }
  if (m.t === 'host') { host = m.id; return; }
  if (m.t !== 'rl') return;
  m = m.d;
  if (m.t !== 's' || !id) return;
  arrivals.push(now); sent.push(m.tm);
  const me = m.p.find(p => p.i === id); if (!me) return;
  if (probe && Math.abs(me.x - probe.x0) >= 1) { results.push(now - probe.t); probe = null; }
  lastX = me.x;
});
const start = performance.now();
const sendIn = d => ws.send(JSON.stringify({ t: 'rl', to: host, d: { t: 'in', ...d } }));
async function run() {
  await new Promise(r => setTimeout(r, 6000)); // 패킷 간격 수집
  for (let i = 0; i < 12; i++) {
    sendIn({ x: 0, y: 0 });
    await new Promise(r => setTimeout(r, 700)); // 멈출 때까지 대기
    probe = { x0: lastX, t: performance.now() };
    sendIn({ x: i % 2 ? 1 : -1, y: 0 });
    await new Promise(r => setTimeout(r, 500));
  }
  sendIn({ x: 0, y: 0 });
  const iv = arrivals.slice(1).map((t, k) => t - arrivals[k]);
  const secs = (arrivals.at(-1) - arrivals[0]) / 1000;
  console.log(`[${URL}]`);
  console.log(`상태 패킷: ${(arrivals.length / secs).toFixed(1)}개/초 (목표 30) · 간격 평균 ${(iv.reduce((a, b) => a + b, 0) / iv.length).toFixed(1)}ms · p95 ${pct(iv, .95).toFixed(0)}ms · 최대 ${Math.max(...iv).toFixed(0)}ms · 100ms 넘게 끊긴 횟수 ${iv.filter(x => x > 100).length}`);
  const siv = sent.slice(1).map((t, k) => t - sent[k]);
  console.log(`방장이 보낸 간격: 평균 ${(siv.reduce((a, b) => a + b, 0) / siv.length).toFixed(1)}ms · p95 ${pct(siv, .95).toFixed(0)}ms · 최대 ${Math.max(...siv).toFixed(0)}ms · 100ms 넘게 밀린 횟수 ${siv.filter(x => x > 100).length}`);
  console.log(`입력→반영(왕복): 중앙값 ${pct(results, .5).toFixed(0)}ms · p95 ${pct(results, .95).toFixed(0)}ms · 표본 ${results.length}`);
  ws.close(); process.exit(0);
}
ws.on('open', run);
