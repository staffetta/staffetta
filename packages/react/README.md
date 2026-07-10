# @staffetta/react

React bindings for the [staffetta](https://github.com/staffetta/staffetta) speedtest client:
a `useSpeedtest` hook with status, live log, start and cancel.

## Install

```sh
npm install @staffetta/react
```

Requires React ≥ 18.

## Usage

```tsx
import {useSpeedtest} from '@staffetta/react'

function SpeedtestPanel() {
  const {status, log, start, cancel} = useSpeedtest({baseUrl: 'https://api.example.com'})

  return (
    <div>
      {status.kind === 'idle' && <button onClick={start}>Run speedtest</button>}
      {status.kind === 'running' && <button onClick={cancel}>Cancel ({status.phase}…)</button>}
      {status.kind === 'done' && <pre>{JSON.stringify(status.result, null, 2)}</pre>}
      {status.kind === 'error' && <p>Test failed: {status.reason}</p>}
      <ul>{log.map((entry, idx) => <li key={idx}>{JSON.stringify(entry)}</li>)}</ul>
    </div>
  )
}
```

The hook accepts the same options as
[`@staffetta/client`](https://www.npmjs.com/package/@staffetta/client)'s `runSpeedtest`
(minus `signal`, `onPhase` and `onSample`, which the hook manages): `baseUrl`, `paths`,
`headers`, `fetch`, `config`, `thresholds`. The server side needs the three protocol
endpoints — see [`@staffetta/server`](https://www.npmjs.com/package/@staffetta/server).

Full documentation: [github.com/staffetta/staffetta](https://github.com/staffetta/staffetta).

## License

[MIT](./LICENSE)
