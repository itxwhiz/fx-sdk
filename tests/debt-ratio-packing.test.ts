import { describe, expect, it } from 'vitest'
import {
  Decimal,
  getDebtRatioRange,
  getEncodeMiscData,
  getEncodeMiscDataWithSlippage,
} from '../src/utils'

const LIMIT = 1n << 60n
const MASK = LIMIT - 1n

function expectRoundTrip(min: bigint, max: bigint) {
  const encoded = getEncodeMiscData(min.toString(), max.toString())
  expect(typeof encoded).toBe('string')
  const packed = BigInt(encoded)
  expect(packed).toBe((max << 60n) | min)
  expect(packed & MASK).toBe(min)
  expect((packed >> 60n) & MASK).toBe(max)
  expect(packed >> 120n).toBe(0n)
}

describe('getEncodeMiscData', () => {
  it('preserves both uint60 fields exactly at the boundaries', () => {
    for (const [min, max] of [
      [0n, 0n], [0n, 1n], [1n, 1n], [0n, MASK],
      [MASK - 1n, MASK], [MASK, MASK],
      [10n ** 18n - 1n, 10n ** 18n],
    ] as const) expectRoundTrip(min, max)
    expect(getEncodeMiscData('0001', '0002')).toBe(getEncodeMiscData('1', '2'))
  })

  it('round trips a deterministic sweep across the uint60 domain', () => {
    let seed = 0x123456789abcdefn
    const next = () => (seed = (seed * 6364136223846793005n + 1n) & MASK)
    for (let index = 0; index < 1024; index++) {
      const a = next()
      const b = next()
      expectRoundTrip(a < b ? a : b, a < b ? b : a)
    }
  })

  it('preserves a real-sized range that default Decimal precision rounds', () => {
    const min = 329949991123456789n
    const max = 336649990923456789n
    const ratio = 333333333333333333n
    const LegacyDecimal = Decimal.clone({ precision: 20, rounding: 4 })
    const oldPacked = BigInt(new LegacyDecimal(max.toString())
      .times(new LegacyDecimal(2).pow(60)).plus(min.toString()).toFixed(0))
    expect(oldPacked & MASK).toBe(334782144128679936n)
    expect(ratio >= min && ratio <= max).toBe(true)
    expect(ratio < (oldPacked & MASK)).toBe(true)
    expectRoundTrip(min, max)
  })

  it('does not depend on or mutate Decimal precision', () => {
    const precision = Decimal.precision
    expectRoundTrip(329949991123456789n, 336649990923456789n)
    expect(Decimal.precision).toBe(precision)
  })

  it('preserves the existing slippage range calculation', () => {
    for (const target of ['0', '500000000000000000', '850000000000000000']) {
      for (const slippage of [0, 1, 100, 500]) {
        const [min, max] = getDebtRatioRange(target, slippage)
        const packed = BigInt(getEncodeMiscDataWithSlippage(target, slippage))
        expect(packed & MASK).toBe(BigInt(min!))
        expect(packed >> 60n).toBe(BigInt(max!))
      }
    }
  })

  it('rejects inputs other than nonempty unsigned decimal integer strings', () => {
    const encode = getEncodeMiscData as (min: unknown, max: unknown) => string
    for (const invalid of [
      undefined, null, false, 1, 1n, NaN, Infinity, '', ' ', '-1', '+1',
      '1.0', '1e18', '0x10', '1_000', '1\n', {}, [],
    ]) {
      expect(() => encode(invalid, '10')).toThrow(TypeError)
      expect(() => encode('0', invalid)).toThrow(TypeError)
    }
  })

  it('rejects overflowing or reversed fields instead of corrupting adjacent bits', () => {
    for (const overflow of [LIMIT.toString(), (LIMIT + 1n).toString(), '9'.repeat(80)]) {
      expect(() => getEncodeMiscData('0', overflow)).toThrow('fit uint60')
      expect(() => getEncodeMiscData(overflow, overflow)).toThrow('fit uint60')
    }
    expect(() => getEncodeMiscData('2', '1')).toThrow('Minimum debt ratio cannot exceed maximum')
  })
})
