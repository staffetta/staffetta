# @staffetta/angular

Angular bindings for the [staffetta](https://github.com/staffetta/staffetta) speedtest client:
a signal-based `SpeedtestService` with status, live log, start and cancel.

## Install

```sh
npm install @staffetta/angular
```

Requires Angular ≥ 17.

## Usage

```ts
import {Component, inject} from '@angular/core'
import {provideSpeedtest, SpeedtestService} from '@staffetta/angular'

@Component({
  selector: 'speedtest-panel',
  providers: [provideSpeedtest()],
  template: `
    @if (speedtest.status(); as status) {
      @if (status.kind === 'idle') {
        <button (click)="speedtest.start({baseUrl: 'https://api.example.com'})">Run speedtest</button>
      }
      @if (status.kind === 'running') {
        <button (click)="speedtest.cancel()">Cancel ({{ status.phase }}…)</button>
      }
      @if (status.kind === 'done') {
        <pre>{{ status.result | json }}</pre>
      }
      @if (status.kind === 'error') {
        <p>Test failed: {{ status.reason }}</p>
      }
    }
    <ul>
      @for (entry of speedtest.log(); track $index) {
        <li>{{ entry | json }}</li>
      }
    </ul>
  `,
})
export class SpeedtestPanel {
  readonly speedtest = inject(SpeedtestService)
}
```

`status` and `log` are read-only signals. The service is deliberately decorator-free (no
`@Injectable`), so the package ships as plain ESM with no Angular compiler in the loop:
register it with `provideSpeedtest()` — in a component's `providers` for one test per
component (Angular calls `ngOnDestroy`, aborting a test left running), or in the bootstrap
providers for an app-wide instance — or just `new SpeedtestService()` yourself.

`start()` accepts the same options as
[`@staffetta/client`](https://www.npmjs.com/package/@staffetta/client)'s `runSpeedtest`
(minus `signal`, `onPhase` and `onSample`, which the service manages): `baseUrl`, `paths`,
`headers`, `fetch`, `config`, `thresholds`. The server side needs the three protocol
endpoints — see [`@staffetta/server`](https://www.npmjs.com/package/@staffetta/server).

Full documentation: [github.com/staffetta/staffetta](https://github.com/staffetta/staffetta).

## License

[MIT](./LICENSE)
