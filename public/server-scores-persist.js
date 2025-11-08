/**
 * Lightweight express server to persist scores for the standalone victory page.
 *
 * Usage:
 *  node server-scores-persist.js
 *
 * Endpoints:
 *  GET  /api/scores         -> { scores: { name: number, ... } }
 *  POST /api/win            -> body { name: "Neil" } increments that name and returns scores
 *  POST /api/reset          -> resets scores to {}
 *
 * Also serves static files from ./public so you can open:
 *  http://localhost:3000/victory-standalone.html
 *
 * Persistence:
 *  Scores are stored at ./scores.json next to this file.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const DATA_FILE = path.join(__dirname, 'scores.json');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load scores from disk (if present)
function loadScores() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('Failed to load scores.json:', e);
    return {};
  }
}

// Save scores to disk (atomic-ish write)
function saveScores(scores) {
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(scores, null, 2), 'utf8');
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    return true;
  } catch (e) {
    console.error('Failed to save scores.json:', e);
    return false;
  }
}

// In-memory scores (authoritative map: name -> number)
let scores = loadScores();

// Ensure some safety: every operation updates disk
app.get('/api/scores', (req, res) => {
  return res.json({ scores });
});

app.post('/api/win', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing name' });
  scores[name] = (scores[name] || 0) + 1;
  const ok = saveScores(scores);
  if (!ok) return res.status(500).json({ error: 'save failed' });
  return res.json({ scores });
});

app.post('/api/reset', (req, res) => {
  scores = {};
  const ok = saveScores(scores);
  if (!ok) return res.status(500).json({ error: 'save failed' });
  return res.json({ scores });
});

// convenience: serve the standalone page at /victory-standalone
app.get('/victory-standalone', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'victory-standalone.html'));
});

app.listen(PORT, () => {
  console.log(`Scores server running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT}/victory-standalone to test the victory page.`);
});