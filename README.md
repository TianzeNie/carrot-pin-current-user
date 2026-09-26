# Carrot, But Userscript — Pin Current User

A small fork of [Carrot, But Userscript](https://github.com/Yan233th/carrot-but-userscript) that keeps your own Codeforces standings row visible at the top of the page and preserves Carrot's rating prediction for that row.

## Features

- Automatically detects the currently logged-in Codeforces handle.
- Pins your row to the top of the standings table.
- Shows Carrot's predicted performance (`Π`), rating delta (`Δ`), and rank-change helper on the pinned row.
- Uses Friends Standings to recover your row when it is missing from the public standings page.
- If public `contest.standings` data omits you, rebuilds standings from contest submissions before calculating the prediction.
- Shows the reconstructed overall rank on the pinned row when available.
- No Codeforces handle is hard-coded.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [carrot-pin-current-user.user.js](./carrot-pin-current-user.user.js).
3. Click **Raw**.
4. Tampermonkey should open the installation page. Click **Install**.
5. Log in to Codeforces and open a contest standings page.

> [!IMPORTANT]
> On Chromium-based browsers such as Chrome or Edge, Tampermonkey may require the browser-level **Allow User Scripts** permission before userscripts can run.
>
> Open your browser's **Extensions / Manage extensions** page, open **Tampermonkey → Details**, and enable **Allow User Scripts** if the option is shown.
>
> If the script is installed but nothing happens on Codeforces, check this setting first and make sure Tampermonkey itself is enabled.

The pin feature activates only when your account appears in that contest's Friends Standings.

## How it works

Normally, Carrot calculates predictions from Codeforces standings data. In some contests, the public standings response can omit a contestant even though that contestant is still visible in Friends Standings.

This fork:

1. detects the logged-in user;
2. loads that user's row from Friends Standings;
3. pins a copy to the top of the visible standings table;
4. if necessary, rebuilds the standings from `contest.status`;
5. runs Carrot's prediction logic with the recovered contestant included.

## Upstream

Based on **Carrot, But Userscript** by **Yan233_**:

https://github.com/Yan233th/carrot-but-userscript

The original prediction and rendering logic belongs to the upstream project. This fork adds the current-user pinning and missing-contestant fallback.

## License

Licensed under **AGPL-3.0-or-later**, matching the upstream project.

See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Notes

- Rebuilding a large live contest from `contest.status` can be slower than using the normal standings endpoint.
- Codeforces HTML/API changes may require future updates.
- Existing Carrot limitations for unsupported or unrated contests still apply.
