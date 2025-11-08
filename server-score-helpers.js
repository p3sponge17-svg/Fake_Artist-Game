// Helper snippets for server.js to keep id-keyed authoritative scores
// and to apply the updated scoring rules requested:
// - If Fake Artist is caught and guesses the word correctly => Fake wins 2 points
// - If Fake Artist is not caught => Fake wins 2 points
// - If Fake Artist is caught and fails to guess => Real Artists each win 1 point
// - First player to 5 points is crowned "The Champion" and champion titles (by name) are incremented.
//
// Place this file next to server.js and require it from server.js:
// const { awardPoint, scoresIdToNameSnapshot, applyRoundOutcome } = require('./server-score-helpers');

function awardPoint(scoresById, playerId, amount = 1) {
  if (!scoresById || typeof playerId === 'undefined') return scoresById || {};
  const out = Object.assign({}, scoresById);
  out[playerId] = (out[playerId] || 0) + (Number(amount) || 0);
  return out;
}

function scoresIdToNameSnapshot(scoresById, playersById) {
  const out = {};
  for (const id in (scoresById || {})) {
    const score = scoresById[id] || 0;
    const p = playersById && playersById[id];
    const name = p && p.name ? p.name : id;
    out[name] = score;
  }
  return out;
}

/**
 * applyRoundOutcome:
 * - scoresById: object mapping playerId -> score (authoritative)
 * - playersById: object mapping playerId -> { id, name, color, ... }
 * - championTitlesByName: object mapping playerName -> integer (will be mutated/returned)
 * - options: { fakeId, fakeCaught (bool), fakeGuessedCorrectly (bool) }
 *
 * Returns an object with the updated state:
 * { scoresById, championTitlesByName, champions: [names], historyEntry }
 *
 * The function does:
 * - awards points according to the new rules (2 points to fake in win cases, 1 point to each real artist when appropriate)
 * - detects any champions (score >= 5) and increments championTitlesByName for champion names
 * - produces a history entry (name-keyed snapshot) you can push to your champion history
 */
function applyRoundOutcome(scoresById, playersById, championTitlesByName = {}, options = {}) {
  const { fakeId, fakeCaught = false, fakeGuessedCorrectly = false } = options;
  let updatedScores = Object.assign({}, scoresById || {});
  let updatedTitles = Object.assign({}, championTitlesByName || {});
  const playerIds = Object.keys(playersById || {});
  const winnersByName = [];

  if (!fakeId || !(playersById && playersById[fakeId])) {
    // defensive: if fakeId missing, nothing to award
    return { scoresById: updatedScores, championTitlesByName: updatedTitles, champions: [], historyEntry: null };
  }

  const fakePlayer = playersById[fakeId];
  // Rule application:
  if (fakeCaught) {
    if (fakeGuessedCorrectly) {
      // Fake guessed correctly after being caught: Fake wins 2 points
      updatedScores = awardPoint(updatedScores, fakeId, 2);
      winnersByName.push(fakePlayer.name || fakeId);
    } else {
      // Fake caught and failed to guess: each real artist wins 1 point
      for (const pid of playerIds) {
        if (pid === fakeId) continue;
        updatedScores = awardPoint(updatedScores, pid, 1);
        const p = playersById[pid];
        if (p && p.name) winnersByName.push(p.name);
      }
    }
  } else {
    // Fake not caught: Fake wins 2 points
    updatedScores = awardPoint(updatedScores, fakeId, 2);
    winnersByName.push(fakePlayer.name || fakeId);
  }

  // Detect champions (first to reach 5 points). There may be ties.
  const champions = [];
  for (const pid of Object.keys(updatedScores)) {
    const score = updatedScores[pid] || 0;
    if (score >= 5) {
      const p = playersById[pid];
      const name = p && p.name ? p.name : pid;
      champions.push(name);
      updatedTitles[name] = (updatedTitles[name] || 0) + 1;
    }
  }

  // Build a name-keyed scores snapshot for history display
  const scoresSnapshotByName = scoresIdToNameSnapshot(updatedScores, playersById);

  const historyEntry = {
    time: Date.now(),
    champions: champions.slice(),        // array of champion names (maybe empty)
    winners: winnersByName.slice(),      // this round's winners by name
    scoresSnapshot: scoresSnapshotByName
  };

  return {
    scoresById: updatedScores,
    championTitlesByName: updatedTitles,
    champions,
    historyEntry
  };
}

module.exports = {
  awardPoint,
  scoresIdToNameSnapshot,
  applyRoundOutcome
};