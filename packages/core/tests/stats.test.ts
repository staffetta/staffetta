import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {
  bytesToMbps,
  computeLatencyStats,
  computeMean,
  computeStdDev,
  computeThroughputSamplesMbps,
  computeThroughputStats,
  roundTo,
} from '../src/index.ts'

describe('bytesToMbps', () => {
  it('converts bytes over elapsed ms to megabits per second', () => {
    // 1_250_000 bytes = 10 Mbit; over 1000 ms → 10 Mbps.
    assert.equal(bytesToMbps(1_250_000, 1000), 10)
  })

  it('returns 0 on a non-positive elapsed time', () => {
    assert.equal(bytesToMbps(1000, 0), 0)
    assert.equal(bytesToMbps(1000, -5), 0)
  })
})

describe('computeMean / computeStdDev', () => {
  it('handles empty input', () => {
    assert.equal(computeMean([]), 0)
    assert.equal(computeStdDev([]), 0)
  })

  it('computes the population standard deviation', () => {
    assert.equal(computeMean([2, 4, 4, 4, 5, 5, 7, 9]), 5)
    assert.equal(computeStdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2)
  })
})

describe('roundTo', () => {
  it('rounds to the requested decimals', () => {
    assert.equal(roundTo(1.005, 1), 1)
    assert.equal(roundTo(1.25, 1), 1.3)
    assert.equal(roundTo(1.2345, 3), 1.235)
  })
})

describe('computeLatencyStats', () => {
  it('reports avg/min/max/jitter rounded to one decimal', () => {
    const stats = computeLatencyStats([10, 20, 30])

    assert.deepEqual(stats, {avgMs: 20, minMs: 10, maxMs: 30, jitterMs: 8.2})
  })
})

describe('computeThroughputStats', () => {
  it('prefers the whole-transfer average when provided', () => {
    const stats = computeThroughputStats([10, 20], 14.5)

    assert.equal(stats.avgMbps, 14.5)
    assert.equal(stats.minMbps, 10)
    assert.equal(stats.maxMbps, 20)
  })

  it('reports the coefficient of variation of the samples', () => {
    const stats = computeThroughputStats([10, 10, 10])

    assert.equal(stats.stabilityCv, 0)
  })
})

describe('computeThroughputSamplesMbps', () => {
  it('buckets chunks into fixed windows, counting empty windows as 0', () => {
    const samples = computeThroughputSamplesMbps(
      [
        {bytes: 125_000, atMs: 50}, // window 0
        {bytes: 125_000, atMs: 250}, // window 2 → window 1 is a stall
      ],
      {startMs: 0, endMs: 300, intervalMs: 100},
    )

    assert.equal(samples.length, 3)
    assert.equal(samples[0], 10)
    assert.equal(samples[1], 0)
    assert.equal(samples[2], 10)
  })

  it('returns no samples on a degenerate time range', () => {
    assert.deepEqual(computeThroughputSamplesMbps([], {startMs: 100, endMs: 100, intervalMs: 100}), [])
  })
})
