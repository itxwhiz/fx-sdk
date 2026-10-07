import { afterEach, describe, expect, it, vi } from 'vitest'
import { Pool } from '../src/core/pool'
import { PoolName } from '../src/types/pool'

const rpc = vi.hoisted(() => ({ multicall: vi.fn(), readContract: vi.fn() }))
vi.mock('../src/core/client', () => ({ getClient: () => rpc }))
afterEach(() => vi.resetAllMocks())

describe('concurrent pool call eligibility', () => {
  it.each(Object.values(PoolName))('only batches view or pure calls for %s', async (poolName) => {
    const seen: string[] = []
    const assertView = ({ abi, functionName }: { abi: Array<Record<string, unknown>>; functionName: string }) => {
      const definition = abi.find(item => item.type === 'function' && item.name === functionName)
      expect(definition, functionName).toBeDefined()
      expect(['view', 'pure']).toContain(definition!.stateMutability)
      seen.push(functionName)
    }
    rpc.multicall.mockImplementation(async ({ contracts }) => {
      for (const call of contracts) assertView(call)
      return [
        { result: [1n, 1n, 1n, 1n, 1n] }, { result: false },
        { result: [0n, 1n] }, { result: [0n, 0n, 0n, 0n] }, { result: [0n, 0n, 0n, 0n] },
      ]
    })
    rpc.readContract.mockImplementation(async (call) => {
      assertView(call)
      if (call.functionName === 'getRate') return 10n ** 18n
      if (call.functionName === 'getPrice') return [1n, 1n, 1n]
      throw new Error('Unexpected read')
    })
    const pool = new Pool({ poolName })
    await Promise.all([pool.getPoolData(), pool.price.getRateRes(), pool.price.getOraclePrice()])
    expect(seen).toEqual(['getPoolInfo', 'paused', 'getDebtRatioRange', 'getPoolFeeRatio', 'getPoolFeeRatio', 'getRate', 'getPrice'])
    expect(rpc.multicall).toHaveBeenCalledTimes(1)
    expect(rpc.readContract).toHaveBeenCalledTimes(2)
  })
})
