// Gridiron Edge website. Reads the data files the scheduled job writes (data/<league>.json)
// and the administrator's hand-set lines (lines.json). Your picks stay in this browser.
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
};

// ---------- storage (works even when the browser blocks it) ----------
function load(key, fallback) {
  try { const v = localStorage.getItem("ge_" + key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("ge_" + key, JSON.stringify(value)); } catch { /* private mode */ }
}
const picks = (kind) => load(`${kind}_${state.league}`, {});
function setPick(kind, id, value) {
  const all = picks(kind);
  if (all[id] === value) delete all[id]; else all[id] = value;
  save(`${kind}_${state.league}`, all);
  render();
}

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
const isLocked = (g) => isFinal(g) || (g.kickoff && new Date(g.kickoff) <= new Date());
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
    const c = { ...g, adjusted: true };
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
  const locked = isLocked(g), mine = picks("picks")[g.id], myTotal = picks("totals")[g.id];
  let stats = "";
  if (state.league === "mlb") {
    const mw = modelWinner(g);
    stats += stat("Model", `${shortName(team(g, mw))} ${Math.round(winChance(g, mw) * 100)}%`);
    const fav = vegasFavorite(g);
    if (fav) {
      const vc = fav === "home" ? g.home_win_chance : 1 - g.home_win_chance;
      stats += stat("Vegas favorite", `${shortName(team(g, fav))} ${Math.round(vc * 100)}%`);
      const lean = mlbLean(g);
      stats += stat("Model likes", `${shortName(team(g, lean.side))} +${Math.round(lean.gap * 100)} pts`, lean.gap >= MLB_HIGHLIGHT);
    } else stats += stat("Vegas", "No line yet");
  } else {
    if (pickMode() === "spread") stats += stat("Vegas line", lineText(g));
    stats += stat("Model", modelText(g));
    const p = modelSpreadPick(g), e = edge(g);
    if (p) stats += stat("Model likes", `${shortName(team(g, p))} ${lineFor(g, p)} (${e.toFixed(1)} pts)`, e >= SPREAD_HIGHLIGHT);
  }
  let totals = "";
  if (D().has_totals && g.total_prediction != null) {
    totals = `<div class="stats">${stat("Over/under", g.total != null ? pts(g.total) : "No line yet")}${stat("Model total", g.total_prediction.toFixed(1))}`;
    const tp = modelTotalPick(g), te = totalEdge(g);
    if (tp) totals += stat("Model likes", `${ouLabel(tp)} (${te.toFixed(1)} pts)`, te >= TOTAL_HIGHLIGHT);
    totals += "</div>";
    if (g.total != null) {
      totals += `<div class="picks"><span class="lbl">Your total:</span>${["over", "under"].map((s) =>
        `<button class="pick" data-total="${s}" data-id="${esc(g.id)}" aria-pressed="${myTotal === s}" ${locked ? "disabled" : ""}>${ouLabel(s)} ${pts(g.total)}</button>`).join("")}</div>`;
    }
  }
  const canPick = g.spread != null || pickMode() === "winner";
  const pickBtns = canPick ? `<div class="picks"><span class="lbl">Your pick:</span>${["away", "home"].map((s) =>
    `<button class="pick" data-pick="${s}" data-id="${esc(g.id)}" aria-pressed="${mine === s}" ${locked ? "disabled" : ""}>${esc(shortName(team(g, s)))}${pickMode() === "spread" ? " " + lineFor(g, s) : ""}</button>`).join("")}${locked ? '<span class="locked">🔒 Locked</span>' : ""}</div>` : "";
  return `<article class="card">
    <div class="card-head"><span class="matchup">${esc(fullName(g.away))} ${g.neutral ? "vs." : "at"} ${esc(fullName(g.home))}</span><span class="when">${esc(when(g))}</span></div>
    <div class="stats">${stats}</div>
    ${totals}
    ${g.adjusted ? '<span class="adjusted">✎ Adjusted line</span>' : ""}
    ${g.notes?.length ? `<ul class="notes">${g.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    ${pickBtns}
  </article>`;
}

function renderWeek() {
  const games = upcomingGames(), w = upcomingWeek();
  let html = `<h1>${w != null ? esc(weekLabel(w)) : "This Week"}</h1>`;
  if (!games.length) return html + `<div class="empty">No upcoming games right now.</div>`;
  html += `<div class="cards">${games.map(gameCard).join("")}</div>`;
  html += `<p class="note">${pickMode() === "spread" ? "Tap a team to pick it against the spread." : "Tap a team to pick the winner."} Picks lock when the game starts. Green marks a big disagreement with Vegas, not a sure thing.</p>`;
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
  if (D().has_totals) {
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
    if (D().has_totals && g.total != null) {
      const tv = [], mp = modelTotalPick(g), yp = myT[g.id];
      if (mp) tv.push(verdict(`Model: ${ouLabel(mp)}`, totalWon(g, mp)));
      if (yp) tv.push(verdict(`You: ${ouLabel(yp)}`, totalWon(g, yp)));
      t = tv.length ? `<div class="verdicts">${tv.join("")}</div>` : "";
    }
    const info = [g.spread != null ? `Line: ${lineText(g)}` : "", D().has_totals && g.total != null ? `Total ${actualTotal(g)} (O/U ${pts(g.total)})` : ""].filter(Boolean).join(" · ");
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
  if (D().has_totals) {
    const mo = modelOU(season), yo = yourOU(season), miss = totalMiss(season);
    html += `<h2>Over/under</h2><div class="table">${row("Model on over/unders", mo)}${row("Highlighted picks only (5+ pts off the total)", modelStrongOU(season), "indent")}${row("You on over/unders", yo)}`;
    if (yo.w + yo.l) html += row("Model on the totals you picked", modelOnYourTotals(season));
    if (miss != null) html += `<div class="row"><span class="t">Model's average miss on total points</span><span class="p">${miss.toFixed(1)} pts</span></div>`;
    html += `</div><p class="note">Like the spread, you need about 52.4% to break even. A typical NBA total misses by about 15 points either way.</p>`;
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
  const main = $("#main"), d = D();
  if (!d) { main.innerHTML = `<div class="empty">Loading ${LEAGUES[state.league]} games…</div>`; return; }
  if (d.error) { main.innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
  let html = d.message ? `<div class="warn">${esc(d.message)}</div>` : "";
  html += { week: renderWeek, results: renderResults, scorecard: renderScorecard, ratings: renderRatings }[state.tab]();
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
    d.games = applyOverrides(d.games);
    state.data[league] = d;
  } catch {
    state.data[league] = { error: `${LEAGUES[league]} games aren't available right now. Please try again later.` };
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.league) { state.league = b.dataset.league; state.week = null; save("league", state.league); render(); loadLeague(state.league).then(render); }
  else if (b.dataset.tab) { state.tab = b.dataset.tab; save("tab", state.tab); render(); window.scrollTo({ top: 0 }); }
  else if (b.dataset.pick) setPick("picks", b.dataset.id, b.dataset.pick);
  else if (b.dataset.total) setPick("totals", b.dataset.id, b.dataset.total);
  else if (b.id === "about-btn") $("#about").showModal();
});
document.addEventListener("change", (e) => { if (e.target.id === "week") { state.week = Number(e.target.value); render(); } });

(async function start() {
  if (!LEAGUES[state.league]) state.league = "nfl";
  if (!["week", "results", "scorecard", "ratings"].includes(state.tab)) state.tab = "week";
  render();
  try { state.overrides = await fetchJSON("lines.json"); } catch { state.overrides = {}; }
  await loadLeague(state.league);
  render();
})();
