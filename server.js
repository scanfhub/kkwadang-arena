// 꽈당 아레나 — 로비·연결 중개 서버
// 게임 계산은 방장 브라우저가 하고, 플레이어끼리는 WebRTC(UDP)로 직접 주고받는다.
// 이 서버는 ① 페이지 제공 ② 방장 지정 ③ WebRTC 연결 신호 전달 ④ 직접 연결이 안 될 때 중계만 한다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/game-core.js': ['game-core.js', 'text/javascript; charset=utf-8'],
  '/host-worker.js': ['host-worker.js', 'text/javascript; charset=utf-8'],
};

const netLog = []; // 접속자별 회선 기록, 최근 500줄
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (FILES[url]) {
    res.writeHead(200, { 'Content-Type': FILES[url][1], 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', FILES[url][0])));
  } else if (url === '/stats') { // 실전 테스트 분석용
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(netLog));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });

let nextId = 1, hostId = 0;
const clients = new Map(); // id -> { ws, name, canHost } (들어온 순서 유지)

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sendTo(id, obj) { const c = clients.get(id); if (c) send(c.ws, obj); }

// 방장: 들어온 순서대로, PC(터치 아닌 기기)를 우선. 바뀌면 모두에게 알리고 새 방장은 전체 명단으로 새 판을 연다.
function electHost() {
  const list = [...clients.entries()];
  const pick = list.find(([, c]) => c.canHost) || list[0];
  hostId = pick ? pick[0] : 0;
  const peers = list.map(([id, c]) => ({ id, name: c.name }));
  for (const [id, c] of list) send(c.ws, { t: 'host', id: hostId, peers: id === hostId ? peers : [] });
}

wss.on('connection', (ws) => {
  let me = 0;
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !me) {
      if (clients.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return; }
      const name = String(m.name || '').trim().slice(0, 10) || '이름없음';
      me = nextId++;
      clients.set(me, { ws, name, canHost: !!m.canHost });
      send(ws, { t: 'welcome', id: me });
      if (!hostId) electHost();
      else { send(ws, { t: 'host', id: hostId, peers: [] }); sendTo(hostId, { t: 'peer-join', id: me, name }); }
    } else if (!me) {
      return;
    } else if (m.t === 'sig') { // WebRTC 연결 신호 전달 (offer/answer/ICE 후보)
      if (clients.has(m.to)) sendTo(m.to, { t: 'sig', from: me, d: m.d });
    } else if (m.t === 'rl') { // 직접 연결 전·실패 시 중계: 참가자는 방장에게만, 방장은 누구에게나
      if (me === hostId || m.to === hostId) sendTo(m.to, { t: 'rl', from: me, d: m.d });
    } else if (m.t === 'nst') { // 클라이언트가 10초마다 보내는 회선 상태 → 한 줄 기록
      const num = v => Math.max(0, Math.min(1e6, Math.round(+v || 0)));
      const line = {
        t: new Date().toISOString(), 이름: clients.get(me).name, 인원: clients.size,
        역할: me === hostId ? '방장' : '참가', 연결: ['방장', 'UDP', '중계'].includes(m.tr) ? m.tr : '?',
        방장까지핑평균ms: num(m.ra), 방장까지핑최대ms: num(m.rm), 받기끊김: num(m.g), 받기최대끊김ms: num(m.m),
        추정한프레임: num(m.gq), 방장입력버퍼평균: Math.round((+m.bf || 0) * 10) / 10, 보간지연ms: num(m.d), fps: num(m.f),
      };
      netLog.push(line); if (netLog.length > 500) netLog.shift();
      console.log('NET ' + JSON.stringify(line));
    }
  });
  ws.on('close', () => {
    if (!me) return;
    clients.delete(me);
    if (me === hostId) electHost();
    else sendTo(hostId, { t: 'peer-leave', id: me });
  });
});

server.listen(PORT, () => console.log(`꽈당 아레나 로비 서버 실행 중: http://localhost:${PORT}`));
