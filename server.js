/**
 * Serveur du Prédicteur Coupe du Monde 2026
 * ===========================================
 * Ce petit serveur fait deux choses :
 *  1. Il appelle l'API-Football à ta place (ta clé reste secrète côté serveur,
 *     jamais visible dans le navigateur de l'utilisateur).
 *  2. Il garde les résultats en mémoire pendant 10 minutes (cache) pour éviter
 *     de dépasser ton quota gratuit de 100 requêtes/jour si plusieurs personnes
 *     ouvrent l'app en même temps.
 *
 * Une fois déployé (voir GUIDE-DEPLOIEMENT.md), ce serveur expose une seule
 * adresse : /api/fixtures qui renvoie les prochains matchs et leurs stats.
 */

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors()); // autorise l'app web (autre domaine) à appeler ce serveur

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY; // définie sur Render, jamais en dur ici
const BASE_URL = "https://v3.football.api-sports.io";

// Coupe du Monde 2026 = league id 1 dans API-Football, saison 2026
const LEAGUE_ID = 1;
const SEASON = 2026;

// ---- Cache simple en mémoire ----
let cache = { data: null, fetchedAt: 0 };
const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes

async function apiFootballGet(path, params) {
  const url = new URL(BASE_URL + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url, {
    headers: { "x-apisports-key": API_KEY },
  });
  if (!resp.ok) {
    throw new Error(`Appel API-Football échoué (${resp.status})`);
  }
  return resp.json();
}

/**
 * Récupère les prochains matchs de la Coupe du Monde 2026 (les 40 suivants,
 * soit environ 3 à 4 journées de tournoi puisque plusieurs matchs se jouent
 * chaque jour), et pour chacun les infos essentielles des deux équipes.
 */
async function fetchUpcomingFixtures() {
  const fixturesResp = await apiFootballGet("/fixtures", {
    league: LEAGUE_ID,
    season: SEASON,
    next: 40,
  });

  const fixtures = fixturesResp.response || [];

  const enriched = await Promise.all(
    fixtures.map(async (f) => {
      const homeId = f.teams.home.id;
      const awayId = f.teams.away.id;

      // Stats simples : on récupère le classement FIFA via une recherche du
      // nom d'équipe n'est pas disponible nativement dans API-Football, donc
      // ici on remonte uniquement les infos déjà fournies par le fixture lui-même.
      return {
        fixtureId: f.fixture.id,
        date: f.fixture.date,
        venue: f.fixture.venue?.name || null,
        round: f.league.round,
        home: {
          id: homeId,
          name: f.teams.home.name,
          logo: f.teams.home.logo,
        },
        away: {
          id: awayId,
          name: f.teams.away.name,
          logo: f.teams.away.logo,
        },
      };
    })
  );

  return enriched;
}

app.get("/api/fixtures", async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && now - cache.fetchedAt < CACHE_DURATION_MS) {
      return res.json({ cached: true, fixtures: cache.data });
    }

    const fixtures = await fetchUpcomingFixtures();
    cache = { data: fixtures, fetchedAt: now };
    res.json({ cached: false, fixtures });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible de récupérer les matchs pour le moment." });
  }
});

// Endpoint de santé, utile pour les services qui "réveillent" le serveur
app.get("/healthz", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Serveur du prédicteur démarré sur le port ${PORT}`);
});
