import {type Provider, type Signal, signal} from '@angular/core'
import {runSpeedtest, type SpeedtestClientOptions, SpeedtestTimeoutError} from '@staffetta/client'
import type {SpeedtestLogEntry, SpeedtestStatus} from '@staffetta/core'

export type {
  SpeedtestLogEntry,
  SpeedtestPhase,
  SpeedtestResult,
  SpeedtestStatus,
  SpeedtestVerdict,
} from '@staffetta/core'

export type SpeedtestServiceOptions = Omit<SpeedtestClientOptions, 'signal' | 'onPhase' | 'onSample'>

/**
 * Drives one speedtest at a time: `start()` is a no-op while a test is running, `cancel()`
 * aborts it returning to the idle state. Deliberately decorator-free (plain class + signals),
 * so it ships as regular ESM without an Angular compiler in the loop — register it with
 * {@link provideSpeedtest} (Angular then calls `ngOnDestroy`, aborting a test left running
 * when the owning injector is destroyed) or instantiate it directly.
 */
export class SpeedtestService {
  private readonly statusSignal = signal<SpeedtestStatus>({kind: 'idle'})
  private readonly logSignal = signal<Array<SpeedtestLogEntry>>([])
  private abortController: undefined | AbortController = undefined

  readonly status: Signal<SpeedtestStatus> = this.statusSignal.asReadonly()
  readonly log: Signal<Array<SpeedtestLogEntry>> = this.logSignal.asReadonly()

  start(options: SpeedtestServiceOptions): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      return
    }

    const controller = new AbortController()
    this.abortController = controller
    this.statusSignal.set({kind: 'running', phase: 'ping'})
    this.logSignal.set([])

    runSpeedtest({
      ...options,
      signal: controller.signal,
      onPhase: phase => {
        this.statusSignal.set({kind: 'running', phase})
        this.logSignal.update(prev => [...prev, {kind: 'phase', phase}])
      },
      onSample: sample => {
        this.logSignal.update(prev => [...prev, {kind: 'sample', sample}])
      },
    }).then(
      result => {
        this.abortController = undefined
        this.statusSignal.set({kind: 'done', result})
      },
      (error: unknown) => {
        this.abortController = undefined

        if (controller.signal.aborted) {
          // Cancelled by the user (or injector destroy): back to the initial state, no leftover output.
          this.statusSignal.set({kind: 'idle'})
          this.logSignal.set([])
          return
        }

        if (error instanceof SpeedtestTimeoutError) {
          this.statusSignal.set({kind: 'error', reason: 'timeout', error, partial: error.partial})
          return
        }

        const isTimeout = error instanceof DOMException && error.name === 'TimeoutError'
        this.statusSignal.set({kind: 'error', reason: isTimeout ? 'timeout' : 'failed', error})
      },
    )
  }

  cancel(): void {
    this.abortController?.abort()
  }

  ngOnDestroy(): void {
    this.cancel()
  }
}

/**
 * Registers {@link SpeedtestService} in an injector without decorator metadata — add it to a
 * component's `providers` (one test per component, cleaned up with it) or to the bootstrap
 * providers for an app-wide instance. Then `inject(SpeedtestService)` as usual.
 */
export function provideSpeedtest(): Provider {
  return {provide: SpeedtestService, useFactory: () => new SpeedtestService()}
}
