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
  premier_league:    { id: "comp_3039", name: "Premier League",    country: "England",  flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  la_liga:           { id: "comp_3040", name: "La Liga",           country: "Spain",    flag: "🇪🇸" },
  bundesliga:        { id: "comp_3041", name: "Bundesliga",        country: "Germany",  flag: "🇩🇪" },
  serie_a:           { id: "comp_3042", name: "Serie A",           country: "Italy",    flag: "🇮🇹" },
  ligue_1:           { id: "comp_3043", name: "Ligue 1",           country: "France",   flag: "🇫🇷" },
  champions_league:  { id: "comp_3044", name: "Champions League",  country: "Europe",   flag: "🏆" },
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
  const key = `${homeId}_${awayId}`;
  try {
    const result = await cached(caches.h2h, key, async () => {
      const data = await statsApiGet("/football/matches", {
        home_team_id: homeId,
        away_team_id: awayId,
        status: "finished",
        per_page: 10,
      });
      return { h2h: data.data || [] };
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
  "comp_3039": "sn_6125938", // Premier League 2025-2026
  "comp_3040": "sn_6125939", // La Liga 2025-2026 (à confirmer)
  "comp_3041": "sn_6125940", // Bundesliga 2025-2026 (à confirmer)
  "comp_3042": "sn_6125941", // Serie A 2025-2026 (à confirmer)
  "comp_3043": "sn_6125942", // Ligue 1 2025-2026 (à confirmer)
  "comp_3044": "sn_6125943", // UCL 2025-2026 (à confirmer)
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

// Vider tous les caches (utile après un déploiement ou pour forcer un refresh)
app.get("/api/clear-cache", (req, res) => {
  Object.values(caches).forEach((c) => c.clear());
  res.json({ cleared: true, message: "Tous les caches ont été vidés." });
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`FootPredicta démarré sur le port ${PORT}`);
});
