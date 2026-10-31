import assert from "node:assert/strict";
import { describe, it } from "node:test";
import axios, {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import {
  onHttpCircuitClosed,
  onHttpCircuitEvent,
  onHttpCircuitFailure,
  onHttpCircuitFallback,
  onHttpCircuitHalfOpen,
  onHttpCircuitOpen,
  HttpCircuitBreaker,
  type CircuitFailureEvent,
  type CircuitFallbackEvent,
  type CircuitHalfOpenEvent,
  type CircuitTimeoutEvent,
  type HttpCircuitBreakerOptions,
} from "../src/index.js";

type TestResponse = AxiosResponse<{ ok: boolean }>;

const fastTripOptions = {
  errorThresholdPercentage: 1,
  volumeThreshold: 1,
  rollingCountTimeout: 1_000,
  resetTimeout: 1_000,
  allowWarmUp: false,
};

function axiosError(status?: number): AxiosError {
  const config = {} as InternalAxiosRequestConfig;
  const error = new AxiosError("request failed", undefined, config);

  if (status !== undefined) {
    error.response = {
      data: { message: "request failed" },
      status,
      statusText: "Error",
      headers: {},
      config,
    };
  }

  return error;
}

function breakerOptions<Args extends unknown[] = []>(
  overrides: Partial<HttpCircuitBreakerOptions<Args>> = {},
): HttpCircuitBreakerOptions<Args> {
  return {
    circuitGroup: "test",
    options: fastTripOptions,
    ...overrides,
  };
}

describe("HttpCircuitBreaker", () => {
  it("requires a non-empty circuit group", () => {
    assert.throws(
      () => HttpCircuitBreaker({ circuitGroup: " " }),
      /non-empty circuitGroup/,
    );
  });

  it("preserves successful results and original rejection identity", async () => {
    const response = { data: { ok: true } } as TestResponse;
    const originalError = axiosError(503);

    class Client {
      @HttpCircuitBreaker(breakerOptions())
      async successfulRequest(): Promise<TestResponse> {
        return response;
      }

      @HttpCircuitBreaker(breakerOptions())
      async failedRequest(): Promise<never> {
        throw originalError;
      }
    }

    const client = new Client();

    assert.equal(await client.successfulRequest(), response);
    await assert.rejects(client.failedRequest(), (error: unknown) => {
      assert.equal(error, originalError);
      return true;
    });
  });

  it("preserves method arguments and the instance context", async () => {
    class Client {
      constructor(private readonly prefix: string) {}

      @HttpCircuitBreaker({ circuitGroup: "arguments" })
      async request(id: number): Promise<string> {
        return `${this.prefix}:${id}`;
      }
    }

    assert.equal(await new Client("user").request(42), "user:42");
  });

  it("supports legacy TypeScript method decorators", async () => {
    const error = axiosError(503);
    const fallbackErrors: unknown[] = [];

    class Client {
      readonly received: string[] = [];

      @onHttpCircuitFailure({ circuitGroup: "legacy" })
      onFailure(event: CircuitFailureEvent) {
        assert.equal(event.error, error);
        this.received.push("failure");
      }

      @onHttpCircuitEvent({ circuitGroup: "legacy", eventName: "reject" })
      onReject() {
        this.received.push("reject");
      }

      @onHttpCircuitFallback<[string], string>({ circuitGroup: "legacy" })
      useFallback(event: CircuitFallbackEvent<[string]>): string {
        fallbackErrors.push(event.err);
        this.received.push("fallback");
        return "cached";
      }

      @HttpCircuitBreaker(
        breakerOptions<[string]>({
          circuitGroup: "legacy",
        }),
      )
      async request(_id: string): Promise<string> {
        throw error;
      }
    }

    const client = new Client();
    assert.equal(await client.request("user-1"), "cached");
    assert.equal(await client.request("user-2"), "cached");
    assert.deepEqual(client.received, [
      "failure",
      "fallback",
      "reject",
      "fallback",
    ]);
    assert.equal(fallbackErrors[0], error);
    assert.equal(
      (fallbackErrors[1] as Error & { code?: string }).code,
      "EOPENBREAKER",
    );
  });

  it("disables the Opossum timeout by default and allows explicitly enabling it", async () => {
    const timeoutEvents: CircuitTimeoutEvent[] = [];

    class Client {
      @onHttpCircuitEvent({
        circuitGroup: "timeouts",
        eventName: "timeout",
      })
      onTimeout(event: CircuitTimeoutEvent) {
        timeoutEvents.push(event);
      }

      @HttpCircuitBreaker({ circuitGroup: "timeouts" })
      async withoutBreakerTimeout(): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "completed";
      }

      @HttpCircuitBreaker({
        circuitGroup: "timeouts",
        options: {
          ...fastTripOptions,
          timeout: 10,
        },
      })
      async withBreakerTimeout(): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return "completed";
      }
    }

    const client = new Client();

    assert.equal(await client.withoutBreakerTimeout(), "completed");
    assert.equal(timeoutEvents.length, 0);

    await assert.rejects(client.withBreakerTimeout(), /Timed out after 10ms/);
    assert.equal(timeoutEvents.length, 1);
    assert.equal(timeoutEvents[0]?.circuitGroup, "timeouts");

    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("keeps breaker state isolated between instances", async () => {
    let firstCalls = 0;
    let secondCalls = 0;

    class Client {
      constructor(private readonly fail: boolean) {}

      @HttpCircuitBreaker(breakerOptions())
      async request(): Promise<string> {
        if (this.fail) {
          firstCalls += 1;
          throw axiosError(503);
        }

        secondCalls += 1;
        return "ok";
      }
    }

    const failingClient = new Client(true);
    const healthyClient = new Client(false);

    await assert.rejects(failingClient.request());
    await assert.rejects(failingClient.request());
    assert.equal(firstCalls, 1);
    assert.equal(await healthyClient.request(), "ok");
    assert.equal(secondCalls, 1);
  });

  it("keeps different decorated methods isolated within one instance", async () => {
    let healthyCalls = 0;

    class Client {
      @HttpCircuitBreaker(breakerOptions())
      async failingRequest(): Promise<never> {
        throw axiosError(503);
      }

      @HttpCircuitBreaker(breakerOptions())
      async healthyRequest(): Promise<string> {
        healthyCalls += 1;
        return "ok";
      }
    }

    const client = new Client();

    await assert.rejects(client.failingRequest());
    await assert.rejects(client.failingRequest());
    assert.equal(await client.healthyRequest(), "ok");
    assert.equal(healthyCalls, 1);
  });

  it("counts network errors and HTTP 408, 429, and 5xx as failures", async () => {
    for (const [label, error] of [
      ["network", new AxiosError("network error")],
      ["408", axiosError(408)],
      ["429", axiosError(429)],
      ["5xx", axiosError(503)],
    ] as const) {
      let calls = 0;

      class Client {
        @HttpCircuitBreaker(breakerOptions())
        async request(): Promise<never> {
          calls += 1;
          throw error;
        }
      }

      const client = new Client();
      await assert.rejects(client.request(), error);
      await assert.rejects(client.request());
      assert.equal(calls, 1, `${label} should open the breaker`);
    }
  });

  it("does not count cancellations and other 4xx responses", async () => {
    for (const error of [
      new axios.CanceledError(),
      axiosError(400),
      axiosError(404),
    ]) {
      let calls = 0;

      class Client {
        @HttpCircuitBreaker(breakerOptions())
        async request(): Promise<never> {
          calls += 1;
          throw error;
        }
      }

      const client = new Client();
      await assert.rejects(client.request(), error);
      await assert.rejects(client.request(), error);
      assert.equal(calls, 2);
    }
  });

  it("classifies an extracted Axios cause and preserves the wrapper rejection", async () => {
    for (const [status, shouldOpen] of [
      [404, false],
      [503, true],
    ] as const) {
      const wrappedError = { cause: axiosError(status) };
      let calls = 0;

      class Client {
        @HttpCircuitBreaker(
          breakerOptions({
            getErrorCause: (error) =>
              typeof error === "object" && error !== null && "cause" in error
                ? error.cause
                : error,
          }),
        )
        async request(): Promise<never> {
          calls += 1;
          throw wrappedError;
        }
      }

      const client = new Client();

      await assert.rejects(client.request(), (error: unknown) => {
        assert.equal(error, wrappedError);
        return true;
      });
      await assert.rejects(client.request());
      assert.equal(calls, shouldOpen ? 1 : 2);
    }
  });

  it("uses shouldCountAsFailure when supplied", async () => {
    const error = axiosError(400);
    let calls = 0;

    class Client {
      @HttpCircuitBreaker(
        breakerOptions({
          shouldCountAsFailure: (receivedError) => receivedError === error,
        }),
      )
      async request(): Promise<never> {
        calls += 1;
        throw error;
      }
    }

    const client = new Client();
    await assert.rejects(client.request(), error);
    await assert.rejects(client.request());
    assert.equal(calls, 1);
  });

  it("counts non-Axios errors by default", async () => {
    const error = new Error("unexpected failure");
    let calls = 0;

    class Client {
      @HttpCircuitBreaker(breakerOptions())
      async request(): Promise<never> {
        calls += 1;
        throw error;
      }
    }

    const client = new Client();
    await assert.rejects(client.request(), error);
    await assert.rejects(client.request());
    assert.equal(calls, 1);
  });

  it("dispatches typed failure and open events to handlers in the same instance and group", async () => {
    const error = axiosError(503);

    class Client {
      readonly received: string[] = [];

      @onHttpCircuitFailure({ circuitGroup: "users" })
      onFailure(event: CircuitFailureEvent) {
        assert.equal(event.error, error);
        assert.equal(event.axiosError, error);
        assert.equal(event.latencyMs >= 0, true);
        assert.deepEqual(event.args, ["user-1"]);
        this.received.push("failure");
      }

      @onHttpCircuitOpen({ circuitGroup: "users" })
      onOpen() {
        this.received.push("open");
      }

      @onHttpCircuitOpen({ circuitGroup: "other" })
      onOtherGroupOpen() {
        this.received.push("other");
      }

      @HttpCircuitBreaker(
        breakerOptions<[string]>({
          circuitGroup: "users",
        }),
      )
      async request(id: string): Promise<never> {
        throw error;
      }
    }

    const first = new Client();
    const second = new Client();
    await assert.rejects(first.request("user-1"), error);

    assert.deepEqual(first.received, ["failure", "open"]);
    assert.deepEqual(second.received, []);
  });

  it("dispatches success and closed transition events", async () => {
    let calls = 0;

    class Client {
      readonly received: string[] = [];

      @onHttpCircuitEvent({ circuitGroup: "reset", eventName: "success" })
      onSuccess() {
        this.received.push("success");
      }

      @onHttpCircuitClosed({ circuitGroup: "reset" })
      onClosed() {
        this.received.push("closed");
      }

      @HttpCircuitBreaker(
        breakerOptions({
          circuitGroup: "reset",
          options: {
            ...fastTripOptions,
            resetTimeout: 10,
          },
        }),
      )
      async request(): Promise<string> {
        calls += 1;
        if (calls === 1) throw axiosError(503);
        return "ok";
      }
    }

    const client = new Client();
    await assert.rejects(client.request());
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(await client.request(), "ok");
    assert.deepEqual(client.received, ["closed", "success"]);
  });

  it("dispatches the half-open transition with its reset timeout", async () => {
    const received: CircuitHalfOpenEvent[] = [];

    class Client {
      @onHttpCircuitHalfOpen({ circuitGroup: "half-open" })
      onHalfOpen(event: CircuitHalfOpenEvent) {
        received.push(event);
      }

      @HttpCircuitBreaker(
        breakerOptions({
          circuitGroup: "half-open",
          options: {
            ...fastTripOptions,
            resetTimeout: 30,
          },
        }),
      )
      async request(): Promise<never> {
        throw axiosError(503);
      }
    }

    const client = new Client();
    await assert.rejects(client.request());
    assert.deepEqual(received, []);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(received, [
      { circuitGroup: "half-open", resetTimeout: 30 },
    ]);
  });

  it("shares group handlers across methods without sharing breaker state", async () => {
    const events: string[] = [];

    class Client {
      @onHttpCircuitFailure({ circuitGroup: "shared" })
      onFailure() {
        events.push("failure");
      }

      @onHttpCircuitEvent({ circuitGroup: "shared", eventName: "success" })
      onSuccess() {
        events.push("success");
      }

      @HttpCircuitBreaker(
        breakerOptions({
          circuitGroup: "shared",
        }),
      )
      async failingRequest(): Promise<never> {
        throw axiosError(503);
      }

      @HttpCircuitBreaker(
        breakerOptions({
          circuitGroup: "shared",
        }),
      )
      async healthyRequest(): Promise<string> {
        return "ok";
      }
    }

    const client = new Client();
    await assert.rejects(client.failingRequest());
    assert.equal(await client.healthyRequest(), "ok");
    assert.deepEqual(events, ["failure", "success"]);
  });

  it("uses the registered fallback and provides the original input and error", async () => {
    const error = axiosError(503);
    const fallbackInputs: (readonly unknown[])[] = [];

    class Client {
      @onHttpCircuitFallback<[string], string>({
        circuitGroup: "fallback",
      })
      useFallback(event: CircuitFallbackEvent<[string]>): string {
        assert.equal(event.err, error);
        fallbackInputs.push(event.input);
        return "cached";
      }

      @HttpCircuitBreaker(
        breakerOptions<[string]>({
          circuitGroup: "fallback",
        }),
      )
      async request(id: string): Promise<string> {
        throw error;
      }
    }

    const client = new Client();
    assert.equal(await client.request("user-1"), "cached");
    assert.deepEqual(fallbackInputs, [["user-1"]]);
  });

  it("requires non-empty groups and rejects duplicate fallback handlers", () => {
    assert.throws(
      () => onHttpCircuitOpen({ circuitGroup: " " }),
      /non-empty circuitGroup/,
    );

    assert.throws(() => {
      class Client {
        @onHttpCircuitFallback({ circuitGroup: "duplicate" })
        firstFallback() {
          return "first";
        }

        @onHttpCircuitFallback({ circuitGroup: "duplicate" })
        secondFallback() {
          return "second";
        }
      }
      return Client;
    }, /Only one @onHttpCircuitFallback/);
  });
});
