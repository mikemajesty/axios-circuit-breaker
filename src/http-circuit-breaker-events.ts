import axios, { type AxiosError } from "axios";
import type Opossum from "opossum";

type HandlerOptions = { circuitGroup: string };

/** Opossum events exposed by the generic event decorator. */
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

export type CircuitOpenEvent = { readonly circuitGroup: string };
export type CircuitClosedEvent = { readonly circuitGroup: string };

/** `result` is unknown because Opossum also emits `success` for filtered errors. */
export type CircuitSuccessEvent = {
  readonly circuitGroup: string;
  readonly result: unknown;
  readonly latencyMs: number;
};

export type CircuitFailureEvent<TData = unknown> = {
  readonly circuitGroup: string;
  readonly error: unknown;
  readonly axiosError?: AxiosError<TData>;
  readonly latencyMs: number;
  readonly args: readonly unknown[];
};

export type CircuitTimeoutEvent<TData = unknown> = {
  readonly circuitGroup: string;
  readonly error: unknown;
  readonly axiosError?: AxiosError<TData>;
};

export type CircuitRejectEvent<TData = unknown> = {
  readonly circuitGroup: string;
  readonly error: unknown;
  readonly axiosError?: AxiosError<TData>;
};

export type CircuitHalfOpenEvent = {
  readonly circuitGroup: string;
  readonly resetTimeout: number;
};

export type CircuitFireEvent = {
  readonly circuitGroup: string;
  readonly args: readonly unknown[];
};

export type CircuitCacheEvent = { readonly circuitGroup: string };

export type CircuitSemaphoreLockedEvent<TData = unknown> = {
  readonly circuitGroup: string;
  readonly error: unknown;
  readonly axiosError?: AxiosError<TData>;
};

export type CircuitHealthCheckFailedEvent<TData = unknown> = {
  readonly circuitGroup: string;
  readonly error: unknown;
  readonly axiosError?: AxiosError<TData>;
};

export type CircuitShutdownEvent = { readonly circuitGroup: string };

export type CircuitFallbackEvent<
  TArgs extends readonly unknown[] = readonly unknown[],
> = {
  readonly input: TArgs;
  readonly err: unknown;
};

export type CircuitEventPayload<
  EventName extends HttpCircuitEventName,
  TData = unknown,
> = EventName extends "success"
  ? CircuitSuccessEvent
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
type PrototypeHandlers = {
  events: Map<string, (string | symbol)[]>;
  fallback?: string | symbol;
};

const handlersByPrototype = new WeakMap<object, Map<string, PrototypeHandlers>>();

export function onHttpCircuitOpen(options: HandlerOptions) {
  return registerEventHandler(options, "open");
}

export function onHttpCircuitClosed(options: HandlerOptions) {
  return registerEventHandler(options, "close");
}

export function onHttpCircuitFailure(options: HandlerOptions) {
  return registerEventHandler(options, "failure");
}

export function onHttpCircuitHalfOpen(options: HandlerOptions) {
  return registerEventHandler(options, "halfOpen");
}

/** Registers a handler for a supported Opossum event without a dedicated decorator. */
export function onHttpCircuitEvent<EventName extends HttpCircuitEventName>(
  options: HandlerOptions & { eventName: EventName },
) {
  return registerEventHandler(options, options.eventName);
}

/** Registers the single fallback allowed for a group on an instance. */
export function onHttpCircuitFallback(options: HandlerOptions) {
  const circuitGroup = validateGroup(options.circuitGroup);

  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void {
    assertInstanceMethod(target, descriptor);
    const group = getPrototypeGroup(target, circuitGroup);

    if (group.fallback !== undefined) {
      throw new TypeError(
        `Only one @onHttpCircuitFallback handler is allowed for circuitGroup "${circuitGroup}".`,
      );
    }

    group.fallback = propertyKey;
  };
}

/** Attaches handlers registered on the instance's prototype chain to a breaker. */
export function attachHttpCircuitHandlers<Args extends unknown[], Result>(
  breaker: Opossum<Args, Result>,
  instance: object,
  circuitGroup: string,
): void {
  const handlers = resolveInstanceHandlers(instance, circuitGroup);
  if (!handlers) return;

  const dispatch = (eventName: string, ...eventArgs: unknown[]) => {
    const listeners = handlers.events.get(eventName);
    if (!listeners?.length) return;

    const payload = createEventPayload(circuitGroup, eventName, eventArgs);
    for (const listener of listeners) listener(payload);
  };

  breaker.on("open", () => dispatch("open"));
  breaker.on("close", () => dispatch("close"));
  breaker.on("success", (result: unknown, latency: number) =>
    dispatch("success", result, latency),
  );
  breaker.on("failure", (error: unknown, latency: number, args: unknown[]) =>
    dispatch("failure", error, latency, args),
  );
  breaker.on("timeout", (error: unknown) => dispatch("timeout", error));
  breaker.on("reject", (error: unknown) => dispatch("reject", error));
  breaker.on("halfOpen", (resetTimeout: number) =>
    dispatch("halfOpen", resetTimeout),
  );
  breaker.on("fire", (args: unknown[]) => dispatch("fire", args));
  breaker.on("cacheHit", () => dispatch("cacheHit"));
  breaker.on("cacheMiss", () => dispatch("cacheMiss"));
  breaker.on("semaphoreLocked", (error: unknown) =>
    dispatch("semaphoreLocked", error),
  );
  breaker.on("healthCheckFailed", (error: unknown) =>
    dispatch("healthCheckFailed", error),
  );
  breaker.on("shutdown", () => dispatch("shutdown"));

  if (handlers.fallback) {
    const fallback = handlers.fallback;
    breaker.fallback((...fallbackArgs: unknown[]) => {
      const err = fallbackArgs.at(-1);
      const input = fallbackArgs.slice(0, -1);
      return fallback({ input, err });
    });
  }
}

function registerEventHandler(options: HandlerOptions, eventName: string) {
  const circuitGroup = validateGroup(options.circuitGroup);

  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void {
    assertInstanceMethod(target, descriptor);
    const group = getPrototypeGroup(target, circuitGroup);
    const properties = group.events.get(eventName) ?? [];
    properties.push(propertyKey);
    group.events.set(eventName, properties);
  };
}

function resolveInstanceHandlers(
  instance: object,
  circuitGroup: string,
): GroupHandlers | undefined {
  const chain: object[] = [];
  let prototype = Object.getPrototypeOf(instance) as object | null;

  while (prototype && prototype !== Object.prototype) {
    chain.push(prototype);
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  let resolved: GroupHandlers | undefined;
  let fallback: FallbackHandler | undefined;

  for (const currentPrototype of chain.reverse()) {
    const registered = handlersByPrototype.get(currentPrototype)?.get(circuitGroup);
    if (!registered) continue;

    resolved ??= { events: new Map() };

    for (const [eventName, propertyKeys] of registered.events) {
      const listeners = resolved.events.get(eventName) ?? [];
      for (const propertyKey of propertyKeys) {
        listeners.push((payload) =>
          Reflect.apply(Reflect.get(instance, propertyKey), instance, [payload]),
        );
      }
      resolved.events.set(eventName, listeners);
    }

    if (registered.fallback !== undefined) {
      if (fallback) {
        throw new TypeError(
          `Only one @onHttpCircuitFallback handler is allowed for circuitGroup "${circuitGroup}" across an inheritance chain.`,
        );
      }
      const propertyKey = registered.fallback;
      fallback = (payload) =>
        Reflect.apply(Reflect.get(instance, propertyKey), instance, [payload]);
    }
  }

  if (resolved && fallback) resolved.fallback = fallback;
  return resolved;
}

function getPrototypeGroup(
  prototype: object,
  circuitGroup: string,
): PrototypeHandlers {
  let groups = handlersByPrototype.get(prototype);
  if (!groups) {
    groups = new Map();
    handlersByPrototype.set(prototype, groups);
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
  const errorPayload = () => ({
    circuitGroup,
    error: args[0],
    axiosError: asAxiosError(args[0]),
  });

  switch (eventName) {
    case "open":
    case "close":
    case "cacheHit":
    case "cacheMiss":
    case "shutdown":
      return { circuitGroup };
    case "success":
      return {
        circuitGroup,
        result: args[0],
        latencyMs: requireNumber(args[1], eventName),
      } satisfies CircuitSuccessEvent;
    case "failure":
      return {
        ...errorPayload(),
        latencyMs: requireNumber(args[1], eventName),
        args: requireArray(args[2], eventName),
      } satisfies CircuitFailureEvent;
    case "timeout":
      return errorPayload() satisfies CircuitTimeoutEvent;
    case "reject":
      return errorPayload() satisfies CircuitRejectEvent;
    case "halfOpen":
      return {
        circuitGroup,
        resetTimeout: requireNumber(args[0], eventName),
      } satisfies CircuitHalfOpenEvent;
    case "fire":
      return {
        circuitGroup,
        args: requireArray(args[0], eventName),
      } satisfies CircuitFireEvent;
    case "semaphoreLocked":
      return errorPayload() satisfies CircuitSemaphoreLockedEvent;
    case "healthCheckFailed":
      return errorPayload() satisfies CircuitHealthCheckFailedEvent;
    default:
      throw new TypeError(`Unsupported circuit event "${eventName}".`);
  }
}

function asAxiosError<TData = unknown>(
  error: unknown,
): AxiosError<TData> | undefined {
  return axios.isAxiosError<TData>(error) ? error : undefined;
}

function requireNumber(value: unknown, eventName: string): number {
  if (typeof value !== "number") {
    throw new TypeError(`Opossum emitted ${eventName} without a numeric value.`);
  }
  return value;
}

function requireArray(value: unknown, eventName: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Opossum emitted ${eventName} without an argument array.`);
  }
  return value;
}

function assertInstanceMethod(
  target: object,
  descriptor: PropertyDescriptor,
): void {
  if (typeof target === "function") {
    throw new TypeError("HTTP circuit handlers can only decorate instance methods.");
  }
  if (typeof descriptor.value !== "function") {
    throw new TypeError("HTTP circuit handlers can only decorate methods.");
  }
}

function validateGroup(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("HTTP circuit handlers require a non-empty circuitGroup.");
  }
  return value;
}
