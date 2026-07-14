import {runSpeedtest, type SpeedtestClientOptions, SpeedtestTimeoutError} from '@staffetta/client'
import type {SpeedtestLogEntry, SpeedtestStatus} from '@staffetta/core'
import {getCurrentScope, type MaybeRefOrGetter, onScopeDispose, type ShallowRef, shallowRef, toValue} from 'vue'

export type {SpeedtestLogEntry, SpeedtestStatus} from '@staffetta/core'

export type UseSpeedtestOptions = Omit<SpeedtestClientOptions, 'signal' | 'onPhase' | 'onSample'>

/**
 * Drives one speedtest at a time: `start()` is a no-op while a test is running, `cancel()`
 * aborts it (also on scope dispose, e.g. component unmount) returning to the idle state.
 * `options` may be a plain object, a ref or a getter — it is resolved when `start()` is called.
 */
export function useSpeedtest(options: MaybeRefOrGetter<UseSpeedtestOptions>): UseSpeedtestContract {
  const status = shallowRef<SpeedtestStatus>({kind: 'idle'})
  const log = shallowRef<Array<SpeedtestLogEntry>>([])
  let abortController: undefined | AbortController

  // Aborts a test left running when the owning effect scope (component) is disposed.
  if (getCurrentScope()) {
    onScopeDispose(() => abortController?.abort())
  }

  const start = () => {
    if (abortController && !abortController.signal.aborted) {
      return
    }

    const controller = new AbortController()
    abortController = controller
    status.value = {kind: 'running', phase: 'ping'}
    log.value = []

    runSpeedtest({
      ...toValue(options),
      signal: controller.signal,
      onPhase: phase => {
        status.value = {kind: 'running', phase}
        log.value = [...log.value, {kind: 'phase', phase}]
      },
      onSample: sample => {
        log.value = [...log.value, {kind: 'sample', sample}]
      },
    }).then(
      result => {
        abortController = undefined
        status.value = {kind: 'done', result}
      },
      (error: unknown) => {
        abortController = undefined

        if (controller.signal.aborted) {
          // Cancelled by the user (or scope dispose): back to the initial state, no leftover output.
          status.value = {kind: 'idle'}
          log.value = []
          return
        }

        if (error instanceof SpeedtestTimeoutError) {
          status.value = {kind: 'error', reason: 'timeout', error, partial: error.partial}
          return
        }

        const isTimeout = error instanceof DOMException && error.name === 'TimeoutError'
        status.value = {kind: 'error', reason: isTimeout ? 'timeout' : 'failed', error}
      },
    )
  }

  const cancel = () => {
    abortController?.abort()
  }

  return {status, log, start, cancel}
}

// Types ///////////////////////////////////////////////////////////////////////

export interface UseSpeedtestContract {
  status: Readonly<ShallowRef<SpeedtestStatus>>
  log: Readonly<ShallowRef<Array<SpeedtestLogEntry>>>
  start: () => void
  cancel: () => void
}
