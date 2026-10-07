import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBorrowByFxUSDAmount, getFxUSDByBorrowAmount } from '../src/core/aggregators'
import { tokens } from '../src/configs/tokens'
import type { MulticallContractCall } from '../src/utils/multicall'

const rpc = vi.hoisted(() => ({ multicall: vi.fn() }))
vi.mock('../src/core/client', () => ({ getClient: () => rpc }))
vi.mock('../src/utils/zapRoute', () => ({
  getZapRoutes: ({ isV3 }: { isV3?: boolean }) => ({ encoding: isV3 ? 3n : 2n, routes: [11n] }),
}))

const HINT = '100000000000000000000'
const EXPECTED = 99999950000000000000n
const METHODS = ['fxUSD', 'borrow'] as const
function quote(method: typeof METHODS[number], btc = false) {
  return method === 'fxUSD'
    ? getFxUSDByBorrowAmount({ hintFxUSDAmount: HINT, borrowAmount: HINT, baseTokenAddress: btc ? tokens.WBTC : tokens.wstETH })
    : getBorrowByFxUSDAmount({ hintToBorrow: HINT, fxUSDAmount: HINT, baseTokenAddress: btc ? tokens.WBTC : tokens.wstETH, precision: 1e20 })
}
function fixture(options: { failV2?: boolean; neverConverge?: boolean } = {}) {
  const epoch = Date.now()
  const events: Array<{ start: number; end?: number; route: bigint; size: number }> = []
  rpc.multicall.mockImplementation(async ({ contracts }: { contracts: MulticallContractCall[] }) => {
    const route = contracts[0]!.args![1] as bigint
    const event = { start: Date.now() - epoch, end: undefined as number | undefined, route, size: contracts.length }
    events.push(event)
    expect(contracts.every(call => call.functionName === 'queryConvert' && call.args![1] === route)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    event.end = Date.now() - epoch
    if (options.failV2 && route === 2n) throw new DOMException('fixture cancellation', 'AbortError')
    return contracts.map(call => ({ status: 'success', result: options.neverConverge ? 0n : call.args![0] }))
  })
  return events
}
function expectPaced(events: ReturnType<typeof fixture>) {
  expect(events.every(event => event.size === 50)).toBe(true)
  for (let index = 1; index < events.length; index++) {
    expect(events[index]!.start - events[index - 1]!.end!).toBe(500)
  }
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks() })
afterEach(() => vi.useRealTimers())

describe('real quote-search operation pacing', () => {
  it.each(METHODS)('%s search preserves all gaps across three iterations and returns without a final delay', async method => {
    const events = fixture()
    let complete = false
    const pending = quote(method).then(result => { complete = true; return result })
    await vi.advanceTimersByTimeAsync(3099)
    expect(complete).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    const [best] = Object.values(result.amounts)
    expect(best!.src).toBe(EXPECTED)
    expect(best!.dst).toBe(BigInt(HINT))
    expect(events.map(event => event.start)).toEqual([0, 600, 1200, 1800, 2400, 3000])
    expectPaced(events)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(METHODS)('%s WBTC search shares pacing across the V2 to V3 boundary', async method => {
    const events = fixture()
    const pending = quote(method, true)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(Object.values(result.amounts).map(value => value.src)).toEqual([EXPECTED, EXPECTED])
    expect(events.map(event => event.route)).toEqual([...Array(6).fill(2n), ...Array(6).fill(3n)])
    expect(events[events.length - 1]!.end).toBe(6700)
    expectPaced(events)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(METHODS)('%s WBTC search keeps the gap after failed V2 batches before its V3 attempt', async method => {
    const events = fixture({ failV2: true })
    const pending = quote(method, true)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(Object.values(result.amounts).map(value => value.src)).toEqual([EXPECTED])
    expect(events.map(event => event.route)).toEqual([2n, 2n, ...Array(6).fill(3n)])
    expect(events[events.length - 1]!.end).toBe(4300)
    expectPaced(events)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves independent simultaneous quote operations on the singleton client', async () => {
    const events = fixture()
    const first = quote('fxUSD')
    const second = quote('fxUSD')
    await vi.runAllTimersAsync()
    expect(await first).toEqual(await second)
    expect(events.map(event => event.start)).toEqual([0, 0, 600, 600, 1200, 1200, 1800, 1800, 2400, 2400, 3000, 3000])
    expect(events[events.length - 1]!.end).toBe(3100)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the ten-iteration bound and error without a final idle wait', async () => {
    const events = fixture({ neverConverge: true })
    const rejection = expect(quote('fxUSD')).rejects.toThrow('Exceeds the maximum trading range')
    await vi.runAllTimersAsync()
    await rejection
    expect(events).toHaveLength(20)
    expect(events[events.length - 1]!.end).toBe(11500)
    expectPaced(events)
    expect(vi.getTimerCount()).toBe(0)
  })
})
