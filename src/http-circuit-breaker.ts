import axios from "axios";
import Opossum from "opossum";
import type { Options } from "opossum";

import { attachHttpCircuitHandlers } from "./http-circuit-breaker-events.js";

const DEFAULT_ERROR_THRESHOLD_PERCENTAGE = 20;
const DEFAULT_VOLUME_THRESHOLD = 5;
const DEFAULT_ROLLING_COUNT_TIMEOUT = 5_000;
const DEFAULT_RESET_TIMEOUT = 2_500;
const DEFAULT_ALLOW_WARM_UP = true;
const DEFAULT_TIMEOUT = false;

/**
 * Decides whether an error contributes to the circuit breaker's failure
 * statistics. Returning `false` filters the error from failure accounting.
 *
 * Opossum emits `success` for filtered errors, but still rejects `fire()` with
 * the original error. This preserves the caller's rejection while preventing
 * the error from incrementing the breaker's failure count.
 */
export type ShouldCountAsFailure = (error: unknown) => boolean;

/**
 * Extracts the error used for classification. The extracted value does not
 * replace the original error returned to the caller or sent to event handlers.
 */
export type GetErrorCause = (error: unknown) => unknown;

/** Configuration for {@link HttpCircuitBreaker}. */
export type HttpCircuitBreakerOptions<Args extends unknown[]> = {
  /**
   * Connects this breaker to event and fallback decorators on the same
   * instance. It does not share breaker state.
   */
  circuitGroup: string;

  /** Opossum options. `errorFilter` is managed internally. */
  options?: Omit<Options<Args>, "errorFilter">;

  /** Extracts a wrapped error before applying the failure policy. */
  getErrorCause?: GetErrorCause;

  /**
   * Replaces the default policy. By default, transport errors and HTTP 5xx
   * responses count as failures; cancellations and HTTP 1xx–4xx responses do
   * not.
   */
  shouldCountAsFailure?: ShouldCountAsFailure;
};

type AsyncMethod<This extends object, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Promise<Result>;

/**
 * Protects an asynchronous instance method with an Opossum circuit breaker.
 * Breaker state is isolated per decorated method and per instance.
 *
 * Successful values and original rejections are preserved unless a registered
 * fallback handles the rejection. The decorator supports TypeScript legacy
 * method decorators (`experimentalDecorators`).
 */
export function HttpCircuitBreaker<
  This extends object,
  Args extends unknown[],
  Result,
>(configuration: HttpCircuitBreakerOptions<Args>) {
  const circuitGroup = configuration.circuitGroup;

  if (typeof circuitGroup !== "string" || circuitGroup.trim().length === 0) {
    throw new TypeError(
      "HttpCircuitBreaker requires a non-empty circuitGroup.",
    );
  }

  // Capture configuration when the decorator is created, not on the first call.
  const configuredOptions = { ...configuration.options };
  const getErrorCause = configuration.getErrorCause ?? identity;
  const shouldCountAsFailure =
    configuration.shouldCountAsFailure ?? shouldCountAxiosFailure;

  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<AsyncMethod<This, Args, Result>>,
  ): void {
    if (typeof target === "function") {
      throw new TypeError(
        "@HttpCircuitBreaker can only decorate instance methods.",
      );
    }

    const originalMethod = descriptor.value;

    if (typeof originalMethod !== "function") {
      throw new TypeError("@HttpCircuitBreaker can only decorate methods.");
    }

    const breakers = new WeakMap<This, Opossum<Args, Result>>();

    descriptor.value = function (
      this: This,
      ...args: Args
    ): Promise<Result> {
      if (
        this === null ||
        (typeof this !== "object" && typeof this !== "function")
      ) {
        throw new TypeError(
          "@HttpCircuitBreaker methods must be called with an instance.",
        );
      }

      let breaker = breakers.get(this);

      if (!breaker) {
        const options: Options<Args> = {
          ...configuredOptions,
          name: configuredOptions.name ?? String(propertyKey),
          group: configuredOptions.group ?? circuitGroup,
          errorThresholdPercentage:
            configuredOptions.errorThresholdPercentage ??
            DEFAULT_ERROR_THRESHOLD_PERCENTAGE,
          volumeThreshold:
            configuredOptions.volumeThreshold ?? DEFAULT_VOLUME_THRESHOLD,
          rollingCountTimeout:
            configuredOptions.rollingCountTimeout ??
            DEFAULT_ROLLING_COUNT_TIMEOUT,
          resetTimeout:
            configuredOptions.resetTimeout ?? DEFAULT_RESET_TIMEOUT,
          allowWarmUp:
            configuredOptions.allowWarmUp ?? DEFAULT_ALLOW_WARM_UP,
          timeout: configuredOptions.timeout ?? DEFAULT_TIMEOUT,

          // Opossum returns true when an error must be excluded from failure
          // accounting. Do not invert this predicate.
          errorFilter: (error) =>
            shouldIgnoreFailure(
              error,
              getErrorCause,
              shouldCountAsFailure,
            ),
        };

        const createdBreaker = new Opossum<Args, Result>(
          (...currentArgs) => originalMethod.apply(this, currentArgs),
          options,
        );

        try {
          attachHttpCircuitHandlers(createdBreaker, this, circuitGroup);
        } catch (error) {
          // Preserve the asynchronous method contract when handler resolution
          // fails (for example, duplicate fallback decorators in inheritance).
          return Promise.reject(error);
        }

        breakers.set(this, createdBreaker);
        breaker = createdBreaker;
      }

      return breaker.fire(...args);
    };
  };
}

function identity(value: unknown): unknown {
  return value;
}

/**
 * Returns true when an operation error should be excluded from failure
 * accounting. If extraction or classification throws, the original operation
 * is counted as a failure.
 */
function shouldIgnoreFailure(
  error: unknown,
  getErrorCause: GetErrorCause,
  shouldCountAsFailure: ShouldCountAsFailure,
): boolean {
  try {
    return !shouldCountAsFailure(getErrorCause(error));
  } catch {
    return false;
  }
}

/**
 * Default HTTP dependency-health policy:
 * - transport/network errors count as failures;
 * - HTTP 5xx responses count as failures;
 * - cancellations and all other HTTP statuses do not.
 *
 * Retryability is a separate policy. In particular, 408 and 429 are not
 * automatically counted by the circuit breaker merely because they may be
 * retryable in some applications.
 */
function shouldCountAxiosFailure(error: unknown): boolean {
  if (axios.isCancel(error)) {
    return false;
  }

  if (!axios.isAxiosError(error)) {
    return true;
  }

  const status = error.response?.status;

  // No HTTP response generally means a transport-level failure or timeout.
  if (status === undefined) {
    return true;
  }

  return status >= 500 && status <= 599;
}
