# pump-replay-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Ryan-zhi/pump-replay-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Ryan-zhi/pump-replay-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay sprint (agent-fun/replay/v2), written in TypeScript for Node 22 with no dependencies.

## Strategy: survivor momentum

Fresh launches are mostly traps, so the bot never buys one. A coin first has to prove it can live: at least 250 slots since creation, at least 10 SOL of real reserve paid in by strangers, at least 40 trades from at least 12 distinct buyers with no single wallet dominating, a creator who has not sold, a reserve still growing over the recent tape, and a price not pinned to its all-time high. Only then does it buy one fixed 0.08 SOL stake.

Exits ride winners with a trailing stop (armed at +20%, giving back 28% from the peak value), cap each loss with a hard stop at 85% of cost, and add a 300-slot time stop, a 30-slot quiet-tape exit and an instant exit when the creator sells.

Because the house only ranks entries that round-trip at least 0.01 SOL on at least 20 coins inside a fixed 6-hour window, the bot paces itself against the tape's timestamps: it aims for 24 entries per 6 hours and steps down through two looser filter tiers only while it is behind that pace.

## Layout

- `main.ts` — the entrypoint the grader runs (`node main.ts`); wires the strategy to the harness.
- `strategy.ts` — the whole strategy: coin tracking, entry filters, exits, pacing.
- `vendor/makefun-bot.ts` — the replay protocol shim from the competition kit (vendored, not authored here).

## License

MIT — see `LICENSE`.
