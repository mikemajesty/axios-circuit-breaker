# Examples and behavior

These examples show what the decorators do at runtime. They use TypeScript
standard decorators; do not enable `experimentalDecorators`.

## 1. Protecting a request

```ts
import axios, { type AxiosResponse } from "axios";
import { HttpCircuitBreaker } from "@mikemajesty/axios-circuit-breaker";

type User = { id: string; name: string };

class UserService {
  @HttpCircuitBreaker({ circuitGroup: "users" })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return axios.get<User>(`https://api.example.com/users/${id}`);
  }
}
```

Calling `getUser("42")` executes the method through a breaker. On success, the
same `AxiosResponse<User>` is returned. If the call rejects and there is no
fallback, the caller receives the original rejection, not a new breaker
exception.

The circuit belongs to the `getUser` method on that particular `UserService`
instance. Another method or another instance gets a separate circuit.

## Keep the decorated method focused on the dependency call

The breaker observes the outcome of the **entire decorated method**. To make
its statistics represent the health of one dependency operation, keep that
method small and have it return the Axios Promise:

```ts
class UserService {
  @HttpCircuitBreaker({ circuitGroup: "users" })
  getUserResponse(id: string): Promise<AxiosResponse<User>> {
    return axios.get<User>(`https://api.example.com/users/${id}`);
  }

  async getUser(id: string): Promise<User> {
    const response = await this.getUserResponse(id);
    return normalizeUser(response.data);
  }
}
```

Here, the breaker measures the HTTP request. Unwrapping and normalizing the
successful response happen after the protected method has completed, so an
exception from `normalizeUser` does not count as an HTTP dependency failure.
The original HTTP rejection still propagates through `getUserResponse` and
can be counted by its breaker.

Avoid putting unrelated logic in the protected method:

```ts
@HttpCircuitBreaker({ circuitGroup: "users" })
async getUser(id: string): Promise<User> {
  try {
    const response = await axios.get<User>(`/users/${id}`);
    return normalizeUser(response.data);
  } catch {
    return defaultUser(id);
  }
}
```

This version can mask the Axios rejection: because the method catches it and
returns a value, the breaker sees a success and does not record that failure.
If `normalizeUser` throws after Axios succeeds, the breaker instead sees that
exception as the method's failure, even though the HTTP request itself worked.
Combining multiple HTTP calls in one decorated method has a similar effect:
they share one circuit result, and a fallback applies to the whole method.

If an HTTP client abstraction performs response parsing, schema validation,
or error conversion before its Promise settles, those errors are part of the
decorated method's outcome too. Decide whether that is the boundary you want
the circuit to protect.

## 2. Configure breaker options

```ts
@HttpCircuitBreaker({
  circuitGroup: "payments",
  options: {
    errorThresholdPercentage: 50,
    volumeThreshold: 10,
    rollingCountTimeout: 10_000,
    resetTimeout: 3_000,
    timeout: 2_000,
  },
})
charge(orderId: string): Promise<Payment> {
  return this.paymentClient.charge(orderId);
}
```

`options` are passed to Opossum, except `errorFilter`, which is reserved for
the library's error classification. By default, the Opossum timeout is
disabled (`timeout: false`), so an existing Axios timeout or propagated
request deadline can control the operation without racing a second timer.
Set a numeric `timeout` when you explicitly want an additional breaker-level
limit:

```ts
@HttpCircuitBreaker({
  circuitGroup: "payments",
  options: { timeout: 2_000 },
})
charge(orderId: string): Promise<Payment> {
  return this.paymentClient.charge(orderId);
}
```

An Opossum timeout limits how long the breaker waits for the action; it does
not guarantee that an already-started Axios request is cancelled. Choose it
alongside Axios timeouts, retry limits, and any request deadline.

If not supplied, the defaults are `errorThresholdPercentage: 20`,
`volumeThreshold: 5`, `rollingCountTimeout: 5000`, `resetTimeout: 2500`, and
`allowWarmUp: true`; the Opossum timeout is disabled.

## 3. Observe failures and circuit transitions

```ts
import {
  HttpCircuitBreaker,
  onHttpCircuitEvent,
  onHttpCircuitFailure,
  onHttpCircuitHalfOpen,
  onHttpCircuitOpen,
  onHttpCircuitClosed,
  type CircuitFailureEvent,
  type CircuitOpenEvent,
  type CircuitClosedEvent,
  type CircuitHalfOpenEvent,
} from "@mikemajesty/axios-circuit-breaker";

class CatalogService {
  @HttpCircuitBreaker({ circuitGroup: "catalog" })
  getItem(id: string): Promise<Item> {
    return this.catalogClient.getItem(id);
  }

  @onHttpCircuitFailure({ circuitGroup: "catalog" })
  onFailure(event: CircuitFailureEvent) {
    console.error("Request failure", {
      error: event.error,
      status: event.axiosError?.response?.status,
      latencyMs: event.latencyMs,
      args: event.args,
    });
  }

  @onHttpCircuitOpen({ circuitGroup: "catalog" })
  onOpen(event: CircuitOpenEvent) {
    console.warn(`Circuit ${event.circuitGroup} opened`);
  }

  @onHttpCircuitClosed({ circuitGroup: "catalog" })
  onClosed(event: CircuitClosedEvent) {
    console.info(`Circuit ${event.circuitGroup} closed`);
  }

  @onHttpCircuitHalfOpen({ circuitGroup: "catalog" })
  onHalfOpen(event: CircuitHalfOpenEvent) {
    console.info(
      `Circuit ${event.circuitGroup} allows a probe after ${event.resetTimeout}ms`,
    );
  }
}
```

`failure` is emitted for each failure counted by Opossum and carries the
original error, latency, and method arguments. `open` and `close` are state
transitions; they do not carry the error that caused the transition. Use
`failure` to inspect individual errors and `open` to react to the circuit
state.

Handlers are associated by group only within their instance. Two methods in
the same instance and group can use the same event handlers while maintaining
independent circuit state. A handler on another instance will not receive
these events.

Handlers run synchronously. An exception thrown by a handler is not swallowed
and may affect the operation that emitted the event. Keep handlers quick and
make them robust against their own failures.

### Other supported events

`@onHttpCircuitEvent` accepts `success`, `timeout`, `reject`, `fire`, `cacheHit`,
`cacheMiss`, `semaphoreLocked`, `healthCheckFailed`, and
`shutdown`. Its payload shape depends on the event; exported types include
`CircuitSuccessEvent`, `CircuitTimeoutEvent`, `CircuitRejectEvent`,
and the corresponding event types. Use dedicated decorators
`@onHttpCircuitHalfOpen` for the half-open transition and
`@onHttpCircuitFailure` for individual failure events.

An error excluded from failure statistics is still a rejected method call.
Opossum reports it via `success` because it is filtered from failure counting;
in that case the event's `result` contains the rejection value rather than a
normal successful response.

## 4. Use a fallback

```ts
import axios, { type AxiosResponse } from "axios";
import {
  HttpCircuitBreaker,
  onHttpCircuitFallback,
  type CircuitFallbackEvent,
} from "@mikemajesty/axios-circuit-breaker";

type User = { id: string; name: string };

class UserService {
  constructor(private readonly cache: UserCache) {}

  @HttpCircuitBreaker({ circuitGroup: "users" })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return axios.get<User>(`https://api.example.com/users/${id}`);
  }

  @onHttpCircuitFallback<[string], AxiosResponse<User>>({
    circuitGroup: "users",
  })
  getCachedUser(
    { input, err }: CircuitFallbackEvent<[string]>,
  ): Promise<AxiosResponse<User>> {
    const [id] = input;
    console.warn("Using cached user after dependency failure", { id, err });
    return this.cache.getUser(id);
  }
}
```

The fallback receives the protected method's arguments as the `input` tuple
and the original rejection as `err`. Its return value becomes the result of
the protected call, so it must match the method's return type. Opossum invokes
the fallback for counted failures and calls rejected because the circuit is
open. Errors filtered from failure counting do not invoke fallback. Without a
registered fallback, the original rejection is propagated.

Register at most one fallback decorator for a given group on an instance. A
fallback group can be shared by multiple protected methods, but those methods
still have separate breakers and must have compatible fallback return types.

## 5. Classify wrapped Axios errors

Applications sometimes wrap an `AxiosError` in their own exception. Use
`getErrorCause` to expose the underlying error to the default Axios
classification without coupling this package to the application's exception
class. If the application's exception provides a `getCause()` method, call it
inside `getErrorCause`:

```ts
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { HttpCircuitBreaker } from "@mikemajesty/axios-circuit-breaker";

type User = { id: string; name: string };

class ApplicationHttpError extends Error {
  constructor(
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }

  getCause<T>(): T {
    return this.cause as T;
  }
}

class UserService {
  constructor(private readonly client: AxiosInstance) {}

  @HttpCircuitBreaker({
    circuitGroup: "users",
    getErrorCause: (error) =>
      error instanceof ApplicationHttpError ? error.getCause<unknown>() : error,
  })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return this.client.get<User>(`/users/${id}`).catch((error: unknown) => {
      throw new ApplicationHttpError("User request failed", error);
    });
  }
}
```

The extracted error is only used to decide whether the breaker counts the
failure. The method still rejects with the original wrapped exception.
`getErrorCause` does not assume every cause is Axios: if the returned value is
not an Axios error, the default policy counts it as a failure.

`getCause()` here belongs to the example application's error class; the
circuit-breaker package does not call it or depend on that convention itself.
`getErrorCause` is the adapter between the application's wrapper and the
library's Axios-aware failure classification.

By default, network errors, timeouts, HTTP `408`, `429`, and `5xx` count as
failures; Axios cancellations and other `4xx` responses do not. This is a
policy for breaker statistics, not error handling: a filtered `4xx` still
rejects to the caller.

If you need to replace that policy, use `shouldCountAsFailure`. When both
callbacks are configured, `shouldCountAsFailure` receives the extracted value:

```ts
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { HttpCircuitBreaker } from "@mikemajesty/axios-circuit-breaker";

type User = { id: string; name: string };

class ApplicationHttpError extends Error {
  constructor(
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }

  getCause<T>(): T {
    return this.cause as T;
  }
}

class UserService {
  constructor(private readonly client: AxiosInstance) {}

  @HttpCircuitBreaker({
    circuitGroup: "users",
    getErrorCause: (error) =>
      error instanceof ApplicationHttpError ? error.getCause<unknown>() : error,
    shouldCountAsFailure: (cause) =>
      axios.isAxiosError(cause) &&
      (cause.response?.status === undefined ||
        cause.response.status === 429 ||
        cause.response.status >= 500),
  })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return this.client
      .get<User>(`https://api.example.com/users/${id}`)
      .catch((error: unknown) => {
        throw new ApplicationHttpError("User request failed", error);
      });
  }
}
```

Supplying `shouldCountAsFailure` replaces the default classification
completely; include any desired cancellation, non-Axios, or `4xx` behavior in
your function.

## 6. Combine the breaker with Axios retry

```ts
import axios, { type AxiosResponse } from "axios";
import axiosRetry from "axios-retry";
import { HttpCircuitBreaker } from "@mikemajesty/axios-circuit-breaker";

const client = axios.create();
axiosRetry(client, { retries: 2 });

class UserService {
  @HttpCircuitBreaker({
    circuitGroup: "users",
    options: { resetTimeout: 2_500 },
  })
  getUser(id: string): Promise<AxiosResponse<User>> {
    return client.get<User>(`https://api.example.com/users/${id}`);
  }
}
```

This package does not configure or require `axios-retry`. If the Axios
instance has a retry interceptor, the breaker sees one logical method call:

- If an internal retry succeeds, the breaker sees a success; intermediate
  failed attempts are not counted by the breaker.
- If all attempts fail, the breaker sees one final rejection and counts one
  failed call, not one failure per HTTP attempt.
- Retries add latency and load. Align their budget with the Axios timeout,
  request deadline, and Opossum `timeout`. Opossum timing out does not
  necessarily cancel the underlying request.

## 7. Customize circuit failure policy

Use `shouldCountAsFailure` when the default Axios policy does not match your
service's semantics:

```ts
import axios from "axios";
import { HttpCircuitBreaker } from "@mikemajesty/axios-circuit-breaker";

class InventoryService {
  @HttpCircuitBreaker({
    circuitGroup: "inventory",
    shouldCountAsFailure: (error) =>
      axios.isAxiosError(error) && error.response?.status === 503,
  })
  getStock(sku: string): Promise<Stock> {
    return this.inventoryClient.getStock(sku);
  }
}
```

The callback decides whether the rejection affects circuit statistics. It
does not convert the rejection into a success: unless a fallback handles it,
the original error remains rejected to the caller.

## 8. Understand group and state isolation

```ts
class DependencyService {
  @HttpCircuitBreaker({ circuitGroup: "dependencies" })
  firstCall(): Promise<string> {
    return this.client.firstCall();
  }

  @HttpCircuitBreaker({ circuitGroup: "dependencies" })
  secondCall(): Promise<string> {
    return this.client.secondCall();
  }
}
```

Both methods can notify handlers registered for `dependencies`, but each
method has its own breaker statistics and state. A second
`DependencyService` instance also has independent breakers and handlers. The
group name is local routing for handlers/fallbacks, not a shared breaker name
or a global event channel.
