/**
 * Configuration fragments shipped with this package.
 *
 * These are the exact blocks the package applies to the user's Pi config
 * when `/openrouter-pin` runs:
 *
 * - `models.json` — OpenRouter `modelOverrides`:
 *   - `z-ai/glm-5.3-flash`: restrict routing to fp8 endpoints (StreamLake,
 *     Novita, GMICloud) sorted by price, with fallbacks disabled so a 429
 *     surfaces to Pi instead of failing over (preserving the resolved
 *     endpoint's context cache; Pi's retry policy then backs off against
 *     the same endpoint). The status line renders the provider actually
 *     resolved from these chunks, e.g. `⇢ StreamLake · fp8 ↻1`.
 *   - `meta/muse-spark-1.3-contributor`: session-affinity compat flags so
 *     consecutive requests stick to the same endpoint.
 * - `settings.json` — agent-level retry policy for transient failures.
 *
 * Both fragments merge deeply and idempotently: unrelated keys the user
 * already has are preserved, arrays replace.
 */

import type { JsonValue } from "./json-merge.ts";

export const GLM_MODEL_ID = "z-ai/glm-5.3-flash";
export const MUSE_MODEL_ID = "meta/muse-spark-1.3-contributor";

export const modelsFragment: JsonValue = {
	providers: {
		openrouter: {
			modelOverrides: {
				[GLM_MODEL_ID]: {
					samplingParams: {
						provider: {
							only: ["streamlake/fp8", "novita/fp8", "gmicloud/fp8"],
							sort: { by: "price" },
							// biome-ignore lint/style/useNamingConvention: field name from the OpenRouter API payload
							allow_fallbacks: false,
						},
					},
				},
				[MUSE_MODEL_ID]: {
					compat: {
						sendSessionAffinityHeaders: true,
						sessionAffinityFormat: "openrouter",
					},
				},
			},
		},
	},
};

export const retryFragment: JsonValue = {
	retry: {
		enabled: true,
		maxRetries: 4,
		baseDelayMs: 2000,
		maxAgentDelayMs: 60_000,
	},
};

export interface ConfigTarget {
	/** File name inside the Pi agent directory. */
	readonly file: "models.json" | "settings.json";
	/** Fragment to merge into that file. */
	readonly fragment: JsonValue;
	/** Human-readable summary used in notifications. */
	readonly description: string;
}

export const CONFIG_TARGETS: readonly ConfigTarget[] = [
	{
		file: "models.json",
		fragment: modelsFragment,
		description: "OpenRouter provider pinning (fp8 endpoints, price sort, session affinity)",
	},
	{
		file: "settings.json",
		fragment: retryFragment,
		description: "agent retry policy (4 retries, 2s base delay)",
	},
];
