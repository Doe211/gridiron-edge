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
  published: {},   // lines everyone sees (published by the administrator)
  drafts: {},      // the administrator's working lines (administrator only)
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

// Tickets: 3 to 12 picks with one wager. Pays by the chart below, in coins won per coin wagered.
// PAYOUT[picks][winning picks] = coins won per coin wagered. A 10-pick ticket also pays
// for 9 of 10 and for 0 of 10.
const PAYOUT = {
  3: { 3: 5 }, 4: { 4: 10 }, 5: { 5: 20 }, 6: { 6: 35 }, 7: { 7: 60 }, 8: { 8: 100 },
  9: { 9: 150 }, 10: { 10: 200, 9: 25, 0: 20 }, 11: { 11: 300 }, 12: { 12: 500 },
};
const fullPay = (n) => (PAYOUT[n] || {})[n];
/** "10 for 10 pays 200 for 1 (also 9 of 10 pays 25, 0 of 10 pays 20)" */
function payText(n) {
  const extras = Object.entries(PAYOUT[n] || {}).filter(([w]) => Number(w) !== n)
    .sort((a, b) => b[0] - a[0]).map(([w, x]) => `${w} of ${n} pays ${x}`);
  return `${n} for ${n} pays ${fullPay(n)} for 1${extras.length ? ` (also ${extras.join(", ")})` : ""}`;
}
const COIN = "⚾";
const MIN_LEGS = 3, MAX_LEGS = 12, MAX_WAGER = 100;
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
/** Players see only the lines the administrator published. The administrator sees their own
 *  working lines, with the live Vegas lines alongside. Vegas lines stay on vegas_spread/vegas_total. */
function applyOverrides(games) {
  const admin = isAdmin();
  return games.map((g) => {
    const pub = state.published[g.id] || null, dr = state.drafts[g.id] || null;
    const line = admin ? dr : pub;
    return { ...g, vegas_spread: g.spread, vegas_total: g.total, spread: line?.spread ?? null, total: line?.total ?? null, pub, draft: dr };
  });
}
const sameLine = (a, b) => (a?.spread ?? null) === (b?.spread ?? null) && (a?.total ?? null) === (b?.total ?? null);
/** Administrator: games whose working line differs from what players see. */
function unpublishedIds() {
  const ids = new Set([...Object.keys(state.drafts), ...Object.keys(state.published)]);
  return [...ids].filter((id) => !sameLine(state.drafts[id], state.published[id]));
}
const hasVegas = (g) => (g.vegas_spread !== undefined ? g.vegas_spread : g.spread) != null;
const scored = (games) => games.filter((g) => isFinal(g) && (state.league !== "college" || hasVegas(g)));
const seasonGames = () => D().games.filter((g) => g.season === D().current_season);
const pickMode = () => D().pick_mode;

function upcomingWeek() {
  const weeks = seasonGames().filter((g) => !isFinal(g) && (hasVegas(g) || state.league !== "college")).map((g) => g.week);
  return weeks.length ? Math.min(...weeks) : null;
}
function upcomingGames() {
  const w = upcomingWeek(); if (w == null) return [];
  return seasonGames().filter((g) => g.week === w && !isFinal(g) && (state.league !== "college" || hasVegas(g)))
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
  const teamBtn = (side) => `<button class="team-pick" data-pick="${side}" data-id="${esc(g.id)}" aria-pressed="${mine === side}" ${locked || g.spread == null ? "disabled" : ""}>
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
      ${isAdmin() ? lineStatus(g) : ""}
    </div>
    ${isAdmin() ? `<div class="vegas-ref">Live Vegas (only you see this): spread ${esc(g.vegas_spread != null ? lineText({ ...g, spread: g.vegas_spread }) : "none")} · O/U ${g.vegas_total != null ? pts(g.vegas_total) : "none"}</div>` : ""}
    ${g.total != null ? `<div class="picks"><span class="lbl">Total:</span>${ouBtn("over")}${ouBtn("under")}</div>` : ""}
    ${isAdmin() && !isFinal(g) ? `<div class="picks"><button class="admin-btn" data-adjust="${esc(g.id)}">✎ Set line</button></div>` : ""}
  </article>`;
}

function lineStatus(g) {
  if (sameLine(g.draft, g.pub)) return g.pub ? '<span class="line-status ok">✓ Published</span>' : "";
  return g.draft ? '<span class="line-status draft">✎ Not published yet</span>' : '<span class="line-status draft">✎ Removal not published yet</span>';
}
function publishBar() {
  const n = unpublishedIds().length;
  return `<div class="publish-bar ${n ? "pending" : ""}"><span>${n ? `${n} line change${n === 1 ? "" : "s"} not published yet. Players don't see ${n === 1 ? "it" : "them"} until you publish.` : "All your lines are published. Players see exactly what you see under Spread and Over/under."}</span>
    <span class="publish-actions">${vegasFillable().length ? `<button class="pick" id="fill-vegas">Fill all with Vegas</button>` : ""}<button class="pick primary" id="publish-lines" ${n ? "" : "disabled"}>Publish lines</button></span></div>`;
}
/** Administrator: this week's games that have no line of yours yet but do have a Vegas line. */
function vegasFillable() {
  return upcomingGames().filter((g) => !g.draft && !isFinal(g) && !(g.kickoff && new Date(g.kickoff) <= new Date())
    && (g.vegas_spread != null || g.vegas_total != null));
}
/** Copies the Vegas spread and over/under into every blank line slot at once (as drafts). Lines you set yourself are left alone. */
async function fillAllVegas() {
  const games = vegasFillable(), b = $("#fill-vegas");
  if (!games.length) { toast("Every game already has a line."); return; }
  if (b) b.disabled = true;
  const now = new Date().toISOString();
  const rows = games.map((g) => ({ game_id: g.id, spread: g.vegas_spread ?? null, total: g.vegas_total ?? null, updated_at: now }));
  const { error } = await db.from("lines").upsert(rows);
  if (error) { toast("Couldn't fill the lines. Check your connection and try again."); if (b) b.disabled = false; return; }
  for (const r of rows) state.drafts[r.game_id] = { spread: r.spread == null ? null : Number(r.spread), total: r.total == null ? null : Number(r.total) };
  for (const d of Object.values(state.data)) if (d.raw) d.games = applyOverrides(d.raw);
  render();
  toast(`Filled ${rows.length} game${rows.length === 1 ? "" : "s"} with Vegas lines. Change any you like, then press Publish lines.`);
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
  if (isAdmin()) html += publishBar();
  else if (!games.some((g) => g.spread != null || g.total != null)) html += `<div class="deadline">Lines aren't posted yet for these games. Check back soon.</div>`;
  html += `<p class="note">Build a ticket: tap ${MIN_LEGS} to ${MAX_LEGS} picks (teams against the spread and Over/Under totals), choose your wager, and place it. Every pick must win (a 10-pick ticket also pays for 9 of 10 or 0 of 10). Once placed, a ticket can't be changed.</p>`;
  html += `<div class="cards">${games.map(gameCard).join("")}</div>`;
  html += ticketBar();
  return html;
}


function renderResults() {
  const weeks = completedWeeks();
  if (!weeks.length) return `<h1>Results</h1><div class="empty">No finished games yet this season.</div>`;
  const w = weeks.includes(state.week) ? state.week : weeks[0];
  const games = seasonGames().filter((g) => g.week === w && isFinal(g) && (state.league !== "college" || hasVegas(g)))
    .sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
  let html = `<h1>${esc(weekLabel(w))} Results</h1>
    <div class="toolbar"><label for="week">Week:</label><select id="week">${weeks.map((x) => `<option value="${x}" ${x === w ? "selected" : ""}>${esc(weekLabel(x))}</option>`).join("")}</select></div>
    <div class="cards">`;
  for (const g of games) {
    const winner = actualWinner(g);
    const teamRow = (side) => `<div class="score-row${winner === side ? " win" : ""}"><span>${esc(fullName(team(g, side)))}</span><b>${side === "home" ? g.home_score : g.away_score}</b></div>`;
    const m = margin(g);
    let cover = "";
    if (g.spread != null) {
      cover = m === g.spread ? `Spread ${esc(lineText(g))}: push`
        : `Covered: <b>${esc(shortName(team(g, m > g.spread ? "home" : "away")))} ${esc(lineFor(g, m > g.spread ? "home" : "away"))}</b>`;
    }
    let ou = "";
    if (g.total != null) {
      const t = actualTotal(g);
      ou = t === g.total ? `Total ${t}: push on ${pts(g.total)}` : `Total ${t}: <b>${t > g.total ? "Over" : "Under"} ${pts(g.total)}</b>`;
    }
    html += `<article class="card result"><div class="card-head"><span class="when">${esc(when(g))}${g.neutral ? " · Neutral site" : ""}</span><span class="when">Final</span></div>
      <div class="scores">${teamRow("away")}${teamRow("home")}</div>
      ${cover || ou ? `<div class="lines">${cover ? `<span>${cover}</span>` : ""}${ou ? `<span>${ou}</span>` : ""}</div>` : ""}</article>`;
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
  document.body.classList.toggle("locked", !!state.locked);
  if (state.locked) { $("#main").innerHTML = lockedScreen(); $("#updated").textContent = ""; return; }
  document.querySelectorAll("[data-league]").forEach((b) => b.setAttribute("aria-selected", b.dataset.league === state.league));
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
  $("#tab-picks").hidden = !isAdmin();
  const main = $("#main"), d = D();
  if (!d) { main.innerHTML = `<div class="empty">Loading ${LEAGUES[state.league]} games…</div>`; return; }
  if (d.error) { main.innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
  let html = d.message ? `<div class="warn">${esc(d.message)}</div>` : "";
  if (state.tab === "picks" && !isAdmin()) state.tab = "week";
  html += { week: renderWeek, tickets: renderMyTickets, results: renderResults, boards: renderBoards, scorecard: renderScorecard, ratings: renderRatings, picks: renderAllPicks }[state.tab]();
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
  else if (b.dataset.tab) { state.tab = b.dataset.tab; save("tab", state.tab); render(); window.scrollTo({ top: 0 }); if (state.tab === "picks") loadAllPicks(); if (state.tab === "boards") loadBoards(); }
  else if (b.dataset.pick) setPick("side", b.dataset.id, b.dataset.pick);
  else if (b.dataset.total) setPick("total", b.dataset.id, b.dataset.total);
  else if (b.id === "about-btn") $("#about").showModal();
  else if (b.id === "ticket-review") openReview();
  else if (b.id === "ticket-clear") { clearDraft(); render(); }
  else if (b.id === "review-place") placeTicket();
  else if (b.dataset.void) { if (b.dataset.armed) voidTicket(Number(b.dataset.void)); else { b.dataset.armed = "1"; b.textContent = "Tap again to void"; } }
  else if (b.dataset.certify) {
    if (b.dataset.override && !b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to let it count"; }
    else { b.disabled = true; certifyTicket(Number(b.dataset.certify), true); }
  }
  else if (b.dataset.uncertify) { if (b.dataset.armed) { b.disabled = true; certifyTicket(Number(b.dataset.uncertify), false); } else { b.dataset.armed = "1"; b.textContent = "Tap again to undo"; } }
  else if (b.dataset.adjust) openAdjust(b.dataset.adjust);
  else if (b.dataset.removeAdj) saveLine(b.dataset.removeAdj, null).then(renderAdminList);
  else if (b.id === "adj-save") submitAdjust(false);
  else if (b.id === "adj-vegas") submitAdjust(true);
  else if (b.id === "adj-remove") { saveLine(adjusting.id, null).then((ok) => ok && $("#adjust").close()); }
  else if (b.id === "publish-lines") publishLines();
  else if (b.id === "fill-vegas") { if (b.dataset.armed) fillAllVegas(); else { b.dataset.armed = "1"; b.textContent = `Tap again to fill ${vegasFillable().length} blank line${vegasFillable().length === 1 ? "" : "s"}`; } }
  else if (b.id === "admin-signout") adminSignOut();
  else if (b.dataset.inviteCopy) copyInvite(b.dataset.inviteCopy);
  else if (b.dataset.inviteReset) { if (b.dataset.armed) resetInvite(Number(b.dataset.inviteReset)); else { b.dataset.armed = "1"; b.textContent = "Tap again: new link"; } }
  else if (b.dataset.inviteRemove) { if (b.dataset.armed) removeInvite(Number(b.dataset.inviteRemove)); else { b.dataset.armed = "1"; b.textContent = "Tap again to remove"; } }
  else if (b.id === "deadline-save") {
    const v = $("#deadline").value;
    if (!v) $("#deadline-status").textContent = "Choose a date and time first.";
    else saveDeadline(new Date(v));
  }
  else if (b.id === "deadline-now-btn") saveDeadline(new Date());
  else if (b.id === "deadline-clear") saveDeadline(null);
  else if (b.id === "picks-refresh") loadAllPicks();
  else if (b.id === "picks-csv") downloadPicks();
  else boardClick(b);
});
document.addEventListener("change", (e) => {
  if (e.target.id === "week") { state.week = Number(e.target.value); render(); }
  if (e.target.id === "picks-week") { state.picksWeek = Number(e.target.value); render(); }
  if (e.target.id === "wager") {
    const v = Math.max(1, Math.min(MAX_WAGER, Math.round(Number(e.target.value) || 1)));
    save("wager", v); render();
  }
  if (e.target.id === "nb-league") fillBoardGames();
  if (e.target.id === "nb-game") $("#nb-title").placeholder = boardGameTitle();
  if (e.target.id === "adj-fav") $("#adj-points-row").hidden = e.target.value === "pick" || e.target.value === "none";
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "review-form") { e.preventDefault(); placeTicket(); }
  if (e.target.id === "signin-form") { e.preventDefault(); adminSignIn(); }
  if (e.target.id === "invite-form") { e.preventDefault(); createInvite(); }
  if (e.target.id === "claim-form") { e.preventDefault(); claimSquare(); }
  if (e.target.id === "newboard-form") { e.preventDefault(); createBoard(); }
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
    state.published = {};
    try { state.settings = await fetchJSON("settings.json"); } catch { state.settings = {}; }
    return;
  }
  const toLines = (rows) => {
    const o = {};
    for (const l of rows || []) o[l.game_id] = { spread: l.spread == null ? null : Number(l.spread), total: l.total == null ? null : Number(l.total) };
    return o;
  };
  const [pub, settings, drafts] = await Promise.all([
    db.from("published_lines").select("game_id,spread,total"),
    db.from("settings").select("key,value"),
    isAdmin() ? db.from("lines").select("game_id,spread,total") : Promise.resolve({ data: [] }),
  ]);
  if (!pub.error) state.published = toLines(pub.data);
  if (!drafts.error) state.drafts = isAdmin() ? toLines(drafts.data) : {};
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
  const toWin = ready ? fullPay(n) * wager : null;
  return `<div class="ticket-bar">
    <div class="tb-row"><b>Your ticket: ${n} ${n === 1 ? "pick" : "picks"}</b>
      <span class="r">${n < MIN_LEGS ? `Pick ${MIN_LEGS - n} more to place a ticket` : n > MAX_LEGS ? `Too many picks (max ${MAX_LEGS})` : payText(n)}</span></div>
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
  $("#review-summary").innerHTML = `${payText(legs.length)} · Wager <b>${coins(wager)}</b> · To win <b>${coins(fullPay(legs.length) * wager)}</b>`;
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
    $("#review-status").textContent = /closed|started|no line|needs|Wager|Unknown|hour/.test(msg)
      ? msg.replace(/^.*?:\s*/, "") : "Couldn't place your ticket. Check your connection and try again.";
  } finally {
    $("#review-place").disabled = false;
  }
}

/** Grades a ticket using the payout chart. A push drops that pick and the ticket is graded
 *  as the smaller ticket; with fewer than 3 picks left and no losses, the wager is returned. */
function gradeTicket(t, legs, games) {
  if (t.voided_at) return { status: "void", net: 0, label: "Voided" };
  let wins = 0, losses = 0, pushes = 0, pending = 0;
  for (const l of legs) {
    const r = pickResult(games.get(l.game_id), l);
    if (r === false) losses++;
    else if (r === true) wins++;
    else if (r === null) pushes++;
    else pending++;
  }
  const row = PAYOUT[legs.length] || {};
  if (pending) {
    // Lost already if no line of the chart can still be reached.
    const reachable = Object.keys(row).some((w) => Number(w) >= wins && Number(w) <= wins + pending + pushes && legs.length - Number(w) >= losses);
    return losses && !reachable ? { status: "lost", net: -t.wager, label: "Lost" } : { status: "pending", net: 0, label: "Pending" };
  }
  const n = legs.length - pushes;
  if (n < MIN_LEGS) return losses ? { status: "lost", net: -t.wager, label: "Lost" } : { status: "refund", net: 0, label: "Wager returned" };
  const x = (PAYOUT[n] || {})[wins];
  if (x == null) return { status: "lost", net: -t.wager, label: "Lost" };
  return { status: "won", net: x * t.wager, label: `Won ${wins} of ${n}` };
}

/** Loads the tickets placed from this device for the current league. */
async function loadMyTickets() {
  if (!db || !session) return;
  const league = state.league;
  const { data, error } = await db.from("tickets").select("number,name,league,wager,legs,placed_at,certified_at,voided_at,ticket_picks(game_id,matchup,kind,choice,line,kickoff)")
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
    <div class="tb-row"><span>Wager <b>${coins(t.wager)}</b> · ${payText(t.legs)}</span><span class="spacer"></span>
      <span class="status-pill ${grade.status}">${esc(grade.label)}${grade.status === "won" ? ` +${coins(grade.net)}` : grade.status === "lost" ? ` −${coins(t.wager)}` : ""}</span>
      ${admin ? `<button class="pick" data-void="${t.number}">Void</button>` : ""}</div>
    ${certifyRow(t, legs, admin)}
  </article>`;
}

/** When a ticket must be certified by: one hour before its first game. */
function certifyBy(legs) {
  const k = legs.map((l) => l.kickoff).filter(Boolean).sort()[0];
  return k ? new Date(new Date(k).getTime() - 60 * 60 * 1000) : null;
}
function certifyRow(t, legs, admin) {
  const by = certifyBy(legs), open = !by || by > new Date();
  const byText = by ? by.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  if (t.voided_at) {
    return `<div class="tb-row certify pending"><span>✕ Voided: not certified an hour before the first game.</span><span class="spacer"></span>${admin ? `<button class="pick primary" data-certify="${t.number}" data-override="1">Override void</button>` : ""}</div>`;
  }
  if (t.certified_at) {
    return `<div class="tb-row certify ok"><span>✓ Certified</span><span class="spacer"></span>${admin && open ? `<button class="pick" data-uncertify="${t.number}">Undo certify</button>` : ""}</div>`;
  }
  return `<div class="tb-row certify pending"><span>⚠ Not certified yet. ${by ? `Must be certified by ${esc(byText)} or it's voided.` : ""}</span><span class="spacer"></span>${admin ? `<button class="pick primary" data-certify="${t.number}">Certify</button>` : ""}</div>`;
}
async function certifyTicket(number, certified) {
  const { error } = await db.rpc("certify_ticket", { p_number: number, p_certified: certified });
  if (error) { toast(/late/i.test(error.message || "") ? "Too late to undo: the certify deadline has passed." : "Couldn't update the ticket. Try again."); return; }
  toast(certified ? `Ticket #${number} certified. It counts.` : `Ticket #${number} is no longer certified.`);
  loadAllPicks();
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
  if (isAdmin()) { renderAdminList(); renderDeadlineForm(); $("#invite-status").textContent = ""; loadInvites(); }
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
  if (state.locked) { await bootApp(); openAdmin(); return; }
  await loadShared().catch(() => {});
  openAdmin();
  await loadMyTickets();
  render();
}

async function adminSignOut() {
  await db.auth.signOut();
  location.reload();
}

function renderAdminList() {
  const ids = [...new Set([...Object.keys(state.drafts), ...Object.keys(state.published)])];
  const all = Object.values(state.data).flatMap((d) => d.raw || []);
  const describe = (g, o) => !o ? "no line" : [o.spread != null ? `spread ${o.spread === 0 ? "pick'em" : o.spread > 0 ? `${g ? g.home : "home"} -${pts(o.spread)}` : `${g ? g.away : "away"} -${pts(-o.spread)}`}` : "", o.total != null ? `O/U ${pts(o.total)}` : ""].filter(Boolean).join(", ");
  $("#admin-list").innerHTML = ids.length ? ids.map((id) => {
    const g = all.find((x) => x.id === id), d = state.drafts[id], p = state.published[id];
    const status = sameLine(d, p) ? "published" : `not published (players see: ${describe(g, p)})`;
    return `<div class="row"><span class="t">${g ? `${esc(g.away)} at ${esc(g.home)}` : esc(id)}<br><span class="r">${esc(describe(g, d))} · ${esc(status)}</span></span>${d ? `<button class="pick" data-remove-adj="${esc(id)}">Remove</button>` : ""}</div>`;
  }).join("") : `<div class="row"><span class="t r">No lines yet. Use ✎ Set line on a game.</span></div>`;
}

let adjusting = null;
function openAdjust(id) {
  const g = D().games.find((x) => x.id === id);
  if (!g) return;
  adjusting = g;
  $("#adj-title").textContent = `${fullName(g.away)} at ${fullName(g.home)}`;
  $("#adj-fav").innerHTML = `<option value="none">No spread</option><option value="away">${esc(g.away)} favored</option><option value="home">${esc(g.home)} favored</option><option value="pick">Pick'em</option>`;
  fillAdjust(g.spread, g.total);
  $("#adj-vegas-spread").textContent = `Live Vegas: ${g.vegas_spread == null ? "no line" : lineText({ ...g, spread: g.vegas_spread })}`;
  $("#adj-total-row").hidden = false;
  $("#adj-vegas-total").textContent = `Live Vegas: ${g.vegas_total == null ? "no line" : pts(g.vegas_total)}`;
  $("#adj-status").textContent = "";
  $("#adj-remove").hidden = !g.draft;
  $("#adjust").showModal();
}
function fillAdjust(spread, total) {
  $("#adj-fav").value = spread == null ? "none" : spread > 0 ? "home" : spread < 0 ? "away" : "pick";
  $("#adj-points").value = spread ? pts(Math.abs(spread)) : "";
  $("#adj-points-row").hidden = $("#adj-fav").value === "pick" || $("#adj-fav").value === "none";
  $("#adj-total").value = total != null ? pts(total) : "";
}

async function submitAdjust(useVegas) {
  const g = adjusting;
  if (useVegas) { fillAdjust(g.vegas_spread, g.vegas_total); $("#adj-status").textContent = "Vegas lines filled in. Change them if you like, then Save."; return; }
  const fav = $("#adj-fav").value, p = parseFloat($("#adj-points").value);
  let spread = null;
  if (fav === "pick") spread = 0;
  else if (fav !== "none") {
    if (!(p >= 0)) { $("#adj-status").textContent = "Enter the points, like 3.5."; return; }
    spread = fav === "home" ? Math.abs(p) : -Math.abs(p);
  }
  const tv = $("#adj-total").value.trim(), t = parseFloat(tv);
  if (tv && !(t > 0)) { $("#adj-status").textContent = "Enter the over/under, like 45.5, or leave it blank."; return; }
  const total = tv ? t : null;
  $("#adj-status").textContent = "Saving…";
  if (await saveLine(g.id, spread == null && total == null ? null : { spread, total })) $("#adjust").close();
}

async function saveLine(id, entry) {
  const setStatus = (t) => { ($("#adjust").open ? $("#adj-status") : $("#admin-status")).textContent = t; };
  const res = entry
    ? await db.from("lines").upsert({ game_id: id, spread: entry.spread, total: entry.total, updated_at: new Date().toISOString() })
    : await db.from("lines").delete().eq("game_id", id);
  if (res.error) { setStatus("Couldn't save. Check your connection and try again."); return false; }
  if (entry) state.drafts[id] = entry; else delete state.drafts[id];
  for (const d of Object.values(state.data)) if (d.raw) d.games = applyOverrides(d.raw);
  setStatus("");
  render();
  if ($("#admin").open) renderAdminList();
  toast("Saved. Players won't see it until you press Publish lines.");
  return true;
}

async function publishLines() {
  const b = $("#publish-lines");
  if (b) b.disabled = true;
  const { error } = await db.rpc("publish_lines");
  if (error) { toast("Couldn't publish. Check your connection and try again."); if (b) b.disabled = false; return; }
  await loadShared();
  render();
  toast("Published. Everyone sees your lines now.");
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
    const { data, error } = await db.from("tickets").select("number,name,wager,legs,placed_at,certified_at,voided_at,ticket_picks(game_id,matchup,kind,choice,line,kickoff)")
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
  const wagered = tickets.filter((t) => !t.voided_at).reduce((a, t) => a + t.wager, 0);
  const paid = graded.filter((x) => x.grade.status === "won").reduce((a, x) => a + x.grade.net + x.t.wager, 0);
  const count = (st) => graded.filter((x) => x.grade.status === st).length;
  html += `<div class="toolbar"><label for="picks-week">Week:</label><select id="picks-week">${weeks.map((x) => `<option value="${x}" ${x === w ? "selected" : ""}>${esc(weekLabel(x))}</option>`).join("")}</select>
    <button class="pick" id="picks-refresh">Refresh</button><button class="pick" id="picks-csv">Download spreadsheet</button></div>
    ${(() => { const n = tickets.filter((t) => !t.certified_at && !t.voided_at).length; return n ? `<div class="publish-bar pending"><span>${n} ticket${n === 1 ? "" : "s"} not certified yet. Press Certify on each one at least an hour before its first game, or it's voided automatically.</span></div>` : ""; })()}
    <div class="summary">${stat("Tickets", String(tickets.length))}${stat("Won", String(count("won")))}${stat("Lost", String(count("lost")))}${stat("Pending", String(count("pending")))}${count("void") ? stat("Voided", String(count("void"))) : ""}${stat("Wagered", coins(wagered))}${stat("Paid out", coins(paid))}</div>`;
  const order = { won: 0, pending: 1, refund: 2, lost: 3, void: 4 };
  graded.sort((a, b) => order[a.grade.status] - order[b.grade.status] || b.grade.net - a.grade.net || a.t.number - b.t.number);
  html += `<h2>Tickets</h2><div class="table standings"><div class="row head"><span class="t">Ticket</span><span class="c">Picks</span><span class="c">Wager</span><span class="c wide">Result</span></div>`
    + graded.map(({ t, grade }) => `<div class="row"><span class="t"><b>#${t.number}</b> ${esc(t.name)}</span><span class="c">${t.legs}</span><span class="c">${t.wager}</span>
      <span class="c wide status-pill ${grade.status}">${esc(grade.status === "won" ? `+${coins(grade.net)}` : grade.status === "lost" ? `−${coins(t.wager)}` : grade.label)}</span></div>`).join("") + `</div>`;
  html += `<h2>Every ticket</h2><div class="cards">${graded.map(({ t }) => ticketCard(t, games, true)).join("")}</div>`;
  return html + `<p class="note">A ✗ is a losing pick. Any loss loses the ticket, except that a 10-pick ticket still pays for 9 of 10 or 0 of 10. A push drops that pick, and the ticket is paid at the smaller size; with fewer than ${MIN_LEGS} winning picks left, the wager is returned. Each pick is judged at the line when the ticket was placed. Void removes a ticket for good. A ticket that isn't certified an hour before its first game is voided automatically; press Override void to let it count anyway.</p>`;
}

function downloadPicks() {
  const games = new Map(D().games.map((g) => [g.id, g]));
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const out = [["Ticket #", "Name", "Placed", "Wager", "Picks", "Ticket result", "Net baseballs", "Game", "Pick", "Line", "Pick result"].map(q).join(",")];
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
  if (!["week", "tickets", "results", "boards", "picks"].includes(state.tab)) state.tab = "week";
  render();
  try { await refreshSession(); } catch { /* the site still works without the database */ }
  await handleInviteLink();
  if (!(await checkMember())) {
    state.locked = true;
    render();
    if (location.hash === "#admin") openAdmin();
    return;
  }
  await bootApp();
})();

/** Loads the game (after the device is known to be invited, or the administrator). */
async function bootApp() {
  state.locked = false;
  await Promise.all([loadShared().catch(() => {}), loadLeague(state.league)]);
  render();
  loadMyTickets();
  if (state.tab === "picks") loadAllPicks();
  if (state.tab === "boards") loadBoards();
  if (location.hash === "#admin") openAdmin();
  // Keep locks, the deadline and adjusted lines current while the page stays open.
  setInterval(async () => {
    if (document.querySelector("dialog[open]")) return;
    await loadShared().catch(() => {});
    if (state.tab === "boards") await loadBoards(true);
    render();
  }, 60000);
}

// ---------- invite only ----------
const inviteLink = (code) => `${location.origin}${location.pathname}#invite=${code}`;

/** Opening a personal link (#invite=CODE) claims it for this device. */
async function handleInviteLink() {
  const m = location.hash.match(/invite=([A-Za-z0-9]+)/);
  if (!m || !db) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (isAdmin()) { state.inviteMessage = "You're signed in as the administrator, so this link wasn't used. Send it to the player to open on their device."; return; }
  try {
    if (!session) {
      const { data, error } = await db.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    const { data, error } = await db.rpc("claim_invite", { p_code: m[1] });
    if (error) throw error;
    if (data && !playerName()) save("player_name", data);
    state.inviteMessage = `Welcome${data ? `, ${data}` : ""}! This device now has access.`;
  } catch (err) {
    const msg = String(err && err.message || "");
    state.inviteMessage = /Invite:/.test(msg) ? msg.replace(/^.*?Invite:\s*/, "") : "Couldn't open your invite. Check your connection and open the link again.";
  }
}

async function checkMember() {
  if (!db) return true;
  if (isAdmin()) return true;
  if (!session) return false;
  const { data, error } = await db.rpc("am_member");
  return !error && data === true;
}

function lockedScreen() {
  return `<div class="locked-screen">
    <div class="lock-icon">🔒</div>
    <h1>Invite only</h1>
    ${state.inviteMessage ? `<p class="warn">${esc(state.inviteMessage)}</p>` : ""}
    <p>Gridiron Edge is private. To play, open the personal link the administrator sent you, on the device you'll play on.</p>
    <p class="note">Each link works on one device only. If you got a new phone or cleared your browser, ask the administrator for a new link.</p>
    <p class="note"><a href="#admin">Administrator sign in</a></p>
  </div>`;
}

let invites = [];
async function loadInvites() {
  const { data, error } = await db.from("invites").select("id,name,code,claimed_at,created_at").order("created_at", { ascending: true });
  if (error) { $("#invite-status").textContent = "Couldn't load invites."; return; }
  invites = data; renderInvites();
}
function renderInvites() {
  const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("#invite-list").innerHTML = invites.length ? invites.map((v) => `<div class="row invite-row">
    <span class="t"><b>${esc(v.name)}</b><br><span class="r">${v.claimed_at ? `✓ In use on a device since ${esc(when(v.claimed_at))}` : "Link not opened yet"}</span>
    ${v.claimed_at ? "" : `<input class="invite-link" readonly value="${esc(inviteLink(v.code))}">`}</span>
    <span class="invite-btns">${v.claimed_at ? "" : `<button class="pick primary" data-invite-copy="${esc(v.code)}">Copy link</button>`}
    <button class="pick" data-invite-reset="${v.id}">Reset</button><button class="pick danger" data-invite-remove="${v.id}">Remove</button></span></div>`).join("")
    : `<div class="row"><span class="t r">No invites yet. Type a name above and press Create link.</span></div>`;
}
async function createInvite() {
  const name = $("#invite-name").value.trim();
  if (!name) { $("#invite-status").textContent = "Type the person's name first."; return; }
  $("#invite-status").textContent = "Creating…";
  const { data, error } = await db.from("invites").insert({ name }).select("id,name,code,claimed_at,created_at").single();
  if (error) { $("#invite-status").textContent = "Couldn't create the link. Try again."; return; }
  $("#invite-name").value = "";
  invites.push(data); renderInvites();
  await copyInvite(data.code, `Link for ${name} created and copied. Send it to them.`);
}
async function copyInvite(code, done = "Link copied. Paste it into a text or email.") {
  try { await navigator.clipboard.writeText(inviteLink(code)); $("#invite-status").textContent = done; }
  catch { $("#invite-status").textContent = "Copy the link from the box under the name."; }
}
async function resetInvite(id) {
  const { data, error } = await db.rpc("reset_invite", { p_id: id });
  if (error) { $("#invite-status").textContent = "Couldn't reset. Try again."; return; }
  await loadInvites();
  await copyInvite(data, "New link created and copied. The old link and device no longer work.");
}
async function removeInvite(id) {
  const { error } = await db.from("invites").delete().eq("id", id);
  if (error) { $("#invite-status").textContent = "Couldn't remove. Try again."; return; }
  $("#invite-status").textContent = "Removed. That device no longer has access.";
  loadInvites();
}
