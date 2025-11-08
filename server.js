/*
  server.js (patched: championsData sends authoritative name-keyed scores)
  - CHAMPION_THRESHOLD, logging, and other improvements retained from previous patch
  - Only change here (relative to the prior server.js) is that getChampions now emits
    scores: { ...gameState.scores } (authoritative name-keyed scores) instead of buildScoresById()
*/

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Load words.json
const wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8'));

// Authoritative game state (scores keyed by player NAME)
let gameState = {
  players: {},           // socketId -> player object { id, name, color, ... }
  gameStarted: false,
  currentRound: 0,
  totalRounds: 2,
  currentTurn: null,
  secretWord: null,
  category: null,
  fakeArtist: null,      // socket id
  drawing: [],
  votes: {},             // voterSocketId -> votedPlayerName (string)
  scores: {},            // playerName -> number (authoritative)
  readyPlayers: new Set(),
  lobbyReadies: new Set(),
  // Champion tracking/history
  championTitles: {},    // name -> count
  history: []            // array of { champions: [...], scoresSnapshot: {...}, time: ISO }
};

let votingCache = { players: {}, drawing: [] };

// Name-based next-round consensus
let nextRoundRequiredNames = new Set(); // set of player NAMES required to click to continue
let nextRoundReadyNames = new Set();    // set of player NAMES that have clicked

// Colors for players
const colors = [
  '#FF6B6B', '#4ECDC4', '#FFD93D', '#6A4C93',
  '#00A8E8', '#FFA500', '#7CFC00', '#FF69B4'
];

/* ---------------- Champion threshold & diagnostics ---------------- */

const CHAMPION_THRESHOLD = 5;
let victoryInProgress = false;

function buildScoresById() {
  // Map authoritative name-keyed scores to socket-id keyed scores (for legacy clients)
  const out = {};
  for (const [id, p] of Object.entries(gameState.players)) {
    const name = p && p.name ? p.name : null;
    out[id] = (name && gameState.scores[name] !== undefined) ? gameState.scores[name] : 0;
  }
  return out;
}

function logScoresContext(reason = '') {
  try {
    console.log('[SERVER DEBUG] Scores snapshot (' + reason + '):', JSON.stringify({
      byName: { ...gameState.scores },
      byId: buildScoresById()
    }));
  } catch (e) {
    console.log('[SERVER DEBUG] Scores snapshot error', e);
  }
}

function checkChampionAndTriggerIfHit(context = '') {
  // Always use authoritative name-keyed gameState.scores here
  const champions = Object.keys(gameState.scores).filter(n => (gameState.scores[n] || 0) >= CHAMPION_THRESHOLD);
  if (champions.length > 0) {
    console.log('[SERVER DEBUG] Champion threshold reached (' + CHAMPION_THRESHOLD + ') in context:', context, 'champions:', champions);
    logScoresContext('before-triggerVictoryOrLobby-' + context);
    triggerVictoryOrLobby();
    return true;
  }
  return false;
}

/* ---------------- Helpers ---------------- */

function ensureScoresForCurrentPlayers() {
  Object.values(gameState.players).forEach(p => {
    if (p && p.name && gameState.scores[p.name] === undefined) gameState.scores[p.name] = 0;
  });
}

function remapPlayerId(oldId, newId) {
  if (gameState.fakeArtist === oldId) {
    gameState.fakeArtist = newId;
    console.log(`[SERVER DEBUG] fakeArtist id remapped to new socket: ${newId}`);
  }
  if (gameState.currentTurn === oldId) {
    gameState.currentTurn = newId;
  }

  // Remap votes keys (voter socket id) to new id
  const newVotes = {};
  for (const [k, v] of Object.entries(gameState.votes)) {
    const nk = (k === oldId ? newId : k);
    newVotes[nk] = v;
  }
  gameState.votes = newVotes;

  if (gameState.readyPlayers.has(oldId)) {
    gameState.readyPlayers.delete(oldId);
    gameState.readyPlayers.add(newId);
  }
  if (gameState.lobbyReadies.has(oldId)) {
    gameState.lobbyReadies.delete(oldId);
    gameState.lobbyReadies.add(newId);
  }
}

function getFakeArtistName() {
  return (gameState.fakeArtist && gameState.players[gameState.fakeArtist]) ? gameState.players[gameState.fakeArtist].name : "(Unknown)";
}

function getIdByNameInPlayers(theName, playersObj = gameState.players) {
  if (!theName) return null;
  const target = theName.trim().toLowerCase();
  for (const [id, p] of Object.entries(playersObj || {})) {
    if ((p.name || '').trim().toLowerCase() === target) return id;
  }
  return null;
}

function updateAllPlayers() {
  const playersList = Object.values(gameState.players);
  io.emit('updatePlayers', playersList);
  io.emit('enableStartButton', playersList.length >= 3);
}

/* ---------------- Game flow ---------------- */

function startNewGame() {
  console.log('[SERVER DEBUG] startNewGame');
  nextRoundRequiredNames.clear();
  nextRoundReadyNames.clear();

  gameState.gameStarted = true;
  gameState.currentRound = 0;
  gameState.readyPlayers.clear();

  Object.keys(gameState.players).forEach(pid => {
    gameState.players[pid].isFakeArtist = false;
    gameState.players[pid].ready = false;
    gameState.players[pid].hasSeenRole = false;
    gameState.players[pid].disconnected = false;
  });

  const playerIds = Object.keys(gameState.players);
  if (playerIds.length === 0) return;

  const fakeArtistId = playerIds[Math.floor(Math.random() * playerIds.length)];
  gameState.fakeArtist = fakeArtistId;
  gameState.players[fakeArtistId].isFakeArtist = true;

  const categories = Object.keys(wordsData.categories);
  gameState.category = categories[Math.floor(Math.random() * categories.length)];
  const words = wordsData.categories[gameState.category];
  gameState.secretWord = words[Math.floor(Math.random() * words.length)];

  gameState.drawing = [];
  gameState.votes = {};

  // Ensure score entries for current players exist
  ensureScoresForCurrentPlayers();

  // Set initial turn
  gameState.currentTurn = playerIds[0];

  // Send roles
  Object.keys(gameState.players).forEach(playerId => {
    const p = gameState.players[playerId];
    if (p.isFakeArtist) {
      io.to(playerId).emit('roleAssigned', { role: 'fake', category: gameState.category });
    } else {
      io.to(playerId).emit('roleAssigned', { role: 'artist', category: gameState.category, secretWord: gameState.secretWord });
    }
    gameState.players[playerId].hasSeenRole = true;
  });

  // Broadcast scores (socket-id keyed) so clients update immediately
  io.emit('scoresUpdated', { scores: buildScoresById(), players: gameState.players });

  // Notify voting clients to redirect if needed
  io.emit('startNewGame');

  // Start drawing
  io.emit('startDrawing', {
    currentTurn: gameState.currentTurn,
    drawing: gameState.drawing
  });
  io.emit('turnChanged', { currentTurn: gameState.currentTurn, players: gameState.players });
}

function startRound() {
  gameState.currentRound++;
  gameState.currentTurn = Object.keys(gameState.players)[0];
  io.emit('roundStarted', {
    round: gameState.currentRound,
    totalRounds: gameState.totalRounds,
    currentTurn: gameState.currentTurn,
    players: gameState.players,
    drawing: gameState.drawing
  });
  io.emit('turnChanged', { currentTurn: gameState.currentTurn, players: gameState.players });
}

function startDrawingPhase() {
  startRound();
  io.emit('startDrawing', {
    currentTurn: gameState.currentTurn,
    drawing: gameState.drawing
  });
}

function nextTurn() {
  const playerIds = Object.keys(gameState.players);
  const currentIndex = playerIds.indexOf(gameState.currentTurn);
  const nextIndex = (currentIndex + 1) % playerIds.length;
  gameState.currentTurn = playerIds[nextIndex];

  io.emit('turnChanged', {
    currentTurn: gameState.currentTurn,
    players: gameState.players
  });

  const roundsCompleted = gameState.currentRound >= gameState.totalRounds;
  const lastPlayer = nextIndex === 0;

  if (lastPlayer && roundsCompleted) {
    votingCache = {
      players: JSON.parse(JSON.stringify(gameState.players)),
      drawing: gameState.drawing.slice()
    };
    io.emit('startVoting', {
      players: votingCache.players,
      drawing: votingCache.drawing
    });
  } else if (lastPlayer && !roundsCompleted) {
    setTimeout(() => { startRound(); }, 1000);
  }
}

/* ---------------- Voting & scoring ---------------- */

/*
  calculateResults:
  - Tally votes by name
  - Determine top names (handle ties)
  - Require strict majority of votes cast to mark the fake as caught
*/
function calculateResults() {
  if (!gameState.players[gameState.fakeArtist]) {
    console.log('[SERVER DEBUG] Fake artist disconnected during round.');
    io.emit('votingResults', {
      votes: gameState.votes,
      voteCounts: {},
      accusedPlayer: null,
      fakeArtist: gameState.fakeArtist,
      fakeName: "(disconnected)",
      fakeArtistCaught: false,
      players: gameState.players,
      error: "Fake Artist disconnected"
    });
    io.emit('winnerCountdown', {
      winnerType: 'none',
      fakeName: "(disconnected)",
      scores: buildScoresById(),
      players: gameState.players
    });
    return;
  }

  // Tally votes by name
  const voteCounts = {};
  Object.values(gameState.votes).forEach(votedName => {
    if (!votedName) return;
    const normalized = (typeof votedName === 'string') ? votedName.trim() : votedName;
    voteCounts[normalized] = (voteCounts[normalized] || 0) + 1;
  });

  // total non-empty votes cast
  const totalVotes = Object.values(gameState.votes).filter(v => v && String(v).trim().length).length;

  // find top names (handle ties)
  let maxVotes = 0;
  let topNames = [];
  for (const [name, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      topNames = [name];
    } else if (count === maxVotes) {
      topNames.push(name);
    }
  }

  let accusedName = null;
  if (topNames.length === 1) accusedName = topNames[0];

  const accusedPlayer = getIdByNameInPlayers(accusedName);
  const fakeName = getFakeArtistName();
  const normalizeName = x => (typeof x === "string" ? x.trim().toLowerCase() : "");

  // require strict majority (>50% of votes cast)
  const hasMajority = (maxVotes > totalVotes / 2);
  const fakeArtistCaught = accusedName && hasMajority && (normalizeName(accusedName) === normalizeName(fakeName));

  console.log('[SERVER DEBUG] votingResults', {
    votes: { ...gameState.votes },
    voteCounts: { ...voteCounts },
    totalVotes,
    maxVotes,
    topNames,
    accusedPlayer,
    accusedPlayerName: accusedName,
    fakeArtist: gameState.fakeArtist,
    fakeName,
    hasMajority,
    fakeArtistCaught,
    players: Object.fromEntries(Object.entries(gameState.players).map(([id, p]) => [id, p.name]))
  });

  io.emit('votingResults', {
    votes: gameState.votes,
    voteCounts,
    accusedPlayer,
    accusedPlayerName: accusedName,
    fakeArtist: gameState.fakeArtist,
    fakeArtistName: fakeName,
    fakeArtistCaught,
    players: gameState.players,
    totalVotes,
    maxVotes,
    topNames
  });

  // Build required set of NAMES for next-round unanimous click
  nextRoundRequiredNames.clear();
  nextRoundReadyNames.clear();

  if (votingCache && votingCache.players && Object.keys(votingCache.players).length) {
    Object.values(votingCache.players).forEach(p => {
      if (p && p.name) nextRoundRequiredNames.add(p.name);
    });
  } else {
    Object.values(gameState.players).forEach(p => {
      if (p && !p.disconnected && p.name) nextRoundRequiredNames.add(p.name);
    });
  }

  // Emit readiness update
  io.emit('nextRoundReadyUpdate', {
    readyNames: Array.from(nextRoundReadyNames),
    readyCount: nextRoundReadyNames.size,
    totalNeeded: nextRoundRequiredNames.size,
    requiredNames: Array.from(nextRoundRequiredNames),
    players: gameState.players
  });

  setTimeout(() => {
    if (fakeArtistCaught) {
      // Prompt fake artist to guess
      io.to(gameState.fakeArtist).emit('fakeGuessPrompt', { secretCategory: gameState.category });

      io.emit('waitForFakeGuess', {
        fakeName,
        message: `${fakeName} was Caught!`,
        subMessage: `Waiting for ${fakeName} to guess the Secret Word`
      });
    } else {
      // Fake not caught: award fake +2 (by name)
      const fName = getFakeArtistName();
      if (fName) {
        if (gameState.scores[fName] === undefined) gameState.scores[fName] = 0;
        gameState.scores[fName] += 2;
        console.log(`[SERVER DEBUG] Awarded points to fake (by name): ${fName} => ${gameState.scores[fName]}`);
        logScoresContext('after-award-fake-in-calculateResults');
      } else {
        console.log('[SERVER DEBUG] Unable to determine fake name to award points.');
      }

      // Immediately check for champion and announce if threshold reached
      if (checkChampionAndTriggerIfHit('calculateResults-after-award-fake')) {
        return; // triggerVictoryOrLobby performed inside check
      }

      // Broadcast updated scores (socket-id keyed)
      io.emit('scoresUpdated', { scores: buildScoresById(), players: gameState.players });

      // Emit winner modal and wait for unanimous clients to click.
      io.emit('winnerCountdown', {
        winnerType: 'fake',
        fakeName,
        scores: buildScoresById(),
        players: gameState.players
      });
    }
  }, 1000);
}

/* When fake artist submits a guess (after being prompted) */
function handleFakeGuess(socket, guessText) {
  const normalizedGuess = (guessText ?? '').trim().toLowerCase();
  const normalizedSecret = (gameState.secretWord ?? '').trim().toLowerCase();
  const fakeName = getFakeArtistName();

  if (normalizedGuess && normalizedGuess === normalizedSecret) {
    // Fake guessed correctly -> fake gets +2
    if (fakeName) {
      if (gameState.scores[fakeName] === undefined) gameState.scores[fakeName] = 0;
      gameState.scores[fakeName] += 2;
      console.log(`[SERVER DEBUG] fake guessed correctly: ${fakeName} => ${gameState.scores[fakeName]}`);
      logScoresContext('after-fake-correct-guess');
    }
    io.emit('scoresUpdated', { scores: buildScoresById(), players: gameState.players });
    io.emit('winnerSteal', { winnerType: 'fake', fakeName, scores: buildScoresById(), players: gameState.players });

    // Check champion after awarding
    if (checkChampionAndTriggerIfHit('handleFakeGuess-fake-correct')) {
      return;
    }
    return;
  }

  // Fake guessed wrong: award every other participant +1 (use votingCache snapshot if available)
  let participantNames = [];
  if (votingCache && votingCache.players && Object.keys(votingCache.players).length) {
    participantNames = Object.values(votingCache.players).map(p => p && p.name ? p.name.trim() : null).filter(Boolean);
  } else {
    participantNames = Object.values(gameState.players)
      .filter(p => p && p.name && !p.disconnected)
      .map(p => p.name.trim());
  }

  const fakeNorm = (fakeName || '').trim().toLowerCase();
  const awarded = [];
  participantNames.forEach(name => {
    if (!name) return;
    if (name.trim().toLowerCase() === fakeNorm) return;
    if (gameState.scores[name] === undefined) gameState.scores[name] = 0;
    gameState.scores[name] += 1;
    awarded.push(name);
  });

  console.log('[SERVER DEBUG] Awarded points to (real artists):', awarded);
  console.log('[SERVER DEBUG] SCORES after fake wrong guess (by name):', JSON.stringify(gameState.scores));
  logScoresContext('after-award-real-artists-fake-wrong');

  io.emit('scoresUpdated', { scores: buildScoresById(), players: gameState.players });

  io.emit('winnerCountdown', {
    winnerType: 'artists',
    winnerNames: awarded,
    fakeName: fakeName,
    scores: buildScoresById(),
    players: gameState.players
  });

  // Check champion after awarding
  if (checkChampionAndTriggerIfHit('handleFakeGuess-fake-wrong')) {
    return;
  }
}

/* ---------------- Victory / Lobby ---------------- */

function triggerVictoryOrLobby() {
  if (victoryInProgress) {
    console.log('[SERVER DEBUG] triggerVictoryOrLobby called but victory already in progress — ignoring.');
    return;
  }
  victoryInProgress = true;

  try {
    logScoresContext('triggerVictoryOrLobby-entry');

    if (Object.values(gameState.scores).some(score => score >= CHAMPION_THRESHOLD)) {
      const maxScore = Math.max(...Object.values(gameState.scores));
      const winners = Object.keys(gameState.scores).filter(n => gameState.scores[n] === maxScore);
      console.log('[SERVER DEBUG] victory', { champions: winners, scores: { ...gameState.scores } });

      // Update champion titles and history
      winners.forEach(name => {
        if (!gameState.championTitles[name]) gameState.championTitles[name] = 0;
        gameState.championTitles[name] += 1;
      });
      gameState.history.push({
        champions: winners.slice(),
        scoresSnapshot: { ...gameState.scores },
        time: (new Date()).toISOString()
      });

      io.emit('victory', {
        champions: winners,
        scores: buildScoresById(),
        players: gameState.players,
        championTitles: gameState.championTitles
      });

      resetGame();
    } else {
      gameState.gameStarted = false;
      gameState.readyPlayers.clear();
      io.emit('returnToLobby');
      victoryInProgress = false; // no champion: clear flag
    }
  } catch (e) {
    console.error('[SERVER ERROR] in triggerVictoryOrLobby', e);
    victoryInProgress = false;
  }
}

function resetGame() {
  gameState.gameStarted = false;
  gameState.currentRound = 0;
  gameState.currentTurn = null;
  gameState.secretWord = null;
  gameState.category = null;
  gameState.fakeArtist = null;
  gameState.drawing = [];
  gameState.votes = {};
  gameState.readyPlayers.clear();
  gameState.lobbyReadies.clear();

  Object.keys(gameState.players).forEach(playerId => {
    gameState.players[playerId].ready = false;
    gameState.players[playerId].hasSeenRole = false;
    gameState.players[playerId].isFakeArtist = false;
    gameState.players[playerId].lobbyReady = false;
    gameState.players[playerId].disconnected = false;
  });

  // KEEP gameState.scores (persist across rounds until victory)
  // Clear victoryInProgress so new games can trigger new victories later
  victoryInProgress = false;
}

/* ---------------- HTTP routes ---------------- */

app.get('/', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/lobby', (req, res) => res.sendFile(path.join(__dirname,'public','lobby.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname,'public','game.html')));
app.get('/voting', (req, res) => res.sendFile(path.join(__dirname,'public','voting.html')));
app.get('/results', (req, res) => res.sendFile(path.join(__dirname,'public','results.html')));
app.get('/champions', (req, res) => res.sendFile(path.join(__dirname,'public','champions.html')));

/* ---------------- Socket.io ---------------- */

io.on('connection', (socket) => {
  console.log(`[SERVER DEBUG] socket connected: ${socket.id}`);
  socket.emit('updatePlayers', Object.values(gameState.players));
  socket.emit('enableStartButton', Object.keys(gameState.players).length >= 3);

  socket.on('joinGame', (playerName) => {
    console.log(`[SERVER DEBUG] joinGame: playerName=${playerName}, id=${socket.id}`);
    // reconnect by name?
    let existing = null;
    for (const [pid, p] of Object.entries(gameState.players)) {
      if (p.name === playerName) { existing = p; break; }
    }

    if (existing) {
      remapPlayerId(existing.id, socket.id);
      delete gameState.players[existing.id];
      existing.id = socket.id;
      gameState.players[socket.id] = existing;
    } else {
      const assignedColor = colors[Object.keys(gameState.players).length % colors.length];
      const player = { id: socket.id, name: playerName, color: assignedColor, isFakeArtist:false, ready:false, hasSeenRole:false, lobbyReady:false, disconnected:false };
      gameState.players[socket.id] = player;
    }

    // Ensure score entry for name
    if (playerName && gameState.scores[playerName] === undefined) {
      gameState.scores[playerName] = 0;
      console.log('[SERVER DEBUG] Initialized score for', playerName, '=> 0');
    }

    const outPlayer = gameState.players[socket.id];
    socket.emit('playerAssigned', { playerId: outPlayer.id, color: outPlayer.color, playerName: outPlayer.name });

    updateAllPlayers();
  });

  socket.on('lobbyReady', () => {
    if (!gameState.players[socket.id]) return;
    gameState.players[socket.id].lobbyReady = true;
    gameState.lobbyReadies.add(socket.id);

    io.emit('lobbyReadyUpdate', { lobbyReadies: Array.from(gameState.lobbyReadies), players: gameState.players });

    if (gameState.lobbyReadies.size === Object.keys(gameState.players).length && Object.keys(gameState.players).length >= 3) {
      console.log('[SERVER DEBUG] All players in lobby ready, starting new game.');
      startNewGame();
      gameState.lobbyReadies.clear();
      for (const pid in gameState.players) gameState.players[pid].lobbyReady = false;
    }
  });

  socket.on('startGame', () => {
    if (!gameState.players[socket.id]) return;
    if (!gameState.players[socket.id].lobbyReady) {
      gameState.players[socket.id].lobbyReady = true;
      gameState.lobbyReadies.add(socket.id);
    }
    io.emit('lobbyReadyUpdate', { lobbyReadies: Array.from(gameState.lobbyReadies), players: gameState.players });

    const totalPlayers = Object.keys(gameState.players).length;
    if (gameState.lobbyReadies.size === totalPlayers && totalPlayers >= 3) {
      console.log('[SERVER DEBUG] All players in lobby ready (startGame), starting new game.');
      startNewGame();
      gameState.lobbyReadies.clear();
      for (const pid in gameState.players) gameState.players[pid].lobbyReady = false;
    } else {
      console.log(`[SERVER DEBUG] startGame: ${socket.id} ready. ${gameState.lobbyReadies.size}/${totalPlayers} ready.`);
    }
  });

  socket.on('readyToSeeRole', () => {
    const player = gameState.players[socket.id]; if (!player) return;
    player.hasSeenRole = true;
    if (player.isFakeArtist === true) {
      io.to(socket.id).emit('roleAssigned', { role: "fake", category: gameState.category });
    } else {
      io.to(socket.id).emit('roleAssigned', { role: "artist", category: gameState.category, secretWord: gameState.secretWord });
    }
  });

  socket.on('playerReady', () => {
    if (!gameState.players[socket.id]) return;
    gameState.readyPlayers.add(socket.id);
    gameState.players[socket.id].ready = true;

    io.emit('playerReadyUpdate', { playerId: socket.id, readyPlayers: Array.from(gameState.readyPlayers), players: gameState.players });

    if (gameState.readyPlayers.size === Object.keys(gameState.players).length) {
      console.log('[SERVER DEBUG] All players ready, starting drawing phase.');
      startDrawingPhase();
    }
  });

  // Drawing handlers
  socket.on('drawStart', (data) => {
    if (!gameState.gameStarted) return;
    if (socket.id !== gameState.currentTurn) return;
    gameState.drawing.push({ type: 'line', points: [data], color: gameState.players[socket.id].color, playerId: socket.id });
    io.emit('drawStart', { ...data, color: gameState.players[socket.id].color, playerId: socket.id });
  });

  socket.on('drawMove', (data) => {
    if (!gameState.gameStarted) return;
    if (socket.id !== gameState.currentTurn) return;
    const currentLine = gameState.drawing[gameState.drawing.length - 1];
    if (currentLine && currentLine.type === 'line') {
      currentLine.points.push(data);
      io.emit('drawMove', { ...data, color: gameState.players[socket.id].color, playerId: socket.id });
    }
  });

  socket.on('drawEnd', () => {
    if (!gameState.gameStarted) return;
    if (socket.id !== gameState.currentTurn) return;
    nextTurn();
  });

  socket.on('submitVote', (votedPlayerName) => {
    console.log(`[SERVER DEBUG] submitVote from ${socket.id} voted ${votedPlayerName}`);
    gameState.votes[socket.id] = votedPlayerName; // store name
    io.emit('voteReceived', { voterId: socket.id, votedPlayerName, voterName: gameState.players[socket.id]?.name ?? "(?)" });

    if (Object.keys(gameState.votes).length === Object.keys(gameState.players).length) {
      console.log('[SERVER DEBUG] All votes received, calculating results.');
      calculateResults();
    }
  });

  // Fake guess
  socket.on('guessSubmitted', (guessText) => {
    handleFakeGuess(socket, guessText);
    // After awarding, checks are performed inside handleFakeGuess
  });

  // Next-round readiness tracked by NAME
  socket.on('startNextRoundReady', () => {
    if (!gameState.players[socket.id]) return;
    const playerName = gameState.players[socket.id].name;
    if (!playerName) return;

    // Only count if name is required for this round
    if (!nextRoundRequiredNames.has(playerName)) {
      console.log(`[SERVER DEBUG] startNextRoundReady ignored from ${socket.id} (${playerName}) - not required`);
      return;
    }

    console.log(`[SERVER DEBUG] startNextRoundReady received from ${socket.id} (${playerName})`);
    nextRoundReadyNames.add(playerName);

    io.emit('nextRoundReadyUpdate', {
      readyNames: Array.from(nextRoundReadyNames),
      readyCount: nextRoundReadyNames.size,
      totalNeeded: nextRoundRequiredNames.size,
      requiredNames: Array.from(nextRoundRequiredNames),
      players: gameState.players
    });

    if (nextRoundReadyNames.size === nextRoundRequiredNames.size && nextRoundRequiredNames.size > 0) {
      console.log('[SERVER DEBUG] All required players ready by name — starting new game.');
      nextRoundReadyNames.clear();
      nextRoundRequiredNames.clear();
      startNewGame();
    }
  });

  socket.on('requestVotingState', () => {
    console.log('[SERVER DEBUG] requestVotingState');
    socket.emit('startVoting', { players: gameState.players, drawing: votingCache.drawing });
  });

  socket.on('newRound', () => {
    console.log('[SERVER DEBUG] newRound (legacy) requested by', socket.id);
    triggerVictoryOrLobby();
  });

  socket.on('disconnect', () => {
    if (!gameState.players[socket.id]) return;
    const pname = gameState.players[socket.id].name;

    if (!gameState.gameStarted) {
      console.log(`[SERVER DEBUG] disconnect in lobby: remove ${socket.id}`);
      delete gameState.players[socket.id];
      gameState.readyPlayers.delete(socket.id);
      gameState.lobbyReadies.delete(socket.id);
      updateAllPlayers();
    } else {
      console.log(`[SERVER DEBUG] disconnect in game: mark as disconnected ${socket.id}`);
      gameState.players[socket.id].disconnected = true;
      updateAllPlayers();
    }

    // If disconnected player's NAME was required to continue, remove them so they don't block
    if (pname && nextRoundRequiredNames.has(pname)) {
      nextRoundRequiredNames.delete(pname);
      nextRoundReadyNames.delete(pname);

      io.emit('nextRoundReadyUpdate', {
        readyNames: Array.from(nextRoundReadyNames),
        readyCount: nextRoundReadyNames.size,
        totalNeeded: nextRoundRequiredNames.size,
        requiredNames: Array.from(nextRoundRequiredNames),
        players: gameState.players
      });

      // if removal makes everyone else ready, start the game
      if (nextRoundRequiredNames.size > 0 && nextRoundReadyNames.size === nextRoundRequiredNames.size) {
        console.log('[SERVER DEBUG] After disconnect removal, all remaining required players are ready. Starting new game.');
        nextRoundReadyNames.clear();
        nextRoundRequiredNames.clear();
        startNewGame();
      }
    }
  });

  /* ---------- Champions & reset handlers ---------- */

  // Client requests champions data (history, current championTitles, scores)
  socket.on('getChampions', () => {
    // IMPORTANT: send authoritative name-keyed scores so the clients render stable snapshots
    socket.emit('championsData', {
      history: gameState.history.slice().reverse(), // newest first
      championTitles: { ...gameState.championTitles },
      // send authoritative name-keyed scores (not socket-id keyed)
      scores: { ...gameState.scores },
      players: gameState.players
    });
  });

  // Reset scores and start next game (clears previous scores but keeps history)
  socket.on('resetScoresAndStart', (opts = {}) => {
    console.log('[SERVER DEBUG] resetScoresAndStart requested by', socket.id, opts);

    // Reset authoritative name-keyed scores
    Object.keys(gameState.scores).forEach(name => {
      gameState.scores[name] = 0;
    });
    logScoresContext('after-resetScoresAndStart');

    // Broadcast cleared scores
    io.emit('scoresUpdated', { scores: buildScoresById(), players: gameState.players });

    // Optionally clear championTitles if you want a full wipe - here we keep championTitles but you can reset:
    if (opts.resetChampionTitles) {
      gameState.championTitles = {};
    }

    // Move players back to lobby and clear ready flags; then, if enough players, start new game
    gameState.gameStarted = false;
    gameState.readyPlayers.clear();
    gameState.lobbyReadies.clear();
    Object.keys(gameState.players).forEach(pid => {
      gameState.players[pid].ready = false;
      gameState.players[pid].lobbyReady = false;
    });

    io.emit('returnToLobby');

    // If enough players, automatically start a new game after a short delay
    setTimeout(() => {
      if (Object.keys(gameState.players).length >= 3) {
        startNewGame();
      }
    }, 1200);
  });

  /* ---------- End champions handlers ---------- */

}); // io.on connection end

server.listen(PORT, () => {
  console.log(`🎨 A FAKE ARTIST GOES TO NEW YORK server running on port ${PORT}`);
  console.log(`👉 Open http://localhost:${PORT} in your browser to play!`);
});