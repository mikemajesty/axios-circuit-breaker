import axios, { type AxiosError } from "axios";
import type Opossum from "opossum";

type HandlerOptions = {
  circuitGroup: string;
};

/**
 * Event names supported by {@link onHttpCircuitEvent}.
 *
 * State-transition events (`open`, `close`, `halfOpen`) and `failure` have
 * dedicated decorators.
 */
export type HttpCircuitEventName =
  | "success"
  | "timeout"
  | "reject"
  | "fire"
  | "cacheHit"
  | "cacheMiss"
  | "semaphoreLocked"
  | "healthCheckFailed"
  | "shutdown";

/** Payload emitted when the circuit opens and starts rejecting calls. */
export type CircuitOpenEvent = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
};

/** Payload emitted when the circuit closes and allows calls normally. */
export type CircuitClosedEvent = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
};

/** Payload emitted after a protected call succeeds. */
export type CircuitSuccessEvent<TResult = unknown> = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Value returned by the protected call. */
  readonly result: TResult;
  /** Time taken by the protected call, in milliseconds. */
  readonly latencyMs: number;
};

/** Payload emitted when a protected call fails and the breaker records it as a failure. */
export type CircuitFailureEvent<TData = unknown> = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Error rejected by the protected call. */
  readonly error: unknown;
  /** The error as an Axios error, when it is one. */
  readonly axiosError?: AxiosError<TData>;
  /** Time taken before the protected call failed, in milliseconds. */
  readonly latencyMs: number;
  /** Arguments passed to the protected method. */
  readonly args: readonly unknown[];
};

/** Payload emitted when the breaker's configured timeout is reached. */
export type CircuitTimeoutEvent<TData = unknown> = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Timeout error. */
  readonly error: unknown;
  /** The error as an Axios error, when it is one. */
  readonly axiosError?: AxiosError<TData>;
};

/** Payload emitted when a call is rejected because the circuit is open. */
export type CircuitRejectEvent<TData = unknown> = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Rejection error. */
  readonly error: unknown;
  /** The error as an Axios error, when it is one. */
  readonly axiosError?: AxiosError<TData>;
};

/** Payload emitted when the reset period ends and the circuit enters half-open state. */
export type CircuitHalfOpenEvent = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Configured reset period, in milliseconds. */
  readonly resetTimeout: number;
};

/** Payload emitted whenever a call is submitted to the circuit breaker. */
export type CircuitFireEvent = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Arguments passed to the protected method. */
  readonly args: readonly unknown[];
};

/** Payload emitted for cache-hit and cache-miss events. */
export type CircuitCacheEvent = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
};

/** Payload emitted when the breaker's concurrency limit prevents a call. */
export type CircuitSemaphoreLockedEvent<TData = unknown> = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Semaphore error. */
  readonly error: unknown;
  /** The error as an Axios error, when it is one. */
  readonly axiosError?: AxiosError<TData>;
};

/** Payload emitted when a configured health check fails. */
export type CircuitHealthCheckFailedEvent<TData = unknown> = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
  /** Health-check error. */
  readonly error: unknown;
  /** The error as an Axios error, when it is one. */
  readonly axiosError?: AxiosError<TData>;
};

/** Payload emitted when the circuit breaker is shut down. */
export type CircuitShutdownEvent = {
  /** Group configured on the protected method. */
  readonly circuitGroup: string;
};

/** Payload passed to a fallback handler. */
export type CircuitFallbackEvent<TArgs extends readonly unknown[] = readonly unknown[]> = {
  /** Arguments from the protected call. */
  readonly input: TArgs;
  /** Error that caused the fallback to run. */
  readonly err: unknown;
};

/** Resolves an event name to the payload type delivered to its handler. */
export type CircuitEventPayload<
  EventName extends HttpCircuitEventName,
  TData = unknown,
  TResult = unknown,
> = EventName extends "success"
  ? CircuitSuccessEvent<TResult>
    : EventName extends "timeout"
      ? CircuitTimeoutEvent<TData>
      : EventName extends "reject"
        ? CircuitRejectEvent<TData>
        : EventName extends "fire"
          ? CircuitFireEvent
          : EventName extends "cacheHit" | "cacheMiss"
            ? CircuitCacheEvent
            : EventName extends "semaphoreLocked"
              ? CircuitSemaphoreLockedEvent<TData>
              : EventName extends "healthCheckFailed"
                ? CircuitHealthCheckFailedEvent<TData>
                : CircuitShutdownEvent;

type EventHandler = (payload: unknown) => unknown;
type FallbackHandler = (payload: CircuitFallbackEvent) => unknown;

type GroupHandlers = {
  events: Map<string, EventHandler[]>;
  fallback?: FallbackHandler;
};

const handlersByInstance = new WeakMap<object, Map<string, GroupHandlers>>();

/**
 * Registers a handler for when a circuit opens.
 *
 * Decorate an instance method that accepts a {@link CircuitOpenEvent}. The
 * handler is associated with the same `circuitGroup` on that instance.
 */
export function onHttpCircuitOpen(options: HandlerOptions) {
  return registerEventHandler<CircuitOpenEvent>(options, "open");
}

/**
 * Registers a handler for when a circuit closes.
 *
 * Decorate an instance method that accepts a {@link CircuitClosedEvent}. The
 * handler is associated with the same `circuitGroup` on that instance.
 */
export function onHttpCircuitClosed(options: HandlerOptions) {
  return registerEventHandler<CircuitClosedEvent>(options, "close");
}

/**
 * Registers a handler for failures recorded by the circuit breaker.
 *
 * Decorate an instance method that accepts a {@link CircuitFailureEvent}.
 * Unlike `reject`, this event describes a failed protected call, not a call
 * blocked because the circuit is already open.
 */
export function onHttpCircuitFailure<TData = unknown>(options: HandlerOptions) {
  return registerEventHandler<CircuitFailureEvent<TData>>(options, "failure");
}

/**
 * Registers a handler for when the reset period ends and the circuit becomes
 * half-open, allowing a trial call.
 *
 * Decorate an instance method that accepts a {@link CircuitHalfOpenEvent}.
 */
export function onHttpCircuitHalfOpen(options: HandlerOptions) {
  return registerEventHandler<CircuitHalfOpenEvent>(options, "halfOpen");
}

/**
 * Registers a handler for a supported Opossum event that does not have a
 * dedicated decorator.
 *
 * Decorate an instance method whose argument matches the payload for
 * `eventName`. The handler is associated with the same `circuitGroup` on that
 * instance. Use the dedicated decorators for `open`, `close`, `halfOpen`, and
 * `failure`.
 */
export function onHttpCircuitEvent<
  EventName extends HttpCircuitEventName,
  TData = unknown,
  TResult = unknown,
>(
  options: HandlerOptions & { eventName: EventName },
) {
  return registerEventHandler<
    CircuitEventPayload<EventName, TData, TResult>
  >(options, options.eventName);
}

/**
 * Registers a fallback for failures in the specified group on this instance.
 *
 * The handler receives the protected method's arguments in `input` and the
 * triggering error in `err`. Only one fallback may be registered for each
 * `circuitGroup` on an instance.
 */
export function onHttpCircuitFallback<
  TArgs extends readonly unknown[] = readonly unknown[],
  TResult = unknown,
>(options: HandlerOptions) {
  validateGroup(options.circuitGroup);

  return registerFallbackHandler<TArgs, TResult>(options);
}

export function attachHttpCircuitHandlers<
  Args extends unknown[],
  Result,
>(
  breaker: Opossum<Args, Result>,
  instance: object,
  circuitGroup: string,
): void {
  const group = handlersByInstance.get(instance)?.get(circuitGroup);
  if (!group) return;

  const dispatch = (eventName: string, ...args: unknown[]) => {
    const handlers = group.events.get(eventName) ?? [];
    const payload = createEventPayload(circuitGroup, eventName, args);
    for (const handler of handlers) {
      handler(payload);
    }
  };

  breaker.on("open", () => dispatch("open"));
  breaker.on("close", () => dispatch("close"));
  breaker.on("success", (result, latencyMs) =>
    dispatch("success", result, latencyMs),
  );
  breaker.on("failure", (error, latencyMs, args) =>
    dispatch("failure", error, latencyMs, args),
  );
  breaker.on("timeout", (error) => dispatch("timeout", error));
  breaker.on("reject", (error) => dispatch("reject", error));
  breaker.on("halfOpen", (resetTimeout) =>
    dispatch("halfOpen", resetTimeout),
  );
  breaker.on("fire", (args) => dispatch("fire", args));
  breaker.on("cacheHit", () => dispatch("cacheHit"));
  breaker.on("cacheMiss", () => dispatch("cacheMiss"));
  breaker.on("semaphoreLocked", (error) =>
    dispatch("semaphoreLocked", error),
  );
  breaker.on("healthCheckFailed", (error) =>
    dispatch("healthCheckFailed", error),
  );
  breaker.on("shutdown", () => dispatch("shutdown"));

  if (group.fallback) {
    const fallback = group.fallback;
    breaker.fallback((...args) => {
      const err = args.at(-1);
      const input = args.slice(0, -1);
      return fallback({ input, err });
    });
  }
}

function registerEventHandler<Payload>(
  options: HandlerOptions,
  eventName: string,
) {
  validateGroup(options.circuitGroup);

  return function <
    This extends object,
  >(
    _method: (this: This, payload: Payload) => unknown,
    context: ClassMethodDecoratorContext<This>,
  ): void {
    if (context.static) {
      throw new TypeError("HTTP circuit handlers can only decorate instance methods.");
    }

    context.addInitializer(function (this: This) {
      const group = getGroupHandlers(this, options.circuitGroup);
      const handlers = group.events.get(eventName) ?? [];
      const handler = context.access.get(this) as Function;
      handlers.push((payload) => Reflect.apply(handler, this, [payload]));
      group.events.set(eventName, handlers);
    });
  };
}

function registerFallbackHandler<
  TArgs extends readonly unknown[],
  TResult,
>(options: HandlerOptions) {
  return function <This extends object>(
    _method: (
      this: This,
      payload: CircuitFallbackEvent<TArgs>,
    ) => TResult | Promise<TResult>,
    context: ClassMethodDecoratorContext<This>,
  ): void {
    if (context.static) {
      throw new TypeError("HTTP circuit handlers can only decorate instance methods.");
    }

    context.addInitializer(function (this: This) {
      const group = getGroupHandlers(this, options.circuitGroup);
      if (group.fallback) {
        throw new TypeError(
          `Only one @onHttpCircuitFallback handler is allowed for circuitGroup "${options.circuitGroup}".`,
        );
      }

      const handler = context.access.get(this) as Function;
      group.fallback = (payload) => Reflect.apply(handler, this, [payload]);
    });
  };
}

function getGroupHandlers(instance: object, circuitGroup: string): GroupHandlers {
  let groups = handlersByInstance.get(instance);
  if (!groups) {
    groups = new Map();
    handlersByInstance.set(instance, groups);
  }

  let group = groups.get(circuitGroup);
  if (!group) {
    group = { events: new Map() };
    groups.set(circuitGroup, group);
  }

  return group;
}

function createEventPayload(
  circuitGroup: string,
  eventName: string,
  args: unknown[],
): unknown {
  switch (eventName) {
    case "open":
      return { circuitGroup } satisfies CircuitOpenEvent;
    case "close":
      return { circuitGroup } satisfies CircuitClosedEvent;
    case "success":
      return {
        circuitGroup,
        result: args[0],
        latencyMs: readNumber(args[1]),
      } satisfies CircuitSuccessEvent;
    case "failure":
      return {
        circuitGroup,
        error: args[0],
        axiosError: getAxiosError(args[0]),
        latencyMs: readNumber(args[1]),
        args: readArray(args[2]),
      } satisfies CircuitFailureEvent;
    case "timeout":
      return {
        circuitGroup,
        error: args[0],
        axiosError: getAxiosError(args[0]),
      } satisfies CircuitTimeoutEvent;
    case "reject":
      return {
        circuitGroup,
        error: args[0],
        axiosError: getAxiosError(args[0]),
      } satisfies CircuitRejectEvent;
    case "halfOpen":
      return {
        circuitGroup,
        resetTimeout: readNumber(args[0]),
      } satisfies CircuitHalfOpenEvent;
    case "fire":
      return {
        circuitGroup,
        args: readArray(args[0]),
      } satisfies CircuitFireEvent;
    case "cacheHit":
    case "cacheMiss":
      return { circuitGroup } satisfies CircuitCacheEvent;
    case "semaphoreLocked":
      return {
        circuitGroup,
        error: args[0],
        axiosError: getAxiosError(args[0]),
      } satisfies CircuitSemaphoreLockedEvent;
    case "healthCheckFailed":
      return {
        circuitGroup,
        error: args[0],
        axiosError: getAxiosError(args[0]),
      } satisfies CircuitHealthCheckFailedEvent;
    case "shutdown":
      return { circuitGroup } satisfies CircuitShutdownEvent;
    default:
      throw new TypeError(`Unsupported circuit event "${eventName}".`);
  }
}

function readNumber(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError("Opossum emitted an event without a numeric value.");
  }

  return value;
}

function readArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Opossum emitted an event without an argument array.");
  }

  return value;
}

function getAxiosError<TData = unknown>(
  error: unknown,
): AxiosError<TData> | undefined {
  return axios.isAxiosError<TData>(error) ? error : undefined;
}

function validateGroup(circuitGroup: string): void {
  if (!circuitGroup.trim()) {
    throw new TypeError("HTTP circuit handlers require a non-empty circuitGroup.");
  }
}
