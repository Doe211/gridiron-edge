# Gridiron Edge

Model predictions for NFL, college football, NBA and MLB games, compared with the Vegas lines.
Visitors make their own picks and see how they do against the model.

**Website:** https://doe211.github.io/gridiron-edge/

## Adjusting a line (administrator)

Open `site/lines.json` on GitHub, click the pencil icon, edit, and click **Commit changes**.
The website updates for everyone in about a minute.

Each entry uses the game's ID. `spread` is how many points the **home** team is favored by
(use a negative number when the away team is favored, `0` for a pick'em). `total` is the over/under.
Leave out either one to keep the Vegas number.

```json
{
  "2026_11_BUF_MIA": { "spread": 3.5 },
  "nba_18447123": { "spread": -2, "total": 228.5 }
}
```

To undo an adjustment, delete its line. To find a game's ID, open the game list for that
league at `https://doe211.github.io/gridiron-edge/data/<league>.json` (nfl, college, nba or mlb).

## How it updates

`.github/workflows/update.yml` runs every 3 hours. It downloads games and lines, runs the model
(`pipeline/`), saves the results to `site/data/`, and publishes the `site/` folder.
API keys are stored as GitHub secrets (`CFBD_KEY`, `BDL_KEY`, `ODDS_KEY`) and are never published.

For entertainment only. If gambling stops being fun, call 1-800-GAMBLER.
