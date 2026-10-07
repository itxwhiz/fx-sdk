import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import { batchedMulticall, type MulticallContractCall } from '../src/utils/multicall'

const calls = (count: number): MulticallContractCall[] => Array.from({ length: count }, (_, index) => ({
  address: '0x0000000000000000000000000000000000000001',
  abi: [],
  functionName: `call${index}`,
}))

function client() {
  const multicall = vi.fn(async ({ contracts }: { contracts: MulticallContractCall[] }) =>
    contracts.map(({ functionName }) => ({ result: functionName, status: 'success' })))
  return { multicall, value: { multicall } as unknown as PublicClient }
}

describe('batchedMulticall scheduling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not call the client or wait for an empty input', async () => {
    const rpc = client()
    expect(await batchedMulticall(rpc.value, [])).toEqual([])
    expect(rpc.multicall).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 50])('returns %i calls without a trailing timer', async (count) => {
    const rpc = client()
    const result = batchedMulticall(rpc.value, calls(count))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(await result).toHaveLength(count)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
  })

  it('keeps the default 500 ms gaps, result order, and 50-call chunks', async () => {
    const rpc = client()
    const result = batchedMulticall(rpc.value, calls(101))
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(rpc.multicall).toHaveBeenCalledTimes(3)
    expect(rpc.multicall.mock.calls.map(([request]) => request.contracts.length)).toEqual([50, 50, 1])
    expect(vi.getTimerCount()).toBe(0)
    expect(await result).toEqual(calls(101).map(({ functionName }) => ({ result: functionName, status: 'success' })))
  })

  it('keeps failure placeholders and the gap after a failed intermediate chunk', async () => {
    const rpc = client()
    rpc.multicall.mockRejectedValueOnce(new Error('RPC unavailable'))
    const result = batchedMulticall(rpc.value, calls(3), 2, 125)
    await vi.advanceTimersByTimeAsync(124)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual([undefined, undefined, { result: 'call2', status: 'success' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wait after a failed final chunk', async () => {
    const rpc = client()
    rpc.multicall.mockRejectedValueOnce(new Error('RPC unavailable'))
    const result = batchedMulticall(rpc.value, calls(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(await result).toEqual([undefined, undefined])
  })
})
