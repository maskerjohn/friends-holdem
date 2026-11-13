const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const { Hand } = require('pokersolver');
const PORT = process.env.PORT || 8787, MAX = 6, START = 2000, SB = 10, BB = 20, TURN_MS = 45000;
const rooms = {};
const RANKS = '23456789TJQKA', SUITS = 'shdc';
function newDeck() { const d = []; for (const r of RANKS) for (const s of SUITS) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; } return d; }
function room(id) { return rooms[id] ||= { id, seats: Array(MAX).fill(null), host: null, hand: null, dealer: -1, log: [], handNo: 0 }; }
function log(r, m) { r.log.push(m); if (r.log.length > 40) r.log.shift(); }
const inHand = (p) => p && p.inHand && !p.folded;
function nextSeat(r, from, pred) { for (let k = 1; k <= MAX; k++) { const i = (from + k) % MAX; if (pred(r.seats[i], i)) return i; } return -1; }

function startHand(r) {
  const ready = r.seats.filter(p => p && p.chips > 0 && !p.away);
  if (ready.length < 2) return '至少需要两位有筹码的玩家';
  r.handNo++;
  const h = r.hand = { deck: newDeck(), board: [], street: 'preflop', currentBet: 0, minRaise: BB, needAct: new Set(), toAct: -1, done: false, showdown: null, deadline: 0 };
  r.seats.forEach(p => { if (!p) return; Object.assign(p, { cards: null, bet: 0, total: 0, folded: false, allIn: false, inHand: p.chips > 0 && !p.away, shown: false, lastAction: '' }); });
  r.dealer = nextSeat(r, r.dealer, p => p && p.inHand);
  const players = r.seats.filter(p => p && p.inHand);
  players.forEach(p => p.cards = [h.deck.pop(), h.deck.pop()]);
  let sb, bb;
  if (players.length === 2) { sb = r.dealer; bb = nextSeat(r, sb, p => p && p.inHand); }
  else { sb = nextSeat(r, r.dealer, p => p && p.inHand); bb = nextSeat(r, sb, p => p && p.inHand); }
  post(r, sb, SB, '小盲'); post(r, bb, BB, '大盲');
  h.currentBet = BB; h.minRaise = BB;
  r.seats.forEach((p, i) => { if (inHand(p) && !p.allIn) h.needAct.add(i); });
  log(r, `第 ${r.handNo} 手开始，庄家：${r.seats[r.dealer].name}`);
  setTurn(r, nextSeat(r, bb, (p, i) => h.needAct.has(i)));
  advanceIfNeeded(r);
  return null;
}
function post(r, i, amt, label) { const p = r.seats[i]; const a = Math.min(amt, p.chips); p.chips -= a; p.bet += a; p.total += a; if (p.chips === 0) p.allIn = true; p.lastAction = `${label} ${a}`; }
function setTurn(r, i) { const h = r.hand; h.toAct = i; h.deadline = i >= 0 ? Date.now() + TURN_MS : 0; }

function act(r, i, type, amount) {
  const h = r.hand; if (!h || h.done || h.toAct !== i) return '还没轮到你';
  const p = r.seats[i], toCall = h.currentBet - p.bet;
  if (type === 'fold') { p.folded = true; p.lastAction = '弃牌'; h.needAct.delete(i); }
  else if (type === 'check') { if (toCall > 0) return '不能过牌，需要跟注'; p.lastAction = '过牌'; h.needAct.delete(i); }
  else if (type === 'call') { const a = Math.min(toCall, p.chips); p.chips -= a; p.bet += a; p.total += a; if (!p.chips) p.allIn = true; p.lastAction = p.allIn ? `全下 ${p.bet}` : `跟注 ${a}`; h.needAct.delete(i); }
  else if (type === 'raise' || type === 'allin') {
    if (type === 'allin' && p.bet + p.chips <= h.currentBet) return act(r, i, 'call');
    let to = type === 'allin' ? p.bet + p.chips : Math.floor(Number(amount));
    if (!(to > h.currentBet)) return '加注金额太小';
    if (to > p.bet + p.chips) to = p.bet + p.chips;
    if (to <= h.currentBet) return act(r, i, 'call');
    const isAllIn = to === p.bet + p.chips;
    if (to - h.currentBet < h.minRaise && !isAllIn) return `最少加到 ${h.currentBet + h.minRaise}`;
    const a = to - p.bet; p.chips -= a; p.bet = to; p.total += a; if (!p.chips) p.allIn = true;
    const raiseBy = to - h.currentBet;
    if (raiseBy >= h.minRaise) { h.minRaise = raiseBy; }
    h.currentBet = to; p.lastAction = p.allIn ? `全下 ${to}` : `加注到 ${to}`;
    h.needAct = new Set(); r.seats.forEach((q, k) => { if (k !== i && inHand(q) && !q.allIn) h.needAct.add(k); });
  } else return '未知操作';
  log(r, `${p.name}：${p.lastAction}`);
  setTurn(r, nextSeat(r, i, (q, k) => h.needAct.has(k)));
  advanceIfNeeded(r); return null;
}

function advanceIfNeeded(r) {
  const h = r.hand; if (!h || h.done) return;
  const live = r.seats.map((p, i) => [p, i]).filter(([p]) => inHand(p));
  if (live.length === 1) return finish(r, [[live[0][1]]], false);
  if (h.needAct.size > 0 && h.toAct >= 0) return;
  // street over
  r.seats.forEach(p => { if (p) p.bet = 0; }); h.currentBet = 0; h.minRaise = BB;
  const canAct = live.filter(([p]) => !p.allIn);
  const order = ['preflop', 'flop', 'turn', 'river'];
  if (h.street === 'river') return showdown(r);
  const deal = (n) => { h.deck.pop(); for (let k = 0; k < n; k++) h.board.push(h.deck.pop()); };
  h.street = order[order.indexOf(h.street) + 1]; deal(h.street === 'flop' ? 3 : 1);
  log(r, `${{ flop: '翻牌', turn: '转牌', river: '河牌' }[h.street]}：${h.board.join(' ')}`);
  r.seats.forEach(p => { if (p && inHand(p) && !p.allIn) p.lastAction = ''; });
  if (canAct.length <= 1) { setTurn(r, -1); h.needAct = new Set(); return advanceIfNeeded(r); }
  h.needAct = new Set(canAct.map(([, i]) => i));
  setTurn(r, nextSeat(r, r.dealer, (q, k) => h.needAct.has(k)));
}

function showdown(r) {
  const h = r.hand;
  const live = r.seats.map((p, i) => [p, i]).filter(([p]) => inHand(p));
  live.forEach(([p]) => p.shown = true);
  const solved = {}; live.forEach(([p, i]) => { solved[i] = Hand.solve([...p.cards, ...h.board]); });
  // side pots
  const contrib = r.seats.map(p => (p && p.inHand) ? p.total : 0);
  const levels = [...new Set(live.map(([p]) => p.total))].sort((a, b) => a - b);
  let prev = 0; const pots = [];
  for (const lv of levels) {
    let amt = 0; contrib.forEach(c => { amt += Math.max(0, Math.min(c, lv) - prev); });
    const elig = live.filter(([p]) => p.total >= lv).map(([, i]) => i);
    if (amt > 0) pots.push({ amt, elig }); prev = lv;
  }
  // leftover (folded players who put more than max live) -> last pot
  const totalPot = contrib.reduce((a, b) => a + b, 0), counted = pots.reduce((a, b) => a + b.amt, 0);
  if (totalPot > counted && pots.length) pots[pots.length - 1].amt += totalPot - counted;
  const results = [];
  pots.forEach((pot, idx) => {
    const winners = Hand.winners(pot.elig.map(i => solved[i]));
    const wIdx = pot.elig.filter(i => winners.includes(solved[i]));
    const share = Math.floor(pot.amt / wIdx.length); let rem = pot.amt - share * wIdx.length;
    const ordered = [...wIdx].sort((a, b) => ((a - r.dealer + MAX) % MAX) - ((b - r.dealer + MAX) % MAX));
    ordered.forEach(i => { r.seats[i].chips += share + (rem-- > 0 ? 1 : 0); });
    results.push({ amt: pot.amt, winners: wIdx.map(i => r.seats[i].name), desc: solved[wIdx[0]].descr, main: idx === 0 });
  });
  h.done = true; setTurn(r, -1);
  h.showdown = { results, hands: Object.fromEntries(live.map(([, i]) => [i, solved[i].descr])) };
  results.forEach(x => log(r, `${x.main ? '主池' : '边池'} ${x.amt} → ${x.winners.join('、')}（${zh(x.desc)}）`));
}
function finish(r, groups) {
  const h = r.hand, i = groups[0][0];
  const pot = r.seats.reduce((a, p) => a + (p && p.inHand ? p.total : 0), 0);
  r.seats[i].chips += pot; h.done = true; setTurn(r, -1);
  h.showdown = { results: [{ amt: pot, winners: [r.seats[i].name], desc: '其他人弃牌' }], hands: {} };
  log(r, `${r.seats[i].name} 赢得 ${pot}（其他人弃牌）`);
}
const ZH = { 'Royal Flush': '皇家同花顺', 'Straight Flush': '同花顺', 'Four of a Kind': '四条', 'Full House': '葫芦', 'Flush': '同花', 'Straight': '顺子', 'Three of a Kind': '三条', 'Two Pair': '两对', 'Pair': '一对', 'High Card': '高牌' };
function zh(d) { for (const k in ZH) if (d.startsWith(k)) return ZH[k] + d.slice(k.length); return d; }

function view(r, me) {
  const h = r.hand;
  return { type: 'state', room: r.id, me, host: r.host, handNo: r.handNo, dealer: r.dealer, sb: SB, bb: BB, log: r.log.slice(-12).map(zh),
    hand: h && { board: h.board, street: h.street, currentBet: h.currentBet, minRaise: h.minRaise, toAct: h.toAct, done: h.done, left: h.deadline ? h.deadline - Date.now() : 0,
      pot: r.seats.reduce((a, p) => a + (p && p.inHand ? p.total : 0), 0),
      showdown: h.showdown && { results: h.showdown.results.map(x => ({ ...x, desc: zh(x.desc) })), hands: Object.fromEntries(Object.entries(h.showdown.hands).map(([k, v]) => [k, zh(v)])) } },
    seats: r.seats.map((p, i) => p && { name: p.name, chips: p.chips, bet: p.bet || 0, folded: p.folded, allIn: p.allIn, inHand: p.inHand, online: p.ws?.readyState === 1, away: p.away, buyins: p.buyins, lastAction: p.lastAction,
      cards: p.cards ? ((i === me || (p.shown && h?.done)) ? p.cards : ['??', '??']) : null }) };
}
function broadcast(r) { r.seats.forEach((p, i) => { if (p?.ws?.readyState === 1) p.ws.send(JSON.stringify(view(r, i))); });
  (r.watchers || []).forEach(w => w.readyState === 1 && w.send(JSON.stringify(view(r, -1)))); }

setInterval(() => { for (const r of Object.values(rooms)) { const h = r.hand; if (h && !h.done && h.toAct >= 0 && h.deadline && Date.now() > h.deadline) {
  const p = r.seats[h.toAct]; act(r, h.toAct, h.currentBet - p.bet > 0 ? 'fold' : 'check'); log(r, `${p.name} 超时`); broadcast(r); } } }, 1000);

const server = http.createServer((req, res) => {
  const f = path.join(__dirname, 'public', req.url === '/' || req.url.startsWith('/?') ? 'index.html' : path.normalize(req.url).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' }); res.end(d); });
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let r = null, me = -1;
  const err = m => ws.send(JSON.stringify({ type: 'error', msg: m }));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      r = room(String(m.room || '').slice(0, 20) || 'lobby');
      const token = String(m.token || ''), name = String(m.name || '玩家').slice(0, 12);
      me = r.seats.findIndex(p => p && p.token === token);
      if (me < 0) { me = r.seats.findIndex(p => !p); if (me < 0) { (r.watchers ||= []).push(ws); err('桌子满了，你现在是观战'); return broadcast(r); }
        r.seats[me] = { token, name, chips: START, buyins: 1, inHand: false }; log(r, `${name} 入座`); }
      r.seats[me].ws = ws; r.seats[me].name = name; r.seats[me].away = false;
      if (r.host == null || !r.seats[r.host]) r.host = me;
      return broadcast(r);
    }
    if (!r || me < 0 || !r.seats[me]) return;
    const p = r.seats[me]; let e = null;
    if (m.type === 'start') { if (r.hand && !r.hand.done) e = '这一手还没结束'; else e = startHand(r); }
    else if (m.type === 'act') e = act(r, me, m.action, m.amount);
    else if (m.type === 'rebuy') { if (r.hand && !r.hand.done && p.inHand) e = '本手结束后才能补码'; else { p.chips += START; p.buyins++; log(r, `${p.name} 补码 ${START}`); } }
    else if (m.type === 'away') { p.away = !p.away; log(r, `${p.name} ${p.away ? '暂离' : '回来了'}`); }
    else if (m.type === 'leave') { if (r.hand && !r.hand.done && p.inHand) { err('这一手结束后才能离开'); return broadcast(r); } r.seats[me] = null; log(r, `${p.name} 离开`); if (r.host === me) r.host = r.seats.findIndex(Boolean); me = -1; }
    if (e) err(e); broadcast(r);
  });
  ws.on('close', () => { if (r) { r.watchers = (r.watchers || []).filter(w => w !== ws); broadcast(r); } });
});
server.listen(PORT, '0.0.0.0', () => console.log('poker on', PORT));
