import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";

dotenv.config();

const EU_A3 = new Set([
  "AUT","BEL","BGR","HRV","CYP","CZE","DNK","EST","FIN","FRA","DEU","GRC",
  "HUN","IRL","ITA","LVA","LTU","LUX","MLT","NLD","POL","PRT","ROU","SVK",
  "SVN","ESP","SWE","GBR"
]);

let countryFeatures = [];

function loadBorders() {
  const filePath = path.join(process.cwd(), "data", "europe_countries.geojson");

  const raw = fs.readFileSync(filePath, "utf8");
  const geo = JSON.parse(raw);

  const feats = Array.isArray(geo?.features) ? geo.features : [];

	countryFeatures = feats.filter(f => {
	const a3 = f?.id;       // np. "POL"
	return EU_A3.has(a3);
});

  console.log("✅ Borders loaded:", countryFeatures.length);
}

// ISO3 -> nazwa pod Twoje TOLL_RATE
const ISO3_TO_NAME = {
  POL: "Polska",
  CZE: "Czechy",
  DEU: "Niemcy",
  AUT: "Austria",
  ITA: "Włochy",
  SVK: "Słowacja",
  HUN: "Węgry",
  SVN: "Słowenia",
  FRA: "Francja",
  BEL: "Belgia",
  NLD: "Holandia",
  GBR: "Wielka Brytania",
  // reszta UE może być dopisana później (na razie stawka 0 jeśli brak)
};

function haversineKmLatLon(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function sampleGeometryEveryN(geometry, targetSamples = 140) {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return [];

  const n = coords.length;
  const step = Math.max(1, Math.floor(n / targetSamples));
  const out = [];

  for (let i = 0; i < n; i += step) {
    const [lon, lat] = coords[i];
    out.push({ lat, lon });
  }

  const [lonLast, latLast] = coords[n - 1];
  const last = out[out.length - 1];
  if (!last || last.lat !== latLast || last.lon !== lonLast) out.push({ lat: latLast, lon: lonLast });

  return out;
}

function countryIso3ForPoint(lat, lon) {
  const pt = turf.point([lon, lat]);
  for (const f of countryFeatures) {
    if (turf.booleanPointInPolygon(pt, f)) return f.id || "???"; // np. "POL"
  }
  return "???";
}

function tollsFromGeometryEU(geometry) {
  const samples = sampleGeometryEveryN(geometry, 140); // możesz dać 200 dla jeszcze większej dokładności
  if (samples.length < 2) return { total_eur: 0, by_country: [] };

  const tagged = samples.map(s => ({ ...s, iso3: countryIso3ForPoint(s.lat, s.lon) }));

  const kmByIso3 = {};
  for (let i = 0; i < tagged.length - 1; i++) {
    const a = tagged[i];
    const b = tagged[i + 1];
    const km = haversineKmLatLon(a, b);
    const c = a.iso3 || "???";
    kmByIso3[c] = (kmByIso3[c] || 0) + km;
  }

  let total = 0;
  const by_country = Object.entries(kmByIso3)
    .filter(([iso3, km]) => iso3 !== "???" && km > 0.2) // odfiltruj śmieci
    .map(([iso3, km]) => {
      const name = ISO3_TO_NAME[iso3] || iso3;
      const rate = TOLL_RATE[name] ?? 0;
      const cost = km * rate;
      total += cost;

      return {
        country: name,
        iso3,
        km: Math.round(km * 10) / 10,
        rate_eur_per_km: rate,
        cost_eur: Math.round(cost * 100) / 100,
      };
    })
    .sort((a, b) => b.km - a.km);

  total = Math.round(total * 100) / 100;

  return { total_eur: total, by_country };
}

const TOLL_RATE = {
  "Polska": 0.15,
  "Czechy": 0.15,
  "Niemcy": 0.35,
  "Austria": 0.50,
  "Włochy": 0.20,
  "Słowacja": 0.20,
  "Węgry": 0.55,
  "Słowenia": 0.20,
  "Francja": 0.40,
  "Belgia": 0.21,
  "Holandia": 0,
	"Wielka Brytania": 0,
	"United Kingdom": 0, // jakby wracało EN
	"UK": 0,
};

function normCountry(c) {
  const m = {
    "Poland": "Polska",
    "Czechia": "Czechy",
    "Czech Republic": "Czechy",
    "Austria": "Austria",
    "Italy": "Włochy",
    "Hungary": "Węgry",
    "Slovakia": "Słowacja",
    "Slovenia": "Słowenia",
    "Germany": "Niemcy",
    "France": "Francja",
    "Belgium": "Belgia",
    "Netherlands": "Holandia",
	"Great Britain": "Wielka Brytania",
  };
  return m[c] || c;
}

// === OpenAI client (global) ===
if (!process.env.OPENAI_API_KEY) {
  console.warn("⚠️ Brak OPENAI_API_KEY w .env (server/.env)");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

const geoCache = new Map();

function extractCountry(display) {
  if (!display) return "??";
  const parts = display.split(",").map(s => s.trim());
  return parts[parts.length - 1] || "??";
}

async function geocode(q) {
  const key = (q || "").trim();
  if (!key) return null;
  if (geoCache.has(key)) return geoCache.get(key);

  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
    encodeURIComponent(key);

  const r = await fetch(url, {
    headers: {
      "User-Agent": "agent-kalkulator/1.0",
      "Accept-Language": "pl",
    },
  });

  if (!r.ok) throw new Error("Geocoding failed: " + r.status);

  const data = await r.json();
  if (!data?.length) return null;

  const out = {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    display: data[0].display_name,
  };

  geoCache.set(key, out);
  return out;
}


function sampleGeometry(geometry, maxSamples = 60) {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return [];

  // bierzemy równomiernie po indeksach
  const n = coords.length;
  const samples = [];
  const step = Math.max(1, Math.floor(n / maxSamples));

  for (let i = 0; i < n; i += step) {
    const [lon, lat] = coords[i];
    samples.push({ lat, lon });
  }

  // dopnij ostatni punkt
  const [lonLast, latLast] = coords[n - 1];
  const last = samples[samples.length - 1];
  if (!last || last.lat !== latLast || last.lon !== lonLast) {
    samples.push({ lat: latLast, lon: lonLast });
  }

  return samples;
}

async function osrmRouteGeojson(coords) {
  const osrmUrl =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;

  const rr = await fetch(osrmUrl);
  if (!rr.ok) throw new Error("Routing failed: " + rr.status);
  const routeData = await rr.json();

  const route = routeData?.routes?.[0];
  if (!route) return null;

  return route;
}

app.post("/api/route", async (req, res) => {
  try {
    const { origin, destination } = req.body || {};
    if (!origin || !destination) {
      return res.status(400).json({ error: "Podaj skąd i dokąd." });
    }

    const a = await geocode(origin);
    const b = await geocode(destination);

    if (!a) return res.status(400).json({ error: `Nie znaleziono miejsca: ${origin}` });
    if (!b) return res.status(400).json({ error: `Nie znaleziono miejsca: ${destination}` });

    const coords = `${a.lon},${a.lat};${b.lon},${b.lat}`;
    const route = await osrmRouteGeojson(coords);
    if (!route) return res.status(400).json({ error: "Nie udało się wyznaczyć trasy." });

    const distance_km = Math.round((route.distance / 1000) * 10) / 10;
    const duration_h = Math.round((route.duration / 3600) * 100) / 100;
	const tolls_geo = tollsFromGeometryEU(route.geometry);

    return res.json({
      origin_resolved: a.display,
      destination_resolved: b.display,
      distance_km,
      duration_h,
      geometry: route.geometry,
	  tolls_geo,

      points: [
        { type: "start", lat: a.lat, lng: a.lon, label: a.display, country: extractCountry(a.display) },
        { type: "end",   lat: b.lat, lng: b.lon, label: b.display, country: extractCountry(b.display) },
      ],
    });
  } catch (err) {
    console.error("ROUTE ERROR:", err);
    return res.status(500).json({ error: "Błąd wyznaczania trasy" });
  }
});

app.post("/api/route/multi", async (req, res) => {
  try {
    const { origin, destination, stops } = req.body || {};
    const mid = Array.isArray(stops) ? stops : [];

    if (!origin || !destination) {
      return res.status(400).json({ error: "Podaj skąd i dokąd." });
    }

    const pointsText = [origin, ...mid, destination]
      .map((x) => (x || "").trim())
      .filter(Boolean);

    if (pointsText.length < 2) {
      return res.status(400).json({ error: "Za mało punktów trasy." });
    }

    // 1) Geocode punktów
    const points = [];
    for (const p of pointsText) {
      const g = await geocode(p);
      if (!g) return res.status(400).json({ error: `Nie znaleziono miejsca: ${p}` });
      points.push({ query: p, ...g }); // { lat, lon, display }
    }

    // 2) Trasa OSRM po współrzędnych
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
    const route = await osrmRouteGeojson(coords);
    if (!route) return res.status(400).json({ error: "Nie udało się wyznaczyć trasy." });

    const distance_km = Math.round((route.distance / 1000) * 10) / 10;
    const duration_h = Math.round((route.duration / 3600) * 100) / 100;
	const tolls_geo = tollsFromGeometryEU(route.geometry);


    // 4) Response
    return res.json({
      points_resolved: points.map((p) => p.display),
      distance_km,
      duration_h,
      geometry: route.geometry,
	  tolls_geo,

      points: points.map((p, idx) => ({
        type: idx === 0 ? "start" : idx === points.length - 1 ? "end" : "via",
        lat: p.lat,
        lng: p.lon,
        label: p.display,
        country: extractCountry(p.display),
      })),

    });
  } catch (err) {
    console.error("ROUTE MULTI ERROR:", err);
    return res.status(500).json({ error: "Błąd wyznaczania trasy (multi)" });
  }
});

app.post("/api/report", async (req, res) => {
  try {
    const body = req.body || {};
    const calc = body.calc || body.result || body;

    if (!calc || typeof calc !== "object" || Object.keys(calc).length === 0) {
      return res.status(400).json({ error: "Brak danych kalkulatora (pusty payload)" });
    }

    // Jeśli nie masz klucza — zwróć czytelnie, zamiast 500 “Błąd serwera”
    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json({
        report:
          "Brak OPENAI_API_KEY w server/.env.\n" +
          "Dodaj linię: OPENAI_API_KEY=... i zrestartuj serwer.",
      });
    }

    const prompt = `
Jesteś asystentem spedytora.
Masz POLICZONE koszty trasy. NIE licz nic od nowa.

Format:
1) Podsumowanie
2) Koszty (paliwo, kierowca, opłaty drogowe, promy, inne)
3) Rekomendowana cena
4) Ryzyka / uwagi (max 3)

Wyniki:
${JSON.stringify(calc, null, 2)}
`.trim();

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    return res.json({ report: response.output_text });
  } catch (err) {
    console.error("REPORT ERROR:", err);
    return res.status(500).json({ error: "Błąd serwera AI" });
  }
});

loadBorders();

/* 🌐 FRONTEND */
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Serwer działa: http://localhost:${PORT}`));
