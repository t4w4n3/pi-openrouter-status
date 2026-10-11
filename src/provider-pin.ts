/**
 * Runtime single-endpoint pinning with client-side failover for the GLM
 * model.
 *
 * Policy: every GLM request is rewritten via `before_provider_request` to
 * carry `provider.only = [activeEndpoint]`, so OpenRouter can never fail
 * over to another endpoint and upstream 429s surface to Pi's retry layer
 * (`retryProviderRequest`), which re-issues the same payload — same
 * endpoint — with exponential backoff honoring `Retry-After`, up to the
 * agent retry policy's `maxRetries`.
 *
 * Only after model requests ultimately fail (ending in `error`) for
 * FAIL_THRESHOLD consecutive requests does the pin move to the next
 * endpoint; after COOLDOWN_MS without failures the cheapest endpoint is
 * restored.
 */

import { GLM_MODEL_ID } from "./fragments.ts";

const MS_PER_SECOND = 1000;

/** Shape of the OpenAI-compatible request payload we mutate. */
interface RequestPayload {
	model?: unknown;
	provider?: unknown;
}

function endpointAt(index: number): string {
	return ENDPOINTS[index] ?? ENDPOINTS[0] ?? "streamlake/fp8";
}

function isGlmRequest(payload: unknown): boolean {
	return typeof payload === "object" && payload !== null && (payload as RequestPayload).model === GLM_MODEL_ID;
}

/** OpenRouter endpoints ordered by price, cheapest first. */
export const ENDPOINTS = ["streamlake/fp8", "novita/fp8"] as const;

/** Failed model requests in a row before the pin moves to the next endpoint. */
export const FAIL_THRESHOLD = 2;

/** Time without failures after which the cheapest endpoint is restored. */
export const COOLDOWN_MS = 10 * 60 * MS_PER_SECOND;

export interface ProviderPinState {
	/** Endpoint currently pinned into every GLM request. */
	readonly activeEndpoint: string;
	/** Consecutive failed GLM model requests on the active endpoint. */
	readonly failures: number;
	/** True when the active endpoint is not the cheapest one. */
	readonly failedOver: boolean;
}

export class ProviderPin {
	private activeIndex = 0;
	private failures = 0;
	private lastFailureAt = 0;

	/**
	 * Rewrite a GLM request payload in place to pin OpenRouter routing to
	 * the active endpoint. Non-GLM payloads are left untouched.
	 */
	onBeforeProviderRequest(payload: unknown): void {
		if (!isGlmRequest(payload)) {
			return;
		}
		(payload as RequestPayload).provider = {
			only: [endpointAt(this.activeIndex)],
			sort: { by: "price" },
			// biome-ignore lint/style/useNamingConvention: field name from the OpenRouter API payload
			allow_fallbacks: false,
		};
	}

	/** Account for a finished model request; pass `role`/`stopReason` from `message_end`. */
	onMessageEnd(role: string | undefined, stopReason: string | undefined): void {
		if (role !== "assistant") {
			return;
		}
		if (stopReason === "error") {
			this.failures += 1;
			this.lastFailureAt = Date.now();
			if (this.failures >= FAIL_THRESHOLD && this.activeIndex < ENDPOINTS.length - 1) {
				this.activeIndex += 1;
				this.failures = 0;
			}
			return;
		}
		if (stopReason !== "aborted") {
			// Any non-error outcome (success, tool use) means the endpoint
			// served the request: restore trust in it.
			this.failures = 0;
		}
	}

	/** Restore the cheapest endpoint after a failure-free cooldown. */
	onBeforeAgentStart(): void {
		if (this.activeIndex > 0 && Date.now() - this.lastFailureAt > COOLDOWN_MS) {
			this.activeIndex = 0;
			this.failures = 0;
		}
	}

	getState(): ProviderPinState {
		return {
			activeEndpoint: endpointAt(this.activeIndex),
			failures: this.failures,
			failedOver: this.activeIndex > 0,
		};
	}
}
