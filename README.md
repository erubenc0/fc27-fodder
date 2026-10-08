# FC27 Fodder Tracker

Live site: https://erubenc0.github.io/fc27-fodder/

Daily EA FC 27 fodder prices (cheapest 81 to 91 on console and PC) with a chart per rating and a paper trader that simulates buy-the-dip trades after EA's 5% tax.

## How it updates

- A scheduled Claude routine reads [FUTBIN's cheapest-by-rating page](https://www.futbin.com/stc/cheapest) every day at 5pm Eastern (it follows daylight saving), checks the numbers look sane, adds them to `data/snapshots.json` together with the 3-hourly readings from the day, and pushes here. GitHub Pages republishes the site within a minute or two.
- If the `DISCORD_WEBHOOK_URL` secret is set, `.github/workflows/discord-daily.yml` posts the close to Discord after each update.

## Files

- `index.html`, `assets/`: the site (plain HTML, CSS and JavaScript, no build step)
- `data/snapshots.json`: price history; `data/events.json`: market events shown on the charts
- `scripts/update_data.py`: merges new readings with sanity checks and outlier removal
- `scripts/discord_post.py`: the Discord webhook post
- `discord-bot/CLAUDE.md`: instructions for the John Von Neumann Discord bot
- `vendor/`: TradingView Lightweight Charts 4.2.3 (Apache 2.0)

For research only. All trading is manual and within EA's rules.
