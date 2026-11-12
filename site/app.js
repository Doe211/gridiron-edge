// Gridiron Edge website. Reads the data files the scheduled job writes (data/<league>.json).
// Players' picks, the pick deadline and the administrator's adjusted lines live in the
// Supabase database (see supabase/setup.sql); config.js says where it is.
"use strict";

const LEAGUES = { nfl: "NFL", college: "College", nba: "NBA", mlb: "MLB" };
const MARGIN_SPREAD = { nfl: 13.5, college: 16, nba: 12, mlb: 4.4 };
const SPREAD_HIGHLIGHT = 3, TOTAL_HIGHLIGHT = 5, MLB_HIGHLIGHT = 0.05;

const state = {
  league: load("league", "nfl"),
  tab: load("tab", "week"),
  week: null,
  data: {},
  overrides: {},
  settings: {}, // administrator settings, e.g. { picks_close: "2026-11-15T18:00:00Z" }
  myTickets: {}, // league -> tickets placed from this device
  myLegs: {},    // league -> { picks: {game: side}, totals: {game: over/under} } from those tickets
};

// ---------- storage (works even when the browser blocks it) ----------
function load(key, fallback) {
  try { const v = localStorage.getItem("ge_" + key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("ge_" + key, JSON.stringify(value)); } catch { /* private mode */ }
}
// Picks on the tickets this device has placed (used by Results and the Scorecard).
const picks = (kind) => (state.myLegs[state.league] || {})[kind] || {};
// The ticket being built on This Week, before it's placed. kind: "picks" (teams) or "totals".
const draft = (kind) => load(`draft_${kind}_${state.league}`, {});

// Tickets: 3 to 8 picks, all must win. Pays this many coins per coin wagered (plus the wager back).
const PAYOUT = { 3: 5.5, 4: 10, 5: 15, 6: 30, 7: 80, 8: 150 };
const COIN = "🪙";
const MIN_LEGS = 3, MAX_LEGS = 8, MAX_WAGER = 100;
const coins = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)} ${COIN}`;

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pts = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const pct = (r) => (r.w + r.l ? ((100 * r.w) / (r.w + r.l)).toFixed(1) + "%" : "—");
const rec = (r) => (r.p ? `${r.w}-${r.l}-${r.p}` : `${r.w}-${r.l}`);
const newRec = () => ({ w: 0, l: 0, p: 0 });
function add(r, won) { if (won === true) r.w++; else if (won === false) r.l++; else r.p++; }

function erf(x) { // Abramowitz-Stegun approximation
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

// ---------- one game ----------
const D = () => state.data[state.league];
const isFinal = (g) => g.home_score != null && g.away_score != null;
const margin = (g) => (isFinal(g) ? g.home_score - g.away_score : null);
/** The administrator's deadline for all picks, if one is set. */
const picksDeadline = () => (state.settings.picks_close ? new Date(state.settings.picks_close) : null);
const picksClosed = () => { const d = picksDeadline(); return !!d && d <= new Date(); };
const isLocked = (g) => isFinal(g) || (g.kickoff && new Date(g.kickoff) <= new Date()) || picksClosed();
/** Whether this league has over/unders to show (NFL and college come with them; NBA from The Odds API). */
const hasTotals = () => D().has_totals || D().games.some((g) => g.total != null);
const team = (g, side) => (side === "home" ? g.home : g.away);
const shortName = (code) => (state.league === "mlb" ? D().names[code] || code : code);
const fullName = (code) => D().names[code] || code;
const modelWinner = (g) => (g.prediction >= 0 ? "home" : "away");
function actualWinner(g) { const m = margin(g); return m == null || m === 0 ? null : m > 0 ? "home" : "away"; }
function modelSpreadPick(g) { return g.spread == null || g.prediction === g.spread ? null : g.prediction > g.spread ? "home" : "away"; }
const edge = (g) => (g.spread == null ? null : Math.abs(g.prediction - g.spread));
function spreadWon(g, side) {
  const m = margin(g); if (m == null || g.spread == null || m === g.spread) return null;
  return (m > g.spread) === (side === "home");
}
function lineText(g) {
  if (g.spread == null) return "No line yet";
  if (g.spread === 0) return "Pick'em";
  return g.spread > 0 ? `${g.home} -${pts(g.spread)}` : `${g.away} -${pts(-g.spread)}`;
}
function lineFor(g, side) {
  if (g.spread == null) return "";
  const v = side === "home" ? -g.spread : g.spread;
  return v === 0 ? "PK" : v > 0 ? `+${pts(v)}` : `-${pts(-v)}`;
}
const modelText = (g) => `${shortName(g.prediction >= 0 ? g.home : g.away)} by ${Math.abs(g.prediction).toFixed(1)}`;
function winChance(g, side) {
  const home = 0.5 * (1 + erf(g.prediction / (MARGIN_SPREAD[state.league] * Math.SQRT2)));
  return side === "home" ? home : 1 - home;
}
function vegasFavorite(g) { const p = g.home_win_chance; return p == null || p === 0.5 ? null : p > 0.5 ? "home" : "away"; }
function mlbLean(g) {
  if (g.home_win_chance == null) return null;
  const d = winChance(g, "home") - g.home_win_chance;
  return { side: d >= 0 ? "home" : "away", gap: Math.abs(d) };
}
const actualTotal = (g) => (isFinal(g) ? g.home_score + g.away_score : null);
function modelTotalPick(g) { return g.total == null || g.total_prediction == null || g.total_prediction === g.total ? null : g.total_prediction > g.total ? "over" : "under"; }
const totalEdge = (g) => (g.total == null || g.total_prediction == null ? null : Math.abs(g.total_prediction - g.total));
function totalWon(g, side) {
  const t = actualTotal(g); if (t == null || g.total == null || t === g.total) return null;
  return (t > g.total) === (side === "over");
}
const ouLabel = (s) => (s === "over" ? "Over" : "Under");

// ---------- the league's games ----------
function applyOverrides(games) {
  return games.map((g) => {
    const o = state.overrides[g.id];
    if (!o) return g;
    const c = { ...g, adjusted: true, vegas_spread: g.spread, vegas_total: g.total };
    if (o.spread != null) c.spread = o.spread;
    if (o.total != null) c.total = o.total;
    return c;
  });
}
const scored = (games) => games.filter((g) => isFinal(g) && (state.league !== "college" || g.spread != null));
const seasonGames = () => D().games.filter((g) => g.season === D().current_season);
const pickMode = () => D().pick_mode;

function upcomingWeek() {
  const weeks = seasonGames().filter((g) => !isFinal(g) && (g.spread != null || state.league !== "college")).map((g) => g.week);
  return weeks.length ? Math.min(...weeks) : null;
}
function upcomingGames() {
  const w = upcomingWeek(); if (w == null) return [];
  return seasonGames().filter((g) => g.week === w && !isFinal(g) && (state.league !== "college" || g.spread != null))
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || "") || a.id.localeCompare(b.id));
}
const completedWeeks = () => [...new Set(seasonGames().filter(isFinal).map((g) => g.week))].sort((a, b) => b - a);
const weekLabel = (w) => (state.league === "college" && w >= 20 ? "Bowls & Playoff" : `Week ${w}`);

// ---------- records ----------
function modelSU(games) { const r = newRec(); scored(games).forEach((g) => { const a = actualWinner(g); if (a) add(r, modelWinner(g) === a); else add(r, null); }); return r; }
function modelATS(games) { const r = newRec(); scored(games).forEach((g) => { const p = modelSpreadPick(g); if (p) add(r, spreadWon(g, p)); }); return r; }
const modelStrongATS = (games) => modelATS(games.filter((g) => (edge(g) ?? 0) >= SPREAD_HIGHLIGHT));
function yourRecord(games) {
  const mine = picks("picks"), r = newRec();
  scored(games).forEach((g) => {
    const p = mine[g.id]; if (!p) return;
    if (pickMode() === "spread") { if (g.spread != null) add(r, spreadWon(g, p)); }
    else { const a = actualWinner(g); if (a) add(r, p === a); }
  });
  return r;
}
function modelOnYours(games) {
  const mine = picks("picks"); const sub = games.filter((g) => mine[g.id]);
  return pickMode() === "spread" ? modelATS(sub) : modelSU(sub);
}
function vegasFavorites(games) { const r = newRec(); scored(games).forEach((g) => { const f = vegasFavorite(g), a = actualWinner(g); if (f && a) add(r, f === a); }); return r; }
const modelOnLined = (games) => modelSU(games.filter((g) => g.home_win_chance != null));
function modelStrongMLB(games) { const r = newRec(); scored(games).forEach((g) => { const l = mlbLean(g), a = actualWinner(g); if (l && l.gap >= MLB_HIGHLIGHT && a) add(r, l.side === a); }); return r; }
function modelOU(games) { const r = newRec(); scored(games).forEach((g) => { const p = modelTotalPick(g); if (p) add(r, totalWon(g, p)); }); return r; }
const modelStrongOU = (games) => modelOU(games.filter((g) => (totalEdge(g) ?? 0) >= TOTAL_HIGHLIGHT));
function yourOU(games) { const mine = picks("totals"), r = newRec(); scored(games).forEach((g) => { const p = mine[g.id]; if (p && g.total != null) add(r, totalWon(g, p)); }); return r; }
function modelOnYourTotals(games) { const mine = picks("totals"); return modelOU(games.filter((g) => mine[g.id])); }
function totalMiss(games) {
  const m = scored(games).filter((g) => g.total_prediction != null).map((g) => Math.abs(actualTotal(g) - g.total_prediction));
  return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
}

// ---------- rendering ----------
const stat = (label, value, hot = false) => `<div class="stat${hot ? " hot" : ""}"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`;
const row = (title, r, cls = "") => `<div class="row ${cls}"><span class="t">${esc(title)}</span><span class="r">${rec(r)}</span><span class="p">${pct(r)}</span></div>`;
const verdict = (label, ok) => `<span class="v ${ok === true ? "yes" : ok === false ? "no" : "push"}">${esc(label)}</span>`;
function when(g) {
  if (!g.kickoff) return "";
  return new Date(g.kickoff).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function gameCard(g) {
  const locked = isLocked(g), mine = draft("picks")[g.id], myTotal = draft("totals")[g.id];
  const teamBtn = (side) => `<button class="team-pick" data-pick="${side}" data-id="${esc(g.id)}" aria-pressed="${mine === side}" ${locked ? "disabled" : ""}>
      <span class="tp-name">${esc(fullName(team(g, side)))}</span>
      <span class="tp-line">${g.spread != null ? esc(lineFor(g, side)) : ""}</span>
    </button>`;
  const ouBtn = (side) => `<button class="pick" data-total="${side}" data-id="${esc(g.id)}" aria-pressed="${myTotal === side}" ${locked ? "disabled" : ""}>${ouLabel(side)} ${pts(g.total)}</button>`;
  return `<article class="card sheet">
    <div class="card-head"><span class="when">${esc(when(g))}${g.neutral ? " · Neutral site" : ""}</span>${locked ? '<span class="locked">🔒 Locked</span>' : ""}</div>
    <div class="teams">${teamBtn("away")}<span class="at">${g.neutral ? "vs." : "at"}</span>${teamBtn("home")}</div>
    <div class="lines">
      <span><span class="label">Spread</span> ${esc(g.spread != null ? lineText(g) : "No line yet")}</span>
      <span><span class="label">Over/under</span> ${g.total != null ? pts(g.total) : "No line yet"}</span>
      ${g.adjusted ? '<span class="adjusted">✎ Adjusted</span>' : ""}
    </div>
    ${g.total != null ? `<div class="picks"><span class="lbl">Total:</span>${ouBtn("over")}${ouBtn("under")}</div>` : ""}
    ${isAdmin() && !isFinal(g) ? `<div class="picks"><button class="admin-btn" data-adjust="${esc(g.id)}">✎ Adjust line</button></div>` : ""}
  </article>`;
}

function renderWeek() {
  const games = upcomingGames(), w = upcomingWeek();
  let html = `<h1>${w != null ? esc(weekLabel(w)) : "This Week"}</h1>`;
  if (!games.length) return html + `<div class="empty">No upcoming games right now.</div>`;
  const dl = picksDeadline();
  if (dl) {
    const t = dl.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    html += picksClosed() ? `<div class="deadline closed">🔒 Picks are closed.</div>` : `<div class="deadline">⏰ Picks close ${esc(t)}</div>`;
  }
  html += `<p class="note">Build a ticket: tap ${MIN_LEGS} to ${MAX_LEGS} picks (teams against the spread and Over/Under totals), choose your wager, and place it. Every pick must win. Once placed, a ticket can't be changed.</p>`;
  html += `<div class="cards">${games.map(gameCard).join("")}</div>`;
  html += ticketBar();
  return html;
}

function renderResults() {
  const weeks = completedWeeks();
  if (!weeks.length) return `<h1>Results</h1><div class="empty">No finished games yet this season.</div>`;
  const w = weeks.includes(state.week) ? state.week : weeks[0];
  const games = seasonGames().filter((g) => g.week === w && isFinal(g) && (state.league !== "college" || g.spread != null))
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
  let html = `<h1>${esc(weekLabel(w))} Results</h1>
    <div class="toolbar"><label for="week">Week:</label><select id="week">${weeks.map((x) => `<option value="${x}" ${x === w ? "selected" : ""}>${esc(weekLabel(x))}</option>`).join("")}</select></div>
    <div class="summary">${stat("Model, winners", rec(modelSU(games)))}${pickMode() === "spread" ? stat("Model vs spread", rec(modelATS(games))) : ""}${stat(pickMode() === "spread" ? "You vs spread" : "You, winners", rec(yourRecord(games)))}`;
  if (hasTotals()) {
    const mo = modelOU(games), yo = yourOU(games);
    if (mo.w + mo.l) html += stat("Model O/U", rec(mo));
    if (yo.w + yo.l) html += stat("You O/U", rec(yo));
  }
  html += `</div><div class="cards">`;
  const mine = picks("picks"), myT = picks("totals");
  for (const g of games) {
    const v = [verdict(`Model winner: ${shortName(team(g, modelWinner(g)))}`, actualWinner(g) ? modelWinner(g) === actualWinner(g) : null)];
    const fav = vegasFavorite(g);
    if (fav) v.push(verdict(`Vegas favorite: ${shortName(team(g, fav))}`, actualWinner(g) ? fav === actualWinner(g) : null));
    const p = modelSpreadPick(g);
    if (p) v.push(verdict(`Model ATS: ${shortName(team(g, p))} ${lineFor(g, p)}`, spreadWon(g, p)));
    const y = mine[g.id];
    if (y && pickMode() === "winner") v.push(verdict(`You: ${shortName(team(g, y))}`, actualWinner(g) ? y === actualWinner(g) : null));
    else if (y && g.spread != null) v.push(verdict(`You: ${shortName(team(g, y))} ${lineFor(g, y)}`, spreadWon(g, y)));
    let t = "";
    if (hasTotals() && g.total != null) {
      const tv = [], mp = modelTotalPick(g), yp = myT[g.id];
      if (mp) tv.push(verdict(`Model: ${ouLabel(mp)}`, totalWon(g, mp)));
      if (yp) tv.push(verdict(`You: ${ouLabel(yp)}`, totalWon(g, yp)));
      t = tv.length ? `<div class="verdicts">${tv.join("")}</div>` : "";
    }
    const info = [g.spread != null ? `Line: ${lineText(g)}` : "", hasTotals() && g.total != null ? `Total ${actualTotal(g)} (O/U ${pts(g.total)})` : ""].filter(Boolean).join(" · ");
    html += `<article class="card result"><div class="card-head"><span class="score">${esc(shortName(g.away))} ${g.away_score} at ${esc(shortName(g.home))} ${g.home_score}</span><span class="line-info">${esc(info)}</span></div><div class="verdicts">${v.join("")}</div>${t}</article>`;
  }
  return html + "</div>";
}

function weeklyChart(season) {
  const pts_ = [];
  for (const w of completedWeeks().slice().sort((a, b) => a - b)) {
    const games = season.filter((g) => g.week === w);
    const m = pickMode() === "spread" ? modelATS(games) : modelSU(games), y = yourRecord(games);
    pts_.push({ w, m: m.w + m.l ? m.w / (m.w + m.l) : null, y: y.w + y.l ? y.w / (y.w + y.l) : null });
  }
  if (!pts_.length) return "";
  const bw = 12, gap = 10, h = 160, top = 10, width = Math.max(320, pts_.length * (2 * bw + gap) + 40);
  let bars = "";
  pts_.forEach((p, i) => {
    const x = 34 + i * (2 * bw + gap);
    if (p.m != null) bars += `<rect x="${x}" y="${top + h - p.m * h}" width="${bw}" height="${p.m * h}" rx="2" fill="var(--muted)"><title>Model ${weekLabel(p.w)}: ${Math.round(p.m * 100)}%</title></rect>`;
    if (p.y != null) bars += `<rect x="${x + bw}" y="${top + h - p.y * h}" width="${bw}" height="${p.y * h}" rx="2" fill="var(--accent)"><title>You ${weekLabel(p.w)}: ${Math.round(p.y * 100)}%</title></rect>`;
    bars += `<text x="${x + bw}" y="${top + h + 16}" font-size="10" text-anchor="middle" fill="var(--muted)">${state.league === "college" && p.w >= 20 ? "Bowl" : "W" + p.w}</text>`;
  });
  const grid = [0, 0.5, 1].map((v) => `<line x1="30" x2="${width}" y1="${top + h - v * h}" y2="${top + h - v * h}" stroke="var(--line)"/><text x="0" y="${top + h - v * h + 4}" font-size="10" fill="var(--muted)">${v * 100}%</text>`).join("");
  return `<h2>${pickMode() === "spread" ? "Against the spread, week by week" : "Picking winners, week by week"}</h2>
    <div class="chart"><div class="legend"><span><i style="background:var(--muted)"></i>Model</span><span><i style="background:var(--accent)"></i>You</span></div>
    <svg width="${width}" height="${top + h + 22}" role="img" aria-label="Weekly win percentage">${grid}${bars}</svg></div>`;
}

function renderScorecard() {
  const season = seasonGames(), spread = pickMode() === "spread";
  const you = yourRecord(season), model = modelOnYours(season);
  let html = `<h1>Scorecard</h1><h2>${D().current_season} season</h2><div class="table">`;
  html += row("Model picking winners", modelSU(season));
  if (spread) { html += row("Model against the spread", modelATS(season)); html += row("Highlighted picks only (3+ pts off the line)", modelStrongATS(season), "indent"); }
  html += row(spread ? "You against the spread" : "You picking winners", you);
  if (state.league === "mlb") {
    const fav = vegasFavorites(season);
    if (fav.w + fav.l) {
      html += row("Vegas favorites (games with a line)", fav);
      html += row("Model on those same games", modelOnLined(season));
      html += row("Model's highlighted teams (5+ pts more than Vegas)", modelStrongMLB(season));
    }
  }
  html += "</div>";
  if (hasTotals()) {
    const model = D().has_totals, mo = modelOU(season), yo = yourOU(season), miss = totalMiss(season);
    html += `<h2>Over/under</h2><div class="table">`;
    if (model) html += row("Model on over/unders", mo) + row("Highlighted picks only (5+ pts off the total)", modelStrongOU(season), "indent");
    html += row("You on over/unders", yo);
    if (model && yo.w + yo.l) html += row("Model on the totals you picked", modelOnYourTotals(season));
    if (model && miss != null) html += `<div class="row"><span class="t">Model's average miss on total points</span><span class="p">${miss.toFixed(1)} pts</span></div>`;
    html += `</div><p class="note">Like the spread, you need about 52.4% to break even.</p>`;
  }
  html += `<h2>You vs. the model</h2><div class="h2h">`;
  if (!(you.w + you.l)) html += `Make picks on the This Week tab. Once those games finish, you'll see how you stack up against the model here.`;
  else {
    const diff = you.w - model.w;
    html += `<div class="stats">${stat("You", `${rec(you)} (${pct(you)})`)}${stat("Model, same games", `${rec(model)} (${pct(model)})`)}</div>
      <div class="big">${diff > 0 ? `You're beating the model by ${diff} ${diff === 1 ? "game" : "games"}.` : diff < 0 ? `The model is ahead by ${-diff} ${diff === -1 ? "game" : "games"}.` : "You and the model are tied."}</div>`;
  }
  html += `</div><p class="note">Compared only on games you picked, so it's a fair fight.</p>`;
  html += weeklyChart(season);
  html += `<p class="note">${spread ? "50% is a coin flip. Because sportsbooks keep part of every bet, you'd need about 52.4% just to break even." : state.league === "mlb" ? "Baseball is hard to predict: picking 55–58% of winners is good, and Vegas favorites usually win about 58–60%." : ""}</p>`;
  const seasons = [...new Set(D().games.map((g) => g.season))].filter((s) => s >= D().history_from).sort((a, b) => b - a);
  html += `<h2>Model track record</h2><div class="table">`;
  for (const s of seasons) {
    const g = D().games.filter((x) => x.season === s), su = modelSU(g), at = modelATS(g), st = modelStrongATS(g);
    html += `<div class="row"><span class="t"><b>${s}</b></span><span class="r" style="text-align:right">Winners: ${rec(su)} (${pct(su)})${spread ? `<br>Vs spread: ${rec(at)} (${pct(at)})${st.w + st.l ? `<br>Highlighted: ${rec(st)} (${pct(st)})` : ""}` : ""}</span></div>`;
  }
  return html + `</div><p class="note">Each prediction used only games played before it, the same way predictions are made today.</p>`;
}

function renderRatings() {
  const note = {
    nfl: "Points better (+) or worse (−) than an average NFL team on a neutral field. To predict a game, subtract the two ratings and add 1.5 points for the home team.",
    college: "Points better (+) or worse (−) than an average top-division (FBS) team on a neutral field. To predict a game, subtract the two ratings and add 2.5 points for the home team.",
    nba: "Points better (+) or worse (−) than an average NBA team on a neutral court. To predict a game, subtract the two ratings and add 2.5 points for the home team.",
    mlb: "Runs better (+) or worse (−) than an average MLB team. To predict a game, subtract the two ratings and add 0.25 runs for the home team.",
  }[state.league];
  return `<h1>Power Ratings</h1><div class="table">${D().ranked.map(([t, r], i) =>
    `<div class="row"><span class="rank">${i + 1}</span><span class="t">${esc(fullName(t))}</span><span class="p ${r >= 0 ? "pos" : "neg"}">${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}</span></div>`).join("")}</div><p class="note">${note}</p>`;
}

function render() {
  document.querySelectorAll("[data-league]").forEach((b) => b.setAttribute("aria-selected", b.dataset.league === state.league));
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
  $("#tab-picks").hidden = !isAdmin();
  const main = $("#main"), d = D();
  if (!d) { main.innerHTML = `<div class="empty">Loading ${LEAGUES[state.league]} games…</div>`; return; }
  if (d.error) { main.innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
  let html = d.message ? `<div class="warn">${esc(d.message)}</div>` : "";
  if (state.tab === "picks" && !isAdmin()) state.tab = "week";
  html += { week: renderWeek, tickets: renderMyTickets, results: renderResults, scorecard: renderScorecard, ratings: renderRatings, picks: renderAllPicks }[state.tab]();
  main.innerHTML = html;
  const updated = new Date(d.updated);
  $("#updated").textContent = `${LEAGUES[state.league]} data updated ${updated.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.`;
}

// ---------- loading ----------
async function fetchJSON(url) {
  const r = await fetch(`${url}?t=${Math.floor(Date.now() / 60000)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function loadLeague(league) {
  if (state.data[league]) return;
  try {
    const d = await fetchJSON(`data/${league}.json`);
    d.raw = d.games;
    d.games = applyOverrides(d.raw);
    state.data[league] = d;
  } catch {
    state.data[league] = { error: `${LEAGUES[league]} games aren't available right now. Please try again later.` };
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.league) { state.league = b.dataset.league; state.week = null; state.allPicks = null; save("league", state.league); render(); loadLeague(state.league).then(() => { render(); loadMyTickets(); if (state.tab === "picks") loadAllPicks(); }); }
  else if (b.dataset.tab) { state.tab = b.dataset.tab; save("tab", state.tab); render(); window.scrollTo({ top: 0 }); if (state.tab === "picks") loadAllPicks(); }
  else if (b.dataset.pick) setPick("side", b.dataset.id, b.dataset.pick);
  else if (b.dataset.total) setPick("total", b.dataset.id, b.dataset.total);
  else if (b.id === "about-btn") $("#about").showModal();
  else if (b.id === "ticket-review") openReview();
  else if (b.id === "ticket-clear") { clearDraft(); render(); }
  else if (b.id === "review-place") placeTicket();
  else if (b.dataset.void) { if (b.dataset.armed) voidTicket(Number(b.dataset.void)); else { b.dataset.armed = "1"; b.textContent = "Tap again to void"; } }
  else if (b.dataset.adjust) openAdjust(b.dataset.adjust);
  else if (b.dataset.removeAdj) saveLine(b.dataset.removeAdj, null).then(renderAdminList);
  else if (b.id === "adj-save") submitAdjust(false);
  else if (b.id === "adj-vegas") submitAdjust(true);
  else if (b.id === "admin-signout") adminSignOut();
  else if (b.id === "deadline-save") {
    const v = $("#deadline").value;
    if (!v) $("#deadline-status").textContent = "Choose a date and time first.";
    else saveDeadline(new Date(v));
  }
  else if (b.id === "deadline-now-btn") saveDeadline(new Date());
  else if (b.id === "deadline-clear") saveDeadline(null);
  else if (b.id === "picks-refresh") loadAllPicks();
  else if (b.id === "picks-csv") downloadPicks();
});
document.addEventListener("change", (e) => {
  if (e.target.id === "week") { state.week = Number(e.target.value); render(); }
  if (e.target.id === "picks-week") { state.picksWeek = Number(e.target.value); render(); }
  if (e.target.id === "wager") {
    const v = Math.max(1, Math.min(MAX_WAGER, Math.round(Number(e.target.value) || 1)));
    save("wager", v); render();
  }
  if (e.target.id === "adj-fav") $("#adj-points-row").hidden = e.target.value === "pick";
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "review-form") { e.preventDefault(); placeTicket(); }
  if (e.target.id === "signin-form") { e.preventDefault(); adminSignIn(); }
});
window.addEventListener("hashchange", () => { if (location.hash === "#admin") openAdmin(); });

// ---------- database (Supabase) ----------
const CFG = window.GE_CONFIG || {};
const db = CFG.supabaseUrl && window.supabase ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;
let session = null, adminFlag = false;
const isAdmin = () => adminFlag;
const playerName = () => load("player_name", "");

async function refreshSession() {
  if (!db) return;
  const { data } = await db.auth.getSession();
  session = data.session;
  adminFlag = false;
  if (session && session.user.email) {
    const { data: rows } = await db.from("admins").select("email").limit(1);
    adminFlag = !!(rows && rows.length);
  }
}

async function loadShared() {
  if (!db) {
    try { state.overrides = await fetchJSON("lines.json"); } catch { state.overrides = {}; }
    try { state.settings = await fetchJSON("settings.json"); } catch { state.settings = {}; }
    return;
  }
  const [lines, settings] = await Promise.all([db.from("lines").select("game_id,spread,total"), db.from("settings").select("key,value")]);
  const o = {};
  for (const l of lines.data || []) o[l.game_id] = { spread: l.spread == null ? null : Number(l.spread), total: l.total == null ? null : Number(l.total) };
  state.overrides = o;
  const st = {};
  for (const x of settings.data || []) st[x.key] = x.value;
  state.settings = st;
  for (const d of Object.values(state.data)) if (d.raw) d.games = applyOverrides(d.raw);
}

// ---------- tickets ----------
/** Legs on the ticket being built, in kickoff order. */
function draftLegs() {
  const legs = [];
  for (const [kind, key] of [["side", "picks"], ["total", "totals"]]) {
    for (const [id, choice] of Object.entries(draft(key))) {
      const g = D().games.find((x) => x.id === id);
      if (g && !isLocked(g)) legs.push({ game_id: id, kind, choice, g });
    }
  }
  return legs.sort((a, b) => (a.g.kickoff || "").localeCompare(b.g.kickoff || ""));
}
const legLabel = (l, line) => l.kind === "side"
  ? `${shortName(team(l.g, l.choice))} ${lineFor({ ...l.g, spread: line ?? l.g.spread }, l.choice)}`
  : `${ouLabel(l.choice)} ${pts(line ?? l.g.total)} (${l.g.away} at ${l.g.home})`;

function ticketBar() {
  const legs = draftLegs(), n = legs.length, wager = load("wager", 5);
  const ready = n >= MIN_LEGS && n <= MAX_LEGS && !picksClosed();
  const toWin = ready ? PAYOUT[n] * wager : null;
  return `<div class="ticket-bar">
    <div class="tb-row"><b>Your ticket: ${n} ${n === 1 ? "pick" : "picks"}</b>
      <span class="r">${n < MIN_LEGS ? `Pick ${MIN_LEGS - n} more to place a ticket` : n > MAX_LEGS ? `Too many picks (max ${MAX_LEGS})` : `${n} for ${n} pays ${PAYOUT[n]} to 1`}</span></div>
    ${n ? `<div class="tb-legs">${legs.map((l) => `<span class="name-chip">${esc(legLabel(l))}</span>`).join("")}</div>` : ""}
    <div class="tb-row">
      <label class="tb-wager">Wager <input id="wager" type="number" inputmode="numeric" min="1" max="${MAX_WAGER}" step="1" value="${wager}"> ${COIN}</label>
      ${toWin != null ? `<span>To win <b>${coins(toWin)}</b></span>` : ""}
      <span class="spacer"></span>
      ${n ? '<button class="pick" id="ticket-clear">Clear</button>' : ""}
      <button class="pick primary" id="ticket-review" ${ready ? "" : "disabled"}>Review ticket</button>
    </div>
  </div>`;
}

function setPick(kind, id, value) {
  const g = D().games.find((x) => x.id === id);
  if (!g || isLocked(g)) return;
  const key = kind === "side" ? "picks" : "totals";
  const mine = draft(key);
  if (mine[id] === value) delete mine[id];
  else {
    if (!mine[id] && draftLegs().length >= MAX_LEGS) { toast(`A ticket can have at most ${MAX_LEGS} picks.`); return; }
    mine[id] = value;
  }
  save(`draft_${key}_${state.league}`, mine);
  render();
}

function clearDraft() {
  save(`draft_picks_${state.league}`, {});
  save(`draft_totals_${state.league}`, {});
}

// Placing a ticket: review, name (first time), then the database checks and records it.
function openReview() {
  const legs = draftLegs(), wager = Math.round(Number(load("wager", 5)));
  if (legs.length < MIN_LEGS || legs.length > MAX_LEGS) return;
  if (!(wager >= 1 && wager <= MAX_WAGER)) { toast(`Wager 1 to ${MAX_WAGER} ${COIN}.`); return; }
  $("#review-legs").innerHTML = legs.map((l) => `<li>${esc(legLabel(l))}<small> · ${esc(when(l.g))}</small></li>`).join("");
  $("#review-summary").innerHTML = `${legs.length} for ${legs.length} pays ${PAYOUT[legs.length]} to 1 · Wager <b>${coins(wager)}</b> · To win <b>${coins(PAYOUT[legs.length] * wager)}</b>`;
  $("#review-name").value = playerName();
  $("#review-status").textContent = "";
  $("#review").showModal();
}

async function placeTicket() {
  const legs = draftLegs(), wager = Math.round(Number(load("wager", 5)));
  const name = $("#review-name").value.trim().slice(0, 40);
  if (!name) { $("#review-status").textContent = "Enter a name for your ticket."; return; }
  save("player_name", name);
  if (!db) { $("#review-status").textContent = "Tickets aren't available right now."; return; }
  $("#review-place").disabled = true;
  $("#review-status").textContent = "Placing your ticket…";
  try {
    if (!session) {
      const { data, error } = await db.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    const { data, error } = await db.rpc("place_ticket", {
      p_name: name, p_league: state.league, p_wager: wager,
      p_picks: legs.map((l) => ({ game_id: l.game_id, kind: l.kind, choice: l.choice })),
    });
    if (error) throw error;
    clearDraft();
    $("#review").close();
    toast(`Ticket #${data} placed. Good luck!`);
    await loadMyTickets();
    render();
  } catch (err) {
    const msg = String(err && err.message || "");
    $("#review-status").textContent = /closed|started|no line|needs|Wager|Unknown/.test(msg)
      ? msg.replace(/^.*?:\s*/, "") : "Couldn't place your ticket. Check your connection and try again.";
  } finally {
    $("#review-place").disabled = false;
  }
}

/** Grades a ticket. Any losing pick loses it; a push drops that pick and pays the smaller ticket;
 *  fewer than 3 winners left returns the wager. */
function gradeTicket(t, legs, games) {
  let wins = 0, lost = false, pending = false;
  for (const l of legs) {
    const r = pickResult(games.get(l.game_id), l);
    if (r === false) lost = true;
    else if (r === true) wins++;
    else if (r === undefined) pending = true;
  }
  if (lost) return { status: "lost", net: -t.wager, label: "Lost" };
  if (pending) return { status: "pending", net: 0, label: "Pending" };
  if (wins < MIN_LEGS) return { status: "refund", net: 0, label: "Wager returned" };
  return { status: "won", net: PAYOUT[wins] * t.wager, label: `Won ${wins} for ${wins}` };
}

/** Loads the tickets placed from this device for the current league. */
async function loadMyTickets() {
  if (!db || !session) return;
  const league = state.league;
  const { data, error } = await db.from("tickets").select("number,name,league,wager,legs,placed_at,ticket_picks(game_id,matchup,kind,choice,line,kickoff)")
    .eq("league", league).eq("user_id", session.user.id).order("placed_at", { ascending: false });
  if (error) return;
  state.myTickets[league] = data;
  const side = {}, total = {};
  for (const t of data.slice().reverse()) for (const l of t.ticket_picks) (l.kind === "side" ? side : total)[l.game_id] = l.choice;
  state.myLegs[league] = { picks: side, totals: total };
  if (league === state.league) render();
}

function ticketCard(t, games, admin = false) {
  const legs = t.ticket_picks || [];
  const grade = gradeTicket(t, legs, games);
  const placed = new Date(t.placed_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `<article class="card ticket ${grade.status}">
    <div class="card-head"><span class="matchup">Ticket #${t.number}${admin ? ` · ${esc(t.name)}` : ""}</span><span class="when">Placed ${esc(placed)}</span></div>
    <ul class="legs">${legs.slice().sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || "")).map((l) => {
      const g = games.get(l.game_id), r = pickResult(g, l);
      const label = g ? legLabel({ ...l, g }, Number(l.line)) : `${l.matchup}: ${l.choice} ${l.line}`;
      return `<li class="${r === false ? "out" : r === true ? "won" : ""}">${r === false ? "✗" : r === true ? "✓" : r === null ? "–" : "•"} <span class="nm">${esc(label)}</span>${g && isFinal(g) ? `<small> · Final ${g.away_score}-${g.home_score}</small>` : ""}</li>`;
    }).join("")}</ul>
    <div class="tb-row"><span>Wager <b>${coins(t.wager)}</b> · ${t.legs} for ${t.legs} pays ${PAYOUT[t.legs]} to 1</span><span class="spacer"></span>
      <span class="status-pill ${grade.status}">${esc(grade.label)}${grade.status === "won" ? ` +${coins(grade.net)}` : grade.status === "lost" ? ` −${coins(t.wager)}` : ""}</span>
      ${admin ? `<button class="pick" data-void="${t.number}">Void</button>` : ""}</div>
  </article>`;
}

function renderMyTickets() {
  let html = `<h1>My Tickets</h1><p class="sub">Tickets placed from this device. A placed ticket can't be changed.</p>`;
  const list = state.myTickets[state.league];
  if (!list) return html + `<div class="empty">${session ? "Loading…" : "You haven't placed a ticket yet. Build one on This Week."}</div>`;
  if (!list.length) return html + `<div class="empty">No ${LEAGUES[state.league]} tickets yet. Build one on This Week.</div>`;
  const games = new Map(D().games.map((g) => [g.id, g]));
  let net = 0;
  for (const t of list) net += gradeTicket(t, t.ticket_picks || [], games).net;
  html += `<div class="summary">${stat("Tickets", String(list.length))}${stat("Net", `${net >= 0 ? "+" : "−"}${coins(Math.abs(net))}`)}</div>`;
  return html + `<div class="cards">${list.map((t) => ticketCard(t, games)).join("")}</div>`;
}

// ---------- administrator ----------
function openAdmin() {
  $("#admin-status").textContent = "";
  $("#admin-setup").hidden = isAdmin();
  $("#admin-connected").hidden = !isAdmin();
  if (isAdmin()) { renderAdminList(); renderDeadlineForm(); }
  $("#admin").showModal();
}

async function adminSignIn() {
  if (!db) { $("#admin-status").textContent = "The database isn't set up yet."; return; }
  const email = $("#admin-email").value.trim(), password = $("#admin-password").value;
  if (!email || !password) { $("#admin-status").textContent = "Enter your email and password."; return; }
  $("#admin-status").textContent = "Signing in…";
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) { $("#admin-status").textContent = "That email and password didn't work."; return; }
  await refreshSession();
  if (!isAdmin()) { $("#admin-status").textContent = "Signed in, but this account isn't the administrator."; return; }
  $("#admin-password").value = "";
  $("#admin-status").textContent = "";
  openAdmin();
  await loadMyTickets();
  render();
}

async function adminSignOut() {
  await db.auth.signOut();
  session = null; adminFlag = false;
  $("#admin").close();
  if (state.tab === "picks") state.tab = "week";
  render();
}

function renderAdminList() {
  const ids = Object.keys(state.overrides);
  const all = Object.values(state.data).flatMap((d) => d.raw || []);
  $("#admin-list").innerHTML = ids.length ? ids.map((id) => {
    const g = all.find((x) => x.id === id), o = state.overrides[id];
    const what = [o.spread != null ? `spread ${o.spread === 0 ? "pick'em" : o.spread > 0 ? `${g ? g.home : "home"} -${pts(o.spread)}` : `${g ? g.away : "away"} -${pts(-o.spread)}`}` : "", o.total != null ? `total ${pts(o.total)}` : ""].filter(Boolean).join(", ");
    return `<div class="row"><span class="t">${g ? `${esc(g.away)} at ${esc(g.home)}` : esc(id)}<br><span class="r">${esc(what)}</span></span><button class="pick" data-remove-adj="${esc(id)}">Undo</button></div>`;
  }).join("") : `<div class="row"><span class="t r">No adjusted lines right now.</span></div>`;
}

let adjusting = null;
function openAdjust(id) {
  const g = D().games.find((x) => x.id === id);
  if (!g) return;
  adjusting = g;
  const vs = g.adjusted ? g.vegas_spread : g.spread, vt = g.adjusted ? g.vegas_total : g.total;
  $("#adj-title").textContent = `${fullName(g.away)} at ${fullName(g.home)}`;
  $("#adj-fav").innerHTML = `<option value="away">${esc(g.away)} favored</option><option value="home">${esc(g.home)} favored</option><option value="pick">Pick'em</option>`;
  $("#adj-fav").value = g.spread == null ? "home" : g.spread > 0 ? "home" : g.spread < 0 ? "away" : "pick";
  $("#adj-points").value = g.spread ? pts(Math.abs(g.spread)) : "";
  $("#adj-points-row").hidden = $("#adj-fav").value === "pick";
  $("#adj-vegas-spread").textContent = `Vegas: ${vs == null ? "no line" : lineText({ ...g, spread: vs })}`;
  $("#adj-total-row").hidden = false;
  $("#adj-total").value = g.total != null ? pts(g.total) : "";
  $("#adj-vegas-total").textContent = `Vegas: ${vt == null ? "no line" : pts(vt)}`;
  $("#adj-status").textContent = "";
  $("#adjust").showModal();
}

async function submitAdjust(useVegas) {
  const g = adjusting;
  const vs = g.adjusted ? g.vegas_spread : g.spread, vt = g.adjusted ? g.vegas_total : g.total;
  let entry = null;
  if (!useVegas) {
    const fav = $("#adj-fav").value, p = parseFloat($("#adj-points").value);
    if (fav !== "pick" && !(p >= 0)) { $("#adj-status").textContent = "Enter the points, like 3.5."; return; }
    const spread = fav === "pick" ? 0 : fav === "home" ? Math.abs(p) : -Math.abs(p);
    entry = {};
    if (spread !== vs) entry.spread = spread;
    const t = parseFloat($("#adj-total").value);
    if (t > 0 && t !== vt) entry.total = t;
    if (!Object.keys(entry).length) entry = null;
  }
  $("#adj-status").textContent = "Saving…";
  if (await saveLine(g.id, entry)) $("#adjust").close();
}

async function saveLine(id, entry) {
  const setStatus = (t) => { ($("#adjust").open ? $("#adj-status") : $("#admin-status")).textContent = t; };
  const res = entry
    ? await db.from("lines").upsert({ game_id: id, spread: entry.spread ?? null, total: entry.total ?? null, updated_at: new Date().toISOString() })
    : await db.from("lines").delete().eq("game_id", id);
  if (res.error) { setStatus("Couldn't save. Check your connection and try again."); return false; }
  if (entry) state.overrides[id] = entry; else delete state.overrides[id];
  for (const d of Object.values(state.data)) if (d.raw) d.games = applyOverrides(d.raw);
  setStatus("");
  render();
  toast("Saved. Everyone sees the new line right away.");
  return true;
}

/** Sets (or with null, removes) the time when all picks close. */
async function saveDeadline(date) {
  const status = $("#deadline-status");
  status.textContent = "Saving…";
  const res = date
    ? await db.from("settings").upsert({ key: "picks_close", value: date.toISOString(), updated_at: new Date().toISOString() })
    : await db.from("settings").delete().eq("key", "picks_close");
  if (res.error) { status.textContent = "Couldn't save. Check your connection and try again."; return; }
  status.textContent = "";
  if (date) state.settings.picks_close = date.toISOString(); else delete state.settings.picks_close;
  renderDeadlineForm();
  render();
  toast(date ? "Deadline saved. It applies to everyone right away." : "Deadline removed.");
}

function renderDeadlineForm() {
  const d = picksDeadline();
  const pad = (n) => String(n).padStart(2, "0");
  $("#deadline").value = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
  $("#deadline-now").textContent = d
    ? `${picksClosed() ? "Picks closed" : "Picks close"} ${d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`
    : "No deadline. Each game locks when it starts.";
}

// ---------- All Tickets (administrator only) ----------
async function loadAllPicks() {
  if (!isAdmin()) return;
  state.allPicksStatus = "Loading tickets…";
  render();
  const league = state.league, rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("tickets").select("number,name,wager,legs,placed_at,ticket_picks(game_id,matchup,kind,choice,line,kickoff)")
      .eq("league", league).order("number", { ascending: true }).range(from, from + 999);
    if (error) { state.allPicksStatus = "Couldn't load tickets. Try again."; render(); return; }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  if (league !== state.league) return;
  state.allPicks = rows;
  state.allPicksStatus = "";
  render();
}

async function voidTicket(number) {
  const { error } = await db.from("tickets").delete().eq("number", number);
  if (error) { toast("Couldn't void the ticket. Try again."); return; }
  toast(`Ticket #${number} voided.`);
  loadAllPicks();
}

/** A ticket's week: the week of its first game. */
function ticketWeek(t, games) {
  const weeks = (t.ticket_picks || []).map((l) => games.get(l.game_id)?.week).filter((w) => w != null);
  return weeks.length ? Math.min(...weeks) : null;
}

function choiceLabel(g, p) {
  if (p.kind === "total") return `${ouLabel(p.choice)} ${p.line != null ? pts(Number(p.line)) : ""}`.trim();
  if (!g) return p.choice;
  const line = p.line == null ? "" : lineFor({ ...g, spread: Number(p.line) }, p.choice);
  return `${shortName(team(g, p.choice))} ${line}`.trim();
}

/** Whether a player's pick won (true), lost (false) or pushed (null), judged at the line they picked at. undefined until the game is final. */
function pickResult(g, p) {
  if (!g || !isFinal(g)) return undefined;
  const line = p.line == null ? null : Number(p.line);
  if (p.kind === "total") return totalWon(line == null ? g : { ...g, total: line }, p.choice);
  if (line != null) return spreadWon({ ...g, spread: line }, p.choice);
  const a = actualWinner(g);
  return a ? a === p.choice : null;
}
function renderAllPicks() {
  let html = `<h1>All Tickets</h1><p class="sub">Only you can see this page.</p>`;
  if (state.allPicksStatus) return html + `<div class="empty">${esc(state.allPicksStatus)}</div>`;
  if (!state.allPicks) return html + `<div class="empty">Loading tickets…</div>`;
  const games = new Map(D().games.map((g) => [g.id, g]));
  const all = state.allPicks;
  const weeks = [...new Set(all.map((t) => ticketWeek(t, games)).filter((w) => w != null))].sort((a, b) => b - a);
  if (!weeks.length) return html + `<div class="toolbar"><button class="pick" id="picks-refresh">Refresh</button></div><div class="empty">No ${LEAGUES[state.league]} tickets yet.</div>`;
  const w = weeks.includes(state.picksWeek) ? state.picksWeek : weeks[0];
  const tickets = all.filter((t) => ticketWeek(t, games) === w);
  const graded = tickets.map((t) => ({ t, grade: gradeTicket(t, t.ticket_picks || [], games) }));
  const wagered = tickets.reduce((a, t) => a + t.wager, 0);
  const paid = graded.filter((x) => x.grade.status === "won").reduce((a, x) => a + x.grade.net + x.t.wager, 0);
  const count = (st) => graded.filter((x) => x.grade.status === st).length;
  html += `<div class="toolbar"><label for="picks-week">Week:</label><select id="picks-week">${weeks.map((x) => `<option value="${x}" ${x === w ? "selected" : ""}>${esc(weekLabel(x))}</option>`).join("")}</select>
    <button class="pick" id="picks-refresh">Refresh</button><button class="pick" id="picks-csv">Download spreadsheet</button></div>
    <div class="summary">${stat("Tickets", String(tickets.length))}${stat("Won", String(count("won")))}${stat("Lost", String(count("lost")))}${stat("Pending", String(count("pending")))}${stat("Wagered", coins(wagered))}${stat("Paid out", coins(paid))}</div>`;
  const order = { won: 0, pending: 1, refund: 2, lost: 3 };
  graded.sort((a, b) => order[a.grade.status] - order[b.grade.status] || b.grade.net - a.grade.net || a.t.number - b.t.number);
  html += `<h2>Tickets</h2><div class="table standings"><div class="row head"><span class="t">Ticket</span><span class="c">Picks</span><span class="c">Wager</span><span class="c wide">Result</span></div>`
    + graded.map(({ t, grade }) => `<div class="row"><span class="t"><b>#${t.number}</b> ${esc(t.name)}</span><span class="c">${t.legs}</span><span class="c">${t.wager}</span>
      <span class="c wide status-pill ${grade.status}">${esc(grade.status === "won" ? `+${coins(grade.net)}` : grade.status === "lost" ? `−${coins(t.wager)}` : grade.label)}</span></div>`).join("") + `</div>`;
  html += `<h2>Every ticket</h2><div class="cards">${graded.map(({ t }) => ticketCard(t, games, true)).join("")}</div>`;
  return html + `<p class="note">A ✗ is a losing pick, which loses the whole ticket. A push drops that pick, and the ticket is paid at the smaller size; with fewer than ${MIN_LEGS} winning picks left, the wager is returned. Each pick is judged at the line when the ticket was placed. Void removes a ticket for good.</p>`;
}

function downloadPicks() {
  const games = new Map(D().games.map((g) => [g.id, g]));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [["Ticket #", "Name", "Placed", "Wager", "Picks", "Ticket result", "Net coins", "Game", "Pick", "Line", "Pick result"].map(q).join(",")];
  for (const t of state.allPicks || []) {
    const grade = gradeTicket(t, t.ticket_picks || [], games);
    for (const l of t.ticket_picks || []) {
      const g = games.get(l.game_id), r = pickResult(g, l);
      out.push([t.number, t.name, t.placed_at, t.wager, t.legs, grade.label, grade.net, l.matchup, choiceLabel(g, l), l.line, r === true ? "Won" : r === false ? "Lost" : r === null ? "Push" : ""].map(q).join(","));
    }
  }
  const url = URL.createObjectURL(new Blob([out.join("\n")], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `gridiron-edge-${state.league}-tickets.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 5000);
}

// ---------- start ----------
(async function start() {
  if (!LEAGUES[state.league]) state.league = "nfl";
  if (!["week", "tickets", "results", "scorecard", "ratings", "picks"].includes(state.tab)) state.tab = "week";
  render();
  try { await refreshSession(); } catch { /* the site still works without the database */ }
  await Promise.all([loadShared().catch(() => {}), loadLeague(state.league)]);
  render();
  loadMyTickets();
  if (state.tab === "picks") loadAllPicks();
  if (location.hash === "#admin") openAdmin();
  // Keep locks, the deadline and adjusted lines current while the page stays open.
  setInterval(async () => {
    if (document.querySelector("dialog[open]")) return;
    await loadShared().catch(() => {});
    render();
  }, 60000);
})();
