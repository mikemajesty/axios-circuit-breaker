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

export type ShouldCountAsFailure = (error: unknown) => boolean;
export type GetErrorCause = (error: unknown) => unknown;

export type HttpCircuitBreakerOptions<Args extends unknown[]> = {
  circuitGroup: string;
  options?: Omit<Options<Args>, "errorFilter">;
  getErrorCause?: GetErrorCause;
  shouldCountAsFailure?: ShouldCountAsFailure;
};

type AsyncMethod<This extends object, Args extends unknown[], Result> = (
  this: This,
  ...args: Args
) => Promise<Result>;

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
