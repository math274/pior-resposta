const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Erro ao abrir index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});
const io = new Server(server);

const QUESTIONS = {
  geral: [
    'Qual o melhor item para sobreviver a um apocalipse zumbi?',
    'O pior nome para um cachorro.',
    'O pior superpoder que existe.',
    'O pior presente de aniversário.',
    'Qual a pior coisa para encontrar na sua pizza?',
    'O pior lugar para esconder um segredo.',
    'O que você NÃO quer ouvir do piloto do avião?',
    'O pior som para ser o toque do seu celular.'
  ],
  escola: [
    'A pior desculpa para faltar na aula.',
    'Uma péssima ideia para o seu primeiro dia de emprego.',
    'O pior nome para uma loja de colchões.',
    'A pior coisa para falar numa reunião importante.',
    'O pior apelido para um professor.',
    'A pior coisa para escrever numa redação do vestibular.',
    'O que você NÃO quer ouvir do chefe numa sexta às 18h?',
    'O pior lugar para tirar uma soneca.'
  ],
  namoro: [
    'Qual a pior coisa para dizer num primeiro encontro?',
    'A pior pessoa para te dar carona.',
    'O pior jeito de pedir alguém em namoro.',
    'A pior coisa para mandar no grupo da família.',
    'A pior música para tocar no casamento.',
    'O pior presente para o Dia dos Namorados.',
    'A pior desculpa para cancelar um rolê.',
    'O pior apelido carinhoso.'
  ],
  bizarro: [
    'A pior coisa para gritar no meio de um cinema.',
    'O que você NÃO quer ver ao abrir a geladeira?',
    'O pior animal de estimação.',
    'A pior coisa para encontrar embaixo da cama.',
    'Um péssimo nome para um filho.',
    'O pior sabor de sorvete.',
    'A pior coisa para ter no lugar das mãos.',
    'O pior lugar para ficar preso no elevador.'
  ]
};
const ALL = Object.values(QUESTIONS).flat();

// Filtro básico de palavrões. Pega a palavra inteira, ignora acentos, números no lugar
// de letras (m3rda) e letras repetidas (puuuta). Não pega palavras separadas por espaço (p o r r a).
const BAD = ['porra', 'caralho', 'merda', 'puta', 'putaria', 'foda', 'foder', 'fodido', 'fodase',
  'fdp', 'pqp', 'buceta', 'boceta', 'piroca', 'viado', 'arrombado', 'cuzao', 'vagabunda',
  'prostituta', 'retardado', 'crioulo'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
const norm = w => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[013457]/g, c => LEET[c]).replace(/(.)\1+/g, '$1');
const BADSET = new Set(BAD.map(norm));
const clean = (text, r) => r.settings.filter
  ? text.replace(/[\p{L}\p{N}]+/gu, t => BADSET.has(norm(t)) ? '*'.repeat(t.length) : t)
  : text;

const poolOf = r => r.settings.cat === 'todas' ? ALL : QUESTIONS[r.settings.cat];
// As perguntas da turma são sorteadas para rodadas aleatórias, sem aparecer todas no começo.
function buildDeck(r) {
  const total = r.settings.rounds;
  const customs = shuffle(approved(r).map(c => clean(c.text, r)));
  const normal = shuffle(poolOf(r));
  const k = Math.min(customs.length, total);
  const slots = shuffle([...Array(total).keys()]).slice(0, k);
  const first = [];
  let ci = 0, ni = 0;
  for (let i = 0; i < total; i++) first.push(slots.includes(i) ? customs[ci++] : normal[ni++]);
  const rest = shuffle([...normal.slice(ni), ...customs.slice(ci)]);
  return [...rest, ...first.filter(Boolean).reverse()];
}

const rooms = {};
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
  } while (rooms[c]);
  return c;
}

function view(r, id) {
  const v = {
    code: r.code, phase: r.phase, host: r.host, you: id, question: r.question, round: r.round,
    settings: r.settings, special: r.special, mod: r.mod, hold: r.hold,
    custom: { approved: approved(r).length, mine: r.sugs.filter(q => q.by === id).length },
    sugs: r.sugs.filter(q => !q.ok).map(q => ({ id: q.id, text: q.text, own: q.by === id, mine: id in q.v ? q.v[id] : null })),
    qs: id === r.host ? approved(r).map(q => ({ id: q.id, text: q.text })) : [],
    left: r.deadline ? Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000)) : null,
    players: Object.entries(r.players).map(([pid, p]) => ({
      id: pid, name: p.name, score: p.score, off: !!p.off,
      done: r.phase === 'answer' ? pid in r.answers : r.phase === 'vote' ? pid in r.votes : false
    }))
  };
  if (r.phase === 'vote') {
    v.options = r.order.map((pid, i) => ({ key: i, text: r.answers[pid].text, mine: pid === id, starred: r.stars[id] === i }));
  }
  if (r.phase === 'result') v.results = r.results;
  if (r.phase === 'final') {
    const ps = Object.values(r.players);
    const cr = ps.slice().sort((a, b) => b.starsGot - a.starsGot)[0];
    const fast = ps.filter(p => p.tn).sort((a, b) => a.tsum / a.tn - b.tsum / b.tn)[0];
    v.awards = [];
    if (cr && cr.starsGot) v.awards.push('⭐ Mais criativo: ' + cr.name);
    if (fast) v.awards.push('⚡ Mais rápido: ' + fast.name + ' (' + (fast.tsum / fast.tn / 1000).toFixed(1) + 's em média)');
    v.hl = r.hl.slice().sort((a, b) => b.votes - a.votes).slice(0, 3);
  }
  return v;
}

function send(r) {
  for (const pid of Object.keys(r.players)) io.to(pid).emit('state', view(r, pid));
}

const AV = ['😎', '🤡', '👻', '🐸', '🦊', '🐙', '🍕', '🔥', '💀', '🦄', '🐧', '🤖'];
const MODS = ['dobro', 'invertido', 'relampago', 'uma_palavra'];
const mkPlayer = name => ({ name, score: 0, starsGot: 0, tsum: 0, tn: 0, off: false, token: crypto.randomBytes(8).toString('hex') });
const mkName = (d, r) => (AV.includes(d && d.av) ? d.av : '🙂') + ' ' + cleanName(d && d.name, r);
const REACTS = ['😂', '💀', '🔥', '👏', '🤢', '😱'];
const approved = r => r.sugs.filter(q => q.ok);
function approve(r, q) {
  q.ok = true;
  if (r.phase !== 'lobby') {
    // entra numa posição aleatória entre as próximas rodadas
    const remaining = Math.max(1, r.settings.rounds - r.round);
    const lo = Math.max(0, r.deck.length - remaining);
    const at = lo + Math.floor(Math.random() * (r.deck.length - lo + 1));
    r.deck.splice(at, 0, clean(q.text, r));
  }
}
function judge(r, q) {
  const elig = Object.keys(r.players).filter(id => id !== q.by).length;
  const vs = Object.values(q.v);
  const yes = vs.filter(x => x).length, no = vs.length - yes;
  if (yes * 2 > elig) approve(r, q);
  else if (no * 2 >= elig) r.sugs = r.sugs.filter(x => x !== q);
}
const onlineIds = r => Object.keys(r.players).filter(id => !r.players[id].off);

function remap(r, from, to) {
  const mv = o => { if (from in o) { o[to] = o[from]; delete o[from]; } };
  mv(r.players); mv(r.answers); mv(r.votes); mv(r.stars); mv(r.drafts);
  r.order = r.order.map(x => x === from ? to : x);
  if (r.host === from) r.host = to;
  r.sugs.forEach(q => {
    if (q.by === from) q.by = to;
    if (from in q.v) { q.v[to] = q.v[from]; delete q.v[from]; }
  });
}

function dropPlayer(r, id) {
  if (!r.players[id]) return;
  delete r.players[id];
  const ids = Object.keys(r.players);
  if (!ids.length) { clearTimer(r); delete rooms[r.code]; return; }
  if (r.host === id) r.host = onlineIds(r)[0] || ids[0];
  if (r.phase !== 'lobby' && onlineIds(r).length < 2) { clearTimer(r); r.phase = 'lobby'; r.round = 0; }
  else advance(r, false);
  send(r);
}

function clearTimer(r) {
  clearTimeout(r.timer);
  r.timer = null;
  r.deadline = null;
}

function startTimer(r) {
  clearTimer(r);
  const secs = (r.mod === 'relampago' && r.phase === 'answer') ? 15 : r.settings.time;
  if (!secs || (r.phase !== 'answer' && r.phase !== 'vote')) return;
  r.deadline = Date.now() + secs * 1000;
  r.timer = setTimeout(() => { advance(r, true); send(r); }, secs * 1000);
}

function advance(r, force) {
  const ids = onlineIds(r);
  if (!ids.length) return;
  if (r.phase === 'answer' && (force || ids.every(p => p in r.answers))) {
    if (force) {
      for (const id of ids) {
        if (id in r.answers) continue;
        let t = clean(String(r.drafts[id] || '').trim().slice(0, 80), r);
        if (r.mod === 'uma_palavra') t = t.split(/\s+/)[0];
        if (t) r.answers[id] = { name: r.players[id].name, text: t };
      }
    }
    const answered = Object.keys(r.answers);
    if (answered.length < 2) {
      r.results = [];
      r.phase = 'result';
      clearTimer(r);
      return;
    }
    r.phase = 'vote';
    r.order = shuffle(answered);
    startTimer(r);
  } else if (r.phase === 'vote' && (force || ids.every(p => p in r.votes))) {
    const counts = r.order.map(() => 0);
    Object.values(r.votes).forEach(i => { counts[i]++; });
    const sc = r.order.map(() => 0);
    Object.values(r.stars).forEach(i => { sc[i]++; });
    r.results = r.order.map((pid, i) => ({
      name: r.answers[pid].name, text: r.answers[pid].text, votes: counts[i], stars: sc[i],
      voters: Object.entries(r.votes).filter(([, k]) => k === i).map(([vid]) => (r.players[vid] || {}).name).filter(Boolean)
    })).sort((a, b) => b.votes - a.votes);
    r.order.forEach((pid, i) => {
      if (r.players[pid]) { r.players[pid].score += counts[i] * (r.special ? 2 : 1) + sc[i]; r.players[pid].starsGot += sc[i]; }
    });
    const top = r.results[0];
    if (top && top.votes > 0) r.hl.push({ q: r.question, text: top.text, name: top.name, votes: top.votes });
    r.phase = 'result';
    clearTimer(r);
  }
}

const check = r => advance(r, false);

function newRound(r) {
  if (!r.deck.length) r.deck = shuffle(poolOf(r));
  r.question = r.deck.pop();
  r.round++;
  r.phase = 'answer';
  r.answers = {};
  r.votes = {};
  r.stars = {};
  r.drafts = {};
  r.special = r.settings.special && r.round >= r.settings.rounds;
  r.mod = r.special ? MODS[Math.floor(Math.random() * MODS.length)] : null;
  r.t0 = Date.now();
  r.hold = r.special;
  clearTimer(r);
  if (r.special) {
    setTimeout(() => {
      if (rooms[r.code] !== r || r.phase !== 'answer') return;
      r.hold = false; r.t0 = Date.now(); startTimer(r); send(r);
    }, 3500);
  } else startTimer(r);
}

const cleanName = (n, r) => clean(String(n || '').trim().slice(0, 12), r) || 'Jogador';

io.on('connection', socket => {
  const room = () => rooms[socket.data.code];

  socket.on('create', (d, cb) => {
    const code = makeCode();
    const p = mkPlayer(mkName(d, { settings: { filter: true } }));
    rooms[code] = {
      code, host: socket.id, phase: 'lobby', round: 0, question: '',
      players: { [socket.id]: p },
      settings: { max: 8, rounds: 5, time: 0, cat: 'todas', filter: true, special: true },
      sugs: [], hl: [], timer: null, deadline: null, special: false, mod: null, hold: false,
      answers: {}, votes: {}, stars: {}, drafts: {}, order: [], results: [], deck: []
    };
    socket.data.code = code;
    cb({ ok: true, token: p.token, code });
    send(rooms[code]);
  });

  socket.on('join', (d, cb) => {
    const r = rooms[String((d && d.code) || '').trim().toUpperCase()];
    if (!r) return cb({ error: 'Sala não encontrada.' });
    if (r.phase !== 'lobby') return cb({ error: 'A partida já começou.' });
    if (Object.keys(r.players).length >= r.settings.max) return cb({ error: 'Sala cheia (máximo ' + r.settings.max + ').' });
    const p = mkPlayer(mkName(d, r));
    r.players[socket.id] = p;
    socket.data.code = r.code;
    cb({ ok: true, token: p.token, code: r.code });
    send(r);
  });

  socket.on('rejoin', (code, token, cb) => {
    const r = rooms[String(code || '').toUpperCase()];
    const old = r && Object.keys(r.players).find(id => r.players[id].token === token);
    if (!old) return cb({ error: 'sala encerrada' });
    clearTimeout(r.players[old].gone);
    remap(r, old, socket.id);
    r.players[socket.id].off = false;
    socket.data.code = r.code;
    cb({ ok: true });
    send(r);
  });

  socket.on('start', () => {
    const r = room();
    if (!r || r.host !== socket.id || r.phase !== 'lobby' || Object.keys(r.players).length < 3) return;
    r.deck = buildDeck(r);
    newRound(r);
    send(r);
  });

  socket.on('answer', text => {
    const r = room();
    if (!r || r.phase !== 'answer' || r.hold || !r.players[socket.id] || socket.id in r.answers) return;
    let t = clean(String(text || '').trim().slice(0, 80), r);
    if (r.mod === 'uma_palavra') t = t.split(/\s+/)[0];
    if (!t) return;
    r.answers[socket.id] = { name: r.players[socket.id].name, text: t };
    r.players[socket.id].tsum += Date.now() - r.t0;
    r.players[socket.id].tn++;
    check(r);
    send(r);
  });

  socket.on('vote', key => {
    const r = room();
    if (!r || r.phase !== 'vote' || !r.players[socket.id] || socket.id in r.votes) return;
    if (!Number.isInteger(key) || key < 0 || key >= r.order.length) return;
    if (r.order[key] === socket.id) return;
    r.votes[socket.id] = key;
    check(r);
    send(r);
  });

  socket.on('sug', text => {
    const r = room();
    if (!r || !r.players[socket.id]) return;
    const t = String(text || '').trim().slice(0, 100);
    if (t.length < 5 || r.sugs.filter(q => q.by === socket.id).length >= 2) return;
    r.sugs.push({ id: crypto.randomBytes(3).toString('hex'), text: t, by: socket.id, v: {}, ok: false });
    send(r);
  });

  socket.on('sugvote', (id, yes) => {
    const r = room();
    const q = r && r.sugs.find(x => x.id === id);
    if (!q || q.ok || q.by === socket.id || !r.players[socket.id] || socket.id in q.v) return;
    q.v[socket.id] = !!yes;
    judge(r, q);
    send(r);
  });

  socket.on('sugok', id => {
    const r = room();
    const q = r && r.host === socket.id && r.sugs.find(x => x.id === id);
    if (!q || q.ok) return;
    approve(r, q);
    send(r);
  });

  socket.on('addq', text => {
    const r = room();
    if (!r || r.host !== socket.id) return;
    const t = String(text || '').trim().slice(0, 100);
    if (t.length < 5) return;
    const q = { id: crypto.randomBytes(3).toString('hex'), text: t, by: null, v: {}, ok: false };
    r.sugs.push(q);
    approve(r, q);
    send(r);
  });

  socket.on('delq', id => {
    const r = room();
    if (!r || r.host !== socket.id) return;
    r.sugs = r.sugs.filter(q => q.id !== id);
    send(r);
  });

  socket.on('leave', () => {
    const r = room();
    if (!r || !r.players[socket.id]) return;
    clearTimeout(r.players[socket.id].gone);
    const id = socket.id;
    socket.data.code = null;
    dropPlayer(r, id);
  });

  socket.on('react', e => {
    const r = room();
    if (!r || !r.players[socket.id] || !REACTS.includes(e)) return;
    const now = Date.now();
    if (now - (socket.data.lr || 0) < 250) return;
    socket.data.lr = now;
    for (const pid of Object.keys(r.players)) io.to(pid).emit('react', e);
  });

  socket.on('draft', text => {
    const r = room();
    if (!r || r.phase !== 'answer' || r.hold || !r.players[socket.id] || socket.id in r.answers) return;
    r.drafts[socket.id] = String(text || '').slice(0, 200);
  });

  socket.on('star', key => {
    const r = room();
    if (!r || r.phase !== 'vote' || !r.players[socket.id] || socket.id in r.stars) return;
    if (!Number.isInteger(key) || key < 0 || key >= r.order.length || r.order[key] === socket.id) return;
    r.stars[socket.id] = key;
    send(r);
  });

  socket.on('skip', () => {
    const r = room();
    if (!r || r.host !== socket.id || r.phase !== 'answer' || r.hold) return;
    if (!r.deck.length) r.deck = shuffle(poolOf(r));
    r.question = r.deck.pop();
    r.answers = {};
    r.drafts = {};
    startTimer(r);
    send(r);
  });

  socket.on('next', () => {
    const r = room();
    if (!r || r.host !== socket.id || r.phase !== 'result') return;
    if (r.round >= r.settings.rounds) { r.phase = 'final'; clearTimer(r); }
    else newRound(r);
    send(r);
  });

  socket.on('again', () => {
    const r = room();
    if (!r || r.host !== socket.id || r.phase !== 'final') return;
    Object.values(r.players).forEach(p => { p.score = 0; p.starsGot = 0; p.tsum = 0; p.tn = 0; });
    r.hl = [];
    r.phase = 'lobby';
    r.round = 0;
    r.sugs = [];
    r.deck = [];
    send(r);
  });

  socket.on('settings', cfg => {
    const r = room();
    if (!r || r.host !== socket.id || r.phase !== 'lobby' || !cfg) return;
    const max = Number(cfg.max), rounds = Number(cfg.rounds), time = Number(cfg.time);
    if (Number.isInteger(max) && max >= 3 && max <= 8 && max >= Object.keys(r.players).length) r.settings.max = max;
    if (Number.isInteger(rounds) && rounds >= 1 && rounds <= 15) r.settings.rounds = rounds;
    if ([0, 30, 60, 90].includes(time)) r.settings.time = time;
    if (cfg.cat === 'todas' || Object.prototype.hasOwnProperty.call(QUESTIONS, cfg.cat)) r.settings.cat = cfg.cat;
    if (typeof cfg.filter === 'boolean') r.settings.filter = cfg.filter;
    if (typeof cfg.special === 'boolean') r.settings.special = cfg.special;
    send(r);
  });

  socket.on('disconnect', () => {
    const r = room();
    const p = r && r.players[socket.id];
    if (!p) return;
    const id = socket.id;
    p.off = true;
    p.gone = setTimeout(() => dropPlayer(r, id), 30000);
    if (r.host === id) r.host = onlineIds(r)[0] || id;
    advance(r, false);
    send(r);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Rodando em http://localhost:' + PORT));
