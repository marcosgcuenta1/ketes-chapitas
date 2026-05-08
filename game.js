// Soccer Stars - Singleplayer + Multiplayer P2P (PeerJS)
// Stack: Phaser 3 + Matter.js, vista cenital, gravedad cero.
// Multiplayer: lockstep en disparos + resync canonico al final del turno (autoridad: host).

// ================================================================
// CONSTANTES
// ================================================================
const FIELD_W       = 1080;          // canvas total (campo + gradas)
const FIELD_H       = 720;
const FIELD_PAD_X   = 120;           // gradas laterales
const FIELD_PAD_Y   = 90;            // gradas arriba/abajo
const WALL_THICK    = 20;

const GOAL_HALF     = 80;
const GOAL_DEPTH    = 38;

const PLAYER_RADIUS = 33;            // un poco mas pequeñas
const BALL_RADIUS   = 21;            // mantenido
const DISC_DEPTH    = 11;            // altura visual del lateral (vista 2.5D)
const BALL_DEPTH    = 6;             // misma idea para el balon, mas sutil
const PLAYER_MASS   = 1.0;
const BALL_MASS     = 0.3;

const RESTITUTION       = 0.7;
const RESTITUTION_WALL  = 0.55;

const FRICTION_AIR_PLAYER = 0.04;
const FRICTION_AIR_BALL   = 0.012;
const STOP_THRESH         = 0.35;     // snap a 0 antes; corta la cola lenta del balon

const FORCE_MULT    = 0.05;
const MAX_VELOCITY  = 22;
const MAX_DRAG_PX   = MAX_VELOCITY / FORCE_MULT;

const TRAIL_THRESHOLD       = 0.8 * MAX_VELOCITY;
const IMPACT_SHAKE_MIN_VEL  = 8;
const IMPACT_SHAKE_COOLDOWN = 110;

const FORMATION = [
    { role: 'gk',  fx: 0.07, fy: 0.50 },
    { role: 'def', fx: 0.23, fy: 0.25 },
    { role: 'def', fx: 0.23, fy: 0.75 },
    { role: 'atk', fx: 0.40, fy: 0.36 },
    { role: 'atk', fx: 0.40, fy: 0.64 }
];

// ================================================================
// MODOS DE JUEGO
// ================================================================
// Cada modo personaliza formacion, numero de balones, condicion de victoria, etc.
// Los modos no incluidos heredan el comportamiento "normal".
const GAME_MODES = {
    normal3: {
        label: 'A 3 GOLES',
        description: 'Partido normal 5 vs 5 a 3 goles',
        emoji: '⚽',
        formation: FORMATION,
        ballCount: 1,
        goalsToWin: 3
    },
    normal5: {
        label: 'A 5 GOLES',
        description: 'Partido normal 5 vs 5 a 5 goles',
        emoji: '⚽',
        formation: FORMATION,
        ballCount: 1,
        goalsToWin: 5
    },
    penaltis: {
        label: '1 CHAPA VS 1 CHAPA',
        description: 'Duelo a 1 chapa, gana quien llegue antes a 3 goles',
        emoji: '⚔️',
        formation: [{ role: 'atk', fx: 0.40, fy: 0.50 }],
        ballCount: 1,
        goalsToWin: 3
    },
    caos: {
        label: 'CAOS DOBLE BALÓN',
        description: '5 vs 5 con DOS balones a la vez. Locuuura',
        emoji: '🎱',
        formation: FORMATION,
        ballCount: 2,
        goalsToWin: 3
    },
    freekick: {
        label: 'TIRO LIBRE',
        description: 'Tiro libre con barrera. 3 rondas con dificultad creciente (2, 3, 4 chapas)',
        emoji: '🧱',
        ballCount: 1,
        isFreekick: true,
        barriersByRound: [2, 3, 4],
        rounds: 3,
        goalsToWin: 999    // no se usa: el match end es por rondas, no por goles
    },
    knockout: {
        label: 'KNOCKOUT',
        description: '5 vs 5 sin balon. Tira las chapas del rival fuera del campo. Ultima en pie gana',
        emoji: '💥',
        formation: FORMATION,
        ballCount: 0,
        isKnockout: true,
        goalsToWin: 999    // no se usa: el match end es por chapas
    },
    diana: {
        label: 'DIANA',
        description: 'En solitario: 5 disparos, marca gol en la zona de mas puntos',
        emoji: '🎯',
        isDiana: true,
        attempts: 5,
        goalsToWin: 999     // no se usa: el match end es por intentos
    }
};

let currentMode = 'normal3';

// Estado especifico del modo Tiro libre
let freekickRound = 1;       // 1, 2, 3
let freekickShots = 0;       // 0, 1, 2 (disparos completados en esta ronda)

// Estado especifico del modo Diana
let dianaAttempt = 0;        // 0..attempts-1
let dianaScore   = 0;        // total acumulado
let dianaZones   = null;     // array de { y0, y1, points } para puntuar el gol

// Clima / variantes de estadio. Modulan textura, overlay y particulas (lluvia/nieve).
const WEATHERS = {
    day:   { label: 'DIA',    overlay: null,                       drops: null  },
    night: { label: 'NOCHE',  overlay: { color: 0x000033, alpha: 0.55 }, drops: null },
    rain:  { label: 'LLUVIA', overlay: { color: 0x021428, alpha: 0.30 }, drops: 'rain' },
    snow:  { label: 'NIEVE',  overlay: { color: 0xb0c8e0, alpha: 0.18 }, drops: 'snow' }
};
let currentWeather = 'day';
let weatherDrops = [];
let weatherGfx   = null;

// Habilidad TURBO: 1 uso por equipo por partido. Multiplica velocidad del proximo disparo.
const TURBO_MULTIPLIER = 1.40;
let abilityUsed  = { red: false, blue: false };
let abilityArmed = false;     // si esta armada, el proximo disparo del equipo activo recibe el boost

const TEAM_COLORS = {
    red:  { fill: 0xcc1f1f },
    blue: { fill: 0x2360c0 }
};

const PALETTE_CONFETTI = [0xff5050, 0x5090ff, 0xffd400, 0xff8a3d, 0x60d0ff, 0xffffff, 0x40e08a, 0xa040ff];

// ================================================================
// SONIDO (WebAudio API procedural, sin assets externos)
// ================================================================
let __audioCtx = null;
let soundMuted = false;
try { soundMuted = localStorage.getItem('chapitas:muted') === '1'; } catch (_) {}

function getAudioCtx() {
    if (__audioCtx) return __audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    __audioCtx = new Ctor();
    return __audioCtx;
}

function makeNoiseBuffer(ctx, dur, decay) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
        const env = decay ? Math.pow(1 - i / len, decay) : 1;
        data[i] = (Math.random() * 2 - 1) * env;
    }
    return buf;
}

function playImpact(intensity) {
    if (soundMuted) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const t = ctx.currentTime;
    const vol = Math.min(0.45, Math.max(0.05, (intensity || 5) * 0.035));
    // Golpe seco (ruido blanco filtrado)
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(ctx, 0.09, 2.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800 + intensity * 50;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    noise.connect(lp).connect(g).connect(ctx.destination);
    noise.start(t);
    // Tono grave subrayando el impacto
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.08);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.6, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(og).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.09);
}

function playBounce(intensity) {
    if (soundMuted) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const t = ctx.currentTime;
    const vol = Math.min(0.30, Math.max(0.03, (intensity || 4) * 0.025));
    // Tic agudo metalico
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(900 + Math.random() * 200, t);
    osc.frequency.exponentialRampToValueAtTime(400, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.07);
}

function playGoalSound() {
    if (soundMuted) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const t = ctx.currentTime;
    // Pitido de gol (silbato sintetizado)
    const w = ctx.createOscillator();
    w.type = 'sine';
    w.frequency.setValueAtTime(2200, t);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.18, t);
    wg.gain.exponentialRampToValueAtTime(0.001, t + 0.30);
    w.connect(wg).connect(ctx.destination);
    w.start(t); w.stop(t + 0.32);
    // Acordes ascendentes triunfales
    [0, 4, 7, 12].forEach((semis, idx) => {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 220 * Math.pow(2, semis / 12);
        const g = ctx.createGain();
        const start = t + 0.18 + idx * 0.12;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(0.18, start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, start + 0.65);
        osc.connect(g).connect(ctx.destination);
        osc.start(start); osc.stop(start + 0.7);
    });
    // Rugido afición (ruido blanco con bandpass que sube y baja)
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoiseBuffer(ctx, 1.2, 0.5);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t + 0.20);
    ng.gain.linearRampToValueAtTime(0.10, t + 0.45);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.40);
    noise.connect(bp).connect(ng).connect(ctx.destination);
    noise.start(t + 0.20);
}

function playUiClick() {
    if (soundMuted) return;
    const ctx = getAudioCtx(); if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(600, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.08);
}

function setMuted(value) {
    soundMuted = !!value;
    try { localStorage.setItem('chapitas:muted', soundMuted ? '1' : '0'); } catch (_) {}
    const btn = document.getElementById('sound-btn');
    if (btn) btn.textContent = soundMuted ? '🔇' : '🔊';
}

// ================================================================
// PERSISTENCIA (localStorage): stats, skin recordado, trofeos
// ================================================================
const STATE_KEY = 'chapitas:state';
const DEFAULT_STATE = {
    lastSkin: 0,
    stats: {
        games: 0, wins: 0, losses: 0, ties: 0,
        goalsFor: 0, goalsAgainst: 0,
        bestStreak: 0, currentStreak: 0,
        byBot: {}     // jorge: {wins, losses}, etc.
    },
    trophies: []   // ids desbloqueados
};

function loadState() {
    try {
        const raw = localStorage.getItem(STATE_KEY);
        if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
        const parsed = JSON.parse(raw);
        return Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), parsed, {
            stats: Object.assign({}, DEFAULT_STATE.stats, parsed.stats || {}),
            trophies: parsed.trophies || []
        });
    } catch (_) { return JSON.parse(JSON.stringify(DEFAULT_STATE)); }
}
function saveState() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(persistState)); } catch (_) {}
}

const persistState = loadState();

const TROPHIES = [
    { id: 'first_goal',    name: 'PRIMER GOL',          desc: 'Marca tu primer gol',           emoji: '⚽' },
    { id: 'first_win',     name: 'PRIMERA VICTORIA',    desc: 'Gana tu primer partido',        emoji: '🥇' },
    { id: 'hat_trick',     name: 'HAT-TRICK',           desc: '3 goles en una partida',        emoji: '🎩' },
    { id: 'clean_sheet',   name: 'PORTERIA A CERO',     desc: 'Gana sin encajar',              emoji: '🛡️' },
    { id: 'beat_jorge',    name: 'VOMITIVO DERROTADO',  desc: 'Vence a Maverick',              emoji: '🤮' },
    { id: 'beat_querol',   name: 'MAESTRO VENCIDO',     desc: 'Vence a Querooool',             emoji: '🎉' },
    { id: 'beat_marcos',   name: 'SEBO MASTER FUERA',   desc: 'Vence a Ketes (difícil)',       emoji: '⚔️' },
    { id: 'streak_3',      name: 'RACHA CALIENTE',      desc: '3 victorias seguidas',          emoji: '🔥' },
    { id: 'games_10',      name: 'VETERANO',            desc: '10 partidas jugadas',           emoji: '🎮' },
    { id: 'games_50',      name: 'ADICTO',              desc: '50 partidas jugadas',           emoji: '🎯' },
    { id: 'diana_master',  name: 'DIANA EXPERTA',       desc: 'Suma 20+ pts en modo Diana',    emoji: '🎯' }
];

function unlockTrophy(id) {
    if (persistState.trophies.includes(id)) return false;
    persistState.trophies.push(id);
    saveState();
    const t = TROPHIES.find(x => x.id === id);
    if (t) showTrophyToast(t);
    return true;
}

function recordMatchResult(matchData) {
    // matchData = { won, lost, tied, scoreFor, scoreAgainst, botId, mode }
    const s = persistState.stats;
    s.games++;
    if (matchData.won)  { s.wins++;   s.currentStreak++;  s.bestStreak = Math.max(s.bestStreak, s.currentStreak); }
    if (matchData.lost) { s.losses++; s.currentStreak = 0; }
    if (matchData.tied) { s.ties++; }
    s.goalsFor     += matchData.scoreFor || 0;
    s.goalsAgainst += matchData.scoreAgainst || 0;
    if (matchData.botId) {
        const b = s.byBot[matchData.botId] || { wins: 0, losses: 0 };
        if (matchData.won)  b.wins++;
        if (matchData.lost) b.losses++;
        s.byBot[matchData.botId] = b;
    }
    saveState();

    // Trofeos
    if ((matchData.scoreFor || 0) >= 1)               unlockTrophy('first_goal');
    if (matchData.won)                                unlockTrophy('first_win');
    if ((matchData.scoreFor || 0) >= 3)               unlockTrophy('hat_trick');
    if (matchData.won && matchData.scoreAgainst === 0) unlockTrophy('clean_sheet');
    if (matchData.won && matchData.botId === 'jorge')  unlockTrophy('beat_jorge');
    if (matchData.won && matchData.botId === 'querol') unlockTrophy('beat_querol');
    if (matchData.won && matchData.botId === 'marcos') unlockTrophy('beat_marcos');
    if (s.currentStreak >= 3)                          unlockTrophy('streak_3');
    if (s.games >= 10)                                 unlockTrophy('games_10');
    if (s.games >= 50)                                 unlockTrophy('games_50');
}

function showTrophyToast(trophy) {
    const cont = document.getElementById('trophy-toasts');
    if (!cont) return;
    const el = document.createElement('div');
    el.className = 'trophy-toast';
    el.innerHTML = `
        <div class="trophy-toast-emoji">${trophy.emoji}</div>
        <div class="trophy-toast-text">
            <div class="trophy-toast-label">TROFEO DESBLOQUEADO</div>
            <div class="trophy-toast-name">${trophy.name}</div>
            <div class="trophy-toast-desc">${trophy.desc}</div>
        </div>`;
    cont.appendChild(el);
    requestAnimationFrame(() => el.classList.add('shown'));
    setTimeout(() => {
        el.classList.remove('shown');
        setTimeout(() => el.remove(), 400);
    }, 3500);
}

// ================================================================
// ESTADO
// ================================================================
let ball;                             // primer (o unico) balon
let balls = [];                       // todos los balones (1 en modo normal, 2 en caos)
let discs = [];                       // [...players.red, ...players.blue, ...balls]  -- indexable estable
let players = { red: [], blue: [] };
let initialPositions = new Map();

let score = { red: 0, blue: 0 };
let currentTeam = 'red';
let pendingGoal = null;

let selectedDisc = null;
let isAiming = false;

let aimGfx, highlightGfx, trailGfx;
let goalNets = { left: null, right: null };
let confettiEmitter;

let activeTrail = null;
let lastImpactTime = 0;
let awaitingSync = false;

let gameState = 'WAITING_FOR_INPUT';   // WAITING_FOR_INPUT | PHYSICS_SIMULATION | MATCH_END
let phaserScene = null;
let phaserGame  = null;
let goalsToWin  = 3;

// Inteligencia artificial (modo local)
let aiLevel    = 'medium';     // 'easy' | 'medium' | 'hard'
let aiThinking = false;        // hay un timeout pendiente de jugar
let aiTimer    = null;
let currentBot = null;         // bot elegido en local (BOTS[...])

// === Red ===
const net = {
    mode: 'local',                    // 'local' | 'host' | 'client'
    peer: null,
    conn: null,
    myTeam: 'red',
    connected: false
};

const dom = {
    state:        document.getElementById('state-label'),
    scoreRed:     document.getElementById('score-red'),
    scoreBlue:    document.getElementById('score-blue'),
    hint:         document.getElementById('hint-text'),
    netBadge:     document.getElementById('net-badge'),
    matchEnd:     document.getElementById('match-end'),
    matchEndWin:  document.getElementById('match-end-winner'),
    endScoreRed:  document.getElementById('end-score-red'),
    endScoreBlue: document.getElementById('end-score-blue'),
    backToMenu:   document.getElementById('back-to-menu-btn')
};

function setState(s) {
    gameState = s;
    if (dom.state) dom.state.textContent = s;
}

function updateUI() {
    const mode = GAME_MODES[currentMode];
    if (mode && mode.isKnockout) {
        // En Knockout el "marcador" muestra chapas restantes de cada equipo
        dom.scoreRed.textContent  = (players.red  || []).length;
        dom.scoreBlue.textContent = (players.blue || []).length;
    } else if (mode && mode.isDiana) {
        // En Diana el "rojo" muestra los puntos acumulados; el "azul" no aplica
        dom.scoreRed.textContent  = dianaScore;
        dom.scoreBlue.textContent = '–';
    } else {
        dom.scoreRed.textContent  = score.red;
        dom.scoreBlue.textContent = score.blue;
    }

    if (mode && mode.isDiana) {
        const total = mode.attempts || 5;
        const remaining = total - dianaAttempt;
        dom.hint.textContent = 'DIANA · intento ' + (dianaAttempt + 1) + '/' + total +
            ' · puntos: ' + dianaScore + (remaining > 1 ? '' : ' · ULTIMO!');
        return;
    }
    if (net.mode === 'local') {
        if (currentBot) {
            // vs bot
            if (currentTeam === 'blue') {
                dom.hint.textContent = 'Turno de ' + currentBot.displayName + ' · pensando…';
            } else {
                dom.hint.textContent = 'Tu turno · arrastra una chapa propia y suelta';
            }
        } else {
            // 1 pa 1 en el mismo PC, ambos turnos son humanos
            const team = currentTeam === 'red' ? 'ROJO' : 'AZUL';
            dom.hint.textContent = 'Turno del equipo ' + team + ' · arrastra y suelta';
        }
    } else {
        const youTurn = currentTeam === net.myTeam;
        dom.hint.textContent = youTurn
            ? 'Tu turno · arrastra una chapa propia y suelta'
            : 'Turno del rival · espera tu jugada';
    }
}

// ================================================================
// MENU + ARRANQUE
// ================================================================
const menu       = document.getElementById('menu');
const menuCard   = document.getElementById('menu-card');
const gameScreen = document.getElementById('game-screen');
const fade       = document.getElementById('fade');
const avatarsEl  = document.getElementById('avatars');

const playLocalBtn = document.getElementById('play-btn-local');
const playHostBtn  = document.getElementById('play-btn-host');
const playJoinBtn  = document.getElementById('play-btn-join');

const hostPanel   = document.getElementById('host-panel');
const joinPanel   = document.getElementById('join-panel');
const hostCodeEl  = document.getElementById('host-code');
const hostStatus  = document.getElementById('host-status');
const joinStatus  = document.getElementById('join-status');
const joinCodeInp = document.getElementById('join-code-input');
const joinConnectBtn = document.getElementById('join-connect-btn');
const copyCodeBtn = document.getElementById('copy-code-btn');

// ----- Skins -----
const PLAYER_FILES  = ['alex', 'cesar', 'dolera', 'jorge', 'llorca', 'marcos', 'martin', 'nacho', 'querol', 'yared'];
const PLAYER_LABELS = [
    'Alexander Dolgopolov',
    'Cesar "Madman"',
    'Odlera',
    'Maverick',
    'Van Bukemer',
    'Ketes',
    'Martinator',
    'Nacho "El Loco"',
    'Queroooool',
    'Yaresito'
];
// Logo de TURBO unico por skin: cada chapa tiene su sello
const PLAYER_TURBO_ICONS = ['🐲', '🦁', '🐺', '🤮', '🦅', '👑', '🤖', '🔥', '⚔️', '⚡'];
const AVATAR_COUNT = PLAYER_FILES.length;
const AVATAR_IMAGES = new Array(AVATAR_COUNT).fill(null);
let selectedSkin = 0;
let opponentSkin = 5;            // en local: el rival usa otro skin distinto

function loadAvatars() {
    const exts = ['webp', 'png', 'jpg', 'jpeg'];
    const tasks = PLAYER_FILES.map((name, i) => new Promise((resolve) => {
        let extIdx = 0;
        const tryNext = () => {
            if (extIdx >= exts.length) { resolve(); return; }
            const img = new Image();
            img.onload = () => { AVATAR_IMAGES[i] = img; resolve(); };
            img.onerror = () => { extIdx++; tryNext(); };
            img.src = `assets/${name}.${exts[extIdx]}`;
        };
        tryNext();
    }));
    Promise.all(tasks).then(() => {
        if (AVATAR_IMAGES.some(img => img)) renderAvatarSwatches();
        else avatarsEl.innerHTML = '<div class="avatars-empty">No se encontraron las 10 caras en <b>assets/</b>.<br>El juego usará chapas de color hasta que las añadas.</div>';
    });
}

// Cargamos el ultimo skin elegido (si existe) desde la persistencia
selectedSkin = (typeof persistState.lastSkin === 'number') ? persistState.lastSkin : 0;
let currentIndex = selectedSkin;

function renderAvatarSwatches() {
    avatarsEl.innerHTML = '';
    for (let i = 0; i < AVATAR_COUNT; i++) {
        const img = AVATAR_IMAGES[i];
        if (!img) continue;

        const wrapper = document.createElement('div');
        wrapper.className = 'avatar-swatch';
        wrapper.dataset.skin = String(i);

        const c = document.createElement('canvas');
        c.width = c.height = 80;
        const ctx = c.getContext('2d');
        ctx.save();
        ctx.beginPath();
        ctx.arc(40, 40, 40, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        const aspect = img.naturalWidth / img.naturalHeight;
        let dw, dh, dx, dy;
        if (aspect > 1) { dh = 80; dw = 80 * aspect; dx = (80 - dw) / 2; dy = 0; }
        else            { dw = 80; dh = 80 / aspect; dx = 0; dy = (80 - dh) / 2; }
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();

        const label = document.createElement('span');
        label.className = 'avatar-name';
        label.textContent = PLAYER_LABELS[i];

        wrapper.appendChild(c);
        wrapper.appendChild(label);
        avatarsEl.appendChild(wrapper);
    }
    updateCarousel();
}

function updateCarousel() {
    const items = avatarsEl.querySelectorAll('.avatar-swatch');
    items.forEach((item) => {
        const skin = parseInt(item.dataset.skin);
        let offset = skin - currentIndex;
        if (offset >  AVATAR_COUNT / 2) offset -= AVATAR_COUNT;
        if (offset < -AVATAR_COUNT / 2) offset += AVATAR_COUNT;
        item.dataset.offset = String(offset);
    });
    selectedSkin = currentIndex;
    if (persistState.lastSkin !== currentIndex) {
        persistState.lastSkin = currentIndex;
        saveState();
    }
}

function moveCarousel(delta) {
    currentIndex = (currentIndex + delta + AVATAR_COUNT) % AVATAR_COUNT;
    updateCarousel();
}

// Click sobre un avatar lateral lo lleva al centro
avatarsEl.addEventListener('click', (e) => {
    const target = e.target.closest('.avatar-swatch');
    if (!target) return;
    const offset = parseInt(target.dataset.offset);
    if (!Number.isNaN(offset) && offset !== 0) moveCarousel(offset);
});

// Flechas laterales
document.getElementById('carousel-prev').addEventListener('click', () => moveCarousel(-1));
document.getElementById('carousel-next').addEventListener('click', () => moveCarousel(1));

// Teclado: flechas izq/der mientras el menu este visible y no haya inputs activos.
// Importante: ignorar tambien si el menu esta en modo compact (paneles host/join abiertos),
// porque entonces el carrusel esta oculto y mover el skin a ciegas seria un bug.
window.addEventListener('keydown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menuCard.classList.contains('compact')) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft')  { moveCarousel(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { moveCarousel(1);  e.preventDefault(); }
});

loadAvatars();

// ----- Balon Jabulani -----
let JABULANI_IMG = null;
(function loadJabulani() {
    const exts = ['jpg', 'jpeg', 'png', 'webp'];
    let i = 0;
    const tryNext = () => {
        if (i >= exts.length) return;
        const img = new Image();
        img.onload = () => { JABULANI_IMG = img; };
        img.onerror = () => { i++; tryNext(); };
        img.src = `assets/jabulani.${exts[i]}`;
    };
    tryNext();
})();

// ----- Imagen de la porteria (lateral) -----
let GOAL_IMG = null;
(function loadGoalImage() {
    const exts = ['png', 'webp', 'jpg', 'jpeg'];
    let i = 0;
    const tryNext = () => {
        if (i >= exts.length) return;
        const img = new Image();
        img.onload = () => { GOAL_IMG = img; };
        img.onerror = () => { i++; tryNext(); };
        img.src = `assets/goal.${exts[i]}`;
    };
    tryNext();
})();

// Selector de modo: dos cards que abren modales. El modo elegido se muestra debajo.
const modeBigRow       = document.getElementById('mode-bigrow');
const currentModeName  = document.getElementById('current-mode-name');
const modalNormal      = document.getElementById('modal-normal');
const modalOther       = document.getElementById('modal-other');

function updateModeUI() {
    const m = GAME_MODES[currentMode];
    currentModeName.textContent = (m && m.label) ? m.label : '—';
}

modeBigRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-big');
    if (!btn) return;
    if (btn.dataset.group === 'normal') modalNormal.classList.remove('hidden');
    else                                  modalOther.classList.remove('hidden');
});

[modalNormal, modalOther].forEach(modal => {
    modal.addEventListener('click', (e) => {
        // Click sobre el fondo del modal cierra
        if (e.target === modal) { modal.classList.add('hidden'); return; }
        const closeBtn = e.target.closest('[data-modal-close]');
        if (closeBtn) { document.getElementById(closeBtn.dataset.modalClose).classList.add('hidden'); return; }
        const opt = e.target.closest('.mode-modal-opt');
        if (!opt) return;
        if (opt.classList.contains('disabled')) return;
        const mode = opt.dataset.mode;
        if (!GAME_MODES[mode]) return;
        currentMode = mode;
        goalsToWin  = GAME_MODES[mode].goalsToWin || 3;
        modal.classList.add('hidden');
        updateModeUI();
    });
});

updateModeUI();

dom.backToMenu.addEventListener('click', returnToMenu);

document.getElementById('exit-match-btn').addEventListener('click', () => {
    playUiClick();
    const msg = net.mode === 'local'
        ? '¿Volver al menú? Se perderá la partida actual.'
        : '¿Salir al menú? La conexión con el rival se cerrará.';
    if (window.confirm(msg)) returnToMenu();
});

// Pantalla de trofeos
const trophiesBtn    = document.getElementById('trophies-btn');
const trophiesScreen = document.getElementById('trophies-screen');
const trophiesGrid   = document.getElementById('trophies-grid');
const trophiesStats  = document.getElementById('trophies-stats');

function renderTrophies() {
    const s = persistState.stats;
    const winRate = s.games > 0 ? Math.round((s.wins / s.games) * 100) : 0;
    trophiesStats.innerHTML =
        `<b>${s.games}</b> partidas · <b>${s.wins}</b> ganadas · <b>${s.losses}</b> perdidas` +
        (s.ties ? ` · <b>${s.ties}</b> empates` : '') +
        ` · ${winRate}% · ⚽ <b>${s.goalsFor}</b>:<b>${s.goalsAgainst}</b>` +
        (s.bestStreak ? ` · 🔥 racha <b>${s.bestStreak}</b>` : '');

    trophiesGrid.innerHTML = '';
    for (const t of TROPHIES) {
        const unlocked = persistState.trophies.includes(t.id);
        const card = document.createElement('div');
        card.className = 'trophy-card ' + (unlocked ? 'unlocked' : 'locked');
        card.innerHTML =
            `<div class="trophy-card-emoji">${unlocked ? t.emoji : '🔒'}</div>` +
            `<div class="trophy-card-text">` +
                `<div class="trophy-card-name">${t.name}</div>` +
                `<div class="trophy-card-desc">${t.desc}</div>` +
            `</div>`;
        trophiesGrid.appendChild(card);
    }
}

trophiesBtn.addEventListener('click', () => {
    renderTrophies();
    trophiesScreen.classList.remove('hidden');
});
document.getElementById('trophies-close').addEventListener('click', () => {
    trophiesScreen.classList.add('hidden');
});
trophiesScreen.addEventListener('click', (e) => {
    if (e.target === trophiesScreen) trophiesScreen.classList.add('hidden');
});

// Habilidad TURBO
const turboBtn      = document.getElementById('turbo-btn');
const turboIconEl   = document.getElementById('turbo-icon');
const turboIndRedEl = document.getElementById('turbo-indicator-red');
const turboIndBluEl = document.getElementById('turbo-indicator-blue');

// Devuelve el emoji de turbo asociado a un equipo segun su skin
function turboIconForTeam(team) {
    return PLAYER_TURBO_ICONS[skinFor(team)] || '⚡';
}

// Refresca los dos indicadores del marcador (rojo / azul) con su logo y estado
function updateTurboIndicators() {
    if (turboIndRedEl) {
        turboIndRedEl.textContent = turboIconForTeam('red');
        turboIndRedEl.classList.toggle('used', !!abilityUsed.red);
    }
    if (turboIndBluEl) {
        turboIndBluEl.textContent = turboIconForTeam('blue');
        turboIndBluEl.classList.toggle('used', !!abilityUsed.blue);
    }
}

function updateTurboButton() {
    updateTurboIndicators();
    if (!turboBtn) return;
    const inMatch = !gameScreen.classList.contains('hidden') && phaserGame;
    if (!inMatch) { turboBtn.classList.add('hidden'); return; }
    const myTeam = (net.mode === 'local' && !currentBot) ? currentTeam : (net.myTeam || 'red');
    const isMyTurn = (net.mode === 'local' && !currentBot)
        ? true
        : (currentTeam === (net.mode === 'local' ? 'red' : net.myTeam));
    const used = abilityUsed[myTeam];

    // Logo del turbo segun el skin del equipo activo (cambia al alternar turnos en local PvP)
    if (turboIconEl) turboIconEl.textContent = turboIconForTeam(myTeam);

    if (gameState !== 'WAITING_FOR_INPUT' || !isMyTurn || used) {
        turboBtn.classList.add('hidden');
        turboBtn.classList.remove('armed');
        return;
    }
    turboBtn.classList.remove('hidden', 'used');
    turboBtn.classList.toggle('armed', abilityArmed);
}
if (turboBtn) {
    turboBtn.addEventListener('click', () => {
        const myTeam = (net.mode === 'local' && !currentBot) ? currentTeam : (net.myTeam || 'red');
        if (abilityUsed[myTeam]) return;
        abilityArmed = !abilityArmed;
        updateTurboButton();
    });
}

// Toggle de sonido
const soundBtn = document.getElementById('sound-btn');
if (soundBtn) {
    soundBtn.textContent = soundMuted ? '🔇' : '🔊';
    soundBtn.addEventListener('click', () => {
        setMuted(!soundMuted);
        if (!soundMuted) playUiClick();
    });
}

// Click sonoro en botones principales del menu (delegado)
document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#play-btn-local, #play-btn-host, #play-btn-join, #join-connect-btn, ' +
                   '.bot-option, #pvp-btn, .mode-big, .mode-modal-opt, ' +
                   '.back-btn, .copy-btn, .play-btn, #back-to-menu-btn')) {
        playUiClick();
    }
}, true);

// --- Tutorial inicial (solo si no se ha visto antes) ---
const tutorialOverlay = document.getElementById('tutorial-overlay');
const tutorialCloseBtn = document.getElementById('tutorial-close');
function showTutorialIfNeeded() {
    if (!tutorialOverlay) return;
    if (persistState.tutorialSeen) return;
    // Si el usuario ya tiene partidas registradas (de versiones previas sin tutorial),
    // damoslo por visto silenciosamente para no estorbar.
    if (persistState.stats && persistState.stats.games > 0) {
        persistState.tutorialSeen = true;
        saveState();
        return;
    }
    tutorialOverlay.classList.remove('hidden');
}
function dismissTutorial() {
    if (!tutorialOverlay) return;
    tutorialOverlay.classList.add('fading-out');
    setTimeout(() => {
        tutorialOverlay.classList.add('hidden');
        tutorialOverlay.classList.remove('fading-out');
    }, 320);
    persistState.tutorialSeen = true;
    saveState();
}
if (tutorialCloseBtn) {
    tutorialCloseBtn.addEventListener('click', () => {
        playUiClick();
        dismissTutorial();
    });
}
showTutorialIfNeeded();

// --- Selector de clima ---
const weatherRow = document.getElementById('weather-row');
if (weatherRow) {
    weatherRow.addEventListener('click', (e) => {
        const chip = e.target.closest('.weather-chip');
        if (!chip) return;
        const w = chip.dataset.weather;
        if (!WEATHERS[w]) return;
        currentWeather = w;
        weatherRow.querySelectorAll('.weather-chip').forEach(c => c.classList.toggle('active', c === chip));
        playUiClick();
    });
}

// --- Modo local ---
playLocalBtn.addEventListener('click', () => {
    net.mode = 'local';
    net.myTeam = 'red';
    // Diana: solo, sin rival ni bot — arranca directo (sin pantalla de bot select)
    const m = GAME_MODES[currentMode];
    if (m && m.isDiana) {
        currentBot = null;
        opponentSkin = selectedSkin;
        transitionToGame(() => startGame());
        return;
    }
    showBotSelect();
});

// --- Modo host ---
playHostBtn.addEventListener('click', () => {
    showPanel('host');
    hostStatus.textContent = 'Inicializando…';
    hostStatus.className = 'net-status';
    hostCodeEl.textContent = '…';
    setupHost();
});

// --- Modo join ---
playJoinBtn.addEventListener('click', () => {
    showPanel('join');
    joinStatus.textContent = ' ';
    joinStatus.className = 'net-status';
    joinCodeInp.value = '';
    joinCodeInp.focus();
});

joinConnectBtn.addEventListener('click', () => {
    const id = joinCodeInp.value.trim();
    if (!id) {
        joinStatus.textContent = 'Introduce un código.';
        joinStatus.className = 'net-status err';
        return;
    }
    setupClient(id);
});

joinCodeInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinConnectBtn.click();
});

copyCodeBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(hostCodeEl.textContent);
        copyCodeBtn.textContent = 'COPIADO';
        setTimeout(() => { copyCodeBtn.textContent = 'COPIAR'; }, 1500);
    } catch (_) { /* ignore */ }
});

document.querySelectorAll('[data-back]').forEach(btn => {
    btn.addEventListener('click', () => {
        cleanupNet();
        showPanel(null);
    });
});

function showPanel(which) {
    hostPanel.classList.remove('visible');
    joinPanel.classList.remove('visible');
    menuCard.classList.remove('compact');
    if (which === 'host') { hostPanel.classList.add('visible'); menuCard.classList.add('compact'); }
    if (which === 'join') { joinPanel.classList.add('visible'); menuCard.classList.add('compact'); }
}

function transitionToGame(startCallback) {
    fade.classList.add('active');
    setTimeout(() => {
        menu.classList.add('hidden');
        gameScreen.classList.remove('hidden');
        if (trophiesBtn) trophiesBtn.classList.add('hidden');
        startCallback();
        setTimeout(() => fade.classList.remove('active'), 80);
    }, 320);
}

function startGame() {
    if (net.mode !== 'local') {
        dom.netBadge.textContent = net.mode === 'host' ? 'ONLINE · HOST' : 'ONLINE · CLIENTE';
        dom.netBadge.classList.add('visible');
    }

    // Forzamos CANVAS en vez de WebGL: al abrir por file:// las imagenes locales
    // (assets/*.webp) "tainted-ean" el canvas y WebGL las rechaza con texImage2D.
    // Canvas 2D acepta drawImage de imagenes locales sin problema.
    phaserGame = new Phaser.Game({
        type: Phaser.CANVAS,
        width: FIELD_W,
        height: FIELD_H,
        parent: 'game-container',
        backgroundColor: '#0a1208',
        physics: { default: 'matter', matter: { gravity: { x: 0, y: 0 }, debug: false } },
        scene: { create, update }
    });
    updateUI();
}

// ================================================================
// RED (PeerJS)
// ================================================================
// Servidores ICE: STUN de Google + TURN public de Open Relay como fallback.
// El TURN actua de relay cuando STUN no consigue atravesar el NAT.
const PEER_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// Genera codigo corto (6 chars sin caracteres ambiguos: sin 0/O, 1/I)
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SHORT_CODE_PREFIX   = 'CHAP-';
function generateShortCode() {
    let s = '';
    for (let i = 0; i < 6; i++) {
        s += SHORT_CODE_ALPHABET[Math.floor(Math.random() * SHORT_CODE_ALPHABET.length)];
    }
    return s;
}
// Normaliza una entrada del usuario a id PeerJS completo: acepta "AB12CD" o "CHAP-AB12CD".
function normalizeShortCode(raw) {
    if (!raw) return '';
    const up = raw.trim().toUpperCase().replace(/\s+/g, '');
    if (up.startsWith(SHORT_CODE_PREFIX)) return up;
    return SHORT_CODE_PREFIX + up;
}

function setupHost(retryCount) {
    retryCount = retryCount || 0;
    net.mode = 'host';
    net.myTeam = 'red';

    const shortCode = generateShortCode();
    const peerId = SHORT_CODE_PREFIX + shortCode;
    net.peer = new Peer(peerId, { config: PEER_CONFIG, debug: 1 });
    net.peer.on('open', (id) => {
        // Mostramos solo la parte corta (mas facil de compartir verbalmente)
        const display = id.startsWith(SHORT_CODE_PREFIX) ? id.slice(SHORT_CODE_PREFIX.length) : id;
        hostCodeEl.textContent = display;
        hostStatus.textContent = 'Esperando rival…';
    });
    net.peer.on('connection', (conn) => {
        net.conn = conn;
        wireConn(conn);
        conn.on('open', () => {
            net.connected = true;
            hostStatus.textContent = 'Rival conectado…';
            hostStatus.className = 'net-status ok';
            // Esperamos el hello del cliente (con su skin) para enviar init y arrancar.
        });
    });
    net.peer.on('error', (err) => {
        // Si el codigo corto colisiono, retry con uno nuevo (max 3 intentos)
        if (err && err.type === 'unavailable-id' && retryCount < 3) {
            try { net.peer.destroy(); } catch (_) {}
            setupHost(retryCount + 1);
            return;
        }
        hostStatus.textContent = 'Error: ' + (err.type || err.message || 'desconocido');
        hostStatus.className = 'net-status err';
    });
}

function setupClient(hostId) {
    net.mode = 'client';
    net.myTeam = 'blue';

    joinStatus.textContent = 'Conectando…';
    joinStatus.className = 'net-status';
    joinConnectBtn.disabled = true;

    const fullId = normalizeShortCode(hostId);
    net.peer = new Peer({ config: PEER_CONFIG, debug: 1 });
    net.peer.on('open', () => {
        const conn = net.peer.connect(fullId, { reliable: true });
        net.conn = conn;
        wireConn(conn);
        conn.on('open', () => {
            net.connected = true;
            joinStatus.textContent = 'Conectado, enviando datos…';
            joinStatus.className = 'net-status ok';
            sendNet({ type: 'hello', skin: selectedSkin });
        });
    });
    net.peer.on('error', (err) => {
        joinStatus.textContent = 'Error: ' + (err.type || err.message || 'desconocido');
        joinStatus.className = 'net-status err';
        joinConnectBtn.disabled = false;
    });
}

function wireConn(conn) {
    conn.on('data', (msg) => onNetMessage(msg));
    conn.on('close', () => {
        net.connected = false;
        if (dom.netBadge) {
            dom.netBadge.textContent = 'DESCONECTADO';
            dom.netBadge.classList.add('warning');
        }
        // Si estabamos en partida, mostramos fin de partida con aviso para no atascarnos
        if (phaserGame && gameState !== 'MATCH_END') {
            showOpponentDisconnected();
        }
    });
    conn.on('error', (err) => console.warn('PeerJS conn error:', err));
}

function showOpponentDisconnected() {
    setState('MATCH_END');
    isAiming = false;
    selectedDisc = null;
    activeTrail = null;
    if (aimGfx)   aimGfx.clear();
    if (trailGfx) trailGfx.clear();
    dom.matchEndWin.textContent = 'RIVAL DESCONECTADO';
    dom.matchEndWin.style.color = '#ffaa55';
    dom.matchEndWin.style.textShadow = '0 0 30px rgba(255,170,85,0.7)';
    dom.endScoreRed.textContent  = score.red;
    dom.endScoreBlue.textContent = score.blue;
    dom.matchEnd.classList.add('visible');
}

function cleanupNet() {
    if (net.conn) { try { net.conn.close(); } catch (_) {} }
    if (net.peer) { try { net.peer.destroy(); } catch (_) {} }
    net.conn = null;
    net.peer = null;
    net.connected = false;
    net.mode = 'local';
    net.myTeam = 'red';
}

function sendNet(msg) {
    if (net.conn && net.connected) {
        try { net.conn.send(msg); } catch (e) { console.warn(e); }
    }
}

function onNetMessage(msg) {
    if (!msg || !msg.type) return;

    // Host recibe el skin del cliente, devuelve init y ambos arrancan
    if (msg.type === 'hello' && net.mode === 'host') {
        opponentSkin = typeof msg.skin === 'number' ? msg.skin : 5;
        sendNet({ type: 'init', goalsToWin, hostSkin: selectedSkin, clientSkin: opponentSkin });
        setTimeout(() => transitionToGame(() => startGame()), 350);
        return;
    }

    // Cliente: el host envia la configuracion (skins, goles a ganar) y el cliente arranca
    if (msg.type === 'init' && net.mode === 'client') {
        opponentSkin = typeof msg.hostSkin === 'number' ? msg.hostSkin : 0;
        selectedSkin = typeof msg.clientSkin === 'number' ? msg.clientSkin : selectedSkin;
        goalsToWin = msg.goalsToWin || 3;
        transitionToGame(() => startGame());
        return;
    }

    if (msg.type === 'shoot') {
        applyRemoteShoot(msg);
        return;
    }

    if (msg.type === 'sync' && net.mode === 'client') {
        applySync(msg);
        return;
    }
}

function applyRemoteShoot(msg) {
    if (gameState !== 'WAITING_FOR_INPUT') return;   // ignorar disparos tardios o tras match end
    const disc = discs[msg.idx];
    if (!disc) return;
    // Sanidad: el remoto solo puede mover su equipo
    const remoteTeam = net.mode === 'host' ? 'blue' : 'red';
    if (disc.label !== 'ball' && disc.team !== remoteTeam) return;
    if (currentTeam !== remoteTeam) return;

    disc.setVelocity(msg.vx, msg.vy);
    if (msg.trail) activeTrail = { disc, points: [] };
    setState('PHYSICS_SIMULATION');
}

function applySync(msg) {
    const Body = Phaser.Physics.Matter.Matter.Body;
    msg.bodies.forEach((b, i) => {
        const d = discs[i];
        if (!d) return;
        Body.setPosition(d.body, { x: b.x, y: b.y });
        Body.setVelocity(d.body, { x: 0, y: 0 });
        Body.setAngularVelocity(d.body, 0);
    });
    score = { ...msg.score };
    currentTeam = msg.currentTeam;
    pendingGoal = null;
    selectedDisc = null;
    isAiming = false;
    activeTrail = null;
    if (trailGfx) trailGfx.clear();
    if (aimGfx)   aimGfx.clear();
    awaitingSync = false;
    updateUI();
    if (msg.gameOver) {
        setState('MATCH_END');
        showMatchEnd(msg.gameOver);
    } else {
        setState('WAITING_FOR_INPUT');
    }
}

function buildSync() {
    return {
        type: 'sync',
        bodies: discs.map(d => ({ x: d.x, y: d.y })),
        score: { ...score },
        currentTeam
    };
}

// ================================================================
// ESCENA
// ================================================================
function create() {
    phaserScene = this;
    // Reset de habilidad por partida
    abilityUsed = { red: false, blue: false };
    abilityArmed = false;

    createGrassTexture(this);
    const redSkin  = skinFor('red');
    const blueSkin = skinFor('blue');
    if (AVATAR_IMAGES[redSkin])  createAvatarDiscTexture(this, 'disc-red',  redSkin,  hexNum(TEAM_COLORS.red.fill));
    else                         createDiscTexture(this, 'disc-red',  PLAYER_RADIUS, TEAM_COLORS.red.fill);
    if (AVATAR_IMAGES[blueSkin]) createAvatarDiscTexture(this, 'disc-blue', blueSkin, hexNum(TEAM_COLORS.blue.fill));
    else                         createDiscTexture(this, 'disc-blue', PLAYER_RADIUS, TEAM_COLORS.blue.fill);
    if (JABULANI_IMG) createBallTexture(this);
    else              createDiscTexture(this, 'disc-ball', BALL_RADIUS, 0xffffff, true);
    createConfettiTexture(this);
    createShadowTexture(this);

    drawStadium(this);

    const mode = GAME_MODES[currentMode] || GAME_MODES.normal3;

    // En Knockout no hay paredes (las chapas pueden salir y desaparecer) ni porterias ni balon.
    if (!mode.isKnockout) {
        buildTopBottomWalls(this);
        // En Diana solo hay porteria derecha (objetivo)
        if (!mode.isDiana) buildGoal(this, 'left');
        buildGoal(this, 'right');
        if (!mode.isDiana) drawGoalDecor(this, 'left');
        drawGoalDecor(this, 'right');
    }

    if (mode.isFreekick) {
        freekickRound = 1;
        freekickShots = 0;
        spawnFreekickRound(this, 'red', 1);
    } else if (mode.isKnockout) {
        // Knockout: equipos en formacion pero sin balon
        spawnTeam(this, 'red');
        spawnTeam(this, 'blue');
        balls = [];
        ball = null;
        discs = [...players.red, ...players.blue];
    } else if (mode.isDiana) {
        dianaAttempt = 0;
        dianaScore = 0;
        dianaZones = buildDianaZones();
        drawDianaZones(this);
        spawnDianaAttempt(this);
    } else {
        spawnTeam(this, 'red');
        spawnTeam(this, 'blue');
        spawnBalls(this, mode.ballCount || 1);
        discs = [...players.red, ...players.blue, ...balls];
    }

    createGoalParticles(this);
    trailGfx     = this.add.graphics().setDepth(8);
    highlightGfx = this.add.graphics().setDepth(15);
    aimGfx       = this.add.graphics().setDepth(15);

    setupWallBounceCorrection(this);
    if (!mode.isKnockout) setupGoalDetection(this);   // Knockout no tiene sensor de gol
    setupImpactDetection(this);

    setupInput(this);
    applyWeatherPhysics();

    updateUI();
    updatePlayerInfo();

    // Popup "VS" al inicio del partido
    triggerVsPopup();
}

// Modula la friccion del aire segun el clima: lluvia y nieve hacen las chapas mas
// resbaladizas. Se llama tras crear los cuerpos.
function applyWeatherPhysics() {
    let mult = 1.0;
    if (currentWeather === 'rain') mult = 0.65;
    else if (currentWeather === 'snow') mult = 0.55;
    if (mult === 1.0) return;
    for (const d of discs) {
        if (!d.body) continue;
        const isBall = d.body.label === 'ball';
        const base = isBall ? FRICTION_AIR_BALL : FRICTION_AIR_PLAYER;
        d.body.frictionAir = base * mult;
    }
}

function triggerVsPopup() {
    const redSkin  = skinFor('red');
    const blueSkin = skinFor('blue');
    let redName, blueName;
    if (net.mode === 'local') {
        redName  = PLAYER_LABELS[selectedSkin] || 'Tú';
        blueName = currentBot ? currentBot.displayName : (PLAYER_LABELS[opponentSkin] || 'Rival');
    } else if (net.myTeam === 'red') {
        redName  = PLAYER_LABELS[selectedSkin] || 'Tú';
        blueName = PLAYER_LABELS[opponentSkin] || 'Rival';
    } else {
        redName  = PLAYER_LABELS[opponentSkin] || 'Rival';
        blueName = PLAYER_LABELS[selectedSkin] || 'Tú';
    }
    showVsPopup(redSkin, blueSkin, redName, blueName);
}

function showVsPopup(redSkin, blueSkin, redName, blueName) {
    const popup     = document.getElementById('vs-popup');
    const left      = document.getElementById('vs-left');
    const right     = document.getElementById('vs-right');
    const text      = document.getElementById('vs-text');
    const photoL    = document.getElementById('vs-photo-left');
    const photoR    = document.getElementById('vs-photo-right');
    const nameL     = document.getElementById('vs-name-left');
    const nameR     = document.getElementById('vs-name-right');
    if (!popup) return;

    // Reset
    left.classList.remove('shown');
    right.classList.remove('shown');
    text.classList.remove('shown');
    void text.offsetWidth;     // forza reflow para reiniciar la animacion del VS

    paintMiniAvatar(photoL, redSkin,  '#ff5b5b');
    paintMiniAvatar(photoR, blueSkin, '#5b9eff');
    nameL.textContent = redName;
    nameR.textContent = blueName;

    setState('PRE_MATCH');
    popup.classList.remove('hidden');

    // Secuencia: izq -> VS (con fuerza) -> der
    setTimeout(() => left.classList.add('shown'),  120);
    setTimeout(() => text.classList.add('shown'),  720);
    setTimeout(() => right.classList.add('shown'), 1320);

    setTimeout(() => {
        popup.classList.add('hidden');
        setState('WAITING_FOR_INPUT');
        maybeStartAITurn();    // si toca el bot, que arranque
    }, 2700);
}

// === Marcador del HUD: foto + nombre + tag (bot) ===
function paintMiniAvatar(canvas, skinIndex, ringHex) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) / 2;

    ctx.clearRect(0, 0, W, H);
    const img = AVATAR_IMAGES[skinIndex];
    if (img) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        const aspect = img.naturalWidth / img.naturalHeight;
        const target = (r - 2) * 2;
        let dw, dh;
        if (aspect > 1) { dh = target; dw = target * aspect; }
        else            { dw = target; dh = target / aspect; }
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        ctx.restore();
    } else {
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.strokeStyle = ringHex;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.stroke();
}

function updatePlayerInfo() {
    const redCanvas  = document.getElementById('player-red-photo');
    const blueCanvas = document.getElementById('player-blue-photo');
    const redName    = document.getElementById('player-red-name');
    const blueName   = document.getElementById('player-blue-name');
    const redTag     = document.getElementById('player-red-tag');
    const blueTag    = document.getElementById('player-blue-tag');
    if (!redName || !blueName) return;

    paintMiniAvatar(redCanvas,  skinFor('red'),  '#ff5b5b');
    paintMiniAvatar(blueCanvas, skinFor('blue'), '#5b9eff');

    const _mode = GAME_MODES[currentMode];
    if (_mode && _mode.isDiana) {
        redName.textContent  = PLAYER_LABELS[selectedSkin] || 'Tú';
        blueName.textContent = 'PORTERIA';
        redTag.textContent   = '';
        blueTag.textContent  = '🎯';
        return;
    }
    if (net.mode === 'local') {
        redName.textContent  = PLAYER_LABELS[selectedSkin] || 'Tú';
        blueName.textContent = currentBot ? currentBot.displayName : (PLAYER_LABELS[opponentSkin] || 'Rival');
        redTag.textContent   = '';
        blueTag.textContent  = currentBot ? '(BOT)' : '';
    } else {
        const myName = PLAYER_LABELS[selectedSkin] || 'Tú';
        const opName = PLAYER_LABELS[opponentSkin] || 'Rival';
        if (net.myTeam === 'red') {
            redName.textContent  = myName;
            blueName.textContent = opName;
        } else {
            redName.textContent  = opName;
            blueName.textContent = myName;
        }
        redTag.textContent  = '';
        blueTag.textContent = '';
    }
}

function update(time) {
    drawSelectionHighlight();
    updateGoalNets(time);
    updateTrail();
    updateBallSpin();
    updateShadows();
    updateTurboButton();
    updateKnockoutEliminations();
    updateDynamicCamera();
    updateWeatherDrops(time);

    if (gameState !== 'PHYSICS_SIMULATION') return;
    if (awaitingSync) return;

    if (allStopped()) {
        for (const d of discs) {
            d.setVelocity(0, 0);
            d.setAngularVelocity(0);
        }

        if (net.mode === 'client') {
            // Cliente espera el sync canonico del host
            awaitingSync = true;
            return;
        }

        const mode = GAME_MODES[currentMode] || GAME_MODES.normal3;

        // === Modo Diana: 5 intentos en solitario, suma puntos por zona ===
        if (mode.isDiana) {
            pendingGoal = null;
            selectedDisc = null;
            activeTrail = null;
            trailGfx.clear();
            dianaAttempt++;
            updateUI();
            if (dianaAttempt >= (mode.attempts || 5)) {
                setState('MATCH_END');
                showDianaEnd();
            } else {
                spawnDianaAttempt(phaserScene);
                setState('WAITING_FOR_INPUT');
            }
            return;
        }

        // === Modo Knockout: gana el equipo que conserve chapas ===
        if (mode.isKnockout) {
            selectedDisc = null;
            activeTrail = null;
            trailGfx.clear();

            const redAlive  = players.red.length;
            const blueAlive = players.blue.length;
            if (redAlive === 0 || blueAlive === 0) {
                let winner;
                if (redAlive === 0 && blueAlive === 0) winner = 'tie';
                else if (redAlive > 0) winner = 'red';
                else                   winner = 'blue';
                updateUI();
                setState('MATCH_END');
                if (net.mode === 'host') sendNet({ ...buildSync(), gameOver: winner });
                showMatchEnd(winner);
                return;
            }

            // Cambia turno al equipo rival; si el rival no tiene chapas (raro) lo dejamos igual
            currentTeam = currentTeam === 'red' ? 'blue' : 'red';
            updateUI();
            setState('WAITING_FOR_INPUT');
            if (net.mode === 'host') sendNet(buildSync());
            maybeStartAITurn();
            return;
        }

        // === Modo Tiro libre: rondas con respawn ===
        if (mode.isFreekick) {
            if (pendingGoal) {
                score[pendingGoal] += 1;
                pendingGoal = null;
            }
            selectedDisc = null;
            activeTrail = null;
            trailGfx.clear();

            freekickShots++;
            if (freekickShots >= 2) {
                freekickShots = 0;
                freekickRound++;
            }

            if (freekickRound > 3) {
                // Match end: gana quien tenga mas goles, o empate
                let winner;
                if (score.red > score.blue)       winner = 'red';
                else if (score.blue > score.red)  winner = 'blue';
                else                              winner = 'tie';
                updateUI();
                setState('MATCH_END');
                showMatchEnd(winner);
            } else {
                const nextAttacker = currentTeam === 'red' ? 'blue' : 'red';
                spawnFreekickRound(phaserScene, nextAttacker, freekickRound);
                updateUI();
                setState('WAITING_FOR_INPUT');
                maybeStartAITurn();
            }
            return;
        }

        // === Modo normal/caos/penaltis: lógica habitual de gol/turno ===
        let winner = null;
        if (pendingGoal) {
            score[pendingGoal] += 1;
            const scorer = pendingGoal;
            const conceding = scorer === 'red' ? 'blue' : 'red';
            pendingGoal = null;
            if (score[scorer] >= goalsToWin) {
                winner = scorer;
            } else {
                resetPositions();
                currentTeam = conceding;
            }
        } else {
            currentTeam = currentTeam === 'red' ? 'blue' : 'red';
        }

        selectedDisc = null;
        activeTrail = null;
        trailGfx.clear();
        updateUI();

        if (winner) {
            setState('MATCH_END');
            if (net.mode === 'host') sendNet({ ...buildSync(), gameOver: winner });
            showMatchEnd(winner);
        } else {
            setState('WAITING_FOR_INPUT');
            if (net.mode === 'host') sendNet(buildSync());
            maybeStartAITurn();
        }
    }
}

function allStopped() {
    for (const d of discs) {
        const v = d.body.velocity;
        if (Math.hypot(v.x, v.y) >= STOP_THRESH) return false;
    }
    return true;
}

// === KNOCKOUT ===
// Elimina una chapa: la quita de discs, players, su sombra y la destruye.
function eliminateDisc(disc) {
    if (!disc || disc._eliminated) return;
    disc._eliminated = true;
    const team = disc.team;
    const ex = disc.x, ey = disc.y;
    if (team && players[team]) {
        const i = players[team].indexOf(disc);
        if (i >= 0) players[team].splice(i, 1);
    }
    const j = discs.indexOf(disc);
    if (j >= 0) discs.splice(j, 1);
    if (selectedDisc === disc) selectedDisc = null;
    if (activeTrail && activeTrail.disc === disc) activeTrail = null;
    if (disc.shadowSprite) {
        try { disc.shadowSprite.destroy(); } catch (_) {}
    }
    try { disc.destroy(); } catch (_) {}
    spawnBoomEffect(phaserScene, ex, ey, team);
    playBounce(8);   // sonido de "expulsion"
    updateUI();
}

// Anima un BOOM!! en la posicion donde la chapa fue eliminada: nube de polvo + texto.
function spawnBoomEffect(scene, x, y, team) {
    if (!scene) return;
    // Mantener el efecto visible aunque la chapa se haya salido del campo: clamp a la zona visible
    const tx = Phaser.Math.Clamp(x, 30, FIELD_W - 30);
    const ty = Phaser.Math.Clamp(y, 30, FIELD_H - 30);

    // Anillo de explosion
    const ring = scene.add.graphics().setDepth(18);
    ring.lineStyle(6, 0xffd87a, 0.95);
    ring.strokeCircle(tx, ty, 18);
    scene.tweens.add({
        targets: ring,
        alpha: 0,
        duration: 480,
        ease: 'Cubic.Out',
        onUpdate: (tw) => {
            const t = tw.progress;
            ring.clear();
            ring.lineStyle(6 - t * 4, 0xffd87a, 0.95 - t * 0.95);
            ring.strokeCircle(tx, ty, 18 + t * 60);
        },
        onComplete: () => ring.destroy()
    });

    // Particulas de polvo (puntos amarillentos volando hacia fuera)
    const dust = scene.add.graphics().setDepth(18);
    const dustParts = [];
    for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 80 + Math.random() * 160;
        dustParts.push({
            x: tx, y: ty,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 30,
            r: 3 + Math.random() * 4,
            life: 0
        });
    }
    const colorPrimary = team === 'red' ? 0xff6a6a : team === 'blue' ? 0x7fb6ff : 0xffd87a;
    const tween = scene.tweens.add({
        targets: { t: 0 },
        t: 1,
        duration: 600,
        onUpdate: (tw) => {
            const dt = 1 / 60;
            dust.clear();
            for (const p of dustParts) {
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vy += 240 * dt;     // gravedad ligera
                p.life = tw.progress;
                const a = 1 - p.life;
                dust.fillStyle(colorPrimary, a * 0.9);
                dust.fillCircle(p.x, p.y, p.r * (1 - p.life * 0.5));
            }
        },
        onComplete: () => dust.destroy()
    });

    // Texto BOOM!! con escala + fade
    const txt = scene.add.text(tx, ty, 'BOOM!!', {
        fontFamily: 'Orbitron, sans-serif',
        fontSize: '52px',
        fontStyle: 'bold',
        color: '#ffd87a',
        stroke: '#3a1a00',
        strokeThickness: 6
    }).setOrigin(0.5).setDepth(20).setScale(0.2).setAngle(-12 + Math.random() * 24);
    scene.tweens.add({
        targets: txt,
        scale: 1.6,
        y: ty - 40,
        alpha: 0,
        duration: 700,
        ease: 'Back.Out',
        onComplete: () => txt.destroy()
    });

    // Camera shake corto
    if (scene.cameras && scene.cameras.main) {
        scene.cameras.main.shake(160, 0.006);
    }
}

// Recorre los discos y elimina los que se han salido del rectangulo del campo.
// Solo aplica en modo Knockout (donde no hay paredes externas).
function updateKnockoutEliminations() {
    const mode = GAME_MODES[currentMode];
    if (!mode || !mode.isKnockout) return;
    const margin = PLAYER_RADIUS + 30;
    const minX = FIELD_PAD_X - margin;
    const maxX = FIELD_W - FIELD_PAD_X + margin;
    const minY = FIELD_PAD_Y - margin;
    const maxY = FIELD_H - FIELD_PAD_Y + margin;
    const toKill = [];
    for (const d of discs) {
        if (d.x < minX || d.x > maxX || d.y < minY || d.y > maxY) {
            toKill.push(d);
        }
    }
    for (const d of toKill) eliminateDisc(d);
}

// ================================================================
// CAPA VISUAL (texturas y dibujo)
// ================================================================
function createGrassTexture(scene) {
    if (scene.textures.exists('grass')) return;
    const tex = scene.textures.createCanvas('grass', FIELD_W, FIELD_H);
    const ctx = tex.getContext();

    // 1. Estadio completo (gradas + vallas + pista) en todo el canvas
    paintStands(ctx);

    // 2. Cesped: solo dentro del rectangulo de juego (innerL..innerR, innerT..innerB)
    const fxL = FIELD_PAD_X;
    const fxR = FIELD_W - FIELD_PAD_X;
    const fyT = FIELD_PAD_Y;
    const fyB = FIELD_H - FIELD_PAD_Y;
    const fieldW = fxR - fxL;
    const fieldH = fyB - fyT;

    // 1. Bandas verticales base con colores ligeramente desaturados (mas verdes naturales)
    const BAND_W = 84;
    for (let x = fxL; x < fxR; x += BAND_W) {
        ctx.fillStyle = (Math.floor((x - fxL) / BAND_W) % 2 === 0) ? '#23461a' : '#2c5821';
        ctx.fillRect(x, fyT, Math.min(BAND_W, fxR - x), fieldH);
    }

    // 2. Difuminar los bordes entre bandas (transicion suave en lugar de corte recto)
    for (let x = fxL + BAND_W; x < fxR; x += BAND_W) {
        const grad = ctx.createLinearGradient(x - 8, 0, x + 8, 0);
        grad.addColorStop(0,   'rgba(20,40,15,0.0)');
        grad.addColorStop(0.5, 'rgba(15,30,10,0.20)');
        grad.addColorStop(1,   'rgba(20,40,15,0.0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - 8, fyT, 16, fieldH);
    }

    // 3. Manchas radiales sutiles (variaciones de iluminacion / segado irregular)
    for (let i = 0; i < 110; i++) {
        const cx = fxL + Math.random() * fieldW;
        const cy = fyT + Math.random() * fieldH;
        const r = 25 + Math.random() * 70;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const dark = Math.random() < 0.55;
        g.addColorStop(0, dark ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.04)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // 4. Briznas: lineas verticales cortas simulando hojas de cesped individuales
    const blades = Math.floor(fieldW * fieldH * 0.0010);
    for (let i = 0; i < blades; i++) {
        const x = fxL + Math.random() * fieldW;
        const y = fyT + Math.random() * fieldH;
        const len = 2 + Math.random() * 4;
        const isLight = Math.random() < 0.40;
        ctx.strokeStyle = isLight
            ? `rgba(255,255,255,${0.06 + Math.random() * 0.07})`
            : `rgba(0,0,0,${0.10 + Math.random() * 0.12})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (Math.random() - 0.5) * 0.8, y - len);
        ctx.stroke();
    }

    // 5. Ruido punteado denso (puntos pequenos, simulan textura granular del cesped)
    const noisePoints = Math.floor(fieldW * fieldH * 0.045);
    for (let i = 0; i < noisePoints; i++) {
        const x = fxL + Math.random() * fieldW;
        const y = fyT + Math.random() * fieldH;
        const dark = Math.random() < 0.55;
        const a = 0.03 + Math.random() * 0.09;
        ctx.fillStyle = dark ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a * 0.55})`;
        ctx.fillRect(x, y, 1, 1);
    }

    // Vinieta oscura del cesped
    const cx = FIELD_W / 2, cy = FIELD_H / 2;
    const grad = ctx.createRadialGradient(cx, cy, fieldH * 0.4, cx, cy, fieldH * 0.85);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.save();
    ctx.beginPath();
    ctx.rect(fxL, fyT, fieldW, fieldH);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(fxL, fyT, fieldW, fieldH);
    ctx.restore();

    tex.refresh();
}

// Estadio: gradas con asientos en bandas largas, vallas publicitarias y pista perimetral.
function paintStands(ctx) {
    const innerL = FIELD_PAD_X;
    const innerR = FIELD_W - FIELD_PAD_X;
    const innerT = FIELD_PAD_Y;
    const innerB = FIELD_H - FIELD_PAD_Y;

    // Grosores de las capas perimetrales (de fuera hacia dentro)
    const TRACK = 14;   // pista de atletismo
    const AD    = 9;    // vallas publicitarias
    const CORN  = 2;    // cornisa oscura

    // 1. Fondo cemento oscuro
    ctx.fillStyle = '#0d1014';
    ctx.fillRect(0, 0, FIELD_W, FIELD_H);

    // 2. GRADAS: filas paralelas al campo. Cada N filas mantiene el mismo color
    // (= una "seccion" del estadio) y luego cambia. Sobre el color base se siembran
    // motas claras y oscuras simulando publico individualizado.
    const sectionPalette = [
        '#3f3954', '#36495d', '#3d524a', '#5a4136',
        '#574a32', '#403649', '#3a4250', '#2e4a3a'
    ];

    function paintBleachers(x, y, w, h, dir) {
        // dir: 'h' filas horizontales (gradas norte/sur), 'v' filas verticales (este/oeste)
        const ROW = 4;
        const sections = [];
        // construir lista de secciones del estadio (paletas y longitudes)
        const total = dir === 'h' ? h : w;
        let consumed = 0;
        let prevIdx = -1;
        while (consumed < total) {
            let idx;
            do { idx = Math.floor(Math.random() * sectionPalette.length); } while (idx === prevIdx);
            prevIdx = idx;
            const len = (5 + Math.floor(Math.random() * 7)) * ROW;
            sections.push({ idx, end: consumed + len });
            consumed += len;
        }

        let secPtr = 0;
        const rowCount = Math.ceil(total / ROW);
        for (let i = 0; i < rowCount; i++) {
            const offset = i * ROW;
            while (secPtr < sections.length - 1 && offset >= sections[secPtr].end) secPtr++;
            const color = sectionPalette[sections[secPtr].idx];

            if (dir === 'h') {
                ctx.fillStyle = color;
                ctx.fillRect(x, y + offset, w, ROW - 1);
                // Sombra del escalon (linea oscura abajo)
                ctx.fillStyle = 'rgba(0,0,0,0.50)';
                ctx.fillRect(x, y + offset + ROW - 1, w, 1);
                // Motas (publico)
                const motas = Math.floor(w / 8);
                for (let m = 0; m < motas; m++) {
                    ctx.fillStyle = Math.random() < 0.55 ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.25)';
                    ctx.fillRect(x + Math.random() * w, y + offset + Math.random() * (ROW - 1), 1, 1);
                }
            } else {
                ctx.fillStyle = color;
                ctx.fillRect(x + offset, y, ROW - 1, h);
                ctx.fillStyle = 'rgba(0,0,0,0.50)';
                ctx.fillRect(x + offset + ROW - 1, y, 1, h);
                const motas = Math.floor(h / 8);
                for (let m = 0; m < motas; m++) {
                    ctx.fillStyle = Math.random() < 0.55 ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.25)';
                    ctx.fillRect(x + offset + Math.random() * (ROW - 1), y + Math.random() * h, 1, 1);
                }
            }
        }
    }

    // Limites de las gradas (lo que queda fuera de cornisa+vallas+pista)
    const standT = innerT - TRACK - AD - CORN;
    const standB = innerB + TRACK + AD + CORN;
    const standL = innerL - TRACK - AD - CORN;
    const standR = innerR + TRACK + AD + CORN;

    paintBleachers(0,      0,       FIELD_W,  standT,           'h');
    paintBleachers(0,      standB,  FIELD_W,  FIELD_H - standB, 'h');
    paintBleachers(0,      standT,  standL,   standB - standT,  'v');
    paintBleachers(standR, standT,  FIELD_W - standR, standB - standT, 'v');

    // 3. CORNISA (linea negra entre gradas y vallas)
    ctx.fillStyle = '#000';
    ctx.fillRect(innerL - TRACK - AD - CORN, innerT - TRACK - AD - CORN,
                  (innerR - innerL) + 2 * (TRACK + AD + CORN), CORN);
    ctx.fillRect(innerL - TRACK - AD - CORN, innerB + TRACK + AD,
                  (innerR - innerL) + 2 * (TRACK + AD + CORN), CORN);
    ctx.fillRect(innerL - TRACK - AD - CORN, innerT - TRACK - AD - CORN,
                  CORN, (innerB - innerT) + 2 * (TRACK + AD + CORN));
    ctx.fillRect(innerR + TRACK + AD, innerT - TRACK - AD - CORN,
                  CORN, (innerB - innerT) + 2 * (TRACK + AD + CORN));

    // 4. VALLAS PUBLICITARIAS (rectangulos coloreados con banda blanca simulando logo)
    const adColors = ['#7a3a35', '#3b5d76', '#3a6a52', '#7a6035', '#252a35',
                      '#5a4275', '#7a5538', '#1f242c', '#2c5550', '#5e2f2c'];

    function paintAdRow(x, y, w, h, horizontal) {
        const PIECE = 70;
        let pos = horizontal ? x : y;
        const end = horizontal ? x + w : y + h;
        let i = Math.floor(Math.random() * adColors.length);
        while (pos < end) {
            const len = Math.min(PIECE, end - pos);
            const c = adColors[i % adColors.length];
            i++;
            if (horizontal) {
                ctx.fillStyle = c;
                ctx.fillRect(pos, y, len - 1, h);
                // Logo abstracto: banda blanca central
                ctx.fillStyle = 'rgba(255,255,255,0.50)';
                ctx.fillRect(pos + 6, y + h / 2 - 1, len - 13, 2);
                // Pequeño cuadrito a la izquierda (icono)
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.fillRect(pos + 3, y + h / 2 - 2, 2, 4);
            } else {
                ctx.fillStyle = c;
                ctx.fillRect(x, pos, w, len - 1);
                ctx.fillStyle = 'rgba(255,255,255,0.50)';
                ctx.fillRect(x + w / 2 - 1, pos + 6, 2, len - 13);
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.fillRect(x + w / 2 - 2, pos + 3, 4, 2);
            }
            pos += len;
        }
    }

    paintAdRow(innerL - TRACK - AD, innerT - TRACK - AD,
                (innerR - innerL) + 2 * (TRACK + AD), AD, true);
    paintAdRow(innerL - TRACK - AD, innerB + TRACK,
                (innerR - innerL) + 2 * (TRACK + AD), AD, true);
    paintAdRow(innerL - TRACK - AD, innerT - TRACK - AD,
                AD, (innerB - innerT) + 2 * (TRACK + AD), false);
    paintAdRow(innerR + TRACK, innerT - TRACK - AD,
                AD, (innerB - innerT) + 2 * (TRACK + AD), false);

    // 5. PISTA PERIMETRAL (pista de atletismo en color tierra)
    ctx.fillStyle = '#6a3a24';
    ctx.fillRect(innerL - TRACK, innerT - TRACK, (innerR - innerL) + 2 * TRACK, TRACK);
    ctx.fillRect(innerL - TRACK, innerB,         (innerR - innerL) + 2 * TRACK, TRACK);
    ctx.fillRect(innerL - TRACK, innerT,         TRACK, innerB - innerT);
    ctx.fillRect(innerR,         innerT,         TRACK, innerB - innerT);

    // Textura de la pista: pequeñas motas mas claras
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i < 600; i++) {
        const onTopBottom = Math.random() < 0.5;
        let px, py;
        if (onTopBottom) {
            const inTop = Math.random() < 0.5;
            px = innerL - TRACK + Math.random() * ((innerR - innerL) + 2 * TRACK);
            py = inTop ? innerT - TRACK + Math.random() * TRACK : innerB + Math.random() * TRACK;
        } else {
            const inLeft = Math.random() < 0.5;
            px = inLeft ? innerL - TRACK + Math.random() * TRACK : innerR + Math.random() * TRACK;
            py = innerT + Math.random() * (innerB - innerT);
        }
        ctx.fillRect(px, py, 1, 1);
    }

    // Lineas blancas de carriles
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
        const off = (TRACK / 4) * i;
        ctx.strokeRect(innerL - TRACK + off, innerT - TRACK + off,
                       (innerR - innerL) + 2 * (TRACK - off),
                       (innerB - innerT) + 2 * (TRACK - off));
    }

    // Sombra interior del campo (borde oscuro entre pista y cesped)
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(innerL, innerT, innerR - innerL, innerB - innerT);
}

function drawStadium(scene) {
    const mode = GAME_MODES[currentMode];
    if (mode && mode.isKnockout) {
        drawSumoArena(scene);
        setupWeatherEffects(scene);
        return;
    }
    scene.add.image(0, 0, 'grass').setOrigin(0, 0).setDepth(0);
    drawFieldLines(scene);
    setupWeatherEffects(scene);
}

// Estadio estilo sumo (dohyō): tatami exterior beige + ring central dorado.
// Las chapas que se salen del rectangulo de campo (margen) son eliminadas.
function drawSumoArena(scene) {
    const cx = FIELD_W / 2;
    const cy = FIELD_H / 2;

    // Fondo: degradado oscuro tipo gimnasio
    const bg = scene.add.graphics().setDepth(0);
    bg.fillStyle(0x161812, 1);
    bg.fillRect(0, 0, FIELD_W, FIELD_H);

    // Tatami: bandas alternas amarillo-pajizas que cubren todo el campo de juego
    const tatami = scene.add.graphics().setDepth(0.3);
    const fxL = FIELD_PAD_X, fxR = FIELD_W - FIELD_PAD_X;
    const fyT = FIELD_PAD_Y, fyB = FIELD_H - FIELD_PAD_Y;
    const innerW = fxR - fxL;
    const innerH = fyB - fyT;
    // Borde de marco oscuro
    tatami.fillStyle(0x3b2a14, 1);
    tatami.fillRect(fxL - 6, fyT - 6, innerW + 12, innerH + 12);
    // Suelo tatami
    const stripH = 22;
    for (let y = fyT; y < fyB; y += stripH) {
        tatami.fillStyle((Math.floor((y - fyT) / stripH) % 2 === 0) ? 0xc9a866 : 0xb89657, 1);
        tatami.fillRect(fxL, y, innerW, Math.min(stripH, fyB - y));
    }
    // Lineas de juntas verticales (cada 60px) sutiles
    tatami.lineStyle(1, 0x000000, 0.18);
    for (let x = fxL + 60; x < fxR; x += 60) {
        tatami.lineBetween(x, fyT, x, fyB);
    }

    // Ring central (dohyō): circulo dorado con borde blanco
    const radiusOuter = Math.min(innerW, innerH) * 0.42;
    const radiusInner = radiusOuter - 8;
    const ring = scene.add.graphics().setDepth(0.6);
    // Sombra exterior leve
    ring.fillStyle(0x000000, 0.25);
    ring.fillCircle(cx, cy + 4, radiusOuter + 6);
    // Aro blanco (linea perimetral del dohyō)
    ring.fillStyle(0xfff4d8, 1);
    ring.fillCircle(cx, cy, radiusOuter);
    // Centro arenoso
    ring.fillStyle(0xd9b06a, 1);
    ring.fillCircle(cx, cy, radiusInner);
    // Punto central
    ring.lineStyle(3, 0x6b3a12, 0.85);
    ring.strokeCircle(cx, cy, 28);
    ring.fillStyle(0x6b3a12, 0.65);
    ring.fillCircle(cx, cy, 4);

    // Marca "KNOCKOUT" en pequeño tipo banner
    scene.add.text(cx, fyT - 18, 'DOHYŌ · KNOCKOUT', {
        fontFamily: 'Orbitron, sans-serif',
        fontSize: '14px',
        color: '#ffd87a'
    }).setOrigin(0.5, 0.5).setDepth(1.2);

    // Texto sutil "FUERA = OUT" en cada esquina
    const cornerStyle = {
        fontFamily: 'Orbitron, sans-serif',
        fontSize: '10px',
        color: '#888'
    };
    scene.add.text(fxL + 8, fyT + 4, 'FUERA = OUT', cornerStyle).setDepth(1.2);
    scene.add.text(fxR - 8, fyB - 14, 'FUERA = OUT', cornerStyle).setOrigin(1, 0).setDepth(1.2);
}

// Aplica los efectos visuales del clima seleccionado: tinte de pantalla y particulas.
function setupWeatherEffects(scene) {
    const w = WEATHERS[currentWeather] || WEATHERS.day;
    weatherDrops = [];

    // Tinte global (oscurece de noche, azulea con lluvia, blanquea con nieve)
    if (w.overlay) {
        const tint = scene.add.graphics().setDepth(2.5);
        tint.fillStyle(w.overlay.color, w.overlay.alpha);
        tint.fillRect(0, 0, FIELD_W, FIELD_H);

        // Modo NOCHE: focos circulares simulando estadio iluminado
        if (currentWeather === 'night') {
            const lights = scene.add.graphics().setDepth(2.6).setBlendMode(Phaser.BlendModes.ADD);
            const spots = [
                { x: FIELD_W * 0.25, y: FIELD_H * 0.25 },
                { x: FIELD_W * 0.75, y: FIELD_H * 0.25 },
                { x: FIELD_W * 0.25, y: FIELD_H * 0.75 },
                { x: FIELD_W * 0.75, y: FIELD_H * 0.75 }
            ];
            for (const s of spots) {
                for (let i = 5; i >= 1; i--) {
                    lights.fillStyle(0xffffcc, 0.05 * i);
                    lights.fillCircle(s.x, s.y, 50 * i);
                }
            }
        }
    }

    // Particulas (lluvia o nieve) animadas en cada frame
    if (w.drops) {
        const isRain = w.drops === 'rain';
        const count  = isRain ? 110 : 90;
        for (let i = 0; i < count; i++) {
            weatherDrops.push({
                x: Math.random() * FIELD_W,
                y: Math.random() * FIELD_H,
                speed:  isRain ? 9 + Math.random() * 8     : 1.4 + Math.random() * 1.4,
                drift:  isRain ? -1.4                       : (Math.random() - 0.5) * 0.6,
                length: isRain ? 12 + Math.random() * 8     : 0,
                size:   isRain ? 0                          : 2 + Math.random() * 2,
                phase:  Math.random() * Math.PI * 2
            });
        }
        weatherGfx = scene.add.graphics().setDepth(22);
    } else {
        weatherGfx = null;
    }
}

function updateWeatherDrops(time) {
    if (!weatherGfx || !weatherDrops.length) return;
    const w = WEATHERS[currentWeather];
    if (!w || !w.drops) return;
    const isRain = w.drops === 'rain';
    weatherGfx.clear();
    if (isRain) {
        weatherGfx.lineStyle(1.4, 0xb0c8ff, 0.55);
        for (const d of weatherDrops) {
            d.y += d.speed;
            d.x += d.drift;
            if (d.y > FIELD_H + 20) { d.y = -20; d.x = Math.random() * FIELD_W; }
            weatherGfx.lineBetween(d.x, d.y, d.x - d.drift * 4, d.y - d.length);
        }
    } else {
        weatherGfx.fillStyle(0xffffff, 0.85);
        for (const d of weatherDrops) {
            d.y += d.speed;
            d.x += d.drift + Math.sin((time + d.phase * 1000) * 0.002) * 0.4;
            if (d.y > FIELD_H + 8) { d.y = -8; d.x = Math.random() * FIELD_W; }
            weatherGfx.fillCircle(d.x, d.y, d.size);
        }
    }
}

function drawFieldLines(scene) {
    const layers = [
        { width: 8, alpha: 0.10 },
        { width: 4, alpha: 0.28 },
        { width: 2, alpha: 1.00 }
    ];
    for (const layer of layers) {
        const g = scene.add.graphics().setDepth(1);
        g.lineStyle(layer.width, 0xffffff, layer.alpha);
        g.strokeRect(FIELD_PAD_X, FIELD_PAD_Y, FIELD_W - FIELD_PAD_X * 2, FIELD_H - FIELD_PAD_Y * 2);
        g.lineBetween(FIELD_W / 2, FIELD_PAD_Y, FIELD_W / 2, FIELD_H - FIELD_PAD_Y);
        g.strokeCircle(FIELD_W / 2, FIELD_H / 2, 70);
        g.strokeRect(FIELD_PAD_X, FIELD_H / 2 - GOAL_HALF - 30, 60, GOAL_HALF * 2 + 60);
        g.strokeRect(FIELD_W - FIELD_PAD_X - 60, FIELD_H / 2 - GOAL_HALF - 30, 60, GOAL_HALF * 2 + 60);
    }
    const dot = scene.add.graphics().setDepth(1);
    dot.fillStyle(0xffffff, 0.95);
    dot.fillCircle(FIELD_W / 2, FIELD_H / 2, 4);
}

function drawGoalDecor(scene, side) {
    const goalTop    = FIELD_H / 2 - GOAL_HALF;
    const goalBottom = FIELD_H / 2 + GOAL_HALF;
    const lineX = side === 'left' ? FIELD_PAD_X                : FIELD_W - FIELD_PAD_X;
    const backX = side === 'left' ? FIELD_PAD_X - GOAL_DEPTH   : FIELD_W - FIELD_PAD_X + GOAL_DEPTH;
    const isLeft = side === 'left';

    const container = scene.add.container(0, 0).setDepth(5);

    // === Si tenemos la imagen de la porteria, la usamos ===
    if (GOAL_IMG) {
        const key = isLeft ? 'goal-img-left' : 'goal-img-right';
        if (!scene.textures.exists(key)) {
            const w = GOAL_IMG.naturalWidth;
            const h = GOAL_IMG.naturalHeight;
            const tex = scene.textures.createCanvas(key, w, h);
            const ctx = tex.getContext();
            if (isLeft) {
                ctx.translate(w, 0);
                ctx.scale(-1, 1);
            }
            ctx.drawImage(GOAL_IMG, 0, 0);
            tex.refresh();
        }
        // Posicionar el sprite encima del area de la porteria (boca a backX y un poco arriba)
        const targetX = Math.min(lineX, backX);
        const targetW = Math.abs(lineX - backX);
        // Extendemos la altura del sprite hacia arriba para que el marco se vea mas
        const EXTRA_UP    = 24;
        const EXTRA_DOWN  = 8;
        const targetY = goalTop - EXTRA_UP;
        const targetH = (goalBottom - goalTop) + EXTRA_UP + EXTRA_DOWN;
        const sprite = scene.add.image(targetX, targetY, key).setOrigin(0, 0).setDisplaySize(targetW, targetH);
        container.add(sprite);

        goalNets[side] = { container, shakeUntil: 0 };
        return;
    }

    // === Fallback procedural si no hay imagen ===
    const innerX = Math.min(lineX, backX) + 2;
    const innerW = Math.abs(lineX - backX) - 4;

    const bg = scene.add.graphics();
    bg.fillStyle(0x000000, 0.55);
    bg.fillRect(innerX, goalTop, innerW, goalBottom - goalTop);
    container.add(bg);

    const net = scene.add.graphics();
    net.lineStyle(1, 0xffffff, 0.45);
    const cell = 5;
    for (let x = innerX; x <= innerX + innerW; x += cell) {
        net.lineBetween(x, goalTop + 1, x, goalBottom - 1);
    }
    for (let y = goalTop + 1; y <= goalBottom - 1; y += cell) {
        net.lineBetween(innerX, y, innerX + innerW, y);
    }
    container.add(net);

    const back = scene.add.graphics();
    back.lineStyle(3, 0xffffff, 0.85);
    back.lineBetween(backX, goalTop, backX, goalBottom);
    container.add(back);

    const bars = scene.add.graphics();
    bars.lineStyle(3, 0xffffff, 0.85);
    const x1 = isLeft ? backX : lineX;
    const x2 = isLeft ? lineX : backX;
    bars.lineBetween(x1, goalTop, x2, goalTop);
    bars.lineBetween(x1, goalBottom, x2, goalBottom);
    container.add(bars);

    goalNets[side] = { container, shakeUntil: 0 };

    drawPost(scene, lineX, goalTop);
    drawPost(scene, lineX, goalBottom);
}

// Poste vertical blanco con altura visible (efecto 2.5D ligero).
// El pie del poste esta en (x, y) y el cuerpo se eleva hacia arriba en pantalla.
function drawPost(scene, x, y) {
    const W = 9;
    const HEIGHT = 22;
    const g = scene.add.graphics().setDepth(13);   // sobre las chapas

    // Sombra al suelo
    g.fillStyle(0x000000, 0.55);
    g.fillEllipse(x + 3, y + 4, W * 2, 6);

    // Pie del poste (elipse oscura en el suelo)
    g.fillStyle(0x444444, 1);
    g.fillEllipse(x, y, W * 1.15, W * 0.55);

    // Cuerpo del poste (rectangulo blanco con bordes oscuros para volumen)
    // Sombra lateral derecha
    g.fillStyle(0x666666, 1);
    g.fillRect(x - W / 2, y - HEIGHT, W, HEIGHT);
    // Cara principal blanca
    g.fillStyle(0xf2f2f2, 1);
    g.fillRect(x - W / 2 + 1.5, y - HEIGHT, W - 3.5, HEIGHT);
    // Highlight central (linea brillante)
    g.fillStyle(0xffffff, 1);
    g.fillRect(x - W / 2 + 2, y - HEIGHT, 2, HEIGHT);

    // Tapa superior (elipse en la cabeza)
    g.fillStyle(0xeeeeee, 1);
    g.fillEllipse(x, y - HEIGHT, W, W * 0.45);
    g.fillStyle(0xffffff, 0.85);
    g.fillEllipse(x - 1, y - HEIGHT - 0.5, W * 0.55, W * 0.25);

    // Borde fino oscuro
    g.lineStyle(1, 0x222222, 0.85);
    g.strokeRect(x - W / 2, y - HEIGHT, W, HEIGHT);
}

function skinFor(team) {
    if (net.mode === 'local') return team === 'red' ? selectedSkin : opponentSkin;
    return net.myTeam === team ? selectedSkin : opponentSkin;
}

function createAvatarDiscTexture(scene, key, skinIndex, ringHex) {
    const img = AVATAR_IMAGES[skinIndex];
    if (!img) return;
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const radius = PLAYER_RADIUS;
    const margin = 6;
    const W = radius * 2 + margin * 2;
    const H = W + DISC_DEPTH;
    const tex = scene.textures.createCanvas(key, W, H);
    const ctx = tex.getContext();
    const cx = W / 2;
    const cy = W / 2;                    // centro de la cara (la base se dibuja desplazada hacia abajo)

    // 1. BASE del disco (mismo radio que la cara, desplazada hacia abajo).
    //    Solo se vera la parte inferior asomando -> efecto luna creciente oscura
    //    que sugiere grosor 2.5D.
    const baseY = cy + DISC_DEPTH;
    // Sombra elipsoidal en la pista (suelo) para anclar mejor
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, baseY + radius * 0.25, radius * 0.95, radius * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
    // Cuerpo de la base (color del anillo, oscurecido)
    ctx.fillStyle = shade(ringHex, -0.60);
    ctx.beginPath();
    ctx.arc(cx, baseY, radius, 0, Math.PI * 2);
    ctx.fill();
    // Borde oscuro de la base
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 2. CARA superior con la foto recortada
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1.5, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const targetSize = (radius - 1.5) * 2;
    const aspect = img.naturalWidth / img.naturalHeight;
    let dw, dh;
    if (aspect > 1) { dh = targetSize; dw = targetSize * aspect; }
    else            { dw = targetSize; dh = targetSize / aspect; }
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();

    // 3. Anillo del color del equipo
    ctx.strokeStyle = ringHex;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1.5, 0, Math.PI * 2);
    ctx.stroke();

    // 4. Borde exterior oscuro fino
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 5. Highlight superior (reflejo)
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.beginPath();
    ctx.ellipse(cx - radius * 0.30, cy - radius * 0.45, radius * 0.30, radius * 0.12, -0.5, 0, Math.PI * 2);
    ctx.fill();

    tex.refresh();
}

function createBallTexture(scene) {
    const key = 'disc-ball';
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const radius = BALL_RADIUS;
    const margin = 6;
    const size = radius * 2 + margin * 2;
    const tex = scene.textures.createCanvas(key, size, size);
    const ctx = tex.getContext();
    const cx = size / 2, cy = size / 2;

    // Sombra elipsoidal
    ctx.fillStyle = 'rgba(0,0,0,0.40)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + radius * 0.20, radius * 0.95, radius * 0.40, 0, 0, Math.PI * 2);
    ctx.fill();

    // Recorte circular y dibujar Jabulani (object-fit: cover)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const img = JABULANI_IMG;
    const targetSize = (radius - 1) * 2;
    const aspect = img.naturalWidth / img.naturalHeight;
    let dw, dh;
    if (aspect > 1) { dh = targetSize; dw = targetSize * aspect; }
    else            { dw = targetSize; dh = targetSize / aspect; }
    const dx = cx - dw / 2;
    const dy = cy - dh / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();

    // Borde fino oscuro
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Highlight superior
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.beginPath();
    ctx.ellipse(cx - radius * 0.30, cy - radius * 0.45, radius * 0.30, radius * 0.12, -0.5, 0, Math.PI * 2);
    ctx.fill();

    tex.refresh();
}

function createDiscTexture(scene, key, radius, primaryHex, isWhite = false) {
    if (scene.textures.exists(key)) return;
    const margin = 6;
    const W = radius * 2 + margin * 2;
    // Solo las chapas (no balon) llevan base 2.5D.
    const wantsDepth = (radius >= PLAYER_RADIUS - 1) && !isWhite;
    const depth = wantsDepth ? DISC_DEPTH : 0;
    const H = W + depth;
    const tex = scene.textures.createCanvas(key, W, H);
    const ctx = tex.getContext();
    const cx = W / 2;
    const cy = W / 2;
    const baseColor = '#' + primaryHex.toString(16).padStart(6, '0');

    // Base 2.5D (circulo oscuro desplazado hacia abajo, asoma luna creciente)
    if (depth > 0) {
        const baseY = cy + depth;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.ellipse(cx, baseY + radius * 0.25, radius * 0.95, radius * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shade(baseColor, -0.60);
        ctx.beginPath();
        ctx.arc(cx, baseY, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Cara superior con gradiente radial
    const gradient = ctx.createRadialGradient(
        cx - radius * 0.35, cy - radius * 0.35, radius * 0.05,
        cx, cy, radius
    );
    if (isWhite) {
        gradient.addColorStop(0,   '#ffffff');
        gradient.addColorStop(0.6, '#dddddd');
        gradient.addColorStop(1,   '#888888');
    } else {
        gradient.addColorStop(0,    shade(baseColor,  0.45));
        gradient.addColorStop(0.55, shade(baseColor,  0.05));
        gradient.addColorStop(1,    shade(baseColor, -0.45));
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.50)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath();
    ctx.ellipse(cx - radius * 0.32, cy - radius * 0.42, radius * 0.28, radius * 0.18, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(cx - radius * 0.40, cy - radius * 0.46, radius * 0.08, 0, Math.PI * 2);
    ctx.fill();

    tex.refresh();
}

function createConfettiTexture(scene) {
    if (scene.textures.exists('confetti')) return;
    const tex = scene.textures.createCanvas('confetti', 6, 10);
    const ctx = tex.getContext();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 6, 10);
    tex.refresh();
}

function createShadowTexture(scene) {
    if (scene.textures.exists('shadow-disc')) return;
    const W = 100, H = 32;
    const tex = scene.textures.createCanvas('shadow-disc', W, H);
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W / 2);
    g.addColorStop(0,   'rgba(0,0,0,0.55)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.25)');
    g.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    tex.refresh();
}

// ================================================================
// CAPA FISICA
// ================================================================
function buildTopBottomWalls(scene) {
    const opts = wallOpts();
    scene.matter.add.rectangle(FIELD_W / 2, FIELD_PAD_Y - WALL_THICK / 2,           FIELD_W, WALL_THICK, { ...opts, label: 'wall-h' });
    scene.matter.add.rectangle(FIELD_W / 2, FIELD_H - FIELD_PAD_Y + WALL_THICK / 2, FIELD_W, WALL_THICK, { ...opts, label: 'wall-h' });
}

function buildGoal(scene, side) {
    const opts = wallOpts();
    const goalTop    = FIELD_H / 2 - GOAL_HALF;
    const goalBottom = FIELD_H / 2 + GOAL_HALF;
    const lineX = side === 'left' ? FIELD_PAD_X                : FIELD_W - FIELD_PAD_X;
    const backX = side === 'left' ? FIELD_PAD_X - GOAL_DEPTH   : FIELD_W - FIELD_PAD_X + GOAL_DEPTH;

    const upperH = goalTop - FIELD_PAD_Y;
    scene.matter.add.rectangle(lineX, FIELD_PAD_Y + upperH / 2, WALL_THICK, upperH, { ...opts, label: 'wall-v' });
    const lowerH = (FIELD_H - FIELD_PAD_Y) - goalBottom;
    scene.matter.add.rectangle(lineX, goalBottom + lowerH / 2, WALL_THICK, lowerH, { ...opts, label: 'wall-v' });
    scene.matter.add.rectangle(backX, FIELD_H / 2, WALL_THICK, GOAL_HALF * 2, { ...opts, label: 'wall-v' });

    const topesCenterX = (lineX + backX) / 2;
    const topesSpan    = Math.abs(backX - lineX);
    scene.matter.add.rectangle(topesCenterX, goalTop - WALL_THICK / 2,    topesSpan, WALL_THICK, { ...opts, label: 'wall-h' });
    scene.matter.add.rectangle(topesCenterX, goalBottom + WALL_THICK / 2, topesSpan, WALL_THICK, { ...opts, label: 'wall-h' });

    scene.matter.add.rectangle(topesCenterX, FIELD_H / 2, topesSpan - 4, GOAL_HALF * 2 - 4, {
        isStatic: true, isSensor: true,
        label: side === 'left' ? 'goal-left' : 'goal-right'
    });
}

function wallOpts() {
    return { isStatic: true, restitution: RESTITUTION, friction: 0, frictionStatic: 0 };
}

function spawnTeam(scene, team) {
    const innerW = FIELD_W - FIELD_PAD_X * 2;
    const innerH = FIELD_H - FIELD_PAD_Y * 2;
    const texKey = team === 'red' ? 'disc-red' : 'disc-blue';
    const mode = GAME_MODES[currentMode] || GAME_MODES.normal;
    const formation = mode.formation || FORMATION;
    for (const slot of formation) {
        const fx = team === 'red' ? slot.fx : 1 - slot.fx;
        const x = FIELD_PAD_X + innerW * fx;
        const y = FIELD_PAD_Y + innerH * slot.fy;
        const disc = createDisc(scene, x, y, PLAYER_RADIUS, texKey, PLAYER_MASS, FRICTION_AIR_PLAYER, 'player');
        disc.team = team;
        disc.role = slot.role;
        players[team].push(disc);
        initialPositions.set(disc, { x, y });
    }
}

function spawnBall(scene) {
    spawnBalls(scene, 1);
}

// Destruye todos los discos (chapas + balones) y limpia las estructuras asociadas.
// Lo usa el modo Tiro libre para reorganizar formaciones entre rondas.
function destroyAllDiscs() {
    for (const d of discs) {
        if (d && d.shadowSprite) {
            try { d.shadowSprite.destroy(); } catch (_) {}
        }
        if (d && d.destroy) {
            try { d.destroy(); } catch (_) {}
        }
    }
    discs = [];
    players = { red: [], blue: [] };
    balls = [];
    ball = null;
    initialPositions = new Map();
}

// Posiciones de defensores estaticos por ronda (lado defensor: derecha cuando rojo ataca).
// Se espejan automaticamente cuando ataca azul.
const FREEKICK_DEFENDERS = {
    1: [
        { fx: 0.62, fy: 0.32 },
        { fx: 0.62, fy: 0.68 }
    ],
    2: [
        { fx: 0.58, fy: 0.30 },
        { fx: 0.58, fy: 0.70 },
        { fx: 0.78, fy: 0.50 }
    ],
    3: [
        { fx: 0.55, fy: 0.28 },
        { fx: 0.55, fy: 0.72 },
        { fx: 0.75, fy: 0.40 },
        { fx: 0.75, fy: 0.60 }
    ]
};

// Tiro libre: configura el campo para un disparo específico.
// `attacker` es 'red' o 'blue' (quien lanza); `round` es 1, 2 o 3.
function spawnFreekickRound(scene, attacker, round) {
    destroyAllDiscs();
    const Body = Phaser.Physics.Matter.Matter.Body;
    const defender = attacker === 'red' ? 'blue' : 'red';
    const innerW = FIELD_W - FIELD_PAD_X * 2;
    const innerH = FIELD_H - FIELD_PAD_Y * 2;
    const fyMid  = FIELD_PAD_Y + innerH * 0.50;

    // Atacante (1 chapa en su mitad, separado del balon para tener espacio de slingshot)
    const atkFx = attacker === 'red' ? 0.30 : 0.70;
    const atkX  = FIELD_PAD_X + innerW * atkFx;
    const atkTex = attacker === 'red' ? 'disc-red' : 'disc-blue';
    const atk = createDisc(scene, atkX, fyMid, PLAYER_RADIUS, atkTex, PLAYER_MASS, FRICTION_AIR_PLAYER, 'player');
    atk.team = attacker;
    atk.role = 'atk';
    players[attacker].push(atk);
    initialPositions.set(atk, { x: atkX, y: fyMid });

    // Defensores distribuidos por el campo (sin portero)
    const defs = FREEKICK_DEFENDERS[Math.min(Math.max(round, 1), 3)];
    const defTex = defender === 'red' ? 'disc-red' : 'disc-blue';
    for (const slot of defs) {
        const fx = attacker === 'red' ? slot.fx : (1 - slot.fx);   // espejo si ataca azul
        const dx = FIELD_PAD_X + innerW * fx;
        const dy = FIELD_PAD_Y + innerH * slot.fy;
        const wall = createDisc(scene, dx, dy, PLAYER_RADIUS, defTex, PLAYER_MASS, FRICTION_AIR_PLAYER, 'player');
        wall.team = defender;
        wall.role = 'wall';
        players[defender].push(wall);
        initialPositions.set(wall, { x: dx, y: dy });
        Body.setStatic(wall.body, true);
    }

    // Balon en posicion intermedia entre el atacante y el centro, con suficiente
    // separacion para que el atacante haga slingshot real, no un toque pegado.
    spawnBalls(scene, 1);
    const ballFx = attacker === 'red' ? 0.43 : 0.57;
    const ballX  = FIELD_PAD_X + innerW * ballFx;
    Body.setPosition(ball.body, { x: ballX, y: fyMid });
    initialPositions.set(ball, { x: ballX, y: fyMid });

    discs = [...players.red, ...players.blue, ...balls];
    currentTeam = attacker;
    applyWeatherPhysics();
}

// === Modo DIANA ===
// Zonas verticales del hueco de porteria con sus puntos (esquinas valen mas).
function buildDianaZones() {
    const top    = FIELD_H / 2 - GOAL_HALF;
    const bottom = FIELD_H / 2 + GOAL_HALF;
    const span = bottom - top;
    return [
        { y0: top,                y1: top + span * 0.22, points: 5 },     // esquina alta
        { y0: top + span * 0.22,  y1: top + span * 0.40, points: 3 },
        { y0: top + span * 0.40,  y1: top + span * 0.60, points: 1 },     // centro (portero)
        { y0: top + span * 0.60,  y1: top + span * 0.78, points: 3 },
        { y0: top + span * 0.78,  y1: bottom,            points: 5 }      // esquina baja
    ];
}

function pointsForBallY(y) {
    if (!dianaZones) return 1;
    for (const z of dianaZones) {
        if (y >= z.y0 && y <= z.y1) return z.points;
    }
    // Si entra justo en el limite, lo asignamos al mas cercano
    if (y < dianaZones[0].y0) return dianaZones[0].points;
    return dianaZones[dianaZones.length - 1].points;
}

// Configura el campo para un intento de Diana: 1 chapa atacante (rojo, equipo del jugador)
// y 1 balon, sin rivales, lanzamiento desde la izquierda hacia la porteria derecha.
function spawnDianaAttempt(scene) {
    destroyAllDiscs();
    const Body = Phaser.Physics.Matter.Matter.Body;
    const innerW = FIELD_W - FIELD_PAD_X * 2;
    const innerH = FIELD_H - FIELD_PAD_Y * 2;
    const fyMid = FIELD_PAD_Y + innerH * 0.50;

    // Posicion atacante: cerca del lateral izquierdo, pero la y la varia un poco para que
    // no sea siempre el mismo angulo (anade dificultad y variedad)
    const atkFx = 0.18;
    const atkFy = 0.30 + Math.random() * 0.40;     // entre 0.30 y 0.70
    const atkX  = FIELD_PAD_X + innerW * atkFx;
    const atkY  = FIELD_PAD_Y + innerH * atkFy;
    const atk = createDisc(scene, atkX, atkY, PLAYER_RADIUS, 'disc-red', PLAYER_MASS, FRICTION_AIR_PLAYER, 'player');
    atk.team = 'red';
    atk.role = 'atk';
    players.red.push(atk);
    initialPositions.set(atk, { x: atkX, y: atkY });

    // Balon en el centro vertical, ligeramente delante del atacante
    spawnBalls(scene, 1);
    const ballFx = 0.32;
    const ballX = FIELD_PAD_X + innerW * ballFx;
    Body.setPosition(ball.body, { x: ballX, y: fyMid });
    initialPositions.set(ball, { x: ballX, y: fyMid });

    discs = [...players.red, ...balls];
    currentTeam = 'red';
    applyWeatherPhysics();
}

// Pinta las zonas de puntos sobre el hueco de la porteria derecha (dentro del marco)
function drawDianaZones(scene) {
    if (!dianaZones) return;
    const g = scene.add.graphics().setDepth(8);
    const xL = FIELD_W - FIELD_PAD_X;             // borde de la portería derecha (entrada)
    const xR = xL + GOAL_DEPTH - 4;
    for (const z of dianaZones) {
        // Color segun puntos: 5 oro, 3 plata, 1 bronce
        let color, label;
        if (z.points === 5)      { color = 0xffd24a; label = '5'; }
        else if (z.points === 3) { color = 0xc8d6dd; label = '3'; }
        else                     { color = 0xc88a3c; label = '1'; }
        g.fillStyle(color, 0.30);
        g.fillRect(xL, z.y0, xR - xL, z.y1 - z.y0);
        g.lineStyle(2, color, 0.85);
        g.strokeRect(xL, z.y0, xR - xL, z.y1 - z.y0);
        const tx = xL + (xR - xL) / 2;
        const ty = (z.y0 + z.y1) / 2;
        scene.add.text(tx, ty, label, {
            fontFamily: 'Orbitron, sans-serif',
            fontSize: '22px',
            color: '#ffffff'
        }).setOrigin(0.5).setDepth(9);
    }
}

function spawnBalls(scene, count) {
    balls = [];
    if (count <= 1) {
        const x = FIELD_W / 2;
        const y = FIELD_H / 2;
        const b = createDisc(scene, x, y, BALL_RADIUS, 'disc-ball', BALL_MASS, FRICTION_AIR_BALL, 'ball');
        initialPositions.set(b, { x, y });
        balls.push(b);
        ball = b;
        return;
    }
    // Multiples balones: separados horizontalmente alrededor del centro
    const innerW = FIELD_W - FIELD_PAD_X * 2;
    const spacing = Math.min(innerW * 0.22, 160);
    for (let i = 0; i < count; i++) {
        const offset = (i - (count - 1) / 2) * spacing;
        const x = FIELD_W / 2 + offset;
        const y = FIELD_H / 2;
        const b = createDisc(scene, x, y, BALL_RADIUS, 'disc-ball', BALL_MASS, FRICTION_AIR_BALL, 'ball');
        initialPositions.set(b, { x, y });
        balls.push(b);
    }
    ball = balls[0];
}

function createDisc(scene, x, y, radius, textureKey, mass, frictionAir, label) {
    const sprite = scene.add.image(x, y, textureKey).setDepth(label === 'ball' ? 12 : 10);

    // Para chapas (label 'player') la textura tiene una zona inferior con el lateral
    // del disco. Reposicionamos el origen para que la "cara" coincida con el body.
    if (label === 'player') {
        const margin = 6;
        const W = radius * 2 + margin * 2;
        const H = W + DISC_DEPTH;
        sprite.setOrigin(0.5, (W / 2) / H);
    }

    const obj = scene.matter.add.gameObject(sprite, {
        shape: { type: 'circle', radius },
        restitution: RESTITUTION,
        frictionAir, friction: 0, frictionStatic: 0,
        mass, label
    });
    obj.label = label;

    // Sombra al suelo: sprite separado, no rota (independiente de body.angle)
    const isBall = label === 'ball';
    const shadowOffsetY = isBall ? 5 : 7;
    const shadowScaleX  = isBall ? (BALL_RADIUS  / 50) * 0.95 : (PLAYER_RADIUS / 50) * 0.92;
    const shadowScaleY  = shadowScaleX * 0.55;
    const shadow = scene.add.image(x, y + shadowOffsetY, 'shadow-disc')
        .setScale(shadowScaleX, shadowScaleY)
        .setDepth(isBall ? 11 : 9);
    obj.shadowSprite  = shadow;
    obj.shadowOffsetY = shadowOffsetY;

    return obj;
}

function resetPositions() {
    const Body = Phaser.Physics.Matter.Matter.Body;
    for (const [obj, pos] of initialPositions) {
        Body.setPosition(obj.body, pos);
        Body.setVelocity(obj.body, { x: 0, y: 0 });
        Body.setAngularVelocity(obj.body, 0);
    }
}

// ================================================================
// VFX
// ================================================================
function createGoalParticles(scene) {
    confettiEmitter = scene.add.particles(0, 0, 'confetti', {
        speed: { min: 200, max: 520 },
        angle: { min: 0, max: 360 },
        gravityY: 700,
        lifespan: { min: 1200, max: 2200 },
        scale: { start: 1.0, end: 0.4 },
        rotate: { min: 0, max: 360 },
        tint: PALETTE_CONFETTI,
        alpha: { start: 1, end: 0.3 },
        emitting: false
    }).setDepth(20);
}

function triggerGoalEffects(scene, side) {
    const lineX = side === 'left' ? FIELD_PAD_X : FIELD_W - FIELD_PAD_X;
    const backX = side === 'left' ? FIELD_PAD_X - GOAL_DEPTH : FIELD_W - FIELD_PAD_X + GOAL_DEPTH;
    const cx = (lineX + backX) / 2;
    const cy = FIELD_H / 2;

    confettiEmitter.explode(140, cx, cy);
    scene.cameras.main.shake(280, 0.013);
    if (goalNets[side]) goalNets[side].shakeUntil = scene.time.now + 350;
    playGoalSound();
    triggerSlowMo(scene, 0.30, 1200);    // bullet-time del gol
    // Si este gol va a terminar el partido, NO disparamos el popup GOOL+frase
    // (se solaparia con el match end). pendingGoal vale 'red' o 'blue'.
    const willEndMatch = (score[pendingGoal] + 1) >= goalsToWin;
    if (!willEndMatch) showGoalPopup(pendingGoal);
}

const GOAL_INSULTS = [
    'ERES SEBO!!! LOCUUUURA!!!',
    'ERES AUTÉNTICAMENTE SÍNDROME',
    'LLÁMAME EL LUNES',
    'LO MISMO TE PLANCHO UN HUEVO QUE TE FRÍO UNA CORBATA',
    'DIOS MÍO, PERO SI VAS CON LA ENFERMEDAD',
    'A FREGAR, PAYASO!!!!',
    'NO SÉ SI SEGUIR JUGANDO, ERES MUY MALO!!!',
    'VAS CON LA ENFERMEDAD, SEBO MASTER',
    'PERO QUÉ SEBO ERES, MADRE MÍA',
    'AUTÉNTICAMENTE SÍNDROME!!! LOCUUUURA',
    'A FREGAR PAYASO, ERES UN SEBO',
    'ESTO ES LOCUUUURA, ERES SEBO!!!',
    'ERES TAN MALO QUE LLÁMAME EL LUNES',
    'VAYA SEBO, A FREGAR PAYASO!!!',
    'LOCUUUURA DE SEBO, VAS CON LA ENFERMEDAD',
    'NO SÉ SI SEGUIR, ESTO ES SÍNDROME PURO'
];

function pickGoalInsult() {
    return GOAL_INSULTS[Math.floor(Math.random() * GOAL_INSULTS.length)];
}

// Slow-motion temporal del motor de fisica (efecto "bullet time" para goles)
let __slowMoTimer = null;
function triggerSlowMo(scene, scale, durationMs) {
    const engine = scene && scene.matter && scene.matter.world && scene.matter.world.engine;
    if (!engine || !engine.timing) return;
    engine.timing.timeScale = scale;
    if (__slowMoTimer) clearTimeout(__slowMoTimer);
    __slowMoTimer = setTimeout(() => {
        if (engine.timing) engine.timing.timeScale = 1.0;
        __slowMoTimer = null;
    }, durationMs);
}

function showGoalPopup(scoringTeam) {
    const popup       = document.getElementById('goal-popup');
    const text        = document.getElementById('goal-text');
    const insult      = document.getElementById('goal-insult');
    const insultBlock = document.getElementById('goal-insult-block');
    const photo       = document.getElementById('goal-insult-photo');
    if (!popup || !text) return;

    // Reset
    popup.classList.add('hidden');

    // Frase y avatar del que marca
    if (insult) insult.textContent = pickGoalInsult();
    if (photo && scoringTeam) {
        const skin = skinFor(scoringTeam);
        const ringHex = scoringTeam === 'red' ? '#ff5b5b' : '#5b9eff';
        paintMiniAvatar(photo, skin, ringHex);
    }

    // Reaplica animaciones (force reflow)
    void text.offsetWidth;
    if (insultBlock) void insultBlock.offsetWidth;

    popup.classList.remove('hidden');
    // GOOL!!! 1500ms + insulto 2400ms con delay 1200ms => ~3600ms total
    setTimeout(() => popup.classList.add('hidden'), 3700);
}

function updateGoalNets(time) {
    for (const side of ['left', 'right']) {
        const entry = goalNets[side];
        if (!entry) continue;
        if (time < entry.shakeUntil) {
            entry.container.x = Phaser.Math.Between(-3, 3);
            entry.container.y = Phaser.Math.Between(-3, 3);
        } else if (entry.container.x !== 0 || entry.container.y !== 0) {
            entry.container.x = 0; entry.container.y = 0;
        }
    }
}

function updateShadows() {
    for (const d of discs) {
        if (d.shadowSprite) {
            d.shadowSprite.x = d.x;
            d.shadowSprite.y = d.y + (d.shadowOffsetY || 6);
        }
    }
}

// Camara dinamica: zoom suave y leve panning hacia el "centro de accion"
// (media de posiciones del balon y la chapa mas rapida) cuando hay simulacion.
// En reposo vuelve a 1.0x y centrada.
function updateDynamicCamera() {
    if (!phaserScene) return;
    const cam = phaserScene.cameras && phaserScene.cameras.main;
    if (!cam) return;

    // Velocidad maxima + posicion ponderada
    let maxSpeed = 0;
    let actX = FIELD_W / 2, actY = FIELD_H / 2;
    if (ball && ball.body) {
        actX = ball.x;
        actY = ball.y;
        maxSpeed = Math.max(maxSpeed, Math.hypot(ball.body.velocity.x, ball.body.velocity.y));
    } else if (discs.length) {
        // Sin balon (knockout): usa la chapa mas rapida como punto de interes
        let fastest = null, fastestSpeed = 0;
        for (const d of discs) {
            const sp = Math.hypot(d.body.velocity.x, d.body.velocity.y);
            if (sp > fastestSpeed) { fastestSpeed = sp; fastest = d; }
        }
        if (fastest) { actX = fastest.x; actY = fastest.y; maxSpeed = fastestSpeed; }
    }
    for (const d of discs) {
        const sp = Math.hypot(d.body.velocity.x, d.body.velocity.y);
        if (sp > maxSpeed) maxSpeed = sp;
    }

    // Zoom: 1.0 reposo, hasta 1.06 a alta velocidad
    const speedNorm = Math.min(maxSpeed / 28, 1);
    const targetZoom = 1.0 + speedNorm * 0.06;
    const curZoom = cam.zoom || 1;
    cam.setZoom(curZoom + (targetZoom - curZoom) * 0.08);

    // Panning suave hacia el punto de accion, con desviacion maxima muy contenida
    const cx = FIELD_W / 2, cy = FIELD_H / 2;
    const pullX = (actX - cx) * 0.10 * speedNorm;       // max 10% de la distancia, solo si hay velocidad
    const pullY = (actY - cy) * 0.10 * speedNorm;
    const targetSx = cx + pullX;
    const targetSy = cy + pullY;
    const curSx = cam.scrollX + cam.width / 2 / cam.zoom;
    const curSy = cam.scrollY + cam.height / 2 / cam.zoom;
    const newSx = curSx + (targetSx - curSx) * 0.06;
    const newSy = curSy + (targetSy - curSy) * 0.06;
    cam.centerOn(newSx, newSy);
}

function updateBallSpin() {
    const Body = Phaser.Physics.Matter.Matter.Body;
    for (const b of balls) {
        if (!b || !b.body) continue;
        const v = b.body.velocity;
        const speed = Math.hypot(v.x, v.y);
        if (speed < 0.1) continue;
        const sign = Math.abs(v.x) >= Math.abs(v.y) ? Math.sign(v.x) : Math.sign(v.y);
        Body.rotate(b.body, speed * 0.045 * (sign || 1));
    }
}

function updateTrail() {
    if (!activeTrail) return;
    activeTrail.points.push({ x: activeTrail.disc.x, y: activeTrail.disc.y });
    if (activeTrail.points.length > 22) activeTrail.points.shift();

    trailGfx.clear();
    const pts = activeTrail.points;
    const colorHex = activeTrail.disc.team === 'red' ? TEAM_COLORS.red.fill : TEAM_COLORS.blue.fill;
    for (let i = 1; i < pts.length; i++) {
        const t = i / pts.length;
        trailGfx.lineStyle(PLAYER_RADIUS * 1.2 * t, colorHex, t * 0.55);
        trailGfx.lineBetween(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y);
    }
    const v = activeTrail.disc.body.velocity;
    if (Math.hypot(v.x, v.y) < 1.0) { activeTrail = null; trailGfx.clear(); }
}

// ================================================================
// COLISIONES
// ================================================================
function setupWallBounceCorrection(scene) {
    const lastVel = new Map();
    const Body = Phaser.Physics.Matter.Matter.Body;

    scene.matter.world.on('beforeupdate', () => {
        for (const d of discs) {
            const b = d.body;
            lastVel.set(b.id, { x: b.velocity.x, y: b.velocity.y });
        }
    });

    scene.matter.world.on('collisionstart', (event) => {
        const hits = new Map();
        for (const pair of event.pairs) {
            const a = pair.bodyA, b = pair.bodyB;
            const aIsWall = a.label === 'wall-h' || a.label === 'wall-v';
            const bIsWall = b.label === 'wall-h' || b.label === 'wall-v';
            if (aIsWall === bIsWall) continue;
            const wall = aIsWall ? a : b;
            const disc = aIsWall ? b : a;
            const e = hits.get(disc.id) || { hitH: false, hitV: false, body: disc };
            if (wall.label === 'wall-h') e.hitH = true; else e.hitV = true;
            hits.set(disc.id, e);
        }
        for (const { hitH, hitV, body } of hits.values()) {
            const v = lastVel.get(body.id);
            if (!v) continue;
            const vx = hitV ? -v.x * RESTITUTION_WALL : v.x;
            const vy = hitH ? -v.y * RESTITUTION_WALL : v.y;
            Body.setVelocity(body, { x: vx, y: vy });
            const speed = Math.hypot(v.x, v.y);
            if (speed > 1.5) playBounce(speed);
        }
    });
}

function setupGoalDetection(scene) {
    scene.matter.world.on('collisionstart', (event) => {
        if (pendingGoal) return;
        const mode = GAME_MODES[currentMode];
        const isDiana = mode && mode.isDiana;
        for (const pair of event.pairs) {
            const labels = [pair.bodyA.label, pair.bodyB.label];
            if (!labels.includes('ball')) continue;
            let scoringSide = null;
            if (labels.includes('goal-left'))  { pendingGoal = 'blue'; scoringSide = 'left';  }
            else if (labels.includes('goal-right')) { pendingGoal = 'red';  scoringSide = 'right'; }
            if (scoringSide) {
                if (isDiana && scoringSide === 'right' && ball) {
                    // Calcular puntos por zona y acumular antes de los efectos
                    const pts = pointsForBallY(ball.y);
                    dianaScore += pts;
                    showDianaPointsToast(scene, pts, ball.y);
                }
                triggerGoalEffects(scene, scoringSide);
                break;
            }
        }
    });
}

// Toast efimero "+5", "+3", "+1" en la posicion del gol en Diana
function showDianaPointsToast(scene, pts, atY) {
    const x = FIELD_W - FIELD_PAD_X - 10;
    const colorHex = pts === 5 ? '#ffd24a' : pts === 3 ? '#c8d6dd' : '#c88a3c';
    const t = scene.add.text(x, atY, '+' + pts, {
        fontFamily: 'Orbitron, sans-serif',
        fontSize: '64px',
        color: colorHex,
        stroke: '#000',
        strokeThickness: 6
    }).setOrigin(0.5).setDepth(20);
    scene.tweens.add({
        targets: t,
        y: atY - 90,
        alpha: 0,
        scale: 1.3,
        duration: 1100,
        ease: 'Cubic.Out',
        onComplete: () => t.destroy()
    });
}

function setupImpactDetection(scene) {
    scene.matter.world.on('collisionstart', (event) => {
        // Sonido de impacto (con cooldown propio para no saturar)
        for (const pair of event.pairs) {
            const a = pair.bodyA, b = pair.bodyB;
            const aIsDisc = a.label === 'player' || a.label === 'ball';
            const bIsDisc = b.label === 'player' || b.label === 'ball';
            if (!aIsDisc || !bIsDisc) continue;
            const speed = Math.max(
                Math.hypot(a.velocity.x, a.velocity.y),
                Math.hypot(b.velocity.x, b.velocity.y)
            );
            if (speed > 2) playImpact(speed);
            break;
        }
        // Shake (con su propio cooldown)
        if (scene.time.now - lastImpactTime < IMPACT_SHAKE_COOLDOWN) return;
        for (const pair of event.pairs) {
            const a = pair.bodyA, b = pair.bodyB;
            const aIsDisc = a.label === 'player' || a.label === 'ball';
            const bIsDisc = b.label === 'player' || b.label === 'ball';
            if (!aIsDisc || !bIsDisc) continue;
            const va = Math.hypot(a.velocity.x, a.velocity.y);
            const vb = Math.hypot(b.velocity.x, b.velocity.y);
            if (Math.max(va, vb) > IMPACT_SHAKE_MIN_VEL) {
                scene.cameras.main.shake(170, 0.0055);
                lastImpactTime = scene.time.now;
                return;
            }
        }
    });
}

// ================================================================
// INPUT
// ================================================================
function setupInput(scene) {
    const canvas = scene.game.canvas;

    function getCanvasPos(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const sx = canvas.width  / rect.width;
        const sy = canvas.height / rect.height;
        return {
            x: (clientX - rect.left) * sx,
            y: (clientY - rect.top)  * sy
        };
    }

    function onMoveAnywhere(e) {
        if (!isAiming || !selectedDisc) return;
        const p = getCanvasPos(e.clientX, e.clientY);
        drawAim(selectedDisc.x, selectedDisc.y, p.x, p.y);
    }

    function onUpAnywhere(e) {
        if (!isAiming || !selectedDisc) { isAiming = false; return; }
        isAiming = false;
        aimGfx.clear();

        const p = getCanvasPos(e.clientX, e.clientY);
        let vx = (selectedDisc.x - p.x) * FORCE_MULT;
        let vy = (selectedDisc.y - p.y) * FORCE_MULT;
        let mag = Math.hypot(vx, vy);
        if (mag < 0.5) return;

        // Habilidad TURBO: multiplica el modulo del disparo (puede pasar el clamp normal)
        let turboMax = MAX_VELOCITY;
        if (abilityArmed) {
            turboMax = MAX_VELOCITY * TURBO_MULTIPLIER;
            const turboTeam = (net.mode === 'local' && !currentBot) ? currentTeam : (net.myTeam || 'red');
            abilityUsed[turboTeam] = true;
            abilityArmed = false;
            // pequeño feedback sonoro propio del boost
            playUiClick();
        }
        if (mag > turboMax) {
            vx = (vx / mag) * turboMax;
            vy = (vy / mag) * turboMax;
            mag = turboMax;
        }

        selectedDisc.setVelocity(vx, vy);
        const trail = mag >= TRAIL_THRESHOLD;
        if (trail) activeTrail = { disc: selectedDisc, points: [] };

        if (net.mode !== 'local' && net.connected) {
            sendNet({ type: 'shoot', idx: discs.indexOf(selectedDisc), vx, vy, trail });
        }
        if (turboBtn) turboBtn.classList.add('hidden');
        setState('PHYSICS_SIMULATION');
    }

    function onCancel() {
        // si la pestana pierde foco, cancelamos el aim sin disparar
        isAiming = false;
        if (aimGfx) aimGfx.clear();
    }

    // Listeners en window: el cursor puede salir del canvas durante el arrastre.
    window.addEventListener('pointermove', onMoveAnywhere);
    window.addEventListener('pointerup',   onUpAnywhere);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur',          onCancel);

    scene.input.on('pointerdown', (pointer) => {
        if (gameState !== 'WAITING_FOR_INPUT') return;
        if (!isPlayerTurn()) return;
        const hit = findOwnDiscAt(pointer.x, pointer.y, currentTeam);
        if (!hit) return;
        selectedDisc = hit;
        isAiming = true;
    });

    // Limpia listeners cuando la escena se destruye (al volver al menu)
    scene.events.once('shutdown', () => {
        window.removeEventListener('pointermove', onMoveAnywhere);
        window.removeEventListener('pointerup',   onUpAnywhere);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur',          onCancel);
    });
}

function findOwnDiscAt(x, y, team) {
    for (const d of players[team]) {
        if (Math.hypot(x - d.x, y - d.y) <= PLAYER_RADIUS + 4) return d;
    }
    return null;
}

// El humano controla este turno?
//  - local sin bot: ambos turnos son humanos.
//  - local con bot: solo cuando currentTeam === net.myTeam ('red').
//  - online: solo cuando currentTeam === net.myTeam.
function isPlayerTurn() {
    if (net.mode === 'local' && !currentBot) return true;
    return currentTeam === net.myTeam;
}

// ================================================================
// UI / DRAWING
// ================================================================
function drawSelectionHighlight() {
    if (!highlightGfx) return;
    highlightGfx.clear();
    if (gameState !== 'WAITING_FOR_INPUT') return;
    if (!isPlayerTurn()) return;     // no destacar las del rival/bot cuando no toca

    const colorHex = currentTeam === 'red' ? TEAM_COLORS.red.fill : TEAM_COLORS.blue.fill;
    highlightGfx.lineStyle(2, colorHex, 0.6);
    for (const d of players[currentTeam]) {
        highlightGfx.strokeCircle(d.x, d.y, PLAYER_RADIUS + 4);
    }
    if (isAiming && selectedDisc) {
        highlightGfx.lineStyle(3, 0xffffff, 0.95);
        highlightGfx.strokeCircle(selectedDisc.x, selectedDisc.y, PLAYER_RADIUS + 5);
    }
}

function drawAim(fromX, fromY, toX, toY) {
    aimGfx.clear();

    // Vector tirachinas (invertido respecto al cursor)
    let dx = fromX - toX;
    let dy = fromY - toY;
    let mag = Math.hypot(dx, dy);
    if (mag < 8) return;

    if (mag > MAX_DRAG_PX) {
        dx = (dx / mag) * MAX_DRAG_PX;
        dy = (dy / mag) * MAX_DRAG_PX;
        mag = MAX_DRAG_PX;
    }

    const t = Phaser.Math.Clamp(mag / MAX_DRAG_PX, 0, 1);
    const color = arrowColor(t);

    const ux = dx / mag, uy = dy / mag;
    const px = -uy,      py = ux;

    // Origen separado del centro de la chapa
    const startGap = PLAYER_RADIUS + 5;
    const startX = fromX + ux * startGap;
    const startY = fromY + uy * startGap;
    const tipX = fromX + dx;
    const tipY = fromY + dy;

    const shaftLen = Math.hypot(tipX - startX, tipY - startY);
    const headLen = 18;
    const headW   = 22;
    if (shaftLen < headLen + 2) return;

    const shaftEndX = startX + ux * (shaftLen - headLen);
    const shaftEndY = startY + uy * (shaftLen - headLen);

    // Asta como trapezoide (de fina a ancha hacia la cabeza, da sensacion de potencia)
    const w0 = 4;
    const w1 = 10;

    // Outline oscuro
    aimGfx.fillStyle(0x000000, 0.40);
    aimGfx.beginPath();
    aimGfx.moveTo(startX    + px * (w0 / 2 + 2), startY    + py * (w0 / 2 + 2));
    aimGfx.lineTo(startX    - px * (w0 / 2 + 2), startY    - py * (w0 / 2 + 2));
    aimGfx.lineTo(shaftEndX - px * (w1 / 2 + 2), shaftEndY - py * (w1 / 2 + 2));
    aimGfx.lineTo(shaftEndX + px * (w1 / 2 + 2), shaftEndY + py * (w1 / 2 + 2));
    aimGfx.closePath();
    aimGfx.fillPath();

    // Asta con color
    aimGfx.fillStyle(color, 0.95);
    aimGfx.beginPath();
    aimGfx.moveTo(startX    + px * w0 / 2, startY    + py * w0 / 2);
    aimGfx.lineTo(startX    - px * w0 / 2, startY    - py * w0 / 2);
    aimGfx.lineTo(shaftEndX - px * w1 / 2, shaftEndY - py * w1 / 2);
    aimGfx.lineTo(shaftEndX + px * w1 / 2, shaftEndY + py * w1 / 2);
    aimGfx.closePath();
    aimGfx.fillPath();

    // Brillo superior (interior, da sensacion 3D)
    aimGfx.fillStyle(0xffffff, 0.32);
    aimGfx.beginPath();
    aimGfx.moveTo(startX    + px * (w0 / 2),       startY    + py * (w0 / 2));
    aimGfx.lineTo(startX    + px * (w0 / 2 - 1.2), startY    + py * (w0 / 2 - 1.2));
    aimGfx.lineTo(shaftEndX + px * (w1 / 2 - 2.5), shaftEndY + py * (w1 / 2 - 2.5));
    aimGfx.lineTo(shaftEndX + px * (w1 / 2),       shaftEndY + py * (w1 / 2));
    aimGfx.closePath();
    aimGfx.fillPath();

    // Cabeza outline
    aimGfx.fillStyle(0x000000, 0.50);
    aimGfx.fillTriangle(
        tipX + ux * 2, tipY + uy * 2,
        shaftEndX + px * (headW / 2 + 2.5) - ux * 1, shaftEndY + py * (headW / 2 + 2.5) - uy * 1,
        shaftEndX - px * (headW / 2 + 2.5) - ux * 1, shaftEndY - py * (headW / 2 + 2.5) - uy * 1
    );
    // Cabeza relleno
    aimGfx.fillStyle(color, 1.0);
    aimGfx.fillTriangle(
        tipX, tipY,
        shaftEndX + px * headW / 2, shaftEndY + py * headW / 2,
        shaftEndX - px * headW / 2, shaftEndY - py * headW / 2
    );

    // Punto de origen (en el centro de la chapa)
    aimGfx.fillStyle(0x000000, 0.45);
    aimGfx.fillCircle(fromX, fromY, 4.5);
    aimGfx.fillStyle(0xffffff, 0.95);
    aimGfx.fillCircle(fromX, fromY, 3);
}

function arrowColor(t) {
    // verde -> amarillo -> rojo
    let r, g, b;
    if (t < 0.5) {
        const k = t * 2;
        r = Math.round( 80 + (255 -  80) * k);
        g = 220;
        b = Math.round( 80 + ( 40 -  80) * k);
    } else {
        const k = (t - 0.5) * 2;
        r = 255;
        g = Math.round(220 + ( 60 - 220) * k);
        b = Math.round( 40 + ( 30 -  40) * k);
    }
    return (r << 16) | (g << 8) | b;
}

// ================================================================
// SELECCION DE BOT (escena tras JUGAR LOCAL)
// ================================================================
const BOTS = {
    jorge: {
        skin: PLAYER_FILES.indexOf('jorge'),
        ai: 'easy',
        stars: 1,
        displayName: 'Maverick',
        texts: [
            'EL NIVEL DE JORGE ES VOMITIVO!!!',
            'ES MUY MALO!! LOCUUUUURA!!!'
        ],
        emojis: ['🤮', '🤢', '💩']
    },
    querol: {
        skin: PLAYER_FILES.indexOf('querol'),
        ai: 'medium',
        stars: 3,
        displayName: 'Querooool',
        texts: [
            'QUEROL SABE JUGAR!!!',
            'QUEROOOOOL ESQUIROOOOLLL!!!!!',
            'QUEROOOOOL VIENE CON GANAS HOY',
            'OJO, QUEROL TIENE OFICIO',
            'EL MAESTRO QUEROOOOOL ESTÁ EN EL CAMPO',
            'QUEROL NO REGALA UN BALÓN',
            'VAS A SUDAR LA CAMISETA CONTRA QUEROL',
            'QUEROL ESTUDIA CADA TIRO. ATENCIÓN',
            'TE TOCA QUEROOOOOL, AGÁRRATE FUERTE'
        ],
        emojis: ['🎉', '🥳', '🎊', '🍾', '✨', '🪅']
    },
    marcos: {
        skin: PLAYER_FILES.indexOf('marcos'),
        ai: 'hard',
        stars: 5,
        displayName: 'Ketes',
        texts: [
            'CUIDADO CON KETES!!!!!!',
            'QUE DIOS TE PILLE CONFESADO',
            'KETES NO HA PERDIDO UN PARTIDO EN SU VIDA',
            'PREPARA EL TESTAMENTO, ESTO VA A DOLER',
            'KETES VIENE A POR TU CABEZA',
            'KETES JUEGA SIN PIEDAD. SIN PIEDAD',
            'KETES ES EL JEFE FINAL. RÍNDETE YA',
            'DICEN QUE KETES NO DUERME, SOLO ENTRENA',
            'KETES YA SABE CÓMO VAS A PERDER',
            'KETES NO TE VA A DEJAR NI TOCAR EL BALÓN'
        ],
        emojis: ['🔪', '⚔️', '🗡️']
    }
};

const botSelectEl = document.getElementById('bot-select');
const botPopupEl  = document.getElementById('bot-popup');
const botPopupTxt = document.getElementById('bot-popup-text');
const botPopupPart= document.getElementById('bot-popup-particles');
const botOptionsEl= document.getElementById('bot-options');

function renderBotOptions() {
    botOptionsEl.querySelectorAll('.bot-option').forEach(btn => {
        btn.innerHTML = '';

        const bot = BOTS[btn.dataset.bot];
        if (!bot) return;

        // Avatar
        const c = document.createElement('canvas');
        c.width = c.height = 110;
        const ctx = c.getContext('2d');
        const img = AVATAR_IMAGES[bot.skin];
        ctx.save();
        ctx.beginPath();
        ctx.arc(55, 55, 55, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        if (img) {
            const aspect = img.naturalWidth / img.naturalHeight;
            let dw, dh, dx, dy;
            if (aspect > 1) { dh = 110; dw = 110 * aspect; dx = (110 - dw) / 2; dy = 0; }
            else            { dw = 110; dh = 110 / aspect; dx = 0; dy = (110 - dh) / 2; }
            ctx.drawImage(img, dx, dy, dw, dh);
        } else {
            ctx.fillStyle = '#333';
            ctx.fillRect(0, 0, 110, 110);
        }
        ctx.restore();
        btn.appendChild(c);

        const name = document.createElement('div');
        name.className = 'bot-name';
        name.textContent = bot.displayName;
        btn.appendChild(name);

        const stars = document.createElement('div');
        stars.className = 'bot-stars';
        for (let i = 0; i < 5; i++) {
            const s = document.createElement('span');
            s.textContent = '★';
            if (i >= bot.stars) s.className = 'empty';
            stars.appendChild(s);
        }
        btn.appendChild(stars);

        const tag = document.createElement('div');
        tag.className = 'bot-tag';
        tag.textContent = '(BOT)';
        btn.appendChild(tag);
    });
}

function renderPvPButton() {
    const btn = document.getElementById('pvp-btn');
    if (!btn) return;
    btn.innerHTML = '';

    const c = document.createElement('canvas');
    c.width = c.height = 60;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1c1f25';
    ctx.beginPath();
    ctx.arc(30, 30, 30, 0, Math.PI * 2);
    ctx.fill();
    // Dos circulos solapados (rojo + azul)
    ctx.fillStyle = '#cc1f1f';
    ctx.beginPath();
    ctx.arc(21, 30, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#2360c0';
    ctx.beginPath();
    ctx.arc(39, 30, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    btn.appendChild(c);

    const txt = document.createElement('div');
    txt.className = 'pvp-text';
    const title = document.createElement('span');
    title.className = 'pvp-title';
    title.textContent = '1 PA 1';
    const sub = document.createElement('span');
    sub.className = 'pvp-sub';
    sub.textContent = 'EN ESTE ORDENADOR';
    txt.appendChild(title);
    txt.appendChild(sub);
    btn.appendChild(txt);
}

function showBotSelect() {
    renderBotOptions();
    renderPvPButton();
    menu.classList.add('hidden');
    botSelectEl.classList.remove('hidden');
}

botOptionsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.bot-option');
    if (!btn) return;
    chooseBot(btn.dataset.bot);
});

document.getElementById('pvp-btn').addEventListener('click', () => {
    startLocalPvP();
});

document.getElementById('bot-select-back').addEventListener('click', () => {
    botSelectEl.classList.add('hidden');
    menu.classList.remove('hidden');
});

function chooseBot(botName) {
    const bot = BOTS[botName];
    if (!bot) return;
    aiLevel      = bot.ai;
    opponentSkin = bot.skin;
    currentBot   = bot;
    showBotPopup(bot);
}

function showBotPopup(bot) {
    botPopupTxt.textContent = pickBotPhrase(bot);
    botPopupEl.classList.remove('hidden');
    spawnEmojiParticles(bot.emojis, 38);
    // segunda y tercera oleadas para que el popup este animado todo el rato
    setTimeout(() => spawnEmojiParticles(bot.emojis, 26), 700);
    setTimeout(() => spawnEmojiParticles(bot.emojis, 22), 1400);

    setTimeout(() => {
        botPopupEl.classList.add('hidden');
        botSelectEl.classList.add('hidden');
        botPopupPart.innerHTML = '';
        transitionToGame(() => startGame());
    }, 2600);
}

function startLocalPvP() {
    currentBot = null;                                  // sin bot, ambos turnos son humanos
    // Dos avatares al azar y distintos entre si
    selectedSkin = Math.floor(Math.random() * AVATAR_COUNT);
    do {
        opponentSkin = Math.floor(Math.random() * AVATAR_COUNT);
    } while (opponentSkin === selectedSkin);

    botPopupTxt.textContent = '1 PA 1!!!';
    botPopupEl.classList.remove('hidden');
    const emojis = ['🎮', '⚔️', '🔥', '💪', '🤜', '🤛'];
    spawnEmojiParticles(emojis, 32);
    setTimeout(() => spawnEmojiParticles(emojis, 22), 700);

    setTimeout(() => {
        botPopupEl.classList.add('hidden');
        botSelectEl.classList.add('hidden');
        botPopupPart.innerHTML = '';
        transitionToGame(() => startGame());
    }, 2000);
}

function pickBotPhrase(bot) {
    // Si el bot tiene una frase "featured" con probabilidad propia (p.ej. 0.25),
    // tirala primero. Si no toca, elige uniforme del resto.
    if (bot.featuredText && Math.random() < (bot.featuredProb || 0)) {
        return bot.featuredText;
    }
    const phrases = bot.texts && bot.texts.length ? bot.texts : [bot.featuredText || ''];
    return phrases[Math.floor(Math.random() * phrases.length)];
}

function spawnEmojiParticles(emojis, count) {
    const w = botPopupPart.clientWidth  || window.innerWidth;
    const h = botPopupPart.clientHeight || window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;

    for (let i = 0; i < count; i++) {
        const el = document.createElement('div');
        el.className = 'emoji-particle';
        el.textContent = emojis[Math.floor(Math.random() * emojis.length)];

        // posicion inicial cerca del centro (donde esta el texto)
        const startX = cx + (Math.random() - 0.5) * 240;
        const startY = cy + (Math.random() - 0.5) * 140;

        // direccion: angulo random, distancia variable. Ligeramente sesgado hacia arriba.
        const angle = Math.random() * Math.PI * 2;
        const radius = 220 + Math.random() * 520;
        const dx = Math.cos(angle) * radius;
        const dy = Math.sin(angle) * radius - 80;

        const rot = (Math.random() - 0.5) * 900;
        const dur = 1800 + Math.random() * 1500;

        el.style.left = startX + 'px';
        el.style.top  = startY + 'px';
        el.style.fontSize = (28 + Math.random() * 36) + 'px';
        el.style.setProperty('--dx', dx + 'px');
        el.style.setProperty('--dy', dy + 'px');
        el.style.setProperty('--rot', rot + 'deg');
        el.style.setProperty('--anim-dur', dur + 'ms');
        el.style.animationDelay = (Math.random() * 400) + 'ms';

        botPopupPart.appendChild(el);

        // limpieza al acabar la animacion (DOM no infla)
        setTimeout(() => el.remove(), dur + 600);
    }
}

// Re-renderizamos las opciones cuando las caras hayan cargado (por si abrieron muy rapido)
window.addEventListener('load', () => setTimeout(renderBotOptions, 0));

// ================================================================
// IA (modo local, equipo azul)
// ================================================================

// Centros del area de gol para cada equipo (donde quiere meterla cada uno)
function targetGoalForTeam(team) {
    // Rojo ataca a la derecha (goal-right). Azul ataca a la izquierda (goal-left).
    if (team === 'red') {
        return { x: FIELD_W - FIELD_PAD_X + GOAL_DEPTH * 0.6, y: FIELD_H / 2 };
    }
    return { x: FIELD_PAD_X - GOAL_DEPTH * 0.6, y: FIELD_H / 2 };
}

// Distancia mínima entre el segmento (x1,y1)→(x2,y2) y el punto (px,py)
function pointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.0001) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
}

// Disparo basico hacia el balon, fuerza moderada. Usado por 'easy' y como fallback.
function aiDecideEasy() {
    let best = null, bestDist = Infinity;
    for (const d of players.blue) {
        const dist = Math.hypot(d.x - ball.x, d.y - ball.y);
        if (dist < bestDist) { bestDist = dist; best = d; }
    }
    if (!best) return null;
    const dx = ball.x - best.x;
    const dy = ball.y - best.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 0.001) return null;
    const power = MAX_VELOCITY * 0.65;
    return { disc: best, vx: (dx / mag) * power, vy: (dy / mag) * power };
}

// Calcula el punto de contacto ideal para empujar el balon hacia el gol del equipo team
function impactPointFor(team) {
    const goal = targetGoalForTeam(team);
    const dxBG = goal.x - ball.x;
    const dyBG = goal.y - ball.y;
    const distBG = Math.hypot(dxBG, dyBG);
    if (distBG < 0.001) return null;
    const ux = dxBG / distBG, uy = dyBG / distBG;
    return {
        x: ball.x - ux * (PLAYER_RADIUS + BALL_RADIUS - 1),
        y: ball.y - uy * (PLAYER_RADIUS + BALL_RADIUS - 1),
        ux, uy,
        distBG
    };
}

// Medium: busca tiro directo a portería, siempre a tope de fuerza.
function aiDecideMedium() {
    const ip = impactPointFor('blue');
    if (!ip) return aiDecideEasy();

    let best = null, bestScore = Infinity;
    for (const d of players.blue) {
        const dx = ip.x - d.x;
        const dy = ip.y - d.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.001) continue;
        // La chapa debe golpear el balon "desde detras" (alineada con el vector balon→gol)
        const cux = dx / dist, cuy = dy / dist;
        const dot = cux * ip.ux + cuy * ip.uy;
        if (dot < 0.55) continue;            // direcciones muy desviadas se descartan
        // score: cerca y bien alineada
        const score = dist - dot * 60;
        if (score < bestScore) { bestScore = score; best = { disc: d, dx, dy, dist, cux, cuy }; }
    }
    if (!best) return aiDecideEasy();

    return {
        disc: best.disc,
        vx: best.cux * MAX_VELOCITY,
        vy: best.cuy * MAX_VELOCITY
    };
}

// Hard: tiro directo, evita chapas en medio, modula velocidad.
function aiDecideHard() {
    const ip = impactPointFor('blue');
    if (!ip) return aiDecideEasy();

    const allDiscs = [...players.red, ...players.blue];
    const candidates = [];

    for (const d of players.blue) {
        const dx = ip.x - d.x;
        const dy = ip.y - d.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.001) continue;

        const cux = dx / dist, cuy = dy / dist;
        const dot = cux * ip.ux + cuy * ip.uy;
        if (dot < 0.30) continue;     // descarta angulos muy malos, pero el resto compite

        // Penaliza chapas atravesadas en el camino chapa→impactPoint.
        // No descarta: la chapa que tire mas limpia ganara igualmente.
        let pathPenalty = 0;
        for (const other of allDiscs) {
            if (other === d) continue;
            const distSeg = pointToSegment(other.x, other.y, d.x, d.y, ip.x, ip.y);
            if (distSeg < (PLAYER_RADIUS * 2 - 4)) pathPenalty += 90;
        }

        // Penaliza si una chapa rival se cruza con el balon→gol (interceptaria)
        let ballPathPenalty = 0;
        const lookAhead = Math.min(ip.distBG, 320);
        for (const r of players.red) {
            const distSeg = pointToSegment(
                r.x, r.y,
                ball.x, ball.y,
                ball.x + ip.ux * lookAhead,
                ball.y + ip.uy * lookAhead
            );
            if (distSeg < (PLAYER_RADIUS + BALL_RADIUS + 2)) ballPathPenalty += 70;
        }

        // Score: cerca + alineada - penalizaciones por bloqueo
        const score = dist - dot * 90 + pathPenalty + ballPathPenalty;
        candidates.push({ disc: d, cux, cuy, dist, dot, score });
    }

    if (!candidates.length) return aiDecideEasy();
    candidates.sort((a, b) => a.score - b.score);
    const chosen = candidates[0];

    // Velocidad calibrada por distancia total (chapa→balon→gol).
    // El balon pierde velocidad por damping; para distancias cortas, no nos pasamos.
    const totalDist = chosen.dist + ip.distBG;
    const norm = Phaser.Math.Clamp(totalDist / 720, 0.55, 1.0);
    const power = MAX_VELOCITY * norm;
    const jitter = 0.96 + Math.random() * 0.06;       // ligero random para no ser identico

    return {
        disc: chosen.disc,
        vx: chosen.cux * power * jitter,
        vy: chosen.cuy * power * jitter
    };
}

// Knockout: empuja una chapa rival hacia el borde mas cercano del campo
// (el atacante propio se coloca al lado opuesto del rival respecto al borde,
//  apuntando hacia ese borde con potencia maxima).
function aiDecideKnockout() {
    if (!players.blue.length || !players.red.length) return null;
    const cxField = FIELD_W / 2;
    const cyField = FIELD_H / 2;
    const candidates = [];
    for (const target of players.red) {
        // Borde mas cercano del rival (calcula distancia a cada borde y se queda con el min)
        const dL = target.x - FIELD_PAD_X;
        const dR = (FIELD_W - FIELD_PAD_X) - target.x;
        const dT = target.y - FIELD_PAD_Y;
        const dB = (FIELD_H - FIELD_PAD_Y) - target.y;
        let edgeUx = 0, edgeUy = 0, edgeDist = Infinity;
        if (dL < edgeDist) { edgeDist = dL; edgeUx = -1; edgeUy =  0; }
        if (dR < edgeDist) { edgeDist = dR; edgeUx =  1; edgeUy =  0; }
        if (dT < edgeDist) { edgeDist = dT; edgeUx =  0; edgeUy = -1; }
        if (dB < edgeDist) { edgeDist = dB; edgeUx =  0; edgeUy =  1; }

        // Punto de impacto: justo al lado opuesto del rival respecto al borde
        const ipx = target.x - edgeUx * (PLAYER_RADIUS * 2 - 2);
        const ipy = target.y - edgeUy * (PLAYER_RADIUS * 2 - 2);

        for (const atk of players.blue) {
            const dx = ipx - atk.x;
            const dy = ipy - atk.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 0.001) continue;
            const ux = dx / dist, uy = dy / dist;
            const dot = ux * edgeUx + uy * edgeUy;
            if (dot < 0.30) continue;       // direccion contraria al empuje deseado
            // Score: cerca, bien alineado, y rival ya cerca del borde (mas facil expulsarlo)
            const score = dist - dot * 80 + edgeDist * 0.4;
            candidates.push({ disc: atk, ux, uy, dist, dot, score });
        }
    }
    if (!candidates.length) {
        // Fallback: un disparo cualquiera hacia el centro
        const atk = players.blue[0];
        const dx = cxField - atk.x;
        const dy = cyField - atk.y;
        const m = Math.hypot(dx, dy) || 1;
        return { disc: atk, vx: (dx / m) * MAX_VELOCITY * 0.6, vy: (dy / m) * MAX_VELOCITY * 0.6 };
    }
    candidates.sort((a, b) => a.score - b.score);
    // En facil, ruido grande; en dificil, va a por el mejor
    const pickIdx = aiLevel === 'easy'
        ? Math.min(candidates.length - 1, Math.floor(Math.random() * 3))
        : 0;
    const c = candidates[pickIdx];
    const power = aiLevel === 'easy' ? MAX_VELOCITY * 0.75 : MAX_VELOCITY;
    const jitter = aiLevel === 'easy' ? 0.85 + Math.random() * 0.25 : 0.95 + Math.random() * 0.07;
    return { disc: c.disc, vx: c.ux * power * jitter, vy: c.uy * power * jitter };
}

function aiDecide() {
    const mode = GAME_MODES[currentMode];
    if (mode && mode.isKnockout) return aiDecideKnockout();
    if (aiLevel === 'easy')   return aiDecideEasy();
    if (aiLevel === 'medium') return aiDecideMedium();
    return aiDecideHard();
}

function maybeStartAITurn() {
    if (net.mode !== 'local') return;
    if (!currentBot) return;                  // 1 vs 1 local sin bot: no actua la IA
    if (currentTeam !== 'blue') return;
    if (gameState !== 'WAITING_FOR_INPUT') return;
    if (aiThinking) return;
    aiThinking = true;

    // Pausa "humana" antes de jugar (varia segun nivel: facil mas rapido, dificil tarda)
    const baseDelay = { easy: 500, medium: 750, hard: 950 }[aiLevel] || 700;
    const jitter = Math.random() * 350;
    aiTimer = setTimeout(() => {
        aiTimer = null;
        aiThinking = false;
        if (gameState !== 'WAITING_FOR_INPUT') return;
        if (currentTeam !== 'blue') return;
        if (net.mode !== 'local') return;

        const move = aiDecide();
        if (!move || !move.disc) return;

        // Clamp por seguridad
        const mag = Math.hypot(move.vx, move.vy);
        if (mag < 0.5) return;
        let { vx, vy } = move;
        if (mag > MAX_VELOCITY) {
            vx = (vx / mag) * MAX_VELOCITY;
            vy = (vy / mag) * MAX_VELOCITY;
        }

        move.disc.setVelocity(vx, vy);
        if (mag >= TRAIL_THRESHOLD) activeTrail = { disc: move.disc, points: [] };
        setState('PHYSICS_SIMULATION');
    }, baseDelay + jitter);
}

function cancelAITurn() {
    if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
    aiThinking = false;
}

// ================================================================
// FIN DE PARTIDA / VOLVER AL MENU
// ================================================================
function getWinnerName(team) {
    if (net.mode === 'local') {
        if (team === 'red') return PLAYER_LABELS[selectedSkin] || 'ROJO';
        return currentBot ? currentBot.displayName : (PLAYER_LABELS[opponentSkin] || 'AZUL');
    }
    if (net.myTeam === team) return PLAYER_LABELS[selectedSkin] || 'TÚ';
    return PLAYER_LABELS[opponentSkin] || 'RIVAL';
}

function getLoserName(winnerTeam) {
    return getWinnerName(winnerTeam === 'red' ? 'blue' : 'red');
}

const WIN_PHRASES = [
    '{X} HA DESTROZADO A {Y}',
    'VAYA REVENTADA DE ANO DE {X} A {Y}',
    '{X} HA HUMILLADO A {Y}!!!',
    '{Y} HA SIDO MASACRADO POR {X}',
    '{X} SE HA MERENDADO A {Y}, LOCUUUURA',
    '{Y} ES PURO SEBO, {X} LE HA DADO UNA LECCIÓN'
];

function pickWinPhrase(winnerName, loserName) {
    const tpl = WIN_PHRASES[Math.floor(Math.random() * WIN_PHRASES.length)];
    return tpl.replace(/{X}/g, winnerName.toUpperCase())
              .replace(/{Y}/g, loserName.toUpperCase());
}


function showMatchEnd(winner) {
    // Si el GOOL!!! del gol decisivo seguia animandose, lo cortamos para que no se superponga.
    const goalPopup = document.getElementById('goal-popup');
    if (goalPopup) goalPopup.classList.add('hidden');

    if (winner === 'tie') {
        dom.matchEndWin.textContent = 'EMPATE!!!';
        dom.matchEndWin.style.color = '#ffd87a';
        dom.matchEndWin.style.textShadow = '0 0 30px rgba(255,205,90,0.65)';
    } else {
        const colorHex = winner === 'red'
            ? hexNum(TEAM_COLORS.red.fill)
            : hexNum(TEAM_COLORS.blue.fill);
        const winnerName = getWinnerName(winner);
        const loserName  = getLoserName(winner);
        dom.matchEndWin.textContent = pickWinPhrase(winnerName, loserName);
        dom.matchEndWin.style.color = colorHex;
        dom.matchEndWin.style.textShadow = `0 0 30px ${colorHex}`;
    }

    const _mode = GAME_MODES[currentMode];
    if (_mode && _mode.isKnockout) {
        dom.endScoreRed.textContent  = (players.red  || []).length;
        dom.endScoreBlue.textContent = (players.blue || []).length;
    } else {
        dom.endScoreRed.textContent  = score.red;
        dom.endScoreBlue.textContent = score.blue;
    }

    dom.matchEnd.classList.add('visible');

    // Persistir resultado y verificar trofeos (solo en local; online lo registramos
    // tambien para el cliente porque su perspectiva es valida)
    const myTeam = net.myTeam || 'red';
    const won  = winner !== 'tie' && winner === myTeam;
    const lost = winner !== 'tie' && winner !== myTeam;
    const tied = winner === 'tie';
    const scoreFor     = score[myTeam];
    const scoreAgainst = score[myTeam === 'red' ? 'blue' : 'red'];
    const botId = (net.mode === 'local' && currentBot)
        ? Object.keys(BOTS).find(k => BOTS[k] === currentBot)
        : null;
    recordMatchResult({ won, lost, tied, scoreFor, scoreAgainst, botId, mode: currentMode });

    // Confeti: tres oleadas de emojis de fiesta
    const partyEmojis = ['🎉', '🎊', '✨', '🎈', '⭐', '🥳', '🏆', '🎆'];
    spawnMatchEndConfetti(partyEmojis, 70, 0);
    spawnMatchEndConfetti(partyEmojis, 50, 700);
    spawnMatchEndConfetti(partyEmojis, 40, 1500);
}

// Match-end exclusivo de DIANA: muestra puntuacion total y un mensaje segun rango.
function showDianaEnd() {
    const goalPopup = document.getElementById('goal-popup');
    if (goalPopup) goalPopup.classList.add('hidden');

    const total = dianaScore;
    let title;
    if (total >= 22)      title = '¡PUNTERIA DIVINA! ' + total + ' PTS';
    else if (total >= 15) title = 'GRAN TIRADA: ' + total + ' PTS';
    else if (total >= 8)  title = 'DECENTE: ' + total + ' PTS';
    else if (total >= 3)  title = 'PUEDES MEJORAR: ' + total + ' PTS';
    else                  title = 'VAYA PUNTERIA... ' + total + ' PTS';

    dom.matchEndWin.textContent = title;
    dom.matchEndWin.style.color = '#ffd24a';
    dom.matchEndWin.style.textShadow = '0 0 30px rgba(255,210,80,0.7)';
    dom.endScoreRed.textContent  = total;
    dom.endScoreBlue.textContent = '0';
    dom.matchEnd.classList.add('visible');

    // Persistir puntuacion (mejor diana, sin contar como partida normal)
    try {
        persistState.bestDiana = Math.max(persistState.bestDiana || 0, total);
        persistState.dianaPlays = (persistState.dianaPlays || 0) + 1;
        saveState();
        if (total >= 20) unlockTrophy('diana_master');
    } catch (_) {}

    const partyEmojis = ['🎯', '🏆', '✨', '⭐', '🎉'];
    spawnMatchEndConfetti(partyEmojis, 60, 0);
    spawnMatchEndConfetti(partyEmojis, 40, 800);
}

function spawnMatchEndConfetti(emojis, count, delay) {
    const container = document.getElementById('match-end-particles');
    if (!container) return;
    setTimeout(() => {
        const w = container.clientWidth  || window.innerWidth;
        const h = container.clientHeight || window.innerHeight;
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            el.className = 'emoji-particle';
            el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
            const startX = w / 2 + (Math.random() - 0.5) * w * 0.55;
            const startY = h / 2 + (Math.random() - 0.5) * h * 0.45;
            const angle = Math.random() * Math.PI * 2;
            const radius = 280 + Math.random() * 600;
            const dx = Math.cos(angle) * radius;
            const dy = Math.sin(angle) * radius - 120;
            const rot = (Math.random() - 0.5) * 1000;
            const dur = 2200 + Math.random() * 1600;

            el.style.left = startX + 'px';
            el.style.top  = startY + 'px';
            el.style.fontSize = (30 + Math.random() * 38) + 'px';
            el.style.setProperty('--dx', dx + 'px');
            el.style.setProperty('--dy', dy + 'px');
            el.style.setProperty('--rot', rot + 'deg');
            el.style.setProperty('--anim-dur', dur + 'ms');
            el.style.animationDelay = (Math.random() * 400) + 'ms';
            container.appendChild(el);
            setTimeout(() => el.remove(), dur + 800);
        }
    }, delay);
}

function returnToMenu() {
    fade.classList.add('active');
    setTimeout(() => {
        // Cancelar cualquier turno de IA pendiente
        cancelAITurn();
        currentBot = null;

        // Destruir Phaser limpio
        if (phaserGame) {
            try { phaserGame.destroy(true); } catch (_) {}
            phaserGame = null;
        }
        phaserScene = null;

        // Cerrar conexion si estabamos online
        cleanupNet();

        // Reset de estado del juego
        score = { red: 0, blue: 0 };
        currentTeam = 'red';
        pendingGoal = null;
        selectedDisc = null;
        isAiming = false;
        activeTrail = null;
        awaitingSync = false;
        lastImpactTime = 0;
        discs = [];
        players = { red: [], blue: [] };
        initialPositions = new Map();
        ball = null;
        aimGfx = highlightGfx = trailGfx = null;
        goalNets = { left: null, right: null };
        confettiEmitter = null;
        gameState = 'WAITING_FOR_INPUT';

        // UI de pantalla
        dom.matchEnd.classList.remove('visible');
        const goalPopup = document.getElementById('goal-popup');
        if (goalPopup) goalPopup.classList.add('hidden');
        const vsPopup = document.getElementById('vs-popup');
        if (vsPopup) vsPopup.classList.add('hidden');
        const matchEndPart = document.getElementById('match-end-particles');
        if (matchEndPart) matchEndPart.innerHTML = '';
        gameScreen.classList.add('hidden');
        botPopupEl.classList.add('hidden');
        botSelectEl.classList.add('hidden');
        if (botPopupPart) botPopupPart.innerHTML = '';
        currentMode   = 'normal3';
        goalsToWin    = 3;
        freekickRound = 1;
        freekickShots = 0;
        if (typeof updateModeUI === 'function') updateModeUI();
        if (trophiesBtn) trophiesBtn.classList.remove('hidden');
        menu.classList.remove('hidden');
        showPanel(null);
        dom.netBadge.classList.remove('visible', 'warning');
        dom.scoreRed.textContent = 0;
        dom.scoreBlue.textContent = 0;
        dom.state.textContent = 'WAITING_FOR_INPUT';

        // Restablecer botones de panel join
        joinConnectBtn.disabled = false;

        setTimeout(() => fade.classList.remove('active'), 80);
    }, 320);
}

// ================================================================
// HELPERS DE COLOR
// ================================================================
function hexNum(num) {
    return '#' + num.toString(16).padStart(6, '0');
}

function shade(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    let r = (num >> 16) & 0xff;
    let g = (num >> 8) & 0xff;
    let b = num & 0xff;
    if (amount >= 0) {
        r = Math.round(r + (255 - r) * amount);
        g = Math.round(g + (255 - g) * amount);
        b = Math.round(b + (255 - b) * amount);
    } else {
        r = Math.round(r * (1 + amount));
        g = Math.round(g * (1 + amount));
        b = Math.round(b * (1 + amount));
    }
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
