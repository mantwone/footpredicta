/**
 * FootPredicta — Serveur API
 * ==========================
 * Sert de proxy entre l'app web et TheStatsAPI, en gardant la clé API
 * secrète côté serveur. Couvre les 5 grands championnats européens + LDC.
 *
 * Endpoints exposés :
 *   GET /api/competitions          — liste des compétitions disponibles
 *   GET /api/fixtures/:compId      — matchs à venir d'une compétition
 *   GET /api/match/:matchId        — détails d'un match (score, statut)
 *   GET /api/xg/:matchId           — données xG d'un match
 *   GET /api/odds/:matchId         — cotes bookmakers d'un match
 *   GET /api/lineups/:matchId      — compositions officielles
 *   GET /api/team-stats/:teamId/:seasonId — stats de saison d'une équipe
 *   GET /api/h2h/:homeId/:awayId   — historique confrontations directes
 *   GET /api/clear-cache           — vider les caches (debug)
 *   GET /healthz                   — santé du serveur
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.STATS_API_KEY;
const BASE_URL = "https://api.thestatsapi.com/api";

// ---- IDs des compétitions sur TheStatsAPI ----
// Ces IDs sont stables — ils ne changent pas d'une saison à l'autre.
const COMPETITIONS = {
  premier_league:    { id: "comp_3039",   name: "Premier League",      country: "England", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  la_liga:           { id: "comp_8814",   name: "LaLiga",              country: "Spain",   flag: "🇪🇸" },
  bundesliga:        { id: "comp_4643",   name: "Bundesliga",          country: "Germany", flag: "🇩🇪" },
  serie_a:           { id: "comp_5840",   name: "Serie A",             country: "Italy",   flag: "🇮🇹" },
  ligue_1:           { id: "comp_0256",   name: "Ligue 1",             country: "France",  flag: "🇫🇷" },
  champions_league:  { id: "comp_3498",   name: "Champions League",    country: "Europe",  flag: "🏆" },
  europa_league:     { id: "comp_7739",   name: "Europa League",       country: "Europe",  flag: "🟠" },
  conference_league: { id: "comp_408698", name: "Conference League",   country: "Europe",  flag: "🔵" },
};

// ---- Appel générique à TheStatsAPI ----
async function statsApiGet(endpoint, params = {}) {
  if (!API_KEY) throw new Error("STATS_API_KEY non configurée sur le serveur.");

  const url = new URL(BASE_URL + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: "Bearer " + API_KEY },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TheStatsAPI ${res.status}: ${text}`);
  }

  return res.json();
}

// ---- Cache générique ----
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const caches = {
  fixtures:   new Map(),
  match:      new Map(),
  xg:         new Map(),
  odds:       new Map(),
  lineups:    new Map(),
  teamStats:  new Map(),
  h2h:        new Map(),
};

function cached(store, key, fetchFn, ttl = CACHE_DURATION_MS) {
  return async () => {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && now - hit.fetchedAt < ttl) return { cached: true, ...hit.data };
    const data = await fetchFn();
    store.set(key, { data, fetchedAt: now });
    return { cached: false, ...data };
  };
}

// ---- Endpoints ----

// Liste des compétitions disponibles (statique, pas d'appel API)
app.get("/api/competitions", (req, res) => {
  res.json({ competitions: COMPETITIONS });
});

// Matchs à venir + récents d'une compétition
app.get("/api/fixtures/:compId", async (req, res) => {
  const { compId } = req.params;
  const key = `fixtures_${compId}`;
  try {
    const result = await cached(caches.fixtures, key, async () => {
      const data = await statsApiGet("/football/matches", {
        competition_id: compId,
        status: "scheduled",
        per_page: 50,
      });
      return { fixtures: data.data || [] };
    })();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Détails d'un match (score, statut, événements)
app.get("/api/match/:matchId", async (req, res) => {
  const { matchId } = req.params;
  try {
    const result = await cached(caches.match, matchId, async () => {
      const data = await statsApiGet(`/football/matches/${matchId}`);
      return { match: data };
    }, 60 * 1000)(); // cache court (1 min) pour les scores en direct
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// xG du match (disponible uniquement si xg_available=true sur le fixture)
app.get("/api/xg/:matchId", async (req, res) => {
  const { matchId } = req.params;
  try {
    const result = await cached(caches.xg, matchId, async () => {
      const data = await statsApiGet(`/football/matches/${matchId}/xg`);
      return { xg: data };
    })();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Cotes bookmakers (Bet365, Pinnacle, Betfair, Paddy Power, Kambi)
app.get("/api/odds/:matchId", async (req, res) => {
  const { matchId } = req.params;
  try {
    const result = await cached(caches.odds, matchId, async () => {
      const data = await statsApiGet(`/football/matches/${matchId}/odds`);
      return { odds: data };
    })();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Compositions officielles (disponibles ~40 min avant le coup d'envoi)
app.get("/api/lineups/:matchId", async (req, res) => {
  const { matchId } = req.params;
  try {
    const result = await cached(caches.lineups, matchId, async () => {
      const data = await statsApiGet(`/football/matches/${matchId}/lineups`);
      return { lineups: data };
    }, 5 * 60 * 1000)();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Stats de saison d'une équipe — essaie la saison en cours, puis la précédente
app.get("/api/team-stats/:teamId/:seasonId", async (req, res) => {
  const { teamId, seasonId } = req.params;
  const key = `${teamId}_${seasonId}`;
  try {
    const result = await cached(caches.teamStats, key, async () => {
      try {
        const data = await statsApiGet(`/football/teams/${teamId}/stats`, {
          season_id: seasonId,
        });
        return { stats: data.data || data, source: "current" };
      } catch (err) {
        if (!err.message.includes("404")) throw err;
        // Saison en cours sans données → essayer la saison précédente
        // On cherche la prev season en listant les saisons de la compétition
        return { stats: null, source: "none" };
      }
    }, 60 * 60 * 1000)();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Stats d'une équipe sur une saison précise (pour l'historique)
app.get("/api/team-stats-prev/:teamId/:compId", async (req, res) => {
  const { teamId, compId } = req.params;
  const prevSeasonId = PREV_SEASON_IDS[compId];
  if (!prevSeasonId) return res.json({ stats: null, source: "no_prev_season" });

  const key = `prev_${teamId}_${prevSeasonId}`;
  try {
    const result = await cached(caches.teamStats, key, async () => {
      const data = await statsApiGet(`/football/teams/${teamId}/stats`, {
        season_id: prevSeasonId,
      });
      return { stats: data.data || data, prevSeasonId, source: "previous" };
    }, 24 * 60 * 60 * 1000)(); // cache 24h, données historiques stables
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Historique des confrontations directes entre deux équipes
app.get("/api/h2h/:homeId/:awayId", async (req, res) => {
  const { homeId, awayId } = req.params;
  const key = `h2h_${homeId}_${awayId}`;

  // On filtre uniquement les ligues/coupes européennes majeures connues
  // plus les championnats nationaux des deux équipes
  const ALLOWED_COMPS = new Set([
    "comp_3039", "comp_8814", "comp_4643", "comp_5840", "comp_0256",
    "comp_3498", "comp_7739", "comp_408698",
  ]);

  try {
    const result = await cached(caches.h2h, key, async () => {
      // Deux appels : home vs away ET away vs home
      const [d1, d2] = await Promise.all([
        statsApiGet("/football/matches", {
          home_team_id: homeId,
          away_team_id: awayId,
          status: "finished",
          per_page: 20,
        }),
        statsApiGet("/football/matches", {
          home_team_id: awayId,
          away_team_id: homeId,
          status: "finished",
          per_page: 20,
        }),
      ]);

      const all = [...(d1.data || []), ...(d2.data || [])];

      // Dédoublonner par ID de match
      const seen = new Set();
      const unique = all.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Filtrer : compétitions connues + score disponible
      const matches = unique.filter(m =>
        ALLOWED_COMPS.has(m.competition_id) &&
        m.score?.final_score?.home !== null &&
        m.score?.final_score?.away !== null
      );

      // Trier par date décroissante et limiter à 6
      matches.sort((a, b) => new Date(b.utc_date) - new Date(a.utc_date));
      return { h2h: matches.slice(0, 6) };
    }, 60 * 60 * 1000)();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Liste les saisons disponibles pour une compétition
app.get("/api/seasons/:compId", async (req, res) => {
  const { compId } = req.params;
  try {
    const data = await statsApiGet(`/football/competitions/${compId}/seasons`);
    res.json({ seasons: data.data || data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// IDs des saisons précédentes (2025-2026) — utilisés pour les stats historiques
// quand la saison en cours n'a pas encore commencé.
const PREV_SEASON_IDS = {
  "comp_3039":   "sn_6125938", // Premier League 25/26
  "comp_8814":   "sn_7246390", // LaLiga 25/26
  "comp_4643":   "sn_5789634", // Bundesliga 25/26
  "comp_5840":   "sn_3061436", // Serie A 25/26
  "comp_0256":   "sn_6120181", // Ligue 1 25/26
  "comp_3498":   "sn_5783461", // UCL 25/26
  "comp_7739":   "sn_0819325", // Europa League 25/26
  "comp_408698": "sn_1397633", // Conference League 25/26
};

// Expose l'ID de saison précédente pour qu'on puisse charger les stats historiques
app.get("/api/prev-season/:compId", (req, res) => {
  const { compId } = req.params;
  const seasonId = PREV_SEASON_IDS[compId] || null;
  res.json({ compId, prevSeasonId: seasonId });
});

// Recherche de compétitions par nom
app.get("/api/search-competitions", async (req, res) => {
  const { q } = req.query;
  try {
    const data = await statsApiGet("/football/competitions", { search: q });
    res.json({ competitions: data.data || data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Debug H2H — réponse brute sans filtre
app.get("/api/debug-h2h/:homeId/:awayId", async (req, res) => {
  const { homeId, awayId } = req.params;
  try {
    const [d1, d2] = await Promise.all([
      statsApiGet("/football/matches", { home_team_id: homeId, away_team_id: awayId, status: "finished", per_page: 5 }),
      statsApiGet("/football/matches", { home_team_id: awayId, away_team_id: homeId, status: "finished", per_page: 5 }),
    ]);
    res.json({
      direction1: (d1.data || []).map(m => ({ id: m.id, comp: m.competition_id, date: m.utc_date, home: m.home_team.name, away: m.away_team.name, score: m.score?.final_score })),
      direction2: (d2.data || []).map(m => ({ id: m.id, comp: m.competition_id, date: m.utc_date, home: m.home_team.name, away: m.away_team.name, score: m.score?.final_score })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vider tous les caches (utile après un déploiement ou pour forcer un refresh)
app.get("/api/clear-cache", (req, res) => {
  Object.values(caches).forEach((c) => c.clear());
  res.json({ cleared: true, message: "Tous les caches ont été vidés." });
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`FootPredicta démarré sur le port ${PORT}`);
});
