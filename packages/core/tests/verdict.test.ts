import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {computeVerdict, type SpeedtestLatencyStats, type SpeedtestThroughputStats} from '../src/index.ts'

function latency(overrides: Partial<SpeedtestLatencyStats> = {}): SpeedtestLatencyStats {
  return {avgMs: 20, minMs: 10, maxMs: 30, jitterMs: 5, ...overrides}
}

function throughput(overrides: Partial<SpeedtestThroughputStats> = {}): SpeedtestThroughputStats {
  return {avgMbps: 100, minMbps: 80, maxMbps: 120, stabilityCv: 0.1, ...overrides}
}

describe('computeVerdict', () => {
  it('reports critical when either direction is below the minimum', () => {
    assert.equal(
      computeVerdict({latency: latency(), download: throughput({avgMbps: 1}), upload: throughput()}),
      'critical',
    )
    assert.equal(
      computeVerdict({latency: latency(), download: throughput(), upload: throughput({avgMbps: 0.5})}),
      'critical',
    )
  })

  it('reports unstable on high jitter or high throughput CV', () => {
    assert.equal(
      computeVerdict({latency: latency({jitterMs: 45}), download: throughput(), upload: throughput()}),
      'unstable',
    )
    assert.equal(
      computeVerdict({latency: latency(), download: throughput({stabilityCv: 0.5}), upload: throughput()}),
      'unstable',
    )
  })

  it('reports optimal when jitter and CV are low on both directions', () => {
    assert.equal(computeVerdict({latency: latency(), download: throughput(), upload: throughput()}), 'optimal')
  })

  it('reports good in between', () => {
    assert.equal(
      computeVerdict({latency: latency({jitterMs: 20}), download: throughput(), upload: throughput()}),
      'good',
    )
  })

  it('honors custom thresholds', () => {
    assert.equal(
      computeVerdict(
        {latency: latency(), download: throughput({avgMbps: 100}), upload: throughput()},
        {
          minDownloadMbps: 200,
          minUploadMbps: 1,
          optimalMaxJitterMs: 10,
          optimalMaxCv: 0.15,
          unstableMinJitterMs: 30,
          unstableMinCv: 0.3,
        },
      ),
      'critical',
    )
  })
})
