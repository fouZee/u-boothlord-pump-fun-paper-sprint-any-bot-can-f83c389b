# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/fouZee/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/fouZee/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A fresh-momentum rotation bot for pump.fun paper trading. Most new pump.fun coins dump after launch, so buy-and-hold loses — this bot buys only coins already proving demand (several distinct buyers, net SOL flowing in and accelerating (the newer half of the entry window must bring in at least as much net SOL as the older half), price rising and sitting near its recent high), then exits fast on a stop-loss, a trailing stop once it is up, or a time limit. With at most 5 open positions it rotates through many coins, clearing the guardrail of a round trip of at least 0.01 SOL on each of at least 20 coins; a small probe trade keeps the coin count on pace when momentum entries go quiet. Fully deterministic: no clock, no randomness, no environment reads.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b --driver process --worktree
```

The grader runs `node /bot/main.ts` (Node 22); `main.ts` is the whole strategy and `vendor/makefun-bot.ts` is the kit's bot shim, vendored byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?ref=witty-sparrow-52&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
