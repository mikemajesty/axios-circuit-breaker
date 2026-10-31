# @mikemajesty/axios-circuit-breaker

Circuit breaker for Axios-backed operations, built on Opossum and TypeScript
legacy method decorators.

The package protects async methods, preserves their successful return values
and original rejections, and optionally provides instance-scoped event
handlers and fallbacks.

## Requirements

- Node.js 20 or later.
- TypeScript 5 or later with `experimentalDecorators` enabled.
- Axios `>=1.6.0 <2`.

## Install

```bash
npm install @mikemajesty/axios-circuit-breaker axios
```

## Quick start

```ts
import axios, { type AxiosResponse } from "axios";
import {
  HttpCircuitBreaker,
  onHttpCircuitFailure,
  onHttpCircuitHalfOpen,
  onHttpCircuitOpen,
  type CircuitFailureEvent,
} from "@mikemajesty/axios-circuit-breaker";

type User = { id: string; name: string };

class UserService {
  @HttpCircuitBreaker({ circuitGroup: "users" })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return axios.get<User>(`/users/${id}`);
  }

  @onHttpCircuitFailure({ circuitGroup: "users" })
  onRequestFailure(event: CircuitFailureEvent) {
    console.error("User dependency failed", event.axiosError?.response?.status);
  }

  @onHttpCircuitOpen({ circuitGroup: "users" })
  onCircuitOpen() {
    console.error("Users circuit opened");
  }

  @onHttpCircuitHalfOpen({ circuitGroup: "users" })
  onCircuitHalfOpen() {
    console.info("Users circuit is allowing a probe request");
  }
}
```

## Core behavior

- Breaker state is isolated per decorated method and per class instance.
- Keep a protected method focused on one dependency call. The breaker observes
  the outcome of the entire decorated method, so unrelated work inside it can
  affect failure statistics and fallback behavior.
- `circuitGroup` is required. It connects a method to event/fallback handlers
  only within the same instance; it does not share circuit state.
- Successful values and rejected errors pass through without being wrapped or
  replaced by the breaker.
- By default, network errors, timeouts, HTTP `408`, `429`, and `5xx` count as
  failures. Axios cancellations and other `4xx` responses do not. Unknown
  non-Axios errors count as failures.
- Axios retry is optional and is not installed by this package. If a method's
  Axios instance retries internally, the breaker sees only the final
  resolution or rejection.
- The Opossum timeout is disabled by default. Set `options.timeout` when you
  want an additional breaker-level time limit; this does not cancel an
  in-flight Axios request.
- Opossum options can be passed through `options`, except `errorFilter`, which
  is controlled by this package.

Default Opossum settings: 20% error threshold, 5-call volume threshold,
5-second rolling window, 2.5-second reset timeout, warm-up enabled, and no
additional Opossum timeout.

### Keep the protected method focused

The method decorated with `@HttpCircuitBreaker` should represent the
dependency operation being protected—ideally one Axios request—and return its
Promise. Do not mix business rules, unrelated calls, or error recovery into
that method. The breaker sees the final outcome of the whole method, not just
the Axios request inside it:

- A validation, mapping, or business-logic exception can be counted as a
  dependency failure even when Axios succeeded.
- Catching an Axios error and returning a default value makes the method look
  successful to the breaker, hiding the dependency failure from its
  statistics.
- Combining multiple dependency calls gives them one shared result: one
  failure can count against this method's circuit, and a fallback may replace
  the result of the entire method.

Keep transformations and business logic outside the decorated method when
they should not affect the dependency circuit. For example, decorate a method
that returns the Axios response, then unwrap or transform it in a separate,
undecorated method. If an HTTP client abstraction performs parsing,
validation, or error conversion before its Promise settles, those outcomes
are part of the decorated method's result too.

## Public decorators

- `@HttpCircuitBreaker({ circuitGroup, ... })` protects an async instance
  method.
- `@onHttpCircuitOpen({ circuitGroup })` observes the open transition.
- `@onHttpCircuitClosed({ circuitGroup })` observes the close transition.
- `@onHttpCircuitHalfOpen({ circuitGroup })` observes when the reset period
  ends and a probe request is allowed.
- `@onHttpCircuitFailure({ circuitGroup })` observes each counted failure.
- `@onHttpCircuitEvent({ circuitGroup, eventName })` observes the remaining
  supported Opossum events: `success`, `timeout`, `reject`, `fire`, `cacheHit`,
  `cacheMiss`, `semaphoreLocked`, `healthCheckFailed`, and
  `shutdown`.
- `@onHttpCircuitFallback({ circuitGroup })` registers one optional fallback
  method per group and instance. It receives `{ input, err }`; `input` contains
  the protected method's arguments.

### What the events mean

| Decorator / event | When it runs | Typical use |
|---|---|---|
| `@onHttpCircuitFailure` / `failure` | A protected action rejects with an error counted by the breaker. | Record the dependency error, latency, and request arguments. |
| `@onHttpCircuitOpen` / `open` | The breaker transitions to open after crossing its failure threshold. | Alert that calls are being blocked or mark the dependency unavailable. |
| `@onHttpCircuitHalfOpen` / `halfOpen` | The reset period ends and the breaker allows a probe call. | Track recovery checks; this event itself is not a successful probe. |
| `@onHttpCircuitClosed` / `close` | The breaker returns to closed, commonly after a successful probe. | Record recovery and resume normal-operation indicators. |
| `@onHttpCircuitEvent({ eventName: "reject" })` / `reject` | A call is rejected because the circuit is already open; the protected action is not run. | Count calls prevented by the breaker separately from dependency failures. |
| `@onHttpCircuitEvent({ eventName: "success" })` / `success` | The action succeeds, or Opossum filters a rejection from failure statistics. | Observe successful results, while accounting for filtered errors. |
| `@onHttpCircuitEvent({ eventName: "timeout" })` / `timeout` | The Opossum timeout expires while the action is pending. | Observe breaker-level timeouts. This package disables that timer by default. |
| `@onHttpCircuitEvent({ eventName: "fire" })` / `fire` | The breaker starts executing the protected action. | Count attempted protected calls. |

`@onHttpCircuitEvent` also supports Opossum's `cacheHit`, `cacheMiss`,
`semaphoreLocked`, `healthCheckFailed`, and `shutdown` events. Their payloads
are described by the exported event types and by the
[Opossum event documentation](https://nodeshift.dev/opossum/).

Event decorators are **optional**: the breaker works without them. Add them
when the application needs operational visibility, such as metrics, logs, or
alerts. Prefer `failure` for individual dependency errors, `open`/`close` for
state changes, `halfOpen` for the start of a recovery probe, and `reject` for
calls blocked while open. `open` and `close` report transitions; they do not
include the error that triggered the transition.

Event handlers run synchronously as Opossum emits events. A thrown handler
error is not swallowed and may affect the operation that emitted the event;
keep handlers quick and make them robust against their own failures.

### When to use a fallback

Fallbacks are also optional. Use one only when the application has a
meaningful degraded response, such as cached or stale-but-acceptable data. A
fallback should preserve the protected method's return contract and should
not silently disguise data that is unsafe or misleading. Without a fallback,
the original rejection is propagated. A fallback runs for counted failures
and calls rejected because the circuit is open; errors filtered from failure
statistics do not trigger it.

See [Examples and behavior](./docs/examples.md) for complete scenarios,
including custom options, wrapped Axios errors, event payloads, fallback, and
the behavior under retries. For details about Opossum options and events, see
the [official Opossum documentation](https://nodeshift.dev/opossum/).

## Development

```bash
npm install
npm test
npm run build
```

The build produces ESM, CommonJS, and TypeScript declarations in `dist/`.
`npm pack --dry-run` previews the files included in a package.

## Publishing

The GitHub Actions workflow at
[`.github/workflows/release.yml`](./.github/workflows/release.yml) publishes
with npm Trusted Publishing. Configure the package's Trusted Publisher in npm,
push the repository to GitHub, then run **Release and Publish** and choose a
version bump.
