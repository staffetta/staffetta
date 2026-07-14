import {runSpeedtest, type SpeedtestPhase, type SpeedtestResult} from '@staffetta/client'
import {createThroughputChart} from './chart.ts'

const BaseUrl = 'https://staffetta-demo.gianmarco-fiorello.workers.dev'

const views = {
  idle: document.getElementById('view-idle')!,
  running: document.getElementById('view-running')!,
  done: document.getElementById('view-done')!,
  error: document.getElementById('view-error')!,
}

const live = document.getElementById('live')!
const verdictEl = document.getElementById('verdict')!
const resultsEl = document.getElementById('results')!
const errorEl = document.getElementById('error')!

const consoleEl = document.getElementById('console')!
const consoleScroll = document.getElementById('console-scroll')!
const consoleToggle = document.getElementById('console-toggle') as HTMLButtonElement
const chartEl = document.getElementById('chart')!
const chart = createThroughputChart({
  canvas: document.getElementById('chart-canvas') as HTMLCanvasElement,
  tooltip: document.getElementById('chart-tooltip')!,
})
const MaxLogLines = 400

let controller: AbortController | undefined

function logLine(kind: string, text: string) {
  const line = document.createElement('div')
  line.className = 'console-line'
  const tag = document.createElement('span')
  tag.className = `console-tag console-tag-${kind}`
  tag.textContent = kind
  line.append(tag, ` ${text}`)
  consoleScroll.append(line)
  while (consoleScroll.childElementCount > MaxLogLines) {
    consoleScroll.firstElementChild?.remove()
  }
  consoleScroll.scrollTop = consoleScroll.scrollHeight
}

const formatMiB = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MiB`

function show(view: keyof typeof views) {
  for (const [name, el] of Object.entries(views)) {
    el.hidden = name !== view
  }
}

function setPhase(phase: SpeedtestPhase) {
  const order: SpeedtestPhase[] = ['ping', 'download', 'upload']
  for (const el of document.querySelectorAll<HTMLElement>('.phase')) {
    const own = el.dataset.phase as SpeedtestPhase
    el.classList.toggle('active', own === phase)
    el.classList.toggle('done', order.indexOf(own) < order.indexOf(phase))
  }
}

async function start() {
  controller = new AbortController()
  show('running')
  live.innerHTML = '&nbsp;'
  consoleScroll.replaceChildren()
  chartEl.hidden = false
  chart.reset()
  logLine('run', `speedtest ${BaseUrl}`)

  try {
    const result = await runSpeedtest({
      baseUrl: BaseUrl,
      signal: controller.signal,
      // Short demo run, sized under the worker's 32 MiB per-request cap.
      config: {transferDurationMs: 5000, maxRequestSizeBytes: 16_777_216},
      onPhase: phase => {
        setPhase(phase)
        logLine('run', `${phase} phase started`)
      },
      onSample: sample => {
        if (sample.phase === 'ping') {
          live.innerHTML = `${sample.rttMs.toFixed(1)} <small>ms</small>`
          logLine('ping', `seq=${sample.seq} time=${sample.rttMs.toFixed(1)} ms`)
        } else if (sample.kind === 'throughput') {
          live.innerHTML = `${sample.mbps.toFixed(1)} <small>Mbps</small>`
          if (sample.phase === 'download') {
            chart.addSample(sample.elapsedMs, sample.mbps)
          }
          logLine(
            sample.phase,
            `t=${(sample.elapsedMs / 1000).toFixed(2)}s  ${sample.mbps.toFixed(1)} Mbps  (${formatMiB(sample.transferredBytes)} total)`,
          )
        } else {
          logLine('probe', `time=${sample.rttMs.toFixed(1)} ms  (under ${sample.phase} load)`)
        }
      },
    })
    logLine('run', `done — verdict: ${result.verdict}`)
    renderResult(result)
    show('done')
  } catch (error) {
    if (controller.signal.aborted) {
      logLine('run', 'cancelled')
      show('idle')
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    logLine('run', `error: ${message}`)
    errorEl.textContent = message
    show('error')
  }
}

function renderResult(result: SpeedtestResult) {
  verdictEl.textContent = result.verdict
  verdictEl.dataset.verdict = result.verdict

  const cells: Array<[string, string, string]> = [
    ['Latency (p50)', result.latency.p50Ms.toFixed(1), 'ms'],
    ['Jitter', result.latency.jitterMs.toFixed(1), 'ms'],
    ['Download', result.download.avgMbps.toFixed(1), 'Mbps'],
    ['Upload', result.upload.avgMbps.toFixed(1), 'Mbps'],
  ]
  if (result.loadedLatency) {
    cells.push(['Bufferbloat', result.loadedLatency.bufferbloatMs.toFixed(0), 'ms'])
  }

  resultsEl.replaceChildren(
    ...cells.map(([label, value, unit]) => {
      const wrap = document.createElement('div')
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      const small = document.createElement('small')
      small.textContent = ` ${unit}`
      dd.append(value, small)
      wrap.append(dt, dd)
      return wrap
    }),
  )
}

consoleToggle.addEventListener('click', () => {
  consoleEl.hidden = !consoleEl.hidden
  consoleToggle.textContent = consoleEl.hidden ? 'Show log' : 'Hide log'
  consoleToggle.setAttribute('aria-expanded', String(!consoleEl.hidden))
})

document.getElementById('start')!.addEventListener('click', start)
document.getElementById('again')!.addEventListener('click', start)
document.getElementById('retry')!.addEventListener('click', start)
document.getElementById('cancel')!.addEventListener('click', () => controller?.abort())
