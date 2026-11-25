// Dip-Buy Survivor: buys seasoned pump.fun curves on pullbacks while buyers are
// still stepping in, banks half at +25%, and rides the rest behind a trailing stop.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
