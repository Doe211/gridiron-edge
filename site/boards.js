// ---------- Boards: Football Squares ----------
// Uses helpers from app.js ($, esc, db, session, isAdmin, toast, coins, COIN, state, load, save, loadLeague, render).

const BOARD_LEAGUES = { nfl: "NFL", college: "College", nba: "NBA" };
const QUARTERS = ["Q1", "Q2", "Q3", "Final"];

state.boards = null;          // list of boards
state.boardsStatus = "";
state.board = null;           // id of the board being viewed
state.squares = {};           // board id -> Map(square -> row)

async function ensureSession() {
  if (session) return session;
  const { data, error } = await db.auth.signInAnonymously();
  if (error) throw error;
  session = data.session;
  return session;
}

async function loadBoards(quiet = false) {
  if (!db) { state.boardsStatus = "Boards aren't available right now."; render(); return; }
  const { data, error } = await db.from("boards").select("*").order("kickoff", { ascending: true });
  if (error) { if (!quiet) { state.boardsStatus = "Couldn't load the boards. Check your connection."; render(); } return; }
  state.boardsStatus = "";
  state.boards = data;
  const { data: sq } = await db.from("board_squares").select("board_id,square,name,user_id,player_no").in("board_id", data.map((b) => b.id));
  state.squares = {};
  for (const b of data) state.squares[b.id] = new Map();
  for (const r of sq || []) state.squares[r.board_id]?.set(r.square, r);
  if (state.board && !data.some((b) => b.id === state.board)) state.board = null;
  render();
}

const playerTag = (row) => (row ? `${row.name}${row.player_no ? " #" + row.player_no : ""}` : "");
const boardById = (id) => (state.boards || []).find((b) => b.id === id);
const taken = (b) => (state.squares[b.id] || new Map()).size;
// The first 80 squares taken fill the pot. Squares 81-100 are the administrator's 20, sold for themselves.
const POT_SQUARES = 80, ADMIN_SQUARES = 20;
const potSquares = (b) => Math.min(taken(b), POT_SQUARES);
const adminSold = (b) => Math.max(0, taken(b) - POT_SQUARES);
const pot = (b) => b.price * potSquares(b);
function prizeFor(b, q) {
  if (b.prizes) return b.prizes[q];
  const p = pot(b), each = Math.floor(p / 4);
  return q === 3 ? p - each * 3 : each;
}
const boardClosed = (b) => !!b.top_digits || (b.kickoff && new Date(b.kickoff) <= new Date());

function winnerSquare(b, score) {
  if (!b.top_digits || !score) return null;
  const col = b.top_digits.indexOf(score[0] % 10), row = b.side_digits.indexOf(score[1] % 10);
  return row * 10 + col;
}

// ---- rendering ----
function renderBoards() {
  const admin = isAdmin();
  if (state.board && boardById(state.board)) return renderBoard(boardById(state.board));
  let html = `<div class="boards-head"><h1>Boards</h1>${admin ? `<button class="plus" id="board-new" aria-label="New board" title="New board">+</button>` : ""}</div>`;
  if (state.boardsStatus) return html + `<div class="empty">${esc(state.boardsStatus)}</div>`;
  if (!state.boards) return html + `<div class="empty">Loading boards…</div>`;
  if (!state.boards.length) return html + `<div class="empty">No boards yet.${admin ? " Press + to make one." : ""}</div>`;
  return html + `<div class="board-list">${state.boards.map((b) => {
    const n = taken(b);
    const status = b.scores?.final ? "Final" : boardClosed(b) ? (b.top_digits ? "Numbers drawn" : "Closed") : `${100 - n} squares open`;
    return `<button class="board-tile" data-board="${b.id}">
      <span class="bt-title">${esc(b.title)}</span>
      <span class="bt-sub">${esc(BOARD_LEAGUES[b.league] || "")} · ${esc(b.team2)} at ${esc(b.team1)}${b.kickoff ? " · " + esc(new Date(b.kickoff).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : ""}</span>
      <span class="bt-meta">${coins(b.price)} a square · Pot ${coins(pot(b))} · ${esc(status)}</span></button>`;
  }).join("")}</div><p class="note">Tap a board to open it.</p>`;
}

function renderBoard(b) {
  const admin = isAdmin(), sq = state.squares[b.id] || new Map(), sc = b.scores;
  const me = session?.user?.id;
  const winners = new Map();   // square -> list of quarter labels
  const quarterRows = QUARTERS.map((label, q) => {
    const score = sc?.quarters?.[q] || null, w = winnerSquare(b, score);
    if (w != null) winners.set(w, [...(winners.get(w) || []), label]);
    const who = w == null ? "" : playerTag(sq.get(w)) || "Open square";
    return { label, score, w, who, prize: prizeFor(b, q) };
  });
  const digit = (arr, i) => (arr ? arr[i] : "");
  let html = `<div class="toolbar"><button class="pick" id="board-back">← All boards</button>
    ${admin && !b.top_digits ? `<button class="pick primary" id="board-draw" data-id="${b.id}">Draw numbers</button>` : ""}
    ${admin ? `<button class="pick danger" id="board-delete" data-id="${b.id}">Delete board</button>` : ""}</div>`;
  html += `<section class="sq">
    <div class="sq-top">
      <div class="sq-brand"><div class="sq-title">${esc(b.title)}</div><div class="sq-kind">FOOTBALL SQUARES</div>
        <div class="sq-money"><span>PRICE PER SQUARE</span><b>${coins(b.price)}</b><span>TOTAL POT</span><b>${coins(pot(b))} <small>(${potSquares(b)} of ${POT_SQUARES})</small></b></div>
        ${admin && adminSold(b) ? `<div class="sq-admin">Admin squares sold: ${adminSold(b)} of ${ADMIN_SQUARES}</div>` : ""}
        ${sc?.live ? `<div class="sq-live">LIVE · ${esc(b.team1)} ${sc.now[0]}, ${esc(b.team2)} ${sc.now[1]} · ${esc(sc.clock)}</div>` : ""}</div>
      <div class="sq-table">
        <span></span>${QUARTERS.map((q) => `<span class="sq-qh">${q}</span>`).join("")}
        <span class="sq-rh">SCORE</span>${quarterRows.map((r) => `<span class="sq-cell">${r.score ? `<i>${r.score[0]}</i><i>${r.score[1]}</i>` : `<i></i><i></i>`}</span>`).join("")}
        <span class="sq-rh">PRIZE</span>${quarterRows.map((r) => `<span class="sq-cell">${coins(r.prize)}</span>`).join("")}
        <span class="sq-rh">WINNER</span>${quarterRows.map((r) => `<span class="sq-cell win">${r.w == null ? "" : `Sq ${r.w + 1}: ${esc(r.who)}`}</span>`).join("")}
      </div>
    </div>
    <div class="sq-team1"><span>TEAM 1</span><b>${esc(b.team1)}</b></div>
    <div class="sq-body">
      <div class="sq-team2"><b>${esc(b.team2)}</b><span>TEAM 2</span></div>
      <div class="sq-scroll"><div class="sq-grid">
        <span class="sq-corner"></span>${[...Array(10)].map((_, c) => `<span class="sq-dh">${digit(b.top_digits, c)}</span>`).join("")}
        ${[...Array(10)].map((_, r) => `<span class="sq-dh side">${digit(b.side_digits, r)}</span>` + [...Array(10)].map((_, c) => {
          const i = r * 10 + c, row = sq.get(i), wins = winners.get(i);
          const cls = ["sq-sq", row ? "taken" : "open", row && row.user_id === me ? "mine" : "", wins ? "winner" : ""].join(" ");
          const canAct = (!row && !boardClosed(b)) || (row && admin && !b.top_digits);
          return `<button class="${cls}" ${canAct ? `data-square="${i}"` : "disabled"} title="${row ? esc(playerTag(row)) : `Square ${i + 1}`}">
            ${wins ? `<em>${wins.join(" ")}</em>` : ""}<span class="nm">${row ? esc(row.name) : ""}${row?.player_no ? `<b class="pn">#${row.player_no}</b>` : ""}</span><small>${i + 1}</small></button>`;
        }).join("")).join("")}
      </div></div>
    </div>
  </section>`;
  const open = 100 - sq.size;
  html += `<p class="note">${boardClosed(b)
    ? (b.top_digits ? "The numbers are drawn, so this board is locked." : "The game has started, so this board is closed.")
    : `Tap an open square to put your name on it. ${open} of 100 squares are open.`}
    Each quarter, the winning square is where the last digit of the ${esc(b.team1)} score (top) meets the last digit of the ${esc(b.team2)} score (side).
    ${admin ? `The pot is the first ${POT_SQUARES} squares taken; the last ${ADMIN_SQUARES} are yours and don't add to it. ` : ""}${b.prizes ? "" : "The pot is split evenly across the four prizes."} Scores fill in automatically during the game, about a minute behind.
    ${admin && !b.top_digits ? " As administrator, tap a taken square to clear it, and press Draw numbers when the board is ready. Drawing locks the board." : ""}</p>`;
  return html;
}

// ---- actions ----
let claiming = null;
function boardClick(b) {
  if (b.dataset.board) { state.board = Number(b.dataset.board); render(); window.scrollTo({ top: 0 }); }
  else if (b.id === "board-back") { state.board = null; render(); }
  else if (b.id === "board-new") openNewBoard();
  else if (b.id === "board-draw") { if (b.dataset.armed) drawNumbers(Number(b.dataset.id)); else { b.dataset.armed = "1"; b.textContent = "Tap again to draw (locks the board)"; } }
  else if (b.id === "board-delete") { if (b.dataset.armed) deleteBoard(Number(b.dataset.id)); else { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; } }
  else if (b.dataset.square) {
    const bd = boardById(state.board), i = Number(b.dataset.square), row = state.squares[bd.id]?.get(i);
    if (row) { if (b.dataset.armed) clearSquare(bd.id, i); else { b.dataset.armed = "1"; b.querySelector(".nm").textContent = "Tap to clear"; } return; }
    claiming = { board: bd.id, square: i };
    $("#claim-title").textContent = `Square ${i + 1} on ${bd.title}`;
    $("#claim-name").value = playerName();
    $("#claim-status").textContent = "";
    $("#claim").showModal();
  }
}

async function claimSquare() {
  const name = $("#claim-name").value.trim().slice(0, 40);
  if (!name) { $("#claim-status").textContent = "Enter your name."; return; }
  save("player_name", name);
  $("#claim-save").disabled = true;
  $("#claim-status").textContent = "Saving…";
  try {
    await ensureSession();
    const { data, error } = await db.rpc("claim_square", { p_board: claiming.board, p_square: claiming.square, p_name: name });
    if (error) throw error;
    $("#claim").close();
    toast(`Square ${claiming.square + 1} is yours, ${name} #${data}.`);
  } catch (err) {
    const msg = String(err?.message || "");
    $("#claim-status").textContent = /already|closed|drawn|started|exists/.test(msg) ? msg : "Couldn't save your square. Check your connection and try again.";
  } finally {
    $("#claim-save").disabled = false;
    loadBoards(true);
  }
}

async function clearSquare(board, square) {
  const { error } = await db.from("board_squares").delete().eq("board_id", board).eq("square", square);
  toast(error ? "Couldn't clear the square." : `Square ${square + 1} cleared.`);
  loadBoards(true);
}
async function drawNumbers(id) {
  const { error } = await db.rpc("draw_numbers", { p_board: id });
  toast(error ? String(error.message || "Couldn't draw the numbers.") : "Numbers drawn. The board is locked.");
  loadBoards(true);
}
async function deleteBoard(id) {
  const { error } = await db.from("boards").delete().eq("id", id);
  if (error) { toast("Couldn't delete the board."); return; }
  toast("Board deleted.");
  state.board = null;
  loadBoards(true);
}

// ---- new board (administrator) ----
function boardGames(league) {
  const d = state.data[league];
  if (!d || !d.games) return [];
  const now = new Date();
  return d.games.filter((g) => g.kickoff && new Date(g.kickoff) > now && g.home_score == null)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff)).slice(0, 120);
}
const boardName = (league, code) => (state.data[league]?.names || {})[code] || code;
function boardGameTitle() {
  const league = $("#nb-league").value, g = boardGames(league).find((x) => x.id === $("#nb-game").value);
  return g ? `${boardName(league, g.away)} at ${boardName(league, g.home)}` : "Board name";
}
function fillBoardGames() {
  const league = $("#nb-league").value, games = boardGames(league);
  $("#nb-game").innerHTML = games.length
    ? games.map((g) => `<option value="${esc(g.id)}">${esc(boardName(league, g.away))} at ${esc(boardName(league, g.home))} · ${esc(new Date(g.kickoff).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</option>`).join("")
    : `<option value="">No upcoming games</option>`;
  $("#nb-title").placeholder = boardGameTitle();
}
async function openNewBoard() {
  $("#nb-status").textContent = "";
  $("#nb-title").value = "";
  $("#nb-league").value = BOARD_LEAGUES[state.league] ? state.league : "nfl";
  $("#newboard").showModal();
  $("#nb-game").innerHTML = `<option>Loading games…</option>`;
  await Promise.all(Object.keys(BOARD_LEAGUES).map(loadLeague));
  fillBoardGames();
}
async function createBoard() {
  const league = $("#nb-league").value, g = boardGames(league).find((x) => x.id === $("#nb-game").value);
  if (!g) { $("#nb-status").textContent = "Choose a game."; return; }
  const price = Math.round(Number($("#nb-price").value));
  if (!(price >= 0 && price <= 100)) { $("#nb-status").textContent = `Price per square: 0 to 100 ${COIN}.`; return; }
  const prizeInputs = [...document.querySelectorAll(".nb-prize")].map((i) => i.value.trim());
  let prizes = null;
  if (prizeInputs.some((v) => v !== "")) {
    if (prizeInputs.some((v) => v === "" || !(Number(v) >= 0))) { $("#nb-status").textContent = "Fill in all four prizes, or leave all four blank to split the pot."; return; }
    prizes = prizeInputs.map((v) => Math.round(Number(v)));
  }
  $("#nb-save").disabled = true;
  const row = { title: ($("#nb-title").value.trim() || boardGameTitle()).slice(0, 60), league, game_id: g.id, kickoff: g.kickoff,
    team1: boardName(league, g.home), team2: boardName(league, g.away), price, prizes };
  const { data, error } = await db.from("boards").insert(row).select().single();
  $("#nb-save").disabled = false;
  if (error) { $("#nb-status").textContent = "Couldn't make the board. Are you signed in as administrator?"; return; }
  $("#newboard").close();
  toast("Board made.");
  state.board = data.id;
  loadBoards(true);
}
