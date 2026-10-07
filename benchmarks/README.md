# Regression checks and controlled latency benchmark

This change ports three independently testable SDK fixes from FxAeon into source.
It does not include application transport policies, response-shape additions, or
short-pool tuple decoding, which is already fixed in upstream `53c0b980`.

## Correctness and compatibility

`getEncodeMiscData` packs the minimum in bits 0–59 and maximum in bits 60–119.
Both protocol flash-loan facets decode these as two 60-bit unsigned integers:

- [Long facet](https://github.com/AladdinDAO/fx-protocol-contracts/blob/5e198e93657db008a57129e7eea21a996618f17f/contracts/periphery/facets/PositionOperateFlashLoanFacetV2.sol#L249-L255)
- [Short facet](https://github.com/AladdinDAO/fx-protocol-contracts/blob/5e198e93657db008a57129e7eea21a996618f17f/contracts/periphery/facets/ShortPositionOperateFlashLoanFacet.sol#L287-L293)

Decimal's default 20-digit precision can round the combined 120-bit integer.
For minimum `329949991123456789` and maximum `336649990923456789`, the old
packing decodes the minimum as `334782144128679936`. The regression test
reproduces this and verifies exact round trips across boundaries and 1,024
seeded pairs. This is a packing fix, not a change to the slippage calculation.

Intentional validation change: bounds must be nonempty unsigned decimal integer
strings, each below `2^60`, with minimum <= maximum. Malformed, overflowing, or
reversed inputs now throw rather than coercing, rounding, or overlapping fields.
Zero, equal bounds, and leading zeroes are supported. The string return type is
unchanged. No global Decimal settings are changed.

`batchedMulticall` keeps its 50-call chunks, original result ordering, failure
placeholders, and 500 ms default gap **between** chunks. It no longer waits after
the final chunk, including a failed final chunk. For every nonempty invocation
this removes one configured delay; it does not remove the between-chunk throttle.
Fake-timer tests assert the precise schedule for empty, single, and multiple
chunks, including failures.

`Pool.getPoolInfo` overlaps only `getPoolData`, `getRateRes`, and `getOraclePrice`.
ABI tests verify these calls are view/pure for all four pools. Each promise is
observed immediately and consumed in the previous pool → rate → oracle order.
This preserves error precedence and returns an early relevant failure without
waiting on slow siblings. Later sibling rejections remain handled. Eager reads
can still run after an earlier read fails; no cancellation API is introduced.
Buy and sell converter quotes retain their original sequential execution and
multicall grouping. They must not be included in this parallel group because
converter quote calls are nonpayable and may change temporary execution state.
There is no caching or promise of an atomic block snapshot.

## Run the offline regression checks

After installing the repository dependencies:

```sh
npm run test:run -- tests/debt-ratio-packing.test.ts tests/multicall-scheduling.test.ts tests/pool-read-scheduling.test.ts tests/pool-planner-failures.test.ts tests/pool-view-calls.test.ts tests/sdk-initialization.test.ts
npm run build
npx tsc --noEmit
node benchmarks/read-latency.cjs
```

The focused suite has 29 passing tests, including 128 pool metadata/Decimal
fixtures and 48 public-planner failure scenarios. An additional six existing
pool constructor/manager tests pass. The new packing/multicall tests were first
run against unchanged upstream: 12 of 13 failed, then all passed after the fixes.

The existing `tests/validation.test.ts` has 13 failures from stale error-message
expectations on both unchanged `53c0b980` and this candidate. Those expectations
are outside this patch. The live-RPC integration suite was not run; the results
here are not a claim that the entire upstream suite passes.

## Benchmark method

The benchmark executes the freshly built CommonJS SDK and real viem automatic
multicall code with a local custom transport. Every `eth_call` waits 100 ms and
returns a deterministic ABI-encoded fixture. It never contacts a provider or
sends a transaction. The only other supported request is a mocked nonce read.

The serial comparison replaces only the first three reads in `getPoolInfo` with
the original sequential implementation, in memory. Both variants already omit
the final multicall sleep, so this measures only the extra concurrency benefit.
Each case has five repetitions, alternating which variant runs first. Reported
values are wall-clock medians; timer/CPU overhead will vary by machine.

Every repetition asserts deep equality of the complete result, all logical
contract reads and arguments, and the original converter quote batch grouping.
The JSON output includes individual samples, request traces, source and result
hashes. Complete transaction-plan equality is checked for ETH and BTC
`depositAndMint`; other planner success paths are not claimed as benchmarked.

Example run: Node 24.19.0, viem 2.43.1, 100 ms mocked RPC delay:

| Operation | Pool | Serial median | Concurrent median | Saved |
|---|---|---:|---:|---:|
| getPoolInfo | wstETH | 540 ms | 332 ms | 208 ms |
| getPoolInfo | WBTC | 537 ms | 334 ms | 203 ms |
| getPoolInfo | wstETH_short | 533 ms | 331 ms | 202 ms |
| getPoolInfo | WBTC_short | 568 ms | 348 ms | 220 ms |
| depositAndMint | wstETH | 641 ms | 436 ms | 205 ms |
| depositAndMint | WBTC | 654 ms | 443 ms | 211 ms |

The pool stage changes from five sequential RPC requests to four requests, with
the first two concurrent. The number and arguments of logical contract reads
are unchanged. These are controlled latency-model results, not live-mainnet
performance measurements, execution guarantees, or estimates of total UI time.
