"""Builds the website's data files: downloads each league, runs the model, and writes
site/data/<league>.json. Run on a schedule by .github/workflows/update.yml.

API keys come from environment variables (GitHub secrets), never from the website:
  CFBD_KEY   CollegeFootballData.com
  BDL_KEY    balldontlie.io
  ODDS_KEY   The Odds API
  SUPABASE_SECRET_KEY   the Gridiron Edge database (to send the schedule and lines, so tickets can be checked)
"""

import json
import os
import sys
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import model  # noqa: E402
import sources as src  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "site", "data")
NOW = datetime.now(timezone.utc)

# How often to ask The Odds API (free plan: 500 credits a month). NBA asks for the spread
# and the over/under, which costs 2 credits, so it checks half as often.
ODDS_GAP_HOURS = {"nba": 6, "mlb": 3}

KEEP = ("id", "season", "week", "kickoff", "home", "away", "home_score", "away_score", "neutral",
        "spread", "total", "home_win_chance", "prediction", "total_prediction", "notes")


def season_for(month_start):
    return NOW.year if NOW.month >= month_start else NOW.year - 1


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write(league, payload):
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, f"{league}.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"))


def slim(g):
    return {k: g[k] for k in KEEP if g.get(k) not in (None, [], "")} | {"neutral": bool(g.get("neutral"))}


def finish(league, games, ratings, *, history_from, pick_mode, names=None, ranked_teams=None,
           message=None, has_totals=False, only_lined=False):
    current = max((g["season"] for g in games), default=NOW.year)
    shown = [slim(g) for g in games
             if g["season"] >= history_from and (not only_lined or g.get("spread") is not None)]
    teams = ranked_teams if ranked_teams is not None else {
        t for g in games if g["season"] == current for t in (g["home"], g["away"])}
    ranked = sorted(([t, round(r, 2)] for t, r in ratings.items() if t in teams), key=lambda x: -x[1])
    write(league, {
        "league": league, "updated": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"), "current_season": current,
        "history_from": history_from, "pick_mode": pick_mode, "has_totals": has_totals,
        "names": names or {}, "ranked": ranked, "games": shown, "message": message,
    })
    print(f"{league}: {len(shown)} games written (season {current})")
    # The database downloads these published files itself every 30 minutes (supabase/sync_games.sql),
    # so no database key is needed here. sync_games() remains for setups that use a secret key.


SUPABASE_URL = "https://ryddmapuqqbuyzwvxnbe.supabase.co"


def sync_games(league, games):
    """Sends recent and upcoming games, with their Vegas lines, to the database, which uses them
    to check every ticket (game not started, real current line)."""
    key = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if not key:
        return
    if not key.startswith("sb_secret_") or "\u2022" in key or len(key) < 30:
        # Says what's wrong without ever printing the key itself.
        raise RuntimeError("SUPABASE_SECRET_KEY doesn't look like a full secret key "
                           f"(starts with sb_secret_: {key.startswith('sb_secret_')}, has hidden dots: {chr(0x2022) in key}, "
                           f"length {len(key)}). Copy it again with Supabase's copy button.")
    lo, hi = NOW.timestamp() - 14 * 86400, NOW.timestamp() + 45 * 86400
    rows = []
    for g in games:
        k = src.parse_iso(g.get("kickoff"))
        if not k or not (lo <= k.timestamp() <= hi):
            continue
        rows.append({"id": g["id"], "league": league, "kickoff": g["kickoff"], "home": g["home"], "away": g["away"],
                     "spread": g.get("spread"), "total": g.get("total"),
                     "home_score": g.get("home_score"), "away_score": g.get("away_score"),
                     "updated_at": NOW.strftime("%Y-%m-%dT%H:%M:%SZ")})
    for i in range(0, len(rows), 500):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/games", data=json.dumps(rows[i:i + 500]).encode(), method="POST",
            headers={"apikey": key, "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"})
        try:
            urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"database answered {e.code}: {e.read()[:200]!r}") from e
    print(f"{league}: {len(rows)} games sent to the database")


def saved_odds(league):
    """Lines saved by earlier runs, read back from the last published file."""
    old = read_json(os.path.join(DATA, f"{league}.json"), {})
    out = {}
    for g in old.get("games", []):
        entry = {k: g[k] for k in ("spread", "total", "home_win_chance") if g.get(k) is not None}
        if entry:
            out[g["id"]] = entry
    return out


def maybe_update_odds(league, games, names, meta):
    saved = saved_odds(league)
    key = os.environ.get("ODDS_KEY", "")
    last = meta.get(f"odds_{league}_last")
    due = not last or (NOW - src.parse_iso(last)).total_seconds() >= ODDS_GAP_HOURS[league] * 3600
    message = None
    if key and due:
        try:
            saved, left = src.odds_update(league, key, games, names, saved)
            meta[f"odds_{league}_last"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
            if left is not None:
                meta["odds_credits_left"] = left
        except src.SourceError as e:
            message = f"Couldn't update betting lines ({e}). Saved lines still show."
    return saved, message


def build_nfl(meta):
    games = src.nfl_games(2018)
    out, ratings = model.run(games, model.NFL)
    finish("nfl", out, ratings, history_from=2021, pick_mode="spread", names=src.NFL_NAMES,
           ranked_teams=set(src.NFL_NAMES))


def build_college(meta):
    season = season_for(8)  # August through January
    games, starting, fbs = src.college_games(os.environ.get("CFBD_KEY", ""), 2023, season)
    out, ratings = model.run(games, model.COLLEGE, starting)
    finish("college", out, ratings, history_from=2024, pick_mode="spread", ranked_teams=fbs, only_lined=True)


def build_nba(meta):
    season = season_for(10)  # named for the year it starts in October
    games, names = src.nba_games(os.environ.get("BDL_KEY", ""), season)
    saved, message = maybe_update_odds("nba", [g for g in games if g["season"] == season], names, meta)
    for g in games:
        line = saved.get(g["id"], {})
        g["spread"], g["total"] = line.get("spread"), line.get("total")
    out, ratings = model.run(games, model.NBA)
    has_lines = any(g.get("spread") is not None for g in games)
    finish("nba", out, ratings, history_from=2025, pick_mode="spread" if has_lines else "winner",
           names=names, message=message, has_totals=True)


def build_mlb(meta):
    season = season_for(3)  # late March through October
    games = src.mlb_games(2023, season)
    saved, message = maybe_update_odds("mlb", [g for g in games if g["season"] == season], {}, meta)
    for g in games:
        g["home_win_chance"] = saved.get(g["id"], {}).get("home_win_chance")
    out, ratings = model.run(games, model.MLB)
    finish("mlb", out, ratings, history_from=2024, pick_mode="winner",
           names={t: src.nickname(t) for g in games for t in (g["home"], g["away"])}, message=message)


def main():
    meta_path = os.path.join(DATA, "meta.json")
    meta = read_json(meta_path, {})
    only = sys.argv[1:] or ["nfl", "college", "nba", "mlb"]
    failed = []
    for league in only:
        try:
            {"nfl": build_nfl, "college": build_college, "nba": build_nba, "mlb": build_mlb}[league](meta)
            meta.setdefault("errors", {}).pop(league, None)
        except Exception as e:  # keep the last good file for this league
            traceback.print_exc()
            meta.setdefault("errors", {})[league] = str(e)
            failed.append(league)
    meta["updated"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=1)
    if failed:
        print("Failed:", ", ".join(failed))


if __name__ == "__main__":
    main()
