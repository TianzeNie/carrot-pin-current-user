# Carrot, But Userscript — Pin Current User

A modified fork of [Yan233th/carrot-but-userscript](https://github.com/Yan233th/carrot-but-userscript) that keeps the currently logged-in Codeforces user visible at the top of standings and keeps Carrot rating prediction working when Codeforces' public standings response omits that contestant.

## What this fork changes

- Automatically detects the currently logged-in Codeforces handle; no handle is hard-coded.
- Fetches the user's row from **Friends Standings** and pins a copy to the top of the visible standings table.
- Preserves Carrot's predicted performance (`Π`), rating delta (`Δ`), and rank-change helper on the pinned row.
- If the public `contest.standings` data omits the pinned contestant, rebuilds standings from `contest.status` (and hacks for CF-format contests) before calculating predictions.
- Replaces the Friends Standings label such as `1 (93)` with the reconstructed overall rank when that rank is available.
- Leaves the normal standings row untouched; the pinned row is an additional convenience copy.

## Install

1. Install a userscript manager such as Tampermonkey.
2. Open [carrot-pin-current-user.user.js](./carrot-pin-current-user.user.js).
3. Click **Raw** and install the userscript.
4. Log in to Codeforces and open a contest standings page.

The pin feature only activates when the logged-in user appears in that contest's Friends Standings.

## Why the fallback exists

In some live contests, the public standings data used by prediction tools can omit a contestant even though that contestant is visible in Friends Standings. In that case this fork reconstructs the contest standings from submissions before running Carrot's prediction algorithm. This avoids estimating rating change from an incomplete contestant pool.

## Upstream and attribution

This project is a derivative work of **Carrot, But Userscript** by **Yan233_**:

- Upstream: https://github.com/Yan233th/carrot-but-userscript
- Original prediction/rendering logic remains credited to the upstream project.
- The pin-current-user integration and missing-contestant fallback are modifications in this fork.

## License

The upstream project is licensed under **GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later)**. This derivative work is distributed under the same license. See [LICENSE](./LICENSE).

## Known limitations

- Codeforces can change its HTML structure or API behavior, which may require updates to handle detection or Friends Standings parsing.
- Reconstructing a large live contest from `contest.status` can be slower than using the normal standings endpoint.
- Team contests and contests that Carrot itself treats as unrated/unsupported retain Carrot's original limitations.
