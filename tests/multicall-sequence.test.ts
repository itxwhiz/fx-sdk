import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicClient } from 'viem'
import { batchedMulticall, createBatchedMulticallSequence, type MulticallContractCall } from '../src/utils/multicall'

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
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('operation-scoped multicall sequence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts the first call immediately, preserves the next-call gap, and has no final timer', async () => {
    const rpc = client()
    const sequence = createBatchedMulticallSequence(rpc.value)
    expect(await sequence(calls(1))).toEqual([{ result: 'call0', status: 'success' }])
    expect(vi.getTimerCount()).toBe(0)
    const next = sequence(calls(1))
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await next).toEqual([{ result: 'call0', status: 'success' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps 500 ms across every boundary of three 100-call invocations', async () => {
    const rpc = client()
    const sequence = createBatchedMulticallSequence(rpc.value)
    const starts: number[] = []
    const epoch = Date.now()
    rpc.multicall.mockImplementation(async ({ contracts }) => {
      starts.push(Date.now() - epoch)
      return contracts.map(({ functionName }) => ({ result: functionName, status: 'success' }))
    })
    let done = false
    const result = (async () => {
      for (let iteration = 0; iteration < 3; iteration++) expect(await sequence(calls(100))).toHaveLength(100)
      done = true
    })()
    await vi.advanceTimersByTimeAsync(2499)
    expect(done).toBe(false)
    expect(starts).toEqual([0, 500, 1000, 1500, 2000])
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(starts).toEqual([0, 500, 1000, 1500, 2000, 2500])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores empty runs without creating or clearing a pending gap', async () => {
    const rpc = client()
    const sequence = createBatchedMulticallSequence(rpc.value)
    expect(await sequence([])).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    await sequence(calls(1))
    expect(await sequence([])).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    const next = sequence(calls(1))
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await next
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, 125])('uses its fixed %i ms delay across and within calls', async delayMs => {
    const rpc = client()
    const sequence = createBatchedMulticallSequence(rpc.value, 1, delayMs)
    const first = sequence(calls(2))
    await vi.advanceTimersByTimeAsync(delayMs)
    await first
    const next = sequence(calls(1))
    if (delayMs > 0) {
      await vi.advanceTimersByTimeAsync(delayMs - 1)
      expect(rpc.multicall).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
    } else await flush()
    await next
    expect(rpc.multicall).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([new Error('RPC failure'), new DOMException('aborted', 'AbortError')])('paces the next run after a failed final batch without retrying it', async failure => {
    const rpc = client()
    rpc.multicall.mockRejectedValueOnce(failure)
    const sequence = createBatchedMulticallSequence(rpc.value)
    expect(await sequence(calls(2))).toEqual([undefined, undefined])
    expect(vi.getTimerCount()).toBe(0)
    const next = sequence(calls(1))
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await next).toEqual([{ result: 'call0', status: 'success' }])
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
  })

  it('does not use wall-clock jumps to shorten or lengthen the gap', async () => {
    const rpc = client()
    const sequence = createBatchedMulticallSequence(rpc.value)
    await sequence(calls(1))
    vi.setSystemTime(Date.now() + 86_400_000)
    const second = sequence(calls(1))
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() - 172_800_000)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
  })

  it('preserves the original delay plus local-processing time', async () => {
    const rpc = client()
    const sequence = createBatchedMulticallSequence(rpc.value)
    await sequence(calls(1))
    await vi.advanceTimersByTimeAsync(200)
    const next = sequence(calls(1))
    await vi.advanceTimersByTimeAsync(499)
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await next
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
  })

  it('keeps distinct operations and ordinary reads independent on the same client', async () => {
    const rpc = client()
    const first = createBatchedMulticallSequence(rpc.value)
    const second = createBatchedMulticallSequence(rpc.value)
    await first(calls(1))
    const waiting = first(calls(1))
    await second(calls(1))
    await batchedMulticall(rpc.value, calls(1))
    expect(rpc.multicall).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(500)
    await waiting
    expect(rpc.multicall).toHaveBeenCalledTimes(4)
  })

  it('does not let a hung operation block a different operation using the same client', async () => {
    const rpc = client()
    let complete!: (result: Array<{ result: string; status: string }>) => void
    rpc.multicall.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const hung = createBatchedMulticallSequence(rpc.value)(calls(1))
    const independent = createBatchedMulticallSequence(rpc.value)(calls(1))
    expect(await independent).toHaveLength(1)
    expect(rpc.multicall).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    complete([{ result: 'call0', status: 'success' }])
    await hung
  })
})
