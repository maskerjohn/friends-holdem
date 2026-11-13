const test = require('node:test');
const assert = require('node:assert/strict');
const { room, startHand, act, showCards, view, buildServer, rooms } = require('../server');
const { WebSocket } = require('ws');

function makeRoom(names, opts = {}) {
  const id = 't' + Math.random().toString(36).slice(2);
  const r = room(id);
  names.forEach((name, i) => {
    r.seats[i] = {
      token: name, name,
      chips: opts.chips ? opts.chips[i] : 2000,
      buyins: 1, inHand: false,
      away: !!(opts.away && opts.away[i])
    };
  });
  if (opts.dealer != null) r.dealer = opts.dealer;
  return r;
}
function apply(r, type, amount) {
  const i = r.hand.toAct;
  const err = act(r, i, type, amount);
  assert.equal(err, null, `${type} seat ${i}: ${err}`);
  return i;
}
function chipSum(r) { return r.seats.reduce((a, p) => a + (p ? p.chips : 0), 0); }
function assertNets(r, before) {
  const v = view(r, 0);
  let netSum = 0;
  r.seats.forEach((p, i) => {
    if (!p) return;
    const delta = p.chips - before[i];
    if (v.seats[i].net == null) assert.equal(delta, 0, `${p.name} chip change without a net`);
    else {
      assert.equal(v.seats[i].net, delta, `${p.name} net`);
      assert.equal(v.hand.showdown.nets[i], delta);
      netSum += v.seats[i].net;
    }
  });
  assert.equal(netSum, 0);
  return v;
}
function rig(r, holes, board) {
  Object.entries(holes).forEach(([i, cards]) => { r.seats[i].cards = cards; });
  r.hand.deck = [board[4], 'Xh', board[3], 'Xh', board[2], board[1], board[0], 'Xh'];
}

test('fold win reports per-player nets and conserves chips', () => {
  const r = makeRoom(['甲', '乙']);
  const before = r.seats.map(p => p && p.chips);
  assert.equal(startHand(r), null);
  assert.equal(r.hand.toAct, 0);
  apply(r, 'fold');
  const v = assertNets(r, before);
  assert.equal(v.seats[0].net, -10);
  assert.equal(v.seats[1].net, 10);
  assert.equal(v.seats[0].chips, 1990);
  assert.equal(v.seats[1].chips, 2010);
  assert.equal(chipSum(r), 4000);
  assert.equal(v.hand.showdown.results[0].amt, 30);
});

test('side pots are included in each player net', () => {
  const r = makeRoom(['甲', '乙', '丙'], { chips: [100, 400, 400], dealer: 2 });
  const before = r.seats.map(p => p && p.chips);
  assert.equal(startHand(r), null);
  rig(r, { 0: ['As', 'Ad'], 1: ['Ks', 'Kd'], 2: ['Qs', 'Qd'] }, ['2c', '3d', '4h', '5s', '9c']);
  apply(r, 'allin');
  apply(r, 'allin');
  apply(r, 'allin');
  assert.equal(r.hand.done, true);
  assert.equal(r.hand.board.join(' '), '2c 3d 4h 5s 9c');
  const v = assertNets(r, before);
  assert.equal(v.seats[0].net, 200);
  assert.equal(v.seats[1].net, 200);
  assert.equal(v.seats[2].net, -400);
  assert.equal(chipSum(r), 900);
  assert.ok(v.hand.showdown.results.length >= 2);
});

test('split pot odd chip is part of the hand net', () => {
  const r = makeRoom(['甲', '乙', '丙'], { dealer: 2 });
  const before = r.seats.map(p => p && p.chips);
  assert.equal(startHand(r), null);
  rig(r, { 0: ['As', 'Kd'], 1: ['Ad', 'Kc'], 2: ['9s', '8s'] }, ['Ah', 'Kh', 'Qh', 'Jh', '2c']);
  apply(r, 'raise', 45);
  apply(r, 'call');
  apply(r, 'call');
  while (!r.hand.done) apply(r, 'check');
  const v = assertNets(r, before);
  assert.equal(v.seats[0].net, 23);
  assert.equal(v.seats[1].net, 22);
  assert.equal(v.seats[2].net, -45);
  assert.equal(chipSum(r), 6000);
});

test('秀牌 reveals one or both cards only when allowed', () => {
  const r = makeRoom(['甲', '乙', '丙', '丁'], { away: [false, false, false, true] });
  const idle = r.seats[3].chips;
  assert.equal(startHand(r), null);
  const hole = r.seats.map(p => p && p.cards && p.cards.slice());
  assert.equal(showCards(r, 0, 0), '现在不能秀牌');
  assert.deepEqual(view(r, 1).seats[0].cards, ['??', '??']);
  assert.equal(view(r, 0).seats[0].canShow, false);

  apply(r, 'fold');
  assert.equal(r.hand.done, false);
  assert.equal(showCards(r, 1, 'both'), '现在不能秀牌');
  assert.equal(showCards(r, 0, 9), '请选择要秀的牌');
  assert.equal(showCards(r, 0, 0), null);
  let other = view(r, 1);
  assert.equal(other.seats[0].cards[0], hole[0][0]);
  assert.equal(other.seats[0].cards[1], '??');
  assert.equal(view(r, -1).seats[0].cards[0], hole[0][0]);
  assert.equal(view(r, -1).seats[1].cards[0], '??');
  assert.deepEqual(view(r, 0).seats[0].cards, hole[0]);
  assert.equal(view(r, 0).seats[0].canShow, true);
  assert.deepEqual(view(r, 0).seats[0].exposed, [true, false]);

  const chips = r.seats.map(p => p && p.chips);
  assert.equal(showCards(r, 0, 'both'), null);
  other = view(r, 2);
  assert.deepEqual(other.seats[0].cards, hole[0]);
  assert.deepEqual(r.seats.map(p => p && p.chips), chips);
  assert.equal(showCards(r, 0, 1), '现在不能秀牌');
  assert.match(r.log[r.log.length - 1], /秀出/);

  apply(r, 'fold');
  assert.equal(r.hand.done, true);
  assert.equal(showCards(r, 2, 1), null);
  assert.equal(view(r, 0).seats[2].cards[1], hole[2][1]);
  assert.equal(view(r, 0).seats[2].cards[0], '??');
  assert.equal(view(r, 2).seats[2].canShow, true);
  assert.equal(r.seats[3].chips, idle);
  assert.equal(view(r, 0).seats[3].net, null);

  assert.equal(startHand(r), null);
  assert.deepEqual(view(r, 1).seats[0].cards, ['??', '??']);
  assert.equal(view(r, 1).seats[0].net, null);
  assert.deepEqual(view(r, 0).seats[0].exposed, [false, false]);
  delete rooms[r.id];
});

test('show cards reach other players over the socket', async () => {
  const { server, wss } = buildServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const roomId = 'ws' + Math.random().toString(36).slice(2, 8);
  const players = [];
  try {
    for (const name of ['甲', '乙', '丙']) players.push(await connect(port, roomId, name));
    await players[0].until(m => m.type === 'state' && m.seats.filter(Boolean).length === 3);
    players[0].ws.send(JSON.stringify({ type: 'start' }));
    const started = await players[1].until(m => m.type === 'state' && m.hand && !m.hand.done && m.hand.street === 'preflop');
    assert.equal(started.hand.toAct, 0);
    assert.deepEqual(started.seats[0].cards, ['??', '??']);
    players[0].ws.send(JSON.stringify({ type: 'act', action: 'fold' }));
    await players[0].until(m => m.type === 'state' && m.seats[0] && m.seats[0].folded);
    const mine = players[0].inbox.findLast(m => m.type === 'state' && m.seats[0] && m.seats[0].folded);
    players[0].ws.send(JSON.stringify({ type: 'show', card: 0 }));
    const seen = await players[1].until(m => m.type === 'state' && m.seats[0] && m.seats[0].cards && m.seats[0].cards[0] !== '??');
    assert.equal(seen.seats[0].cards[0], mine.seats[0].cards[0]);
    assert.equal(seen.seats[0].cards[1], '??');
    const fromProp = await players[2].until(m => m.type === 'state' && m.seats[0] && m.seats[0].cards && m.seats[0].cards[0] !== '??');
    assert.equal(fromProp.seats[0].cards[0], mine.seats[0].cards[0]);
    assert.deepEqual(fromProp.seats[1].cards, ['??', '??']);
    assert.equal(seen.hand.done, false);
    players[0].ws.send(JSON.stringify({ type: 'show', card: 'both' }));
    const both = await players[2].until(m => m.type === 'state' && m.seats[0] && m.seats[0].cards && m.seats[0].cards[1] !== '??');
    assert.deepEqual(both.seats[0].cards, mine.seats[0].cards);
  } finally {
    players.forEach(p => p.ws.close());
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    delete rooms[roomId];
  }
});

function connect(port, roomId, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = new Set();
  ws.on('message', raw => {
    inbox.push(JSON.parse(raw));
    waiters.forEach(fn => fn());
  });
  const until = (pred) => new Promise((resolve, reject) => {
    const to = setTimeout(() => { waiters.delete(kick); reject(new Error('timeout ' + name)); }, 2000);
    const kick = () => {
      const hit = inbox.findLast(pred);
      if (!hit) return;
      clearTimeout(to); waiters.delete(kick); resolve(hit);
    };
    waiters.add(kick);
    kick();
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', room: roomId, name, token: name }));
      resolve({ ws, inbox, until });
    });
    ws.on('error', reject);
  });
}
