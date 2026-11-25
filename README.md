# launch-radar-board

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/haguai112/launch-radar-board/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/haguai112/launch-radar-board/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar boards every genuine launch candidate in the snapshot (198 on this snapshot): all 40 watchlist protocols plus the pre-token protocols below the floor, with wrapped, staked, bridged and exchange products filtered out the same way the watchlist rule filters them. Each is valued with shrunk category peer multiples (median market-cap/TVL of traded peers, adjusted for 7-day momentum, years live with no token recorded, and chain reach), given a launch-odds score, and handed a concrete farm plan with costs and time. The dashboard is sortable, filterable, and carries a detail view per protocol.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ss2jambv&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
