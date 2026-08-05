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
        status: "scheduled,live",
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

// Stats de saison d'une équipe (forme, buts, xG agrégé sur toute la saison)
app.get("/api/team-stats/:teamId/:seasonId", async (req, res) => {
  const { teamId, seasonId } = req.params;
  const key = `${teamId}_${seasonId}`;
  try {
    const result = await cached(caches.teamStats, key, async () => {
      const data = await statsApiGet(`/football/teams/${teamId}/stats`, {
        season_id: seasonId,
      });
      return { stats: data };
    }, 60 * 60 * 1000)(); // cache 1h (données de saison, peu volatile)
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

// Vider tous les caches (utile après un déploiement ou pour forcer un refresh)
app.get("/api/clear-cache", (req, res) => {
  Object.values(caches).forEach((c) => c.clear());
  res.json({ cleared: true, message: "Tous les caches ont été vidés." });
});

app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`FootPredicta démarré sur le port ${PORT}`);
});
