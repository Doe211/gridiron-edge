"""The prediction model (same as the Gridiron Edge app).

Every team has a power rating in points: how much better or worse it is than an
average team on a neutral field.

Before each game:  predicted home margin = home rating - away rating + home-field edge
After each game:   both ratings move a little toward what actually happened.

Games are processed in date order, so every prediction uses only games played
before it. That keeps the accuracy numbers honest.
"""

from dataclasses import dataclass


@dataclass
class Settings:
    learning_rate: float
    home_field: float
    margin_cap: float
    offseason_shrink: float
    rest_per_day: float = 0.0       # points per extra day of rest over the opponent
    rest_cap_days: int = 7
    backup_qb_penalty: float = 0.0  # points off when a team starts someone other than its regular QB
    qb_lookback: int = 17
    total_learning_rate: float = 0.0  # 0 turns over/under predictions off
    league_average_start: float = 0.0
    league_average_rate: float = 0.003
    total_offseason_shrink: float = 0.6
    total_error_cap: float = 40.0


# Tested on the 2021-2026 NFL seasons. Rest and the backup-QB penalty each lowered
# the model's average miss in every one of those seasons. Travel made it worse.
NFL = Settings(0.06, 1.5, 17, 0.33, rest_per_day=0.2, rest_cap_days=7, backup_qb_penalty=2.0, qb_lookback=17)
COLLEGE = Settings(0.10, 2.5, 28, 0.40)
# NBA totals: average miss about 15 points vs 16.4 for guessing the league average (2023-24 to 2025-26).
NBA = Settings(0.05, 2.5, 20, 0.33, total_learning_rate=0.05, league_average_start=115)
MLB = Settings(0.02, 0.25, 6, 0.5)


def _signed(v):
    return ("+" if v >= 0 else "−") + f"{abs(v):.1f}"


def run(games, s: Settings, starting=None):
    """games: list of dicts with id, season, kickoff (ISO string or None), home, away,
    home_score, away_score, neutral, and optional home_rest/away_rest/home_qb/away_qb/
    home_qb_name/away_qb_name. Adds prediction, total_prediction, notes. Returns (games, ratings)."""
    starting = starting or {}
    order = sorted(games, key=lambda g: (g.get("kickoff") or "9999", g["id"]))
    ratings, offense, defense, recent = {}, {}, {}, {}
    league_avg = s.league_average_start
    season = None
    out = []

    def rating(t):
        return ratings.get(t, starting.get(t, 0.0))

    def is_backup(team, qb):
        if s.backup_qb_penalty <= 0 or not qb:
            return False
        r = recent.get(team, [])[-s.qb_lookback:]
        if len(r) < 3:
            return False
        counts = {}
        for q in r:
            counts[q] = counts.get(q, 0) + 1
        regular = max(counts, key=counts.get)
        return qb != regular and counts.get(qb, 0) < 0.34 * counts[regular]

    for g in order:
        g = dict(g)
        if g["season"] != season:
            season = g["season"]
            for t in list(ratings):
                base = starting.get(t, 0.0)
                ratings[t] = base + (ratings[t] - base) * (1 - s.offseason_shrink)
            for d in (offense, defense):
                for t in d:
                    d[t] *= 1 - s.total_offseason_shrink

        home, away = rating(g["home"]), rating(g["away"])
        pred = home - away + (0 if g.get("neutral") else s.home_field)
        notes = []

        hr, ar = g.get("home_rest"), g.get("away_rest")
        if s.rest_per_day > 0 and hr is not None and ar is not None and hr != ar:
            days = max(-s.rest_cap_days, min(s.rest_cap_days, hr - ar))
            pts = s.rest_per_day * days
            pred += pts
            rested = g["home"] if days > 0 else g["away"]
            n = abs(hr - ar)
            notes.append(f"Rest: {rested} has {n} more {'day' if n == 1 else 'days'} ({rested} {_signed(abs(pts))})")
        if is_backup(g["home"], g.get("home_qb")):
            pred -= s.backup_qb_penalty
            notes.append(f"Backup QB: {g.get('home_qb_name') or 'unknown'} ({g['home']} {_signed(-s.backup_qb_penalty)})")
        if is_backup(g["away"], g.get("away_qb")):
            pred += s.backup_qb_penalty
            notes.append(f"Backup QB: {g.get('away_qb_name') or 'unknown'} ({g['away']} {_signed(-s.backup_qb_penalty)})")

        g["prediction"] = round(pred, 2)
        g["notes"] = notes

        home_pts = league_avg + offense.get(g["home"], 0) + defense.get(g["away"], 0)
        away_pts = league_avg + offense.get(g["away"], 0) + defense.get(g["home"], 0)
        if s.total_learning_rate > 0:
            g["total_prediction"] = round(home_pts + away_pts, 1)

        hs, as_ = g.get("home_score"), g.get("away_score")
        if hs is not None and as_ is not None:
            capped = max(-s.margin_cap, min(s.margin_cap, hs - as_))
            surprise = capped - pred
            ratings[g["home"]] = home + s.learning_rate * surprise
            ratings[g["away"]] = away - s.learning_rate * surprise
            if s.total_learning_rate > 0:
                c = s.total_error_cap
                hm = max(-c, min(c, hs - home_pts))
                am = max(-c, min(c, as_ - away_pts))
                k = s.total_learning_rate
                offense[g["home"]] = offense.get(g["home"], 0) + k * hm
                defense[g["away"]] = defense.get(g["away"], 0) + k * hm
                offense[g["away"]] = offense.get(g["away"], 0) + k * am
                defense[g["home"]] = defense.get(g["home"], 0) + k * am
                league_avg += s.league_average_rate * ((hs + as_) / 2 - league_avg)
            for team, qb in ((g["home"], g.get("home_qb")), (g["away"], g.get("away_qb"))):
                if qb:
                    recent.setdefault(team, []).append(qb)
        out.append(g)
    return out, ratings
