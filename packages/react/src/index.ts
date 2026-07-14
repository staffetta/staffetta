import {runSpeedtest, type SpeedtestClientOptions, SpeedtestTimeoutError} from '@staffetta/client'
import type {SpeedtestLogEntry, SpeedtestStatus} from '@staffetta/core'
import {useCallback, useEffect, useRef, useState} from 'react'

export type {SpeedtestLogEntry, SpeedtestStatus} from '@staffetta/core'

export type UseSpeedtestOptions = Omit<SpeedtestClientOptions, 'signal' | 'onPhase' | 'onSample'>

/**
 * Drives one speedtest at a time: `start()` is a no-op while a test is running, `cancel()`
 * aborts it (also on unmount) returning to the idle state. `options` is read when `start()`
 * is called, so an inline object literal is fine.
 */
export function useSpeedtest(options: UseSpeedtestOptions): UseSpeedtestContract {
  const [status, setStatus] = useState<SpeedtestStatus>({kind: 'idle'})
  const [log, setLog] = useState<Array<SpeedtestLogEntry>>([])
  const optionsRef = useRef(options)
  optionsRef.current = options
  const abortControllerRef = useRef<undefined | AbortController>(undefined)

  // Aborts a test left running on unmount.
  useEffect(() => () => abortControllerRef.current?.abort(), [])

  const start = useCallback(() => {
    if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
      return
    }

    const abortController = new AbortController()
    abortControllerRef.current = abortController
    setStatus({kind: 'running', phase: 'ping'})
    setLog([])

    runSpeedtest({
      ...optionsRef.current,
      signal: abortController.signal,
      onPhase: phase => {
        setStatus({kind: 'running', phase})
        setLog(prev => [...prev, {kind: 'phase', phase}])
      },
      onSample: sample => {
        setLog(prev => [...prev, {kind: 'sample', sample}])
      },
    }).then(
      result => {
        abortControllerRef.current = undefined
        setStatus({kind: 'done', result})
      },
      (error: unknown) => {
        abortControllerRef.current = undefined

        if (abortController.signal.aborted) {
          // Cancelled by the user (or unmount): back to the initial state, no leftover output.
          setStatus({kind: 'idle'})
          setLog([])
          return
        }

        if (error instanceof SpeedtestTimeoutError) {
          setStatus({kind: 'error', reason: 'timeout', error, partial: error.partial})
          return
        }

        const isTimeout = error instanceof DOMException && error.name === 'TimeoutError'
        setStatus({kind: 'error', reason: isTimeout ? 'timeout' : 'failed', error})
      },
    )
  }, [])

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  return {status, log, start, cancel}
}

// Types ///////////////////////////////////////////////////////////////////////

export interface UseSpeedtestContract {
  status: SpeedtestStatus
  log: Array<SpeedtestLogEntry>
  start: () => void
  cancel: () => void
}
