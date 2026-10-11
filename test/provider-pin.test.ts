import { describe, expect, test } from "bun:test";
import { COOLDOWN_MS, FAIL_THRESHOLD, ProviderPin } from "../src/provider-pin.ts";

interface TestPayload {
	model: string;
	messages: never[];
	provider?: unknown;
}

function makeRequest(): TestPayload {
	return { model: "z-ai/glm-5.3-flash", messages: [] };
}

function fail(pin: ProviderPin): void {
	pin.onMessageEnd("assistant", "error");
}

describe("provider pin routing", () => {
	test("rewrites GLM requests to the active endpoint, cheapest first", () => {
		const pin = new ProviderPin();
		const payload = makeRequest();
		pin.onBeforeProviderRequest(payload);
		expect(payload.provider).toEqual({
			only: ["streamlake/fp8"],
			sort: { by: "price" },
			// biome-ignore lint/style/useNamingConvention: field name from the OpenRouter API payload
			allow_fallbacks: false,
		});
		expect(pin.getState()).toEqual({ activeEndpoint: "streamlake/fp8", failures: 0, failedOver: false });
	});

	test("leaves non-GLM payloads untouched", () => {
		const pin = new ProviderPin();
		const payload: TestPayload = { model: "anthropic/claude-sonnet-5", messages: [] };
		pin.onBeforeProviderRequest(payload);
		expect(payload.provider).toBeUndefined();
	});

	test("pinned endpoint follows the failover state", () => {
		const pin = new ProviderPin();
		fail(pin);
		const before = makeRequest();
		pin.onBeforeProviderRequest(before);
		expect((before.provider as { only?: unknown }).only).toEqual(["streamlake/fp8"]);
		fail(pin);
		const after = makeRequest();
		pin.onBeforeProviderRequest(after);
		expect((after.provider as { only?: unknown }).only).toEqual(["novita/fp8"]);
	});
});

describe("provider pin failover", () => {
	test("keeps the pin through isolated failures and flips after the threshold", () => {
		const pin = new ProviderPin();
		fail(pin);
		expect(pin.getState().activeEndpoint).toEqual("streamlake/fp8");
		fail(pin);
		expect(pin.getState()).toEqual({ activeEndpoint: "novita/fp8", failures: 0, failedOver: true });
	});

	test("a success resets the failure count", () => {
		const pin = new ProviderPin();
		for (let i = 0; i < FAIL_THRESHOLD - 1; i += 1) {
			fail(pin);
		}
		pin.onMessageEnd("assistant", "stop");
		expect(pin.getState().failures).toBe(0);
		expect(pin.getState().activeEndpoint).toEqual("streamlake/fp8");
	});

	test("aborted requests neither count nor reset", () => {
		const pin = new ProviderPin();
		fail(pin);
		pin.onMessageEnd("assistant", "aborted");
		expect(pin.getState().failures).toBe(1);
		fail(pin);
		// Threshold reached: the pin flipped and the counter reset.
		expect(pin.getState().failures).toBe(0);
		expect(pin.getState().activeEndpoint).toEqual("novita/fp8");
	});

	test("never moves past the last endpoint", () => {
		const pin = new ProviderPin();
		for (let i = 0; i < 10; i += 1) {
			fail(pin);
		}
		expect(pin.getState().activeEndpoint).toEqual("novita/fp8");
	});

	test("ignores non-assistant message ends", () => {
		const pin = new ProviderPin();
		pin.onMessageEnd("user", "error");
		expect(pin.getState().failures).toBe(0);
	});

	test("restores the cheapest endpoint after a failure-free cooldown", () => {
		const pin = new ProviderPin();
		fail(pin);
		fail(pin);
		expect(pin.getState().failedOver).toBe(true);
		// Cooldown not elapsed: the pin holds.
		pin.onBeforeAgentStart();
		expect(pin.getState().activeEndpoint).toEqual("novita/fp8");
		// Simulate an old last-failure timestamp, then start a new agent run.
		const internal = pin as unknown as { lastFailureAt: number };
		internal.lastFailureAt = Date.now() - COOLDOWN_MS - 1;
		pin.onBeforeAgentStart();
		expect(pin.getState()).toEqual({ activeEndpoint: "streamlake/fp8", failures: 0, failedOver: false });
	});
});
