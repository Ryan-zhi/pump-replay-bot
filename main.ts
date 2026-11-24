// Paper-trading entry for the pump.fun replay sprint: wires the
// survivor-momentum strategy in strategy.ts to the replay harness through
// the vendored protocol shim. The grader runs `node main.ts` on Node 22.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
  onDone: (_state, done) => {
    console.error(`done: ${done.reason}, final cash ${done.account.cash_lamports} lamports`);
  },
});
