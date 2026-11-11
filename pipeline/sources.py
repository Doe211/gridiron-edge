"""Downloads games for each league. Uses only Python's standard library.

Raw downloads are kept in a private cache folder (never published), so finished seasons
are fetched only once and the free monthly limits last.
"""

import csv
import io
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

CACHE = os.environ.get("GE_CACHE", os.path.join(os.path.dirname(__file__), "..", ".cache"))
EASTERN = ZoneInfo("America/New_York")
UA = {"User-Agent": "GridironEdge/1.0 (+https://github.com)"}


class SourceError(Exception):
    pass


def _get(url, headers=None, retries=3):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(15 + attempt * 10)
                continue
            raise SourceError(f"{url.split('?')[0]} answered {e.code}") from e
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(5)
                continue
            raise SourceError(f"couldn't reach {url.split('?')[0]}") from e


def _cached(name, fetch, use_cache):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if use_cache and os.path.exists(path):
        with open(path, "rb") as f:
            return f.read()
    try:
        data = fetch()
    except SourceError:
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        raise
    with open(path, "wb") as f:
        f.write(data)
    return data


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_iso(text):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def week_number(first, when):
    """Monday-to-Sunday weeks counted from the season's first game (Eastern time)."""
    if not first or not when:
        return 1
    a = first.astimezone(EASTERN).date()
    b = when.astimezone(EASTERN).date()
    a -= timedelta(days=a.weekday())
    b -= timedelta(days=b.weekday())
    return (b - a).days // 7 + 1


# ---------------------------------------------------------------- NFL (nflverse, no key)

NFL_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
NFL_RENAMED = {"OAK": "LV", "SD": "LAC", "STL": "LA"}
NFL_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LA": "Los Angeles Rams", "LAC": "Los Angeles Chargers",
    "LV": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SF": "San Francisco 49ers", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}


def nfl_games(first_season=2018):
    data = _cached("nfl_games.csv", lambda: _get(NFL_URL)[0], use_cache=False)
    rows = csv.DictReader(io.StringIO(data.decode("utf-8")))

    def num(v, kind=float):
        try:
            return kind(v) if v not in ("", "NA") else None
        except ValueError:
            return None

    games = []
    for r in rows:
        season, week = num(r["season"], int), num(r["week"], int)
        if season is None or season < first_season or week is None:
            continue
        time_ = r["gametime"] or "13:00"
        try:
            kick = datetime.strptime(f"{r['gameday']} {time_}", "%Y-%m-%d %H:%M").replace(tzinfo=EASTERN)
        except ValueError:
            kick = None
        a, h = r["away_team"], r["home_team"]
        games.append({
            "id": r["game_id"], "season": season, "week": week, "kickoff": iso(kick),
            "away": NFL_RENAMED.get(a, a), "home": NFL_RENAMED.get(h, h),
            "away_score": num(r["away_score"], int), "home_score": num(r["home_score"], int),
            "neutral": r["location"] == "Neutral",
            "spread": num(r["spread_line"]), "total": num(r["total_line"]),
            "home_rest": num(r["home_rest"], int), "away_rest": num(r["away_rest"], int),
            "home_qb": r["home_qb_id"] or None, "away_qb": r["away_qb_id"] or None,
            "home_qb_name": r["home_qb_name"] or None, "away_qb_name": r["away_qb_name"] or None,
        })
    return games


# ---------------------------------------------------------------- College (CollegeFootballData.com)

CFB_URL = "https://api.collegefootballdata.com"


def _cfb_line(lines, home):
    order = ["consensus", "draftkings", "espn bet", "bovada", "william hill (new jersey)"]
    usable = [l for l in lines or [] if l.get("spread") is not None or l.get("formattedSpread")]
    pick = None
    for name in order:
        pick = next((l for l in usable if (l.get("provider") or "").lower() == name), None)
        if pick:
            break
    pick = pick or (usable[0] if usable else None)
    if not pick:
        return None, None
    spread = None
    text = (pick.get("formattedSpread") or "").strip()
    if text and " " in text:
        team, _, value = text.rpartition(" ")
        if "pick" in text.lower():
            spread = 0.0
        else:
            try:
                v = float(value)
                spread = -v if team == home else v
            except ValueError:
                pass
    if spread is None and pick.get("spread") is not None:
        spread = -float(pick["spread"])
    return spread, pick.get("overUnder")


def college_games(key, first_season, current_season):
    if not key:
        raise SourceError("no CollegeFootballData.com key")
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    games, starting, fbs = [], {}, set()
    for season in range(first_season, current_season + 1):
        past = season < current_season
        for kind in ("regular", "postseason"):
            gd = json.loads(_cached(f"cfb_games_{season}_{kind}.json",
                                    lambda: _get(f"{CFB_URL}/games?year={season}&seasonType={kind}", headers)[0], past))
            ld = json.loads(_cached(f"cfb_lines_{season}_{kind}.json",
                                    lambda: _get(f"{CFB_URL}/lines?year={season}&seasonType={kind}", headers)[0], past))
            lines = {l["id"]: _cfb_line(l.get("lines"), l.get("homeTeam")) for l in ld}
            for g in gd:
                for team, level in ((g["homeTeam"], g.get("homeClassification")), (g["awayTeam"], g.get("awayClassification"))):
                    if level == "fbs":
                        fbs.add(team)
                    starting.setdefault(team, {"fbs": 0.0, "fcs": -20.0}.get(level, -30.0))
                done = bool(g.get("completed")) and g.get("homePoints") is not None and g.get("awayPoints") is not None
                spread, total = lines.get(g["id"], (None, None))
                games.append({
                    "id": f"cfb_{g['id']}", "season": g["season"],
                    "week": 20 if kind == "postseason" else g["week"],
                    "kickoff": iso(parse_iso(g.get("startDate"))),
                    "away": g["awayTeam"], "home": g["homeTeam"],
                    "away_score": g["awayPoints"] if done else None,
                    "home_score": g["homePoints"] if done else None,
                    "neutral": bool(g.get("neutralSite")),
                    "spread": spread, "total": total,
                })
    return games, starting, fbs


# ---------------------------------------------------------------- NBA (balldontlie.io)

BDL_URL = "https://api.balldontlie.io/v1/games"


def _bdl_pages(query, key):
    out, cursor = [], None
    while True:
        url = f"{BDL_URL}?{query}&per_page=100" + (f"&cursor={cursor}" if cursor else "")
        url = url.replace("[]", "%5B%5D")
        body, _ = _get(url, {"Authorization": key}, retries=6)
        page = json.loads(body)
        out += page["data"]
        cursor = (page.get("meta") or {}).get("next_cursor")
        if not cursor:
            return out
        time.sleep(12.5)  # free plan: 5 requests a minute


def nba_games(key, current_season):
    if not key:
        raise SourceError("no balldontlie.io key")
    raw = []
    prev = current_season - 1
    raw += json.loads(_cached(f"nba_{prev}.json",
                              lambda: json.dumps(_bdl_pages(f"seasons[]={prev}", key)).encode(), use_cache=True))
    path = os.path.join(CACHE, f"nba_{current_season}.json")
    if os.path.exists(path):
        with open(path) as f:
            current = {g["id"]: g for g in json.load(f)}
        now = datetime.now(EASTERN)
        start = (now - timedelta(days=4)).strftime("%Y-%m-%d")
        end = (now + timedelta(days=10)).strftime("%Y-%m-%d")
        try:
            for g in _bdl_pages(f"seasons[]={current_season}&start_date={start}&end_date={end}", key):
                current[g["id"]] = g
        except SourceError:
            pass
        current = list(current.values())
    else:
        current = _bdl_pages(f"seasons[]={current_season}", key)
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as f:
        json.dump(current, f)
    raw += current

    def kick(g):
        d = parse_iso(g.get("datetime"))
        if d:
            return d
        if g.get("date"):
            return datetime.strptime(g["date"][:10], "%Y-%m-%d").replace(tzinfo=EASTERN)
        return None

    first = {}
    for g in raw:
        k = kick(g)
        if k and (g["season"] not in first or k < first[g["season"]]):
            first[g["season"]] = k
    names, games = {}, []
    for g in raw:
        h, v = g["home_team"], g["visitor_team"]
        if h["id"] > 30 or v["id"] > 30:
            continue  # exhibition games against international clubs
        names[h["abbreviation"]] = h["full_name"]
        names[v["abbreviation"]] = v["full_name"]
        k = kick(g)
        final = g.get("status_state") == "final" or g.get("status") == "Final"
        scored = (g.get("home_team_score") or 0) + (g.get("visitor_team_score") or 0) > 0
        games.append({
            "id": f"nba_{g['id']}", "season": g["season"], "week": week_number(first.get(g["season"]), k),
            "kickoff": iso(k), "away": v["abbreviation"], "home": h["abbreviation"],
            "away_score": g.get("visitor_team_score") if final and scored else None,
            "home_score": g.get("home_team_score") if final and scored else None,
            "neutral": False, "spread": None, "total": None,
        })
    return games, names


# ---------------------------------------------------------------- MLB (statsapi.mlb.com, no key)

MLB_URL = "https://statsapi.mlb.com/api/v1/schedule"


def nickname(name):
    words = name.split()
    if len(words) < 2:
        return name
    last_two = " ".join(words[-2:])
    return last_two if last_two in ("Red Sox", "White Sox", "Blue Jays") else words[-1]


def mlb_games(first_season, current_season):
    games = []
    for season in range(first_season, current_season + 1):
        data = json.loads(_cached(
            f"mlb_{season}.json",
            lambda: _get(f"{MLB_URL}?sportId=1&season={season}&gameType=R,F,D,L,W")[0],
            use_cache=season < current_season))
        raw, seen = [], set()
        for day in data.get("dates", []):
            for g in day.get("games", []):
                state = (g.get("status") or {}).get("detailedState") or ""
                if state.startswith(("Postponed", "Cancelled", "Suspended")) or g["gamePk"] in seen:
                    continue
                seen.add(g["gamePk"])
                raw.append((g, parse_iso(g.get("gameDate"))))
        opening = min((d for _, d in raw if d), default=None)
        for g, d in raw:
            final = (g.get("status") or {}).get("abstractGameState") == "Final"
            t = g["teams"]
            games.append({
                "id": f"mlb_{g['gamePk']}", "season": season, "week": week_number(opening, d),
                "kickoff": iso(d), "away": t["away"]["team"]["name"], "home": t["home"]["team"]["name"],
                "away_score": t["away"].get("score") if final else None,
                "home_score": t["home"].get("score") if final else None,
                "neutral": False, "spread": None, "total": None,
            })
    return games


# ---------------------------------------------------------------- Betting lines (The Odds API)

ODDS_URL = "https://api.the-odds-api.com/v4/sports/{sport}/odds/?regions=us&markets={markets}&oddsFormat=american&apiKey={key}"


def _same_team(a, b):
    return a.lower() == b.lower() or nickname(a).lower() == nickname(b).lower()


def _implied(odds):
    return -odds / (-odds + 100) if odds < 0 else 100 / (odds + 100)


def odds_update(kind, key, games, names, saved):
    """kind: 'nba' (spread + over/under, 2 credits) or 'mlb' (moneyline, 1 credit).
    saved: {game_id: {...}} lines kept from earlier checks. Returns (saved, credits_left or None)."""
    now = datetime.now(timezone.utc)
    upcoming = [g for g in games if g["home_score"] is None and g["kickoff"] and parse_iso(g["kickoff"]) > now]
    if not key or not upcoming:
        return saved, None
    sport, markets = ("basketball_nba", "spreads,totals") if kind == "nba" else ("baseball_mlb", "h2h")
    body, headers = _get(ODDS_URL.format(sport=sport, markets=markets, key=key), retries=2)
    events = json.loads(body)
    for ev in events:
        start = parse_iso(ev["commence_time"])
        cands = [g for g in upcoming
                 if _same_team(names.get(g["home"], g["home"]), ev["home_team"])
                 and _same_team(names.get(g["away"], g["away"]), ev["away_team"])
                 and abs((parse_iso(g["kickoff"]) - start).total_seconds()) < 18 * 3600]
        if not cands:
            continue
        game = min(cands, key=lambda g: abs((parse_iso(g["kickoff"]) - start).total_seconds()))
        values, totals = [], []
        for book in ev.get("bookmakers", []):
            for m in book.get("markets", []):
                if m["key"] == "totals":
                    over = next((o for o in m["outcomes"] if o["name"] == "Over"), None)
                    if over and over.get("point") is not None:
                        totals.append(over["point"])
                elif m["key"] in ("spreads", "h2h"):
                    home = next((o for o in m["outcomes"] if _same_team(o["name"], ev["home_team"])), None)
                    away = next((o for o in m["outcomes"] if _same_team(o["name"], ev["away_team"])), None)
                    if m["key"] == "spreads" and home and home.get("point") is not None:
                        values.append(-home["point"])
                    elif m["key"] == "h2h" and home and away:
                        ph, pa = _implied(home["price"]), _implied(away["price"])
                        values.append(ph / (ph + pa))
        entry = dict(saved.get(game["id"], {}))
        if values:
            values.sort()
            entry["spread" if kind == "nba" else "home_win_chance"] = round(values[len(values) // 2], 4)
        if totals:
            totals.sort()
            entry["total"] = totals[len(totals) // 2]
        if entry:
            saved[game["id"]] = entry
    left = headers.get("x-requests-remaining")
    return saved, (int(float(left)) if left else None)
