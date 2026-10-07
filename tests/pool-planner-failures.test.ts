import { afterEach, describe, expect, it, vi } from 'vitest'
import { FxSdk } from '../src/core'
import { Pool } from '../src/core/pool'
import { Price } from '../src/core/price'
import { tokens } from '../src/configs/tokens'

const owner = '0x1111111111111111111111111111111111111111'
vi.mock('../src/core/client', () => ({
  getClient: () => ({ readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName !== 'ownerOf') throw new Error(`Unexpected fixture RPC: ${functionName}`)
    return '0x1111111111111111111111111111111111111111'
  } }),
}))
afterEach(() => vi.restoreAllMocks())

describe('public planners with failed concurrent pool reads', () => {
  it('propagates the original failure before building any transaction for every supported market and side', async () => {
    for (const market of ['ETH', 'BTC'] as const) for (const type of ['long', 'short'] as const) {
      const methods = type === 'long'
        ? ['increasePosition', 'reducePosition', 'adjustPositionLeverage', 'depositAndMint', 'repayAndWithdraw'] as const
        : ['increasePosition', 'reducePosition', 'adjustPositionLeverage'] as const
      for (const method of methods) for (const failed of ['pool', 'rate', 'oracle'] as const) {
        const failure = new Error(`${method}:${market}:${type}:${failed}`)
        const called: string[] = []
        const pool = vi.spyOn(Pool.prototype, 'getPoolData').mockImplementation(async () => {
          called.push('pool')
          if (failed === 'pool') throw failure
          return {} as Awaited<ReturnType<Pool['getPoolData']>>
        })
        const rate = vi.spyOn(Price.prototype, 'getRateRes').mockImplementation(async () => {
          called.push('rate')
          if (failed === 'rate') throw failure
          return 10n ** 18n
        })
        const oracle = vi.spyOn(Price.prototype, 'getOraclePrice').mockImplementation(async () => {
          called.push('oracle')
          if (failed === 'oracle') throw failure
          return { anchorPrice: 1n, minPrice: 1n, maxPrice: 1n }
        })
        const buy = vi.spyOn(Price.prototype, 'getBuyPrice').mockRejectedValue(new Error('Unexpected buy quote'))
        const sell = vi.spyOn(Price.prototype, 'getSellPrice').mockRejectedValue(new Error('Unexpected sell quote'))
        const token = market === 'ETH' ? tokens.wstETH : tokens.WBTC
        await expect(new FxSdk()[method]({
          market, type, positionId: 1, userAddress: owner,
          leverage: 2, slippage: 0.5, amount: 10n ** 18n,
          inputTokenAddress: token, outputTokenAddress: token,
          depositTokenAddress: token, withdrawTokenAddress: token,
          depositAmount: 10n ** 18n, mintAmount: 100n * 10n ** 18n,
          repayAmount: 100n * 10n ** 18n, withdrawAmount: 10n ** 16n,
        } as never)).rejects.toBe(failure)
        expect(called).toEqual(['pool', 'rate', 'oracle'])
        expect(buy).not.toHaveBeenCalled()
        expect(sell).not.toHaveBeenCalled()
        for (const spy of [pool, rate, oracle, buy, sell]) spy.mockRestore()
      }
    }
  })
})
