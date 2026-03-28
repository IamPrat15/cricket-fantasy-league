/**
 * ESPNcricinfo Unofficial JSON API scraper
 * IPL 2026 Series ID: 1510719
 *
 * Endpoints used:
 *  Schedule : https://hs-consumer-api.espncricinfo.com/v1/pages/series/schedule?lang=en&seriesId=1510719
 *  Scorecard: https://hs-consumer-api.espncricinfo.com/v1/pages/match/details?lang=en&seriesId=1510719&matchId={id}
 *
 * DISCLAIMER: These are undocumented internal endpoints. They work as of IPL 2026
 * but may break without notice if ESPN changes their API structure.
 */

const SERIES_ID = process.env.CRICINFO_SERIES_ID || '1510719';
const BASE = 'https://hs-consumer-api.espncricinfo.com/v1/pages';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.espncricinfo.com/',
  'Origin': 'https://www.espncricinfo.com',
};

// ─── Fetch helper ─────────────────────────────────────────────────────────────
async function cricFetch(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`ESPNcricinfo returned ${res.status} for ${url}`);
  return res.json();
}

// ─── Get all IPL 2026 matches from schedule ──────────────────────────────────
async function getSchedule() {
  const url = `${BASE}/series/schedule?lang=en&seriesId=${SERIES_ID}`;
  const data = await cricFetch(url);

  // Navigate the response structure
  const fixtures = data?.content?.matches || data?.matches || [];
  return fixtures.map(m => ({
    matchId: m.objectId || m.id,
    matchNumber: m.title || m.matchTitle,
    status: m.status,           // 'live' | 'result' | 'preview'
    teams: [
      m.teams?.[0]?.team?.shortName || m.team1?.shortName,
      m.teams?.[1]?.team?.shortName || m.team2?.shortName,
    ],
    startDate: m.startDate,
    venue: m.ground?.name,
    isLive: m.isLive || m.matchStatus === 'live',
    isCompleted: m.matchStatus === 'result' || m.status === 'result',
  }));
}

// ─── Get scorecard for a specific match ──────────────────────────────────────
async function getScorecard(matchId) {
  const url = `${BASE}/match/details?lang=en&seriesId=${SERIES_ID}&matchId=${matchId}`;
  const data = await cricFetch(url);

  const content = data?.content || data;
  const innings = content?.scorecard?.innings || content?.innings || {};
  const playerScores = {};

  // Parse each innings
  Object.values(innings).forEach(inning => {
    // Batsmen
    const batsmen = inning?.inningBatsmen || inning?.batsmen || [];
    batsmen.forEach(b => {
      const name = b?.player?.name || b?.name;
      if (!name) return;
      const runs = parseInt(b?.runs) || 0;
      const fours = parseInt(b?.fours) || 0;
      const sixes = parseInt(b?.sixes) || 0;
      const balls = parseInt(b?.balls) || 0;
      const isDismissed = b?.dismissal !== 'not out' && !!b?.dismissal;

      // Fantasy scoring: runs + boundary bonus + SR bonus + duck penalty
      let pts = runs;
      pts += fours;           // +1 per four (boundary bonus)
      pts += sixes * 2;       // +2 per six
      if (runs >= 50 && runs < 100) pts += 8;   // half-century bonus
      if (runs >= 100) pts += 16;               // century bonus
      if (runs === 0 && isDismissed) pts -= 5;  // duck penalty

      playerScores[name] = (playerScores[name] || 0) + pts;
    });

    // Bowlers
    const bowlers = inning?.inningBowlers || inning?.bowlers || [];
    bowlers.forEach(b => {
      const name = b?.player?.name || b?.name;
      if (!name) return;
      const wickets = parseInt(b?.wickets) || 0;
      const maidens = parseInt(b?.maidens) || 0;
      const runsGiven = parseInt(b?.runs) || 0;
      const overs = parseFloat(b?.overs) || 0;

      // Fantasy: wickets + maiden + economy bonus
      let pts = wickets * 25;
      pts += maidens * 8;
      if (wickets >= 3 && wickets < 5) pts += 4;   // 3-wicket bonus
      if (wickets >= 5) pts += 8;                   // 5-wicket bonus

      // Economy rate bonus/penalty (min 2 overs)
      if (overs >= 2) {
        const eco = runsGiven / overs;
        if (eco <= 5) pts += 6;
        else if (eco <= 6) pts += 4;
        else if (eco <= 7) pts += 2;
        else if (eco >= 10 && eco < 11) pts -= 2;
        else if (eco >= 11 && eco < 12) pts -= 4;
        else if (eco >= 12) pts -= 6;
      }

      playerScores[name] = (playerScores[name] || 0) + pts;
    });

    // Fielding: catches, stumpings, run-outs
    const fow = inning?.inningFallOfWickets || [];
    const allDismissals = batsmen.map(b => b?.dismissalText || '').join(' ');

    // Parse catches / stumpings from dismissal text
    batsmen.forEach(b => {
      const d = b?.dismissalText || b?.dismissal || '';
      const catchMatch = d.match(/c (\w[\w\s]+?) b/i);
      const stumpMatch = d.match(/st (\w[\w\s]+?) b/i);
      const runoutMatch = d.match(/run out \((\w[\w\s]+?)\)/i);

      if (catchMatch) {
        const fielder = catchMatch[1].trim();
        if (fielder && fielder.toLowerCase() !== 'sub') {
          playerScores[fielder] = (playerScores[fielder] || 0) + 8;
        }
      }
      if (stumpMatch) {
        const wk = stumpMatch[1].trim();
        playerScores[wk] = (playerScores[wk] || 0) + 12;
      }
      if (runoutMatch) {
        const fielder = runoutMatch[1].trim();
        if (fielder) playerScores[fielder] = (playerScores[fielder] || 0) + 6;
      }
    });
  });

  return {
    matchId,
    playerScores,   // { playerName: totalFantasyPoints }
    rawData: content,
  };
}

// ─── Get live / most recent match ───────────────────────────────────────────
async function getLatestMatch() {
  const schedule = await getSchedule();
  // Prefer live match, else last completed
  const live = schedule.find(m => m.isLive);
  if (live) return live;
  const completed = schedule.filter(m => m.isCompleted);
  return completed[completed.length - 1] || null;
}

// ─── Get ALL completed match scorecards (for full season sync) ───────────────
async function getAllCompletedScores() {
  const schedule = await getSchedule();
  const completed = schedule.filter(m => m.isCompleted);
  const allScores = {};

  for (const match of completed) {
    try {
      const { playerScores } = await getScorecard(match.matchId);
      Object.entries(playerScores).forEach(([name, pts]) => {
        allScores[name] = (allScores[name] || 0) + pts;
      });
      // Small delay to be polite to ESPN servers
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.warn(`Skipping match ${match.matchId}: ${e.message}`);
    }
  }

  return allScores;
}

module.exports = { getSchedule, getScorecard, getLatestMatch, getAllCompletedScores, SERIES_ID };
