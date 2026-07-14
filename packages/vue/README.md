# @staffetta/vue

Vue bindings for the [staffetta](https://github.com/staffetta/staffetta) speedtest client:
a `useSpeedtest` composable with status, live log, start and cancel.

## Install

```sh
npm install @staffetta/vue
```

Requires Vue ≥ 3.3.

## Usage

```vue
<script setup lang="ts">
import {useSpeedtest} from '@staffetta/vue'

const {status, log, start, cancel} = useSpeedtest({baseUrl: 'https://api.example.com'})
</script>

<template>
  <div>
    <button v-if="status.kind === 'idle'" @click="start">Run speedtest</button>
    <button v-if="status.kind === 'running'" @click="cancel">Cancel ({{ status.phase }}…)</button>
    <pre v-if="status.kind === 'done'">{{ status.result }}</pre>
    <p v-if="status.kind === 'error'">Test failed: {{ status.reason }}</p>
    <ul><li v-for="(entry, idx) in log" :key="idx">{{ entry }}</li></ul>
  </div>
</template>
```

`status` and `log` are shallow refs; a test left running is aborted when the owning effect
scope (usually the component) is disposed. Options may be a plain object, a ref or a getter —
they are resolved when `start()` is called.

The composable accepts the same options as
[`@staffetta/client`](https://www.npmjs.com/package/@staffetta/client)'s `runSpeedtest`
(minus `signal`, `onPhase` and `onSample`, which the composable manages): `baseUrl`, `paths`,
`headers`, `fetch`, `config`, `thresholds`. The server side needs the three protocol
endpoints — see [`@staffetta/server`](https://www.npmjs.com/package/@staffetta/server).

Full documentation: [github.com/staffetta/staffetta](https://github.com/staffetta/staffetta).

## License

[MIT](./LICENSE)
