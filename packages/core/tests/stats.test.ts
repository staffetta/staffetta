import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {
  bytesToMbps,
  computeLatencyStats,
  computeLoadedLatency,
  computeMean,
  computePercentile,
  computeStdDev,
  computeThroughputSamplesMbps,
  computeThroughputStats,
  roundTo,
  spreadTransferChunks,
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

describe('computePercentile', () => {
  it('interpolates linearly between the two nearest ranks', () => {
    assert.equal(computePercentile([10, 20, 30], 50), 20)
    assert.equal(computePercentile([10, 20, 30], 90), 28)
    assert.equal(computePercentile([30, 10, 20, 40], 25), 17.5)
  })

  it('handles edge inputs', () => {
    assert.equal(computePercentile([], 50), 0)
    assert.equal(computePercentile([42], 90), 42)
    assert.equal(computePercentile([10, 20], 0), 10)
    assert.equal(computePercentile([10, 20], 100), 20)
  })
})

describe('computeLatencyStats', () => {
  it('reports avg/min/max/percentiles/jitter rounded to one decimal', () => {
    const stats = computeLatencyStats([10, 20, 30])

    assert.deepEqual(stats, {avgMs: 20, minMs: 10, maxMs: 30, p50Ms: 20, p90Ms: 28, jitterMs: 8.2})
  })
})

describe('computeLoadedLatency', () => {
  it('reports the worst-direction median increase over the idle median', () => {
    const idle = computeLatencyStats([10, 20, 30]) // p50 = 20
    const loaded = computeLoadedLatency(idle, [100, 120, 140], [40, 50, 60])

    assert.ok(loaded)
    assert.equal(loaded.download.p50Ms, 120)
    assert.equal(loaded.upload.p50Ms, 50)
    assert.equal(loaded.bufferbloatMs, 100)
  })

  it('floors the increase at 0 and requires samples on both directions', () => {
    const idle = computeLatencyStats([50, 50, 50])

    assert.equal(computeLoadedLatency(idle, [10, 10], [10, 10])?.bufferbloatMs, 0)
    assert.equal(computeLoadedLatency(idle, [], [10, 10]), undefined)
    assert.equal(computeLoadedLatency(idle, [10, 10], []), undefined)
  })
})

describe('spreadTransferChunks', () => {
  it('spreads the bytes uniformly over the transfer duration', () => {
    const chunks = spreadTransferChunks({bytes: 300, endMs: 1000, elapsedMs: 300, intervalMs: 100})

    assert.equal(chunks.length, 3)
    assert.deepEqual(
      chunks.map(it => it.bytes),
      [100, 100, 100],
    )
    assert.deepEqual(
      chunks.map(it => it.atMs),
      [800, 900, 1000],
    )
  })

  it('degrades to a single chunk on degenerate durations', () => {
    assert.deepEqual(spreadTransferChunks({bytes: 100, endMs: 50, elapsedMs: 0, intervalMs: 100}), [
      {bytes: 100, atMs: 50},
    ])
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

  it('excludes the single best and worst sample from the CV, keeping raw min/max', () => {
    const stats = computeThroughputStats([10, 10, 10, 10, 10, 30])

    assert.equal(stats.stabilityCv, 0)
    assert.equal(stats.minMbps, 10)
    assert.equal(stats.maxMbps, 30)
  })

  it('does not trim the CV when there are too few samples', () => {
    const noisy = computeThroughputStats([10, 10, 10, 30])

    assert.ok(noisy.stabilityCv > 0)
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

  it('merges the trailing remainder into the last window instead of a noisy partial window', () => {
    // 250 ms over 100 ms windows → 2 windows, the last one 150 ms long. The chunk at 240 ms
    // would rate 20 Mbps over a 50 ms partial window; over the merged window it rates 6.67.
    const samples = computeThroughputSamplesMbps([{bytes: 125_000, atMs: 240}], {
      startMs: 0,
      endMs: 250,
      intervalMs: 100,
    })

    assert.equal(samples.length, 2)
    assert.equal(samples[0], 0)
    assert.ok(samples[1] && Math.abs(samples[1] - (125_000 * 8) / 1000 / 150) < 1e-9)
  })

  it('returns no samples on a degenerate time range', () => {
    assert.deepEqual(computeThroughputSamplesMbps([], {startMs: 100, endMs: 100, intervalMs: 100}), [])
  })
})
