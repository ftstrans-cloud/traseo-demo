
/* =========================
   MAPA + TRASA
========================= */
let map = null;
let routeLine = null;
let routeMarkers = [];

function setRouteToUI(route){
  if (!route) return;
  initRouteBuilder(); // zbuduje Skąd/Dokąd
  const list = document.getElementById("routeList");
  if (!list) return;

  // ustaw Skąd i Dokąd
  const wrappers = Array.from(list.children);
  const firstInput = wrappers[0]?.querySelector("input");
  const lastInput = wrappers[wrappers.length - 1]?.querySelector("input");
  if (firstInput) firstInput.value = route.origin || "";
  if (lastInput) lastInput.value = route.destination || "";

  // wstaw stop-y
  const stops = Array.isArray(route.stops) ? route.stops : [];
  stops.forEach(s => {
    addRoutePoint();
    const w = Array.from(list.children).slice(1, -1).pop(); // ostatni stop
    const inp = w?.querySelector("input");
    if (inp) inp.value = s;
  });

  // odśwież podpisy/przyciski
  updateRouteButtons();
}

let autoSaveTimer = null;

const APP_CONFIG = {
  company: "Traseo",
  contact: "tel. +48 797 997 422 • email: ___@___.pl",
  nip: "NIP: KPRM Warszawa",
  // jeśli chcesz logo: wstaw URL do PNG/SVG (albo data:image/...):
  logoUrl: "assets/traseo_logo.jpg", // np. "https://twojadomena.pl/logo.png"
};

function money(x){
  return (x == null || Number.isNaN(Number(x)))
    ? "—"
    : (Number(x).toFixed(2) + " €");
}

function autoSaveAfterRun(){
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try { autoSaveNow(); } catch (e) { console.warn("autoSaveNow failed", e); }
  }, 400); // 0.4s po ostatnim run
}

function autoSaveNow(){
  const calc = window.lastCalc;
  const input = window.lastInput;
  if (!calc || !input) return;

  const r = window.lastRoutePayload || {};
  const tolls_geo = window.lastRouteTollsGeo || null;

  const items = hLoad();

  const idx = items.findIndex(x => x.id === HISTORY_AUTO_ID);
  const autoItem = {
    id: HISTORY_AUTO_ID,
    ts: Date.now(),
    name: "AUTO – ostatnia kalkulacja",
    client: "",
    note: "",

    route: {
      origin: r.origin || "",
      destination: r.destination || "",
      stops: Array.isArray(r.stops) ? r.stops : [],
      points_resolved: r.points_resolved || null,
    },

    input,
    result: calc,
    tolls_geo,
  };

  if (idx >= 0) items[idx] = autoItem;
  else items.unshift(autoItem);

  hSave(items.slice(0, 60));
  renderHistory();
}

function normC(countryName){
  const c = String(countryName || "").toLowerCase();

  // NLD
  if (c.includes("netherlands") || c.includes("holandia") || c.includes("niderland")) return "NL";

  // GBR
  if (c.includes("united kingdom") || c.includes("wielka brytania") || c.includes("uk") || c.includes("england")) return "GB";

  return "";
}

function applyVignettesToTollsGeo(tg, driverDays, kmTotal, gbpEur){
  if (!tg?.by_country?.length) return { tg, vignetteRows: [], vignetteTotal: 0 };

  const by = tg.by_country.map(x => ({
    ...x, // ✅ było ".x" (to psuło JS)
    _key: normC(x.country),
    km: Number(x.km || 0),
    rate_eur_per_km: Number(x.rate_eur_per_km || 0),
    cost_eur: Number(x.cost_eur || 0),
  }));

  // ✅ proporcjonalnie do km, zaokrąglaj w górę
  const daysFor = (km) => {
    if (!kmTotal || kmTotal <= 0) return 0;
    const raw = (Number(driverDays || 0) * (km / kmTotal));
    return km > 0 ? Math.max(1, Math.ceil(raw)) : 0; // ✅ ceil zamiast round
  };

  let vignetteTotal = 0;
  const vignetteRows = [];

  // NL
  const nl = by.find(x => x._key === "NL");
  if (nl && nl.km > 0) {
    const days = daysFor(nl.km);
    const cost = days * 12; // EUR/dzień
    vignetteTotal += cost;
    vignetteRows.push({ country: "NL (winieta dzienna)", days, cost_eur: +cost.toFixed(2) });

    // WYŁĄCZ €/km dla NL
    nl.rate_eur_per_km = 0;
    nl.cost_eur = 0;
  }

  // GB (jeśli w ogóle wystąpi w tg.by_country — zwykle nie, bo UE geo nie obejmuje GB)
  const gb = by.find(x => x._key === "GB");
  if (gb && gb.km > 0) {
    const days = daysFor(gb.km);
    const cost = days * 10 * Number(gbpEur || 1.15); // 10 GBP/dzień -> EUR
    vignetteTotal += cost;
    vignetteRows.push({ country: "GB (winieta dzienna)", days, cost_eur: +cost.toFixed(2) });

    // WYŁĄCZ €/km dla GB
    gb.rate_eur_per_km = 0;
    gb.cost_eur = 0;
  }

  const rest = by.reduce((sum, x) => sum + (Number(x.cost_eur) || 0), 0);
  const newTotal = +(rest + vignetteTotal).toFixed(2);

  const newTg = {
    ...tg, // ✅ było ".tg"
    total_eur: newTotal,
    by_country: by.map(x => ({
      country: x.country,
      km: +x.km.toFixed(1),
      rate_eur_per_km: x.rate_eur_per_km,
      cost_eur: +x.cost_eur.toFixed(2),
    }))
  };

  return { tg: newTg, vignetteRows, vignetteTotal: +vignetteTotal.toFixed(2) };
}

function hasGBInRoutePayload() {
  const r = window.lastRoutePayload || {};
  const txt = [
    r.origin_resolved, r.destination_resolved,
    ...(r.points_resolved || [])
  ].filter(Boolean).join(" | ").toLowerCase();

  // Nominatim zwykle daje "United Kingdom"
  return txt.includes("united kingdom") || txt.includes("wielka brytania") || txt.includes("uk");
}

function calcDailyVignettesFromGeo(tg, driverDays, gbpEur, routeText = "", totalRouteKm = 0, kmPerDayUi = 0) {
  const rows = [];
  const daysTotal = Math.max(0, Number(driverDays || 0));
  if (!daysTotal) return { rows, total_eur: 0 };

  const by = Array.isArray(tg?.by_country) ? tg.by_country : [];
  const euKm = by.reduce((s, x) => s + (Number(x.km) || 0), 0);

  const routeKm = Math.max(0, Number(totalRouteKm || 0));
  const rt = String(routeText || "").toLowerCase();
  const gbInText =
    rt.includes("united kingdom") || rt.includes("wielka brytania") || rt.includes("zjednoczone królestwo") ||
    rt.includes("england") || rt.includes("great britain") || rt.includes("gb") || rt.includes(" uk");

  // szacunek km poza UE (GB) – tylko jeśli w trasie jest UK/GB
  const nonEuKmEst = (routeKm > 0 && euKm > 0) ? Math.max(0, routeKm - euKm) : 0;

  // km "do proporcji" = EU + (poza EU jeśli wykryto GB)
  const totalKmForDays = (euKm + (gbInText ? nonEuKmEst : 0)) || euKm || routeKm || 0;

  // km/dzień: najpierw UI, potem z trasy
  const kmPerDay = (Number(kmPerDayUi) > 0)
    ? Number(kmPerDayUi)
    : (totalKmForDays > 0 ? (totalKmForDays / daysTotal) : 0);

  const daysForKm = (kmInCountry) => {
    if (!kmInCountry || kmInCountry <= 0) return 0;
    if (!kmPerDay || kmPerDay <= 0) return 0;
    return Math.max(1, Math.ceil(kmInCountry / kmPerDay)); // ZAOKRĄGLAMY W GÓRĘ
  };

  const NL_EUR_PER_DAY = 12;
  const GB_GBP_PER_DAY = 10;
  const kGbpEur = (Number(gbpEur) && Number(gbpEur) > 0) ? Number(gbpEur) : 1.17;

  let kmNL = 0;
  let kmGB = 0;

  for (const x of by) {
    const c = String(x.country || "").toLowerCase();
    const km = Number(x.km) || 0;
    if (!km) continue;

    if (c.includes("holand") || c.includes("nether") || c === "nl") kmNL += km;

    if (
      c.includes("united kingdom") || c.includes("zjednoczone królestwo") || c.includes("wielka brytania") ||
      c.includes("great britain") || c.includes("britain") || c === "uk" || c === "gb"
    ) kmGB += km;
  }

  // GB: jeśli geo nie ma, użyj szacunku poza UE
  const kmGBFinal = (kmGB > 0) ? kmGB : (gbInText ? nonEuKmEst : 0);

  // policz dni
  let daysNL = kmNL > 0 ? daysForKm(kmNL) : 0;
  let daysGB = kmGBFinal > 0 ? daysForKm(kmGBFinal) : 0;

  // (opcjonalnie) przytnij sumę do driverDays, żeby nie rosło ponad dni trasy
  // zabieramy najpierw z większego kraju
  let sum = daysNL + daysGB;
  while (sum > daysTotal) {
    if (daysGB >= daysNL && daysGB > 1) daysGB--;
    else if (daysNL > 1) daysNL--;
    else break;
    sum = daysNL + daysGB;
  }

  if (daysNL > 0) {
    const costEur = daysNL * NL_EUR_PER_DAY;
    rows.push({ country: "NL (winieta)", unit: "dzień", qty: daysNL, rate: NL_EUR_PER_DAY, rate_ccy: "EUR", cost_eur: +costEur.toFixed(2) });
  }

  if (daysGB > 0) {
    const costEur = daysGB * GB_GBP_PER_DAY * kGbpEur;
    rows.push({ country: "GB (winieta)", unit: "dzień", qty: daysGB, rate: GB_GBP_PER_DAY, rate_ccy: "GBP", cost_eur: +costEur.toFixed(2) });
  }

  const total = rows.reduce((s, r) => s + (Number(r.cost_eur) || 0), 0);
  return { rows, total_eur: +total.toFixed(2) };
  
  console.log("VIN:", window.lastRouteVignettes);
}


function openPdfReport(){

  // lokalne helpery (żeby PDF nie znikał przez scope/redeclaration)
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  const moneyPdf = (x) =>
    (x == null || Number.isNaN(Number(x))) ? "—" : (Number(x).toFixed(2) + " €");

  const num1 = (x) =>
    (x == null || Number.isNaN(Number(x))) ? "—" : String(Number(x).toFixed(1));

  const num2 = (x) =>
    (x == null || Number.isNaN(Number(x))) ? "—" : String(Number(x).toFixed(2));

  const calc = window.lastCalc;
  const input = window.lastInput;
  if (!calc || !input) { alert("Najpierw policz trasę."); return; }

  const r = window.lastRoutePayload || {};
  const tgBase = window.lastRouteTollsGeo || null;

  // ✅ bierz wersję po override (bez NL/GB per-km), jeśli istnieje
  const tg = window.lastRouteTollsGeoAdj || tgBase;

  // winiety już policzone wcześniej w app.js
  const daily = window.lastRouteVignettes || { rows: [], total_eur: 0 };

  const isOffer = (calc.calc_mode === "offer" && Number(calc.offer_price_eur) > 0);
  const price = isOffer ? Number(calc.offer_price_eur) : Number(calc.suggested_price_eur);

  // Dane klienta: preferuj ostatnio zapisany rekord historii, potem pola modala
  let clientName = "";
  let offerName = "";
  let note = "";

  try {
    const items = (typeof hLoad === "function") ? hLoad() : [];
    const lastId = window.lastHistoryId;
    const it = lastId ? items.find(x => x.id === lastId) : null;

    offerName = (it?.name || document.getElementById("h_name")?.value || "").trim();
    clientName = (it?.client || document.getElementById("h_client")?.value || "").trim();
    note = (it?.note || document.getElementById("h_note")?.value || "").trim();
  } catch {}

  const now = new Date();
  const paymentTerms = (document.getElementById("payment_terms")?.value || "—").trim();
  const nowStr = now.toLocaleString();

  // Numer oferty: YYYYMMDD-HHMM-XXXX
  const pad2 = (n) => String(n).padStart(2,"0");
  const y = now.getFullYear();
  const m = pad2(now.getMonth()+1);
  const d = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const mm = pad2(now.getMinutes());
  const rand = Math.random().toString(16).slice(2,6).toUpperCase();
  const offerNo = `${y}${m}${d}-${hh}${mm}-${rand}`;

  const title = "Oferta transportowa";

  const routeLine =
    (r.origin || "") + " → " + (r.destination || "") +
    (Array.isArray(r.stops) && r.stops.length ? (" (punkty: " + r.stops.length + ")") : "");

  const kmTotal = Number(calc.distance_km || 0);
  const totalCost = Number(calc.total_cost_eur || 0);
  const costPerKm = (kmTotal > 0) ? (totalCost / kmTotal) : 0;
  const pricePerKm = (kmTotal > 0 && price > 0) ? (price / kmTotal) : 0;

  const marginPct = (calc.margin_pct != null && !Number.isNaN(Number(calc.margin_pct)))
    ? (Number(calc.margin_pct).toFixed(1) + "%")
    : "—";

  const reportAi = (document.getElementById("aiReport")?.textContent || "").trim();

  // --- tabela myta UE (per km) ---
  let tollRows = "";
  if (tg && Array.isArray(tg.by_country) && tg.by_country.length) {
    tollRows = tg.by_country.map(x => (
      "<tr>" +
        "<td>" + esc(x.country ?? "—") + "</td>" +
        "<td style='text-align:right;'>" + esc(num1(x.km)) + "</td>" +
        "<td style='text-align:right;'>" + esc(String(x.rate_eur_per_km ?? "—")) + "</td>" +
        "<td style='text-align:right;'>" + esc(String(x.cost_eur ?? "—")) + "</td>" +
      "</tr>"
    )).join("");
  } else {
    tollRows = "<tr><td colspan='4' style='opacity:.7;'>Brak danych myta UE (tolls_geo).</td></tr>";
  }

  // --- dopisz winiety jako wiersze w tej samej tabeli ---
  let vignetteRows = "";
  if (daily?.rows?.length) {
    vignetteRows = daily.rows.map(x => (
      "<tr>" +
        "<td>" + esc(String(x.country ?? "—")) + "</td>" +
        "<td style='text-align:right;'>" + esc(String(x.qty ?? "—")) + "</td>" +
        "<td style='text-align:right;'>" + esc(String(x.rate ?? "—")) + " " + esc(String(x.rate_ccy ?? "")) + "/" + esc(String(x.unit ?? "")) + "</td>" +
        "<td style='text-align:right;'>" + esc(moneyPdf(x.cost_eur)) + "</td>" +
      "</tr>"
    )).join("");
  }

  const aiBlock = reportAi
    ? ("<div class='card'><div class='h'>Raport AI</div><pre class='ai'>" + esc(reportAi) + "</pre></div>")
    : ("<div class='card'><div class='h'>Raport AI</div><div class='muted'>Brak (opcjonalnie)</div></div>");

  const watermarkHtml = (window.APP_CONFIG?.logoUrl)
    ? ("<div class='wm'><img class='wmImg' src='" + esc(window.APP_CONFIG.logoUrl) + "' alt='logo' /></div>")
    : ("");

  const html =
"<!doctype html><html><head>" +
"<meta charset='utf-8' />" +
"<meta name='viewport' content='width=device-width, initial-scale=1' />" +
"<title>" + esc(title) + " " + esc(offerNo) + "</title>" +
"<style>" +
"  :root{ --bg:#ffffff; --card:#ffffff; --ink:#0b1220; --mut:#516173; --line:#c7d2fe; --lineStrong:#6d7cff; --soft:#f6f8fb; }" +
"  html, body{ background:#ffffff !important; color:var(--ink) !important; }" +
"  body{ margin:0; font-family: Arial, sans-serif; background:var(--bg); color:var(--ink); }" +
"  .wm{ position:fixed; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; z-index:0; }" +
"  .wmImg{ width:90%; max-width:1200px; opacity:0.08; }" +
"  .page{ position:relative; z-index:1; padding:24px; }" +
"  .printbar{ position: sticky; top:0; background:var(--bg); padding:10px 0; }" +
"  .printbtn{ border:1px solid var(--line); background:var(--soft); padding:8px 10px; border-radius:12px; cursor:pointer; font-weight:700; }" +
"  .top{ display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }" +
"  .brand{ font-weight:900; font-size:18px; }" +
"  .muted{ color:var(--mut); font-size:12px; }" +
"  .tag{ display:inline-block; padding:4px 10px; border:1px solid var(--line); border-radius:999px; font-size:12px; background:#fff; }" +
"  .card{ border:2px solid var(--lineStrong); border-radius:16px; padding:12px; margin-top:12px; background:var(--card); }" +
"  .h{ font-weight:900; margin-bottom:8px; }" +
"  .grid2{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }" +
"  .kpi{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-top:12px; }" +
"  .k{ border:2px solid var(--line); border-radius:16px; padding:10px; background:var(--soft); }" +
"  .k .t{ font-size:11px; color:var(--mut); }" +
"  .k .v{ font-size:16px; font-weight:900; margin-top:4px; }" +
"  table{ width:100%; border-collapse:collapse; }" +
"  th,td{ border-bottom:1px solid var(--line); padding:8px 6px; font-size:12px; }" +
"  th{ text-align:left; background:var(--soft); border-bottom:2px solid var(--lineStrong); }" +
"  .ai{ white-space: pre-wrap; margin:0; font-size:12px; background:var(--soft); border:1px solid var(--line); padding:10px; border-radius:12px; }" +
"  .sigGrid{ display:grid; grid-template-columns: 1fr 1fr; gap:16px; }" +
"  .sig{ border-top:1px solid var(--line); padding-top:8px; font-size:12px; color:var(--mut); }" +
"  @media print{ .printbar{ display:none; } .page{ padding: 14mm; } }" +
"</style></head><body>" +
watermarkHtml +
"<div class='page'>" +

"<div class='printbar'><button class='printbtn' onclick='window.print()'>Drukuj / Zapisz jako PDF</button></div>" +

"<div class='top'>" +
"  <div>" +
"    <div class='brand'>" + esc(window.APP_CONFIG?.company || "Twoja firma") + "</div>" +
"    <div class='muted'>" + esc(window.APP_CONFIG?.contact || "") + "</div>" +
"    <div class='muted'>" + esc(window.APP_CONFIG?.nip || "") + "</div>" +
"  </div>" +
"  <div style='text-align:right;'>" +
"    <div class='tag'>" + esc(title) + "</div><br/>" +
"    <div class='muted' style='margin-top:6px;'><b>Nr oferty:</b> " + esc(offerNo) + "</div>" +
"    <div class='muted' style='margin-top:4px;'>Wygenerowano: " + esc(nowStr) + "</div>" +
"  </div>" +
"</div>" +

"<div class='card'>" +
"  <div class='h'>Dane oferty</div>" +
"  <div class='grid2'>" +
"    <div>" +
"      <div><b>Relacja:</b> " + esc(routeLine) + "</div>" +
"      <div class='muted' style='margin-top:4px;'><b>Dystans:</b> " + esc(num1(calc.distance_km)) + " km</div>" +
"      <div class='muted' style='margin-top:4px;'><b>Tryb:</b> " + (isOffer ? "Marża ze zlecenia" : "Wycena trasy") + "</div>" +
"      <div class='muted' style='margin-top:4px;'><b>Termin płatności:</b> " + esc(paymentTerms) + "</div>" +
"    </div>" +
"    <div>" +
"      <div><b>Nazwa wyceny:</b> " + esc(offerName || "—") + "</div>" +
"      <div class='muted' style='margin-top:4px;'><b>Klient:</b> " + esc(clientName || "—") + "</div>" +
"      <div class='muted' style='margin-top:4px;'><b>Notatka:</b> " + esc(note || "—") + "</div>" +
"    </div>" +
"  </div>" +
"</div>" +

"<div class='kpi'>" +
"  <div class='k'><div class='t'>Koszt całkowity</div><div class='v'>" + esc(moneyPdf(calc.total_cost_eur)) + "</div><div class='muted'>Koszt/km: " + esc(num2(costPerKm)) + " €/km</div></div>" +
"  <div class='k'><div class='t'>" + (isOffer ? "Cena zlecenia" : "Cena sugerowana") + "</div><div class='v'>" + esc(moneyPdf(price)) + "</div><div class='muted'>Cena/km: " + esc(num2(pricePerKm)) + " €/km</div></div>" +
"  <div class='k'><div class='t'>Marża</div><div class='v'>" + esc(moneyPdf(calc.margin_eur)) + " <span class='muted'>(" + esc(marginPct) + ")</span></div></div>" +
"</div>" +

"<div class='grid2'>" +
"  <div class='card'>" +
"    <div class='h'>Koszty</div>" +
"    <table>" +
"      <tr><td>Paliwo</td><td style='text-align:right;'>" + esc(moneyPdf(calc.fuel_cost_eur)) + "</td></tr>" +
"      <tr><td>Kierowca</td><td style='text-align:right;'>" + esc(moneyPdf(calc.driver_cost_eur)) + "</td></tr>" +
"      <tr><td>Myto</td><td style='text-align:right;'>" + esc(moneyPdf(calc.tolls_eur)) + "</td></tr>" +
"      <tr><td>Promy</td><td style='text-align:right;'>" + esc(moneyPdf(calc.ferries_eur)) + "</td></tr>" +
"      <tr><td>Winiety dzienne (NL/GB)</td><td style='text-align:right;'>" + esc(moneyPdf(daily.total_eur)) + "</td></tr>" +
"      <tr><td>Inne</td><td style='text-align:right;'>" + esc(moneyPdf(calc.other_costs_eur)) + "</td></tr>" +
"      <tr><td><b>Suma</b></td><td style='text-align:right;'><b>" + esc(moneyPdf(calc.total_cost_eur)) + "</b></td></tr>" +
"    </table>" +
"  </div>" +

"  <div class='card'>" +
"    <div class='h'>Myto UE – podział na kraje</div>" +
"    <table>" +
"      <thead><tr><th>Kraj</th><th style='text-align:right;'>km</th><th style='text-align:right;'>€/km</th><th style='text-align:right;'>€</th></tr></thead>" +
"      <tbody>" + tollRows + vignetteRows + "</tbody>" +
"    </table>" +
"    <div class='muted' style='margin-top:8px;'>Razem (UE offline): " + esc(moneyPdf(tg?.total_eur)) + "</div>" +
"  </div>" +
"</div>" +

aiBlock +

"<div class='card'>" +
"  <div class='h'>Podpis / pieczątka</div>" +
"  <div class='sigGrid' style='margin-top:18px;'>" +
"    <div class='sig'>Podpis osoby przygotowującej ofertę</div>" +
"    <div class='sig'>Podpis / pieczątka klienta</div>" +
"  </div>" +
"</div>" +

"<div class='card'>" +
"  <div class='h'>Warunki / zastrzeżenia</div>" +
"  <div class='muted'>• Dokument poglądowy (v0.1+). Myto UE jest szacowane wg modelu offline; finalne stawki zależą m.in. od klasy pojazdu i taryf.</div>" +
"  <div class='muted'>• Płatność, terminy, ADR, chłodnia, postoje, godziny okien — do potwierdzenia w zleceniu.</div>" +
"</div>" +

"</div></body></html>";

  const w = window.open("", "_blank");
  if (!w) {
    alert("Przeglądarka zablokowała popup. Zezwól na otwieranie okien dla tej strony.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function setCalcMode(mode){
  const hidden = document.getElementById("calc_mode");
  const row = document.getElementById("modeOfferRow");
  const buttons = document.querySelectorAll("#modeSwitch .modeBtn");

  if (hidden) hidden.value = mode;
  buttons.forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  if (row) row.style.display = (mode === "offer") ? "grid" : "none";

  run(); // przelicz po zmianie trybu
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("#modeSwitch .modeBtn");
  if (!btn) return;
  setCalcMode(btn.dataset.mode);
});

document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "offer_price_eur") run();
});

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true }).setView([52.23, 21.01], 6);

const lightTiles = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  { attribution: '&copy; OpenStreetMap' }
);

const darkTiles = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: '&copy; Esri'
  }
);

window.lightTiles = lightTiles;
window.darkTiles = darkTiles;

lightTiles.addTo(map);
window.map = map;

  setTimeout(() => {
  if (map) map.invalidateSize();
}, 50);
}

function clearRouteOnMap() {
  if (routeLine && map) {
    try { map.removeLayer(routeLine); } catch {}
    routeLine = null;
  }
  clearMarkersOnMap();
}
function makeFlagIcon(color = "#22c55e", label = "S") {
  // Prosty „pin-flag” w SVG: maszt + chorągiewka + kropka
  const svg = `
  <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="23" r="3.2" fill="${color}" stroke="#111" stroke-width="1"/>
    <path d="M9 5 L9 21" stroke="#111" stroke-width="2" stroke-linecap="round"/>
    <path d="M10 6 L23 9 L10 12 Z" fill="${color}" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>
    <text x="16.5" y="11" text-anchor="middle" font-size="7" font-family="Arial" font-weight="700" fill="#111">${label}</text>
  </svg>`;

  return L.divIcon({
    className: "route-flag-icon",
    html: svg,
    iconSize: [28, 28],
    iconAnchor: [9, 23],   // „stopka” na punkcie
    popupAnchor: [10, -18]
  });
}

function clearMarkersOnMap() {
  if (!map) return;
  routeMarkers.forEach(m => { try { map.removeLayer(m); } catch {} });
  routeMarkers = [];
}
function drawRouteMarkers(points) {
  initMap();
  clearMarkersOnMap();

  if (!Array.isArray(points) || points.length < 2) return;

  points.forEach((p, idx) => {
    const type = p.type || (idx === 0 ? "start" : (idx === points.length - 1 ? "end" : "via"));

    // Kolory + literki na fladze
    const icon =
      type === "start" ? makeFlagIcon("#22c55e", "S") :   // zielona START
      type === "end"   ? makeFlagIcon("#ef4444", "E") :   // czerwona END
                        makeFlagIcon("#eab308", "P");     // żółta VIA (P = punkt)

    const marker = L.marker([p.lat, p.lng], { icon }).addTo(map);

    const title =
      type === "start" ? "START" :
      type === "end"   ? "STOP"  : `PUNKT ${idx}`;

    marker.bindPopup(`${title}${p.label ? `<br>${p.label}` : ""}`);

    routeMarkers.push(marker);
  });
}

function drawGeometry(geometry) {
  initMap();
  clearRouteOnMap();

  if (!geometry || !geometry.coordinates || geometry.coordinates.length < 2) {
    console.warn("Brak geometrii trasy:", geometry);
    return;
  }

  // OSRM: [lon,lat] -> Leaflet: [lat,lon]
  const latlngs = geometry.coordinates.map(([lon, lat]) => [lat, lon]);

  routeLine = L.polyline(latlngs, { weight: 5 }).addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });

  setTimeout(() => map.invalidateSize(), 50);
}


function updateMapFromRoute(data) {
  if (data && data.geometry) drawGeometry(data.geometry);
  else console.warn("Backend nie zwrócił data.geometry");

  if (Array.isArray(data.points) && data.points.length) {
    drawRouteMarkers(data.points);
  }
  console.log("updateMapFromRoute points len:", data?.points?.length);
}

/* =========================
   ROUTE BUILDER (pola)
========================= */
function initRouteBuilder(){
  const list = document.getElementById("routeList");
  if (!list) return;
  list.innerHTML = "";

  addRouteRow("Skąd", "Warszawa", { fixed: true });
  addRouteRow("Dokąd", "Leeds", { fixed: true });
  updateRouteButtons();
}

function addRouteRow(label, value = "", opts = {}){
  const list = document.getElementById("routeList");

  const wrapper = document.createElement("div");

  const tag = document.createElement("div");
  tag.className = "routeTag";
  tag.textContent = label;

  const row = document.createElement("div");
  row.className = "routeRow";
  row.dataset.fixed = opts.fixed ? "1" : "0";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = label;
  input.value = value;

  const up = document.createElement("button");
  up.type = "button";
  up.className = "iconBtn small";
  up.title = "Przesuń w górę";
  up.textContent = "↑";
  up.onclick = () => moveRouteRow(row, -1);

  const down = document.createElement("button");
  down.type = "button";
  down.className = "iconBtn small";
  down.title = "Przesuń w dół";
  down.textContent = "↓";
  down.onclick = () => moveRouteRow(row, +1);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "iconBtn delBtn";
  del.title = "Usuń punkt";
  del.textContent = "✕";
  del.onclick = () => { wrapper.remove(); updateRouteButtons(); };

  if (opts.fixed){
    del.disabled = true;
    del.style.opacity = "0.45";
    del.style.cursor = "not-allowed";
  }

  row.appendChild(input);
  row.appendChild(up);
  row.appendChild(down);
  row.appendChild(del);

  wrapper.appendChild(tag);
  wrapper.appendChild(row);

  if (!opts.fixed){
    const wrappers = Array.from(list.children);
    const last = wrappers[wrappers.length - 1];
    list.insertBefore(wrapper, last);
  } else {
    list.appendChild(wrapper);
  }

  updateRouteButtons();
}

function addRoutePoint(){ addRouteRow("Punkt pośredni", "", { fixed: false }); }

function clearRouteMiddle(){
  const list = document.getElementById("routeList");
  const wrappers = Array.from(list.children);
  wrappers.slice(1, -1).forEach(w => w.remove());
  updateRouteButtons();
}

function moveRouteRow(rowEl, dir){
  const wrapper = rowEl.parentElement; // wrapper
  const list = document.getElementById("routeList");
  const wrappers = Array.from(list.children);
  const idx = wrappers.indexOf(wrapper);
  const newIdx = idx + dir;

  if (newIdx < 0 || newIdx >= wrappers.length) return;

  if (dir < 0) list.insertBefore(wrapper, wrappers[newIdx]);
  else list.insertBefore(wrapper, wrappers[newIdx].nextSibling);

  relabelRoute();
  updateRouteButtons();
}

function relabelRoute(){
  const list = document.getElementById("routeList");
  const wrappers = Array.from(list.children);

  wrappers.forEach((w, i) => {
    const tag = w.querySelector(".routeTag");
    const row = w.querySelector(".routeRow");
    const isFirst = i === 0;
    const isLast = i === wrappers.length - 1;

    tag.textContent = isFirst ? "Skąd" : (isLast ? "Dokąd" : "Punkt pośredni");

    const fixed = isFirst || isLast;
    row.dataset.fixed = fixed ? "1" : "0";

    const del = row.querySelector(".delBtn");
    if (del){
      del.disabled = fixed;
      del.style.opacity = fixed ? "0.45" : "1";
      del.style.cursor = fixed ? "not-allowed" : "pointer";
    }
  });
}

function updateRouteButtons(){
  const list = document.getElementById("routeList");
  const wrappers = Array.from(list.children);

  wrappers.forEach((w, i) => {
    const row = w.querySelector(".routeRow");
    const upBtn = row.querySelector('button[title="Przesuń w górę"]');
    const downBtn = row.querySelector('button[title="Przesuń w dół"]');

    if (upBtn) upBtn.disabled = (i === 0);
    if (downBtn) downBtn.disabled = (i === wrappers.length - 1);
  });

  relabelRoute();
}

function getRouteFromUI(){
  const list = document.getElementById("routeList");
  const wrappers = Array.from(list.children);

  const values = wrappers
    .map(w => w.querySelector(".routeRow input").value.trim())
    .filter(Boolean);

  const origin = values[0] || "";
  const destination = values[values.length - 1] || "";
  const stops = values.slice(1, -1);

  return { origin, destination, stops };
}

/* =========================
   KALKULACJE (Twoje)
========================= */
function updateTotalDistance(){
  const base = Number(document.getElementById("base_distance_km")?.value || 0);
  const empty = Number(document.getElementById("empty_km")?.value || 0);
  const total = Math.round((base + empty) * 10) / 10;

  const distEl = document.getElementById("distance_km");
  if (distEl) distEl.value = total;

  return { base, empty, total };
}

function calcDriverDays(distanceKm, kmPerDay){
  const km = Number(distanceKm) || 0;
  const perDay = Math.max(1, Number(kmPerDay) || 550);
  let days = Math.ceil(km / perDay);

  let weekendAdded = false;
  if (days > 6){ days += 1; weekendAdded = true; }
  if (km > 0 && days === 0) days = 1;

  return { days, weekendAdded };
}

function applyAutoFields(){
  const autoDays = document.getElementById("auto_driver_days")?.checked;
  const autoOther = document.getElementById("auto_other_costs")?.checked;

  const kmPerDay = Number(document.getElementById("km_per_day")?.value || 550);
  const dailyExtra = Number(document.getElementById("daily_extra_eur")?.value || 100);

  const totalKm = Number(document.getElementById("distance_km")?.value || 0);
  const { days, weekendAdded } = calcDriverDays(totalKm, kmPerDay);

  if (autoDays) {
    const el = document.getElementById("driver_days");
    if (el) el.value = String(days);
  }

  if (autoOther) {
    const el = document.getElementById("other_costs_eur");
    if (el) el.value = String(Math.round(days * dailyExtra * 100) / 100);
  }

  const note = document.getElementById("autoNote");
  if (note){
    note.textContent = totalKm > 0
      ? `AUTO: ${days} dni (ceil(${totalKm} / ${kmPerDay}))${weekendAdded ? " + 1 dzień pauzy weekendowej" : ""}${autoOther ? ` • inne = ${days} × ${dailyExtra}€` : ""}`
      : "AUTO: ustaw dystans (Pobierz km / pusty dolot), żeby policzyć dni i inne koszty.";
  }
}

function round2(x){ return Math.round(x * 100) / 100; }

function textHasGB(s){
  const t = String(s || "").toLowerCase();
  return t.includes("uk") || t.includes("united kingdom") || t.includes("wielka brytania") || t.includes("england") || t.includes("scotland") || t.includes("london");
}
function textHasNL(s){
  const t = String(s || "").toLowerCase();
  return t.includes("netherlands") || t.includes("holandia") || t.includes("niderland") || t.includes("amsterdam") || t.includes("rotterdam");
}

function calculateCosts(data){
  const fuel_l = data.distance_km * data.fuel_l_per_100km / 100;
  const fuel_cost_pln = fuel_l * data.fuel_price_pln_per_l;
  const fuel_cost_eur = fuel_cost_pln / data.eur_pln;

  const driver_cost_eur = data.driver_days * data.driver_eur_per_day;
	const tg = window.lastRouteTollsGeo || null;
	const daily = calcDailyVignettesFromGeo(tg, data.driver_days, data.gbp_eur);
	const daily_vignettes_eur = daily.total_eur;
  const total_cost_eur =
  fuel_cost_eur
  + data.tolls_eur
  + daily_vignettes_eur          // <-- DODAJ
  + data.ferries_eur
  + driver_cost_eur
  + data.other_costs_eur;

	let price_eur = 0;
	let offer_price_eur = 0;

	if (data.calc_mode === "offer" && data.offer_price_eur > 0) {
		// Odwrócony kalkulator: mam cenę zlecenia → liczę marżę
	offer_price_eur = data.offer_price_eur;
	price_eur = offer_price_eur;
	} else {
  // Klasyczny tryb: liczę cenę sugerowaną z target marży
	price_eur = total_cost_eur * (1 + data.target_margin_pct / 100);
	}

	const margin_eur = price_eur - total_cost_eur;
	const margin_pct = price_eur > 0 ? (margin_eur / price_eur) * 100 : 0;

  return {
    distance_km: round2(data.distance_km),
    tolls_eur: round2(data.tolls_eur),
    ferries_eur: round2(data.ferries_eur),
    other_costs_eur: round2(data.other_costs_eur),

    fuel_l: round2(fuel_l),
    fuel_cost_pln: round2(fuel_cost_pln),
    fuel_cost_eur: round2(fuel_cost_eur),
    driver_cost_eur: round2(driver_cost_eur),
    total_cost_eur: round2(total_cost_eur),
	daily_vignettes_eur: round2(daily_vignettes_eur),
	daily_vignettes_rows: daily.rows,
    suggested_price_eur: round2(data.calc_mode === "offer" ? 0 : price_eur),
	offer_price_eur: round2(offer_price_eur),
	margin_eur: round2(margin_eur),
	margin_pct: round2(margin_pct),
	calc_mode: data.calc_mode,
  };
}

function run() {

console.log("RUN CLICK");

  const { base, empty, total } = updateTotalDistance();
  applyAutoFields();

  const data = {
    distance_km: total,
    base_distance_km: base,
    empty_km: empty,

    fuel_l_per_100km: +document.getElementById("fuel_l_per_100km").value,
    fuel_price_pln_per_l: +document.getElementById("fuel_price_pln_per_l").value,
    eur_pln: +document.getElementById("eur_pln").value,
	gbp_eur: +document.getElementById("gbp_eur").value,  
    tolls_eur: +document.getElementById("tolls_eur").value,
    ferries_eur: +document.getElementById("ferries_eur").value,
    driver_days: +document.getElementById("driver_days").value,
    driver_eur_per_day: +document.getElementById("driver_eur_per_day").value,
    other_costs_eur: +document.getElementById("other_costs_eur").value,
    target_margin_pct: +document.getElementById("target_margin_pct").value,
	
	calc_mode: document.getElementById("calc_mode")?.value || "suggest",
	offer_price_eur: +document.getElementById("offer_price_eur")?.value || 0,
  };
  
  if (data.calc_mode !== "offer") {
  data.offer_price_eur = 0;
}
  
  console.log("MODE:", data.calc_mode, "OFFER:", data.offer_price_eur);

  const result = calculateCosts(data);

  result.base_distance_km = round2(base);
  result.empty_km = round2(empty);
  result.distance_km = round2(total);

  window.lastCalc = result;
  window.lastInput = data;

  renderResult(data, result);
  
  autoSaveAfterRun();

	const isOffer = (result.calc_mode === "offer" && result.offer_price_eur > 0);

	document.getElementById("summary").textContent =
		"Koszt całkowity: " + result.total_cost_eur + " EUR\n" +
		"Dystans: " + result.base_distance_km + " km + pusty dolot " + result.empty_km + " km = " + result.distance_km + " km\n" +
		"Paliwo: " + result.fuel_cost_eur + " EUR | Kierowca: " + result.driver_cost_eur + " EUR\n" +
		"Myto: " + result.tolls_eur + " EUR | Promy: " + result.ferries_eur + " EUR | Inne: " + result.other_costs_eur + " EUR\n" +
	(isOffer
		? ("Cena zlecenia: " + result.offer_price_eur + " EUR\n" +
       "Marża: " + result.margin_eur + " EUR (" + result.margin_pct + "%)")
		: ("Proponowana cena: " + result.suggested_price_eur + " EUR\n" +
       "Marża: " + result.margin_eur + " EUR (" + result.margin_pct + "%)"));
}

function applyVignetteOverrides(tg, v){
  if (!tg?.by_country?.length) return tg;

  const hasNL = !!v?.rows?.some(r => String(r.country).startsWith("NL"));
  const hasGB = !!v?.rows?.some(r => String(r.country).startsWith("GB"));

  if (!hasNL && !hasGB) return tg;

  const isNL = (c) => /holand|niderl|nether|nl\b/i.test(String(c||""));
  const isGB = (c) => /\bgb\b|uk|united kingdom|wielka brytania|england|scotland/i.test(String(c||""));

  let removed = 0;
  const kept = [];

  for (const x of tg.by_country){
    const c = x.country;
    const drop = (hasNL && isNL(c)) || (hasGB && isGB(c));
    if (drop) removed += Number(x.cost_eur || 0);
    else kept.push(x);
  }

  const total = Math.max(0, Number(tg.total_eur || 0) - removed);
  return { ...tg, by_country: kept, total_eur: Math.round(total*100)/100 };
}

/* =========================
   API: POBIERZ TRASĘ
========================= */
async function getRoute(){
console.log("getRoute() start:", getRouteFromUI());
  const baseInput = document.getElementById("base_distance_km");
  const routeInfoEl = document.getElementById("routeInfo");
  const { origin, destination, stops } = getRouteFromUI();
  const useMulti = stops.length > 0;


  if (!origin || !destination) {
    routeInfoEl.textContent = "Uzupełnij Skąd i Dokąd.";
    return;
  }

  routeInfoEl.textContent = "Szukam trasy...";

  try {
    const url = useMulti
      ? "http://localhost:3001/api/route/multi"
      : "http://localhost:3001/api/route";

    const payload = useMulti ? { origin, destination, stops } : { origin, destination };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
	window.lastRouteTollsGeo = data.tolls_geo || null;
	console.log("tolls_geo:", data.tolls_geo);
	console.log("tolls(v0):", data.tolls);


	const rui = getRouteFromUI();
		window.lastRoutePayload = {
		origin: rui.origin,
		destination: rui.destination,
		stops: rui.stops,
		points_resolved: data.points_resolved || null,
		title: (rui.origin && rui.destination) ? `${rui.origin} → ${rui.destination}` : "Wycena trasy"
	};

    if (!res.ok) {
      routeInfoEl.textContent = data.error || "Błąd wyznaczania trasy.";
      return;
    }

    baseInput.value = data.distance_km;
    updateMapFromRoute(data);
const { base, empty, total } = updateTotalDistance();
applyAutoFields();

// --- WINIETY (NL/GB) + OVERRIDE MYTA ---
const tg0 = window.lastRouteTollsGeo;
const driverDays = +document.getElementById("driver_days")?.value || 0;
const gbpEur = +document.getElementById("gbp_eur")?.value || 1.17;

// tekst trasy do wykrywania kraju, jeśli masz taką logikę
const routeText =
  (data.origin_resolved || origin || "") + " " +
  (data.destination_resolved || destination || "") + " " +
  (Array.isArray(data.points_resolved) ? data.points_resolved.join(" ") : "");

// policz winiety raz
const kmPerDayUi = +document.getElementById("km_per_day")?.value || 0;

const v = calcDailyVignettesFromGeo(
  tg0,
  driverDays,
  gbpEur,
  routeText,
  Number(data.distance_km || 0),
  kmPerDayUi
);

window.lastRouteVignettes = v;

// usuń NL/GB z myta per-km jeśli są rozliczane winietą
const tgAdj = applyVignetteOverrides(tg0, v);
window.lastRouteTollsGeoAdj = tgAdj;

// ustaw pole myta = (myto po override) + winiety
const baseTolls = (tgAdj?.total_eur != null) ? Number(tgAdj.total_eur) : 0;
document.getElementById("tolls_eur").value = (baseTolls + Number(v.total_eur || 0)).toFixed(2);

console.log("VIN:", window.lastRouteVignettes);
console.log("driverDays:", driverDays);

// debug bez błędu scope
window._lastDriverDays = driverDays;
console.log("VIN:", window.lastRouteVignettes);
console.log("driverDays:", window._lastDriverDays);
	
	run();

    let pointsText = "";
    if (Array.isArray(data.points_resolved) && data.points_resolved.length) {
      pointsText = "Punkty:\n- " + data.points_resolved.join("\n- ") + "\n\n";
    } else if (data.origin_resolved || data.destination_resolved) {
      pointsText =
        "Skąd: " + (data.origin_resolved || origin) + "\n" +
        "Dokąd: " + (data.destination_resolved || destination) + "\n\n";
    }

    routeInfoEl.textContent =
      pointsText +
      `Trasa z mapy: ${base} km\n` +
      `Pusty dolot: ${empty} km\n` +
      `RAZEM do kalkulacji: ${total} km\n` +
      `Czas (bazowy): ${data.duration_h} h`;

  } catch (e) {
    console.error(e);
    routeInfoEl.textContent = "Nie mogę połączyć się z serwerem (route).";
  }
}

/* =========================
   BOOT + EXPORT dla onclick
========================= */
window.addEventListener("load", () => {
  console.log("APP BOOT");

  initRouteBuilder();
  initMap();

  // auto
  document.getElementById("empty_km")?.addEventListener("input", () => { updateTotalDistance(); applyAutoFields(); });
  document.getElementById("km_per_day")?.addEventListener("input", applyAutoFields);
  document.getElementById("daily_extra_eur")?.addEventListener("input", applyAutoFields);
  document.getElementById("auto_driver_days")?.addEventListener("change", applyAutoFields);

});

function renderResult(input, result) {
  const k1 = document.getElementById("kpi_total");
  const k2 = document.getElementById("kpi_price");
  const k3 = document.getElementById("kpi_margin");

  if (k1) k1.textContent = (result.total_cost_eur ?? "—") + " EUR";

  const isOffer = (result.calc_mode === "offer" && Number(result.offer_price_eur || 0) > 0);

  if (isOffer) {
    if (k2) k2.textContent = (result.offer_price_eur ?? "—") + " EUR";
    if (k3) k3.textContent = (result.margin_eur ?? "—") + " EUR";
  } else {
    if (k2) k2.textContent = (result.suggested_price_eur ?? "—") + " EUR";
    if (k3) k3.textContent = (result.margin_eur ?? "—") + " EUR";
  }

  // ✅ WINIETY – bierzemy z globala (NIE z "v" lokalnego)
  const v = window.lastRouteVignettes || null;

  const vEl = document.getElementById("vignetteTotal");
  if (vEl) {
    if (v?.rows?.length) {
      const line = v.rows
        .map(x => `${x.country}: ${x.qty} dni (${Number(x.cost_eur || 0).toFixed(2)} €)`)
        .join(" | ");
      vEl.textContent = `Winiety dzienne: ${line} | Razem: ${Number(v.total_eur || 0).toFixed(2)} EUR`;
    } else {
      vEl.textContent = "";
    }
  }

  // === TABELA Pozycja / Wartość ===
  const tbody = document.getElementById("costTable");
  if (tbody) {
    const row = (label, value) => `
      <tr>
        <td>${label}</td>
        <td style="text-align:right;">${value}</td>
      </tr>
    `;

    tbody.innerHTML = "";
    tbody.innerHTML += row("Dystans (km)", result.distance_km ?? "—");
    tbody.innerHTML += row("Paliwo (EUR)", result.fuel_cost_eur ?? "—");
    tbody.innerHTML += row("Kierowca (EUR)", result.driver_cost_eur ?? "—");
    tbody.innerHTML += row("Myto (EUR)", result.tolls_eur ?? "—");
    tbody.innerHTML += row("Promy (EUR)", result.ferries_eur ?? "—");
    tbody.innerHTML += row("Inne koszty (EUR)", result.other_costs_eur ?? "—");
    tbody.innerHTML += row("<b>Koszt całkowity (EUR)</b>", `<b>${result.total_cost_eur ?? "—"}</b>`);

    if (isOffer) {
      tbody.innerHTML += row("Cena zlecenia (EUR)", result.offer_price_eur ?? "—");
      tbody.innerHTML += row("<b>Marża (EUR)</b>", `<b>${result.margin_eur ?? "—"}</b>`);
      tbody.innerHTML += row("Marża (%)", (result.margin_pct ?? "—") + "%");
    } else {
      tbody.innerHTML += row("Cena sugerowana (EUR)", result.suggested_price_eur ?? "—");
      tbody.innerHTML += row("Marża (EUR)", result.margin_eur ?? "—");
    }
  }

  // === Koszt / km ===
  const perKmEl = document.getElementById("perKm");
  if (perKmEl) {
    const km = Number(result.distance_km || 0);
    const total = Number(result.total_cost_eur || 0);
    perKmEl.textContent = (km > 0) ? `Koszt / km: ${(total / km).toFixed(2)} EUR/km` : "";
  }

  // === Myto per kraj (UE offline) + winiety dopisane jako wiersze ===
  const tollsBody = document.getElementById("tollsTable");
  const tollsTotalEl = document.getElementById("tollsTotal");

  const tg = window.lastRouteTollsGeoAdj || window.lastRouteTollsGeo;

  if (tollsBody) {
    tollsBody.innerHTML = "";

    if (tg?.by_country?.length) {
      tg.by_country.forEach(x => {
        tollsBody.innerHTML += `
          <tr>
            <td>${x.country ?? "—"}</td>
            <td style="text-align:right;">${x.km ?? "—"}</td>
            <td style="text-align:right;">${x.rate_eur_per_km ?? "—"}</td>
            <td style="text-align:right;">${x.cost_eur ?? "—"}</td>
          </tr>
        `;
      });
    } else {
      tollsBody.innerHTML = `<tr><td colspan="4" style="opacity:.75;">Brak danych myta (tolls_geo).</td></tr>`;
    }

    // dopisz winiety jako osobne wiersze (tylko raz)
    if (v?.rows?.length) {
      v.rows.forEach(r => {
        tollsBody.innerHTML += `
          <tr>
            <td>${r.country}</td>
            <td style="text-align:right;">${r.qty}</td>
            <td style="text-align:right;">${r.rate} ${r.rate_ccy}/${r.unit}</td>
            <td style="text-align:right;">${Number(r.cost_eur || 0).toFixed(2)}</td>
          </tr>
        `;
      });
    }

    // podsumowanie
    const base = (tg?.total_eur != null) ? Number(tg.total_eur) : 0;
    const add  = (v?.total_eur != null)  ? Number(v.total_eur)  : 0;

    if (tollsTotalEl) {
      if (add > 0) {
        tollsTotalEl.textContent =
          `Myto (UE offline): ${base.toFixed(2)} € | Winiety: ${add.toFixed(2)} € | Razem: ${(base + add).toFixed(2)} €`;
      } else {
        tollsTotalEl.textContent = `Myto (UE offline) razem: ${base ? base.toFixed(2) : "—"} EUR`;
      }
    }
  }
}

async function generateReport(){
  if (!window.lastCalc || !window.lastInput) {
    aiReportEl.textContent = "Najpierw kliknij POLICZ.";
    return;
  }

  aiReportEl.textContent = "Generuję raport...";

  const payload = {
    note: "Kalkulacja",
    input: window.lastInput,
    calc: window.lastCalc
  };

  try {
    const res = await fetch("http://localhost:3001/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
	
	console.log("ROUTE DATA:", data);console.log("ROUTE DATA:", data);

    if (!res.ok) {
      aiReportEl.textContent =
        (data.error || "Błąd serwera.") +
        (data.gotKeys ? ("\n\ngotKeys: " + data.gotKeys.join(", ")) : "");
      return;
    }

    aiReportEl.innerText = data.report || "(brak treści raportu)";
} catch (e) {
  console.error("REPORT FETCH ERROR:", e);
  aiReportEl.textContent =
    "Nie mogę połączyć się z serwerem. " +
    "Szczegóły w konsoli (REPORT FETCH ERROR).";
}

}

// ważne: żeby onclick widział funkcję w każdym trybie
window.generateReport = generateReport;

// ===== RAPORT AI (JEDYNA WERSJA) =====
async function generateReport(){
  const aiReportEl = document.getElementById("aiReport");
  if (!aiReportEl) {
    console.error("Brak elementu #aiReport w HTML");
    return;
  }

  if (!window.lastCalc || !window.lastInput) {
    aiReportEl.textContent = "Najpierw kliknij POLICZ.";
    return;
  }

  aiReportEl.textContent = "Generuję raport...";

  const payload = {
    note: "Kalkulacja",
    input: window.lastInput,
    calc: window.lastCalc
  };

  try {
    const res = await fetch("http://localhost:3001/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      aiReportEl.textContent =
        (data.error || "Błąd serwera.") +
        (data.gotKeys ? ("\n\ngotKeys: " + data.gotKeys.join(", ")) : "");
      return;
    }

    aiReportEl.innerText = data.report || "(brak treści raportu)";
  } catch (e) {
    console.error("REPORT FETCH ERROR:", e);
    aiReportEl.textContent =
      "Nie mogę połączyć się z serwerem. Czy działa http://localhost:3001 ?";
  }
}

// ===== EXPORT DLA onclick="" (JEDEN RAZ) =====
window.getRoute = getRoute;
window.run = run;
window.addRoutePoint = addRoutePoint;
window.clearRouteMiddle = clearRouteMiddle;
window.generateReport = generateReport;

// ===== PODPIĘCIE PRZYCISKU (opcjonalnie) =====
window.addEventListener("load", () => {
  const btn = document.getElementById("btnReportAI");
  if (btn) {
    btn.addEventListener("click", () => window.generateReport());
  }
});

const HISTORY_KEY = "ak_history_v1";
const HISTORY_AUTO_ID = "AUTO_LAST";

function hLoad(){
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}
function hSave(items){
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}
function hId(){
  return "H" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function openSaveHistoryModal(){
  // podpowiedzi do pól
  const r = window.lastRoutePayload || null;
  const calc = window.lastCalc || null;

  const nameEl = document.getElementById("h_name");
  const clientEl = document.getElementById("h_client");
  const noteEl = document.getElementById("h_note");

  if (nameEl && !nameEl.value) {
    const title = r?.title || (r?.origin && r?.destination ? `${r.origin} → ${r.destination}` : "Wycena trasy");
    nameEl.value = title;
  }
  if (clientEl && !clientEl.value) clientEl.value = "";
  if (noteEl && !noteEl.value) noteEl.value = "";

  document.getElementById("historyModal").style.display = "flex";
}
function closeSaveHistoryModal(){
  document.getElementById("historyModal").style.display = "none";
}

function toggleHistory(forceClose = false){
  const drawer = document.getElementById("historyDrawer");
  const back = document.getElementById("historyBackdrop");
  if (!drawer || !back) return;

  const isOpen = drawer.classList.contains("open");
  const next = forceClose ? false : !isOpen;

  drawer.classList.toggle("open", next);
  back.classList.toggle("open", next);
  drawer.setAttribute("aria-hidden", next ? "false" : "true");

  if (next) {
    // odśwież listę przy otwarciu
    try { renderHistory(); } catch {}
  }
}

// ESC zamyka drawer
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleHistory(true);
});

function toggleHistoryPanel(forceOpen){
  const body = document.getElementById("historyPanelBody");
  const ch = document.getElementById("historyChevron");
  if (!body) return;

  const isOpen = body.style.display !== "none";
  const next = (forceOpen === true) ? true : (forceOpen === false ? false : !isOpen);

  body.style.display = next ? "block" : "none";
  if (ch) ch.textContent = next ? "▴" : "▾";

  if (next) renderHistory();
}

function saveCurrentToHistory(){
  const calc = window.lastCalc;
  const input = window.lastInput;
  if (!calc || !input) {
    alert("Brak danych do zapisu. Kliknij najpierw „Policz”.");
    return;
  }

  const r = window.lastRoutePayload || {};
  const tolls_geo = window.lastRouteTollsGeo || null;

  // ✅ nowe: zapisuj też wersję „po winietach” i same winiety
  const tolls_geo_adj = window.lastRouteTollsGeoAdj || null;
  const vignettes = window.lastRouteVignettes || null;

  const name = (document.getElementById("h_name")?.value || "").trim() || (r.title || "Wycena");
  const client = (document.getElementById("h_client")?.value || "").trim();
  const note = (document.getElementById("h_note")?.value || "").trim();

  const item = {
    id: hId(),
    ts: Date.now(),
    name,
    client,
    note,

    route: {
      origin: r.origin || "",
      destination: r.destination || "",
      stops: Array.isArray(r.stops) ? r.stops : [],
      points_resolved: r.points_resolved || null,
    },

    input,
    result: calc,

    // ✅ zapis danych myta i winiet
    tolls_geo,
    tolls_geo_adj,
    vignettes,
  };

  const items = hLoad();
  items.unshift(item);
  hSave(items.slice(0, 60));

  window.lastHistoryId = item.id; // ✅ poprawnie: item, nie „it”
  renderHistory();

  closeSaveHistoryModal();

  // ✅ opcjonalnie: od razu pokaż panel historii
  if (typeof toggleHistoryPanel === "function") toggleHistoryPanel(true);
}

function clearHistoryConfirm(){
  if (!confirm("Na pewno wyczyścić historię wycen?")) return;
  hSave([]);
  renderHistory();
}

function renderHistory(){
  const el = document.getElementById("historyList");
  if (!el) return;

  const items = hLoad();
  if (!items.length) {
    el.innerHTML = `<div style="opacity:.75;font-size:13px;">Brak zapisów. Kliknij "+ Zapisz do historii".</div>`;
    return;
  }

  el.innerHTML = "";

  items.forEach(it => {
    const dt = new Date(it.ts).toLocaleString();
    const mode = it.result?.calc_mode === "offer" ? "OFFER" : "SUGGEST";
    const cost = it.result?.total_cost_eur ?? "—";
    const price = (it.result?.calc_mode === "offer" && it.result?.offer_price_eur > 0)
      ? it.result.offer_price_eur
      : (it.result?.suggested_price_eur ?? "—");
    const margin = it.result?.margin_eur ?? "—";

    const routeTxt = it.route?.origin && it.route?.destination
      ? `${it.route.origin} → ${it.route.destination}${(it.route.stops?.length ? ` (+${it.route.stops.length})` : "")}`
      : "—";

   const card = document.createElement("div");
    card.className = "historyItem";

    card.innerHTML = `
      <div class="historyTop">
        <div>
          <div class="historyName">${escapeHtml(it.name)}</div>
          <div class="historyMeta">${dt}${it.client ? " • " + escapeHtml(it.client) : ""}</div>
        </div>
        <div class="badge">${mode}</div>
      </div>

      <div class="historyLine">${escapeHtml(routeTxt)}</div>
      ${it.note ? `<div class="historyMeta" style="margin-top:4px;">${escapeHtml(it.note)}</div>` : ""}

      <div class="historyBadges">
        <div class="badge">Koszt: <b>${cost}</b> €</div>
        <div class="badge">Cena: <b>${price}</b> €</div>
        <div class="badge">Marża: <b>${margin}</b> €</div>
      </div>

      <div class="historyBtns">
        <button type="button" class="btn secondary" data-act="load" data-id="${it.id}">⚡ Wczytaj</button>
        <button type="button" class="btn secondary" data-act="reload" data-id="${it.id}">🗺 Odśwież trasę</button>
        <button type="button" class="btn secondary" data-act="duplicate" data-id="${it.id}">Duplikuj</button>
        <button type="button" class="btn secondary" data-act="delete" data-id="${it.id}">Usuń</button>
      </div>
    `;

    el.appendChild(card);
  });

  el.querySelectorAll("button[data-act]").forEach(btn => {
    btn.onclick = () => {
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id");
      if (act === "load") return hRestore(id, false);
      if (act === "reload") return hRestore(id, true);
      if (act === "delete") return hDelete(id);
      if (act === "duplicate") return hDuplicate(id);
    };
  });
}

function hFind(id){
  return hLoad().find(x => x.id === id);
}

function hDelete(id){
  const items = hLoad().filter(x => x.id !== id);
  hSave(items);
  renderHistory();
}

function hDuplicate(id){
  const it = hFind(id);
  if (!it) return;
  const items = hLoad();
  const copy = JSON.parse(JSON.stringify(it));
  copy.id = hId();
  copy.ts = Date.now();
  copy.name = it.name + " (kop.)";
  items.unshift(copy);
  hSave(items.slice(0, 60));
  renderHistory();
}

// 2 klikami: klik “Wczytaj” i koniec

function hRestore(id, refreshRoute = false){
  const it = hFind(id);
  if (!it) return;

  // 1️⃣ Przywróć pola kalkulatora
  const input = it.input || {};
  Object.entries(input).forEach(([k,v]) => {
    const el = document.getElementById(k);
    if (el != null) el.value = v;
  });

  // 2️⃣ Tryb + oferta
  const mode = it.result?.calc_mode || "suggest";
  if (typeof setCalcMode === "function") {
    setCalcMode(mode);
  } else {
    const hidden = document.getElementById("calc_mode");
    if (hidden) hidden.value = mode;
  }

  const offerEl = document.getElementById("offer_price_eur");
  if (offerEl) offerEl.value = (it.result?.offer_price_eur || "");

  // 3️⃣ Przywróć trasę do UI
  if (typeof setRouteToUI === "function") {
    setRouteToUI(it.route);
  }

  // 4️⃣ Przywróć myto geo (dla szybkiego trybu)
  window.lastRouteTollsGeo = it.tolls_geo || null;
  window.lastRouteTollsGeoAdj = it.tolls_geo_adj || null;
  window.lastRouteVignettes = it.vignettes || null;
  
  try{
  const tg = window.lastRouteTollsGeoAdj || window.lastRouteTollsGeo;
  const v = window.lastRouteVignettes;
  const base = tg?.total_eur != null ? Number(tg.total_eur) : 0;
  const add = v?.total_eur != null ? Number(v.total_eur) : 0;
  const te = document.getElementById("tolls_eur");
  if (te) te.value = (base + add).toFixed(2);
}catch(e){ console.warn("restore tolls+vignettes failed", e); }

  if (refreshRoute) {
    // 🗺 pełne przeliczenie trasy z backendu
	console.log("RESTORE route:", it.route);
	console.log("UI route now:", getRouteFromUI());
    setTimeout(() => getRoute(), 80);
  } else {
    // ⚡ szybkie przeliczenie tylko kosztów
    run();
  }
}

// proste escapowanie do HTML (żeby nie rozwalić DOM)
function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// odpal przy starcie
document.addEventListener("DOMContentLoaded", renderHistory);

(function initResizableLayout(){
  const root = document.documentElement;

  const splitLeft  = document.getElementById("splitLeft");
  const splitRight = document.getElementById("splitRight");
  const splitMapH  = document.getElementById("splitMapH");
  const infoEl     = document.getElementById("mapSizeInfo");

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // restore
  const savedLeft  = Number(localStorage.getItem("ui_leftW") || "");
  const savedRight = Number(localStorage.getItem("ui_rightW") || "");
  const savedMapH  = Number(localStorage.getItem("ui_mapH") || "");

  if (savedLeft)  root.style.setProperty("--leftW",  savedLeft + "px");
  if (savedRight) root.style.setProperty("--rightW", savedRight + "px");
  if (savedMapH)  root.style.setProperty("--mapH",   savedMapH + "px");

  function invalidateLeaflet(){
    if (window.map && typeof window.map.invalidateSize === "function") {
      setTimeout(() => window.map.invalidateSize(), 80);
    }
  }

  function updateInfo(){
    const leftW = getComputedStyle(root).getPropertyValue("--leftW").trim();
    const rightW = getComputedStyle(root).getPropertyValue("--rightW").trim();
    const mapH = getComputedStyle(root).getPropertyValue("--mapH").trim();
    if (infoEl) infoEl.textContent = `Układ: lewa ${leftW}, prawa ${rightW}, mapa wysokość ${mapH}`;
  }
  updateInfo();

  // Drag helper
  function drag(el, onMove){
    if (!el) return;
    let active = false;

    el.addEventListener("pointerdown", (e) => {
      active = true;
      el.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = getComputedStyle(el).cursor;
    });

    el.addEventListener("pointermove", (e) => {
      if (!active) return;
      onMove(e);
      updateInfo();
      invalidateLeaflet();
    });

    el.addEventListener("pointerup", () => {
      active = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    });
  }

  // 1) szerokość LEWEJ kolumny
  drag(splitLeft, (e) => {
    const rect = document.querySelector(".app3").getBoundingClientRect();
    const x = e.clientX - rect.left;

    const minLeft = Number(getComputedStyle(root).getPropertyValue("--minLeft")) || 320;
    const minMap  = Number(getComputedStyle(root).getPropertyValue("--minMap"))  || 420;

    // prawa część to: handle + mapa + handle + prawaKolumna
    const rightW = parseFloat(getComputedStyle(root).getPropertyValue("--rightW")) || 480;
    const handle = parseFloat(getComputedStyle(root).getPropertyValue("--handle")) || 10;
    const gap    = parseFloat(getComputedStyle(root).getPropertyValue("--gap")) || 12;

    const maxLeft = rect.width - (rightW + minMap + handle*2 + gap*4);
    const newLeft = clamp(x, minLeft, maxLeft);

    root.style.setProperty("--leftW", newLeft + "px");
    localStorage.setItem("ui_leftW", String(Math.round(newLeft)));
  });

  // 2) szerokość PRAWEJ kolumny
  drag(splitRight, (e) => {
    const rect = document.querySelector(".app3").getBoundingClientRect();
    const x = rect.right - e.clientX;

    const minRight = Number(getComputedStyle(root).getPropertyValue("--minRight")) || 340;
    const minMap   = Number(getComputedStyle(root).getPropertyValue("--minMap"))  || 420;

    const leftW = parseFloat(getComputedStyle(root).getPropertyValue("--leftW")) || 380;
    const handle = parseFloat(getComputedStyle(root).getPropertyValue("--handle")) || 10;
    const gap    = parseFloat(getComputedStyle(root).getPropertyValue("--gap")) || 12;

    const maxRight = rect.width - (leftW + minMap + handle*2 + gap*4);
    const newRight = clamp(x, minRight, maxRight);

    root.style.setProperty("--rightW", newRight + "px");
    localStorage.setItem("ui_rightW", String(Math.round(newRight)));
  });

  // 3) wysokość MAPY
  drag(splitMapH, (e) => {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    const rect = mapEl.getBoundingClientRect();
    const newH = e.clientY - rect.top;

    const minMapH = Number(getComputedStyle(root).getPropertyValue("--minMapH")) || 320;
    const maxMapH = Math.max(minMapH, window.innerHeight - 220); // bezpieczny limit

    const h = clamp(newH, minMapH, maxMapH);
    root.style.setProperty("--mapH", Math.round(h) + "px");
    localStorage.setItem("ui_mapH", String(Math.round(h)));
  });

})();
