interface ChartPoint {
  tMs: number
  mbps: number
}

const PaddingLeft = 44
const PaddingRight = 10
const PaddingTop = 8
const PaddingBottom = 22

function readTokens() {
  const style = getComputedStyle(document.documentElement)
  return {
    grid: style.getPropertyValue('--line').trim(),
    text: style.getPropertyValue('--ink-faint').trim(),
    series: style.getPropertyValue('--chart-download').trim(),
  }
}

/** Rounds up to a friendly axis ceiling: 1/2/5 × 10^n. */
function niceCeil(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude
  }
  return 10 * magnitude
}

/** Single-series live line chart of the download throughput windows. */
export function createThroughputChart(args: {
  canvas: HTMLCanvasElement
  tooltip: HTMLElement
}) {
  const {canvas, tooltip} = args
  const context = canvas.getContext('2d')!
  let points: Array<ChartPoint> = []
  let hoverX: number | undefined

  function draw() {
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0) return
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    const tokens = readTokens()
    const area = {
      x: PaddingLeft,
      y: PaddingTop,
      w: width - PaddingLeft - PaddingRight,
      h: height - PaddingTop - PaddingBottom,
    }
    const tMax = Math.max(5000, ...points.map(p => p.tMs))
    const yMax = niceCeil(Math.max(1, ...points.map(p => p.mbps)) * 1.05)
    const xOf = (tMs: number) => area.x + (tMs / tMax) * area.w
    const yOf = (mbps: number) => area.y + area.h - (mbps / yMax) * area.h

    context.font = '11px ui-monospace, SF Mono, Menlo, monospace'

    // Recessive horizontal grid with y labels at 0 / ½ / max.
    context.lineWidth = 1
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    for (const fraction of [0, 0.5, 1]) {
      const y = yOf(yMax * fraction)
      context.strokeStyle = tokens.grid
      context.fillStyle = tokens.text
      context.beginPath()
      context.moveTo(area.x, y)
      context.lineTo(area.x + area.w, y)
      context.stroke()
      context.fillText(String(Math.round(yMax * fraction)), area.x - 8, y)
    }

    // X labels every second.
    context.textAlign = 'center'
    context.textBaseline = 'top'
    for (let second = 0; second <= tMax / 1000; second++) {
      context.fillText(`${second}s`, xOf(second * 1000), area.y + area.h + 8)
    }

    // The 2px series line.
    if (points.length > 0) {
      context.strokeStyle = tokens.series
      context.lineWidth = 2
      context.lineJoin = 'round'
      context.beginPath()
      for (const [index, point] of points.entries()) {
        const x = xOf(point.tMs)
        const y = yOf(point.mbps)
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      }
      context.stroke()
    }

    // Crosshair, emphasized nearest point, tooltip.
    if (hoverX !== undefined && hoverX >= area.x && hoverX <= area.x + area.w) {
      const tAt = ((hoverX - area.x) / area.w) * tMax
      context.strokeStyle = tokens.text
      context.lineWidth = 1
      context.setLineDash([3, 3])
      context.beginPath()
      context.moveTo(hoverX, area.y)
      context.lineTo(hoverX, area.y + area.h)
      context.stroke()
      context.setLineDash([])

      const nearest = nearestPoint(tAt)
      if (nearest) {
        context.fillStyle = tokens.series
        context.beginPath()
        context.arc(xOf(nearest.tMs), yOf(nearest.mbps), 4, 0, Math.PI * 2)
        context.fill()

        tooltip.hidden = false
        tooltip.textContent = `t=${(nearest.tMs / 1000).toFixed(2)}s\n${nearest.mbps.toFixed(1)} Mbps`
        const flip = hoverX > area.x + area.w * 0.7
        tooltip.style.left = flip ? `${hoverX - tooltip.offsetWidth - 10}px` : `${hoverX + 10}px`
        tooltip.style.top = `${area.y + 4}px`
      } else {
        tooltip.hidden = true
      }
    } else {
      tooltip.hidden = true
    }
  }

  function nearestPoint(tMs: number): ChartPoint | undefined {
    if (points.length === 0) return undefined
    let best = points[0]!
    for (const point of points) {
      if (Math.abs(point.tMs - tMs) < Math.abs(best.tMs - tMs)) best = point
    }
    return Math.abs(best.tMs - tMs) <= 400 ? best : undefined
  }

  canvas.addEventListener('pointermove', event => {
    hoverX = event.offsetX
    draw()
  })
  canvas.addEventListener('pointerleave', () => {
    hoverX = undefined
    draw()
  })

  new ResizeObserver(draw).observe(canvas)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw)

  return {
    addSample(tMs: number, mbps: number) {
      points.push({tMs, mbps})
      draw()
    },
    reset() {
      points = []
      hoverX = undefined
      draw()
    },
  }
}
