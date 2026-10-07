import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { Pool } from '../src/core/pool'
import { Decimal, cBN } from '../src/utils'

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const READS = ['pool', 'rate', 'oracle', 'buy', 'sell'] as const;
type ReadName = typeof READS[number];
type PoolContext = { config: Record<string, unknown>; getPoolData: () => Promise<unknown>; price: Record<string, () => Promise<unknown>> };
type PoolMethod = (this: PoolContext) => Promise<Record<string, any>>;


function fixture(isShort = false, seed = 1) {
  return {
    config: { isShort, poolName: isShort ? 'wstETH_short' : 'wstETH', retainedMetadata: 'unchanged' },
    pool: {
      collateralCapacity: 10n ** 30n, collateralBalance: BigInt(seed),
      debtCapacity: 10n ** 29n, debtBalance: BigInt(seed) * 100n,
      isPaused: seed % 2 === 0, poolMinDebtRatio: 1n, poolMaxDebtRatio: 999999999999999999n,
      supplyFeeRatio: BigInt(seed) * 100001n, withdrawFeeRatio: BigInt(seed) * 99999n,
      repayFeeRatio: BigInt(seed) * 234567n,
      routerFeeRatios: [1n, 2n, 3n, 4n], mintFeeRatios: [4n, 3n, 2n, 1n],
    },
    rate: 10n ** 18n + BigInt(seed) * 987654321123n,
    oracle: { anchorPrice: BigInt(seed), minPrice: 1n, maxPrice: 10n ** 30n },
    buy: `${2000 + seed}.123456789123456789`,
    sell: `${1999 + seed}.987654321987654321`,
  };
}

function expectedPoolInfo(value: ReturnType<typeof fixture>) {
  const buy = cBN(value.buy).times(1e18).div(value.rate).toString();
  const sell = cBN(value.sell).times(1e18).div(value.rate).toString();
  return {
    ...value.config, ...value.pool, ...value.oracle,
    collRest: value.pool.collateralCapacity - value.pool.collateralBalance,
    debtRest: value.pool.debtCapacity - value.pool.debtBalance,
    rateRes: value.rate, averagePrice: cBN(buy).add(cBN(sell)).div(2).toString(),
    openPrice: value.config.isShort ? sell : buy,
    closePrice: value.config.isShort ? buy : sell,
    openFeeRatio: cBN(value.pool.supplyFeeRatio).div(1e9).toNumber(),
    closeFeeRatio: cBN(value.pool.withdrawFeeRatio).div(1e9).toNumber(),
    repayFeeRatio: cBN(value.pool.repayFeeRatio).div(1e9).toNumber(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((done) => setImmediate(done));

function context(read: (name: ReadName) => Promise<unknown>, config = fixture().config): PoolContext {
  return { config, getPoolData: () => read('pool'), price: {
    getRateRes: () => read('rate'), getOraclePrice: () => read('oracle'),
    getBuyPrice: () => read('buy'), getSellPrice: () => read('sell'),
  } };
}

describe('Pool.getPoolInfo view scheduling', () => {
  test(`view reads start together, map out-of-order results, and keep converter calls separate`, async () => {
    const method = Pool.prototype.getPoolInfo as unknown as PoolMethod;
    const value = fixture();
    const gates = Object.fromEntries(READS.map((name) => [name, deferred<unknown>()])) as Record<ReadName, ReturnType<typeof deferred<unknown>>>;
    const started: ReadName[] = [];
    const pending = method.call(context((name) => { started.push(name); return gates[name].promise; }));
    // Baseline fails here: it starts only the pool read.
    assert.deepEqual(started, ['pool', 'rate', 'oracle']);
    gates.oracle.resolve(value.oracle);
    gates.rate.resolve(value.rate);
    await flush();
    assert.deepEqual(started, ['pool', 'rate', 'oracle'], 'no quote until all view reads settle');
    gates.pool.resolve(value.pool);
    await flush();
    assert.deepEqual(started, ['pool', 'rate', 'oracle', 'buy']);
    gates.buy.resolve(value.buy);
    await flush();
    assert.deepEqual(started, [...READS], 'sell starts only after buy resolves');
    gates.sell.resolve(value.sell);
    assert.deepEqual(await pending, expectedPoolInfo(value));
    assert.equal(new Set(started).size, 5, 'each read invoked exactly once');
  });

  test(`pool metadata and Decimal results are identical over both sides and boundary-sized values`, async () => {
    const method = Pool.prototype.getPoolInfo as unknown as PoolMethod;
    const precision = Decimal.precision;
    for (const isShort of [false, true]) for (let seed = 0; seed < 64; seed += 1) {
      const value = fixture(isShort, seed);
      const calls: ReadName[] = [];
      const result = await method.call(context(async (name) => { calls.push(name); return value[name]; }, value.config));
      assert.deepEqual(result, expectedPoolInfo(value));
      assert.deepEqual(calls, [...READS]);
    }
    assert.equal(Decimal.precision, precision, 'never mutate global Decimal precision');
  });

  test(`every individual read failure blocks output and all started rejections are observed`, async () => {
    const method = Pool.prototype.getPoolInfo as unknown as PoolMethod;
    for (const failed of READS) {
      const failure = failed === 'rate' ? new DOMException('aborted', 'AbortError') : new Error(`${failed} unavailable`);
      const value = fixture();
      const calls: ReadName[] = [];
      await assert.rejects(method.call(context(async (name) => {
        calls.push(name);
        if (name === failed) throw failure;
        return value[name];
      })), (cause: unknown) => cause === failure);
      assert.deepEqual(calls, failed === 'buy' ? ['pool', 'rate', 'oracle', 'buy']
        : failed === 'sell' ? [...READS] : ['pool', 'rate', 'oracle']);
    }
    // The test runner treats unhandled rejections as test failures.
    await flush();
  });

  test(`concurrent failures preserve pool-before-rate-before-oracle error priority`, async () => {
    const method = Pool.prototype.getPoolInfo as unknown as PoolMethod;
    for (const earliest of ['pool', 'rate', 'oracle'] as const) {
      const gates = Object.fromEntries(READS.map((name) => [name, deferred<unknown>()])) as Record<ReadName, ReturnType<typeof deferred<unknown>>>;
      const errors = { pool: new Error('pool failed'), rate: new Error('rate failed'), oracle: new Error('oracle failed') };
      const calls: ReadName[] = [];
      const pending = method.call(context((name) => { calls.push(name); return gates[name].promise; }));
      const rejection = assert.rejects(pending, (cause: unknown) => cause === errors[earliest]);
      // Reject later reads before the pool settles; none may leak unhandled.
      gates.oracle.reject(errors.oracle);
      await flush();
      if (earliest === 'oracle') gates.rate.resolve(fixture().rate); else gates.rate.reject(errors.rate);
      await flush();
      if (earliest === 'pool') gates.pool.reject(errors.pool); else gates.pool.resolve(fixture().pool);
      await rejection;
      assert.deepEqual(calls, ['pool', 'rate', 'oracle']);
    }
    await flush();
  });

  test(`an early pool or rate failure returns without waiting for slow siblings`, async () => {
    const method = Pool.prototype.getPoolInfo as unknown as PoolMethod;
    for (const earliest of ['pool', 'rate'] as const) {
      const gates = Object.fromEntries(READS.map((name) => [name, deferred<unknown>()])) as Record<ReadName, ReturnType<typeof deferred<unknown>>>;
      const failure = new Error(`${earliest} failed immediately`);
      const calls: ReadName[] = [];
      const pending = method.call(context((name) => { calls.push(name); return gates[name].promise; }));
      let observed: unknown;
      void pending.catch((cause: unknown) => { observed = cause; });
      if (earliest === 'rate') gates.pool.resolve(fixture().pool);
      gates[earliest].reject(failure);
      await flush();
      assert.equal(observed, failure, 'slow siblings must not delay the relevant failure');
      assert.deepEqual(calls, ['pool', 'rate', 'oracle']);
      gates.oracle.reject(new Error('later oracle failure'));
      if (earliest === 'pool') gates.rate.reject(new DOMException('later cancellation', 'AbortError'));
      await assert.rejects(pending, (cause: unknown) => cause === failure);
      await flush();
    }
  });

  test(`advancing chain fixtures stay uncached and converter reads remain later ordered snapshots`, async () => {
    const method = Pool.prototype.getPoolInfo as unknown as PoolMethod;
    let block = 100;
    const snapshots: Array<{ name: ReadName; block: number }> = [];
    const read = async (name: ReadName) => {
      snapshots.push({ name, block });
      const value = fixture(false, block);
      await Promise.resolve();
      if (name === 'oracle' || name === 'buy' || name === 'sell') block += 1;
      return value[name];
    };
    await method.call(context(read));
    assert.deepEqual(snapshots, [
      { name: 'pool', block: 100 }, { name: 'rate', block: 100 }, { name: 'oracle', block: 100 },
      { name: 'buy', block: 101 }, { name: 'sell', block: 102 },
    ]);
    snapshots.length = 0;
    await method.call(context(read));
    assert.equal(snapshots[0]!.block, 103, 'a second plan must issue fresh reads');
    assert.equal(snapshots.length, 5);
    // This deliberately does not claim an atomic block snapshot. Review and
    // pre-sign simulation are still responsible for current executability.
  });
})
