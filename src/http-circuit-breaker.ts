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
 * statistics. Return `false` to ignore the error for circuit-state purposes;
 * the original rejection is still returned to the caller.
 */
export type ShouldCountAsFailure = (error: unknown) => boolean;

/**
 * Extracts the underlying error used for failure classification. This does
 * not replace the error returned to the caller or included in failure events.
 */
export type GetErrorCause = (error: unknown) => unknown;

/**
 * Configuration for {@link HttpCircuitBreaker}.
 */
export type HttpCircuitBreakerOptions<Args extends unknown[]> = {
  /**
   * Required group name connecting this method to event and fallback
   * decorators on the same instance. It does not share breaker state.
   */
  circuitGroup: string;
  /**
   * Opossum options for this breaker. `errorFilter` is managed internally and
   * cannot be overridden. Defaults include a 20% error threshold, a
   * five-call volume threshold, a 5-second rolling window, and a 2.5-second
   * reset timeout. The Opossum timeout is disabled unless configured.
   */
  options?: Omit<Options<Args>, "errorFilter">;
  /**
   * Extracts a wrapped error before applying the default Axios failure policy
   * or the configured `shouldCountAsFailure` function.
   */
  getErrorCause?: GetErrorCause;
  /**
   * Overrides the default failure policy. By default, network errors, HTTP
   * 408, 429, and 5xx responses count as failures; cancellations and other
   * 4xx responses do not.
   */
  shouldCountAsFailure?: ShouldCountAsFailure;
};

type AsyncMethod<This extends object, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Promise<Result>;

/**
 * Protects an instance method with an Opossum circuit breaker.
 *
 * Supports TypeScript legacy method decorators (`experimentalDecorators`).
 * Breaker state is isolated per decorated method and per instance. Successful
 * results and original rejections are preserved; without a fallback, a
 * rejected call remains rejected.
 *
 * @param configuration Breaker behavior and event-handler group configuration.
 */
export function HttpCircuitBreaker<
  This extends object,
  Args extends unknown[],
  Result,
>(configuration: HttpCircuitBreakerOptions<Args>) {
  if (!configuration.circuitGroup.trim()) {
    throw new TypeError(
      "HttpCircuitBreaker requires a non-empty circuitGroup.",
    );
  }

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
    if (!originalMethod) {
      throw new TypeError("@HttpCircuitBreaker can only decorate methods.");
    }

    const breakers = new WeakMap<This, Opossum<Args, Result>>();
    const getErrorCause = configuration.getErrorCause ?? identity;
    const countAsFailure =
      configuration.shouldCountAsFailure ?? shouldCountAxiosFailure;

    descriptor.value = function (this: This, ...args: Args): Promise<Result> {
      if (
        (typeof this !== "object" || this === null) &&
        typeof this !== "function"
      ) {
        throw new TypeError(
          "@HttpCircuitBreaker methods must be called with an instance.",
        );
      }

      let breaker = breakers.get(this);

      if (!breaker) {
        const options: Options<Args> = {
          ...configuration.options,
          name: configuration.options?.name ?? String(propertyKey),
          group: configuration.options?.group ?? configuration.circuitGroup,
          errorThresholdPercentage:
            configuration.options?.errorThresholdPercentage ??
            DEFAULT_ERROR_THRESHOLD_PERCENTAGE,
          volumeThreshold:
            configuration.options?.volumeThreshold ?? DEFAULT_VOLUME_THRESHOLD,
          rollingCountTimeout:
            configuration.options?.rollingCountTimeout ??
            DEFAULT_ROLLING_COUNT_TIMEOUT,
          resetTimeout:
            configuration.options?.resetTimeout ?? DEFAULT_RESET_TIMEOUT,
          allowWarmUp:
            configuration.options?.allowWarmUp ?? DEFAULT_ALLOW_WARM_UP,
          timeout: configuration.options?.timeout ?? DEFAULT_TIMEOUT,
          errorFilter: (error) => !countAsFailure(getErrorCause(error)),
        };

        breaker = new Opossum<Args, Result>(
          (...currentArgs) => originalMethod.apply(this, currentArgs),
          options,
        );
        attachHttpCircuitHandlers(breaker, this, configuration.circuitGroup);
        breakers.set(this, breaker);
      }

      return breaker.fire(...args);
    };
  };
}

function identity(value: unknown): unknown {
  return value;
}

function shouldCountAxiosFailure(error: unknown): boolean {
  if (axios.isCancel(error)) {
    return false;
  }

  if (!axios.isAxiosError(error)) {
    return true;
  }

  const status = error.response?.status;
  if (status === undefined) {
    return true;
  }

  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}
