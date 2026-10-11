/**
 * Dynamic compaction tuning for OpenRouter models.
 *
 * Pi auto-compacts when `contextTokens > contextWindow - reserveTokens`
 * (`reserveTokens` defaults to 16384). With a 1M-token window that only
 * triggers near 984K tokens — far beyond what such models handle well.
 *
 * `/openrouter-pin` therefore queries the OpenRouter catalog for the
 * declared `context_length` of every enabled `openrouter/*` model and
 * pins the auto-compact point to a fixed target:
 *
 *   reserveTokens = max(16384, contextLength - 350000)
 *
 * A 200K model keeps the built-in default (compact ~184K); a 1M model
 * compacts at ~350K. Overrides equal to the built-in default are never
 * written, so the fragment stays minimal and idempotent.
 *
 * NOTE: Pi caches settings.json in memory; the new thresholds take
 * effect after a restart or `/reload`.
 */

import { join } from "node:path";
import { type FileSystemPort, nodeFileSystem } from "./apply-config.ts";
import type { ConfigTarget } from "./fragments.ts";
import { deepMerge, type JsonValue } from "./json-merge.ts";

const OPENROUTER_PREFIX = "openrouter/";
const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const SETTINGS_FILE = "settings.json";

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge the compaction fragment into the settings.json target (or append one). */
function withCompactionTarget(baseTargets: readonly ConfigTarget[], fragment: JsonValue): readonly ConfigTarget[] {
	const settingsFile = baseTargets.find((target) => target.file === SETTINGS_FILE);
	if (settingsFile === undefined) {
		return [
			...baseTargets,
			{
				file: SETTINGS_FILE,
				fragment,
				description: "per-model compaction thresholds (from declared context lengths)",
			},
		];
	}
	return baseTargets.map((target) => {
		if (target !== settingsFile) {
			return target;
		}
		return {
			...target,
			fragment: deepMerge(target.fragment, fragment),
			description: `${target.description} + per-model compaction thresholds`,
		};
	});
}

/** Auto-compact once the projected context reaches this many tokens. */
export const COMPACT_TARGET_TOKENS = 350_000;
/** Built-in Pi default reserve; never reserve less than this. */
export const MIN_RESERVE_TOKENS = 16_384;

/** Pure computation: tokens to reserve so compaction triggers at the target. */
export function computeReserveTokens(contextLength: number): number {
	if (!Number.isSafeInteger(contextLength) || contextLength <= 0) {
		return MIN_RESERVE_TOKENS;
	}
	return Math.max(MIN_RESERVE_TOKENS, contextLength - COMPACT_TARGET_TOKENS);
}

/**
 * Pure computation: extract the `openrouter/*` entries from the
 * `enabledModels` list of parsed settings.json contents. Entries already
 * carry the Pi `provider/modelId` shape used by `compaction.modelOverrides`.
 */
export function extractOpenRouterModelKeys(settings: JsonValue | undefined): string[] {
	const enabled = (settings as { enabledModels?: unknown } | undefined)?.enabledModels;
	if (!Array.isArray(enabled)) {
		return [];
	}
	const keys: string[] = [];
	for (const entry of enabled) {
		if (typeof entry === "string" && entry.toLowerCase().startsWith(OPENROUTER_PREFIX)) {
			keys.push(entry);
		}
	}
	return keys;
}

/**
 * Pure computation: build the `compaction` fragment for the given
 * override-key → context-length pairs. Models whose computed reserve
 * equals the built-in default are omitted.
 */
export function buildCompactionFragment(modelContexts: ReadonlyMap<string, number>): JsonValue {
	const overrides: { [key: string]: JsonValue } = {};
	for (const [key, contextLength] of modelContexts) {
		const reserve = computeReserveTokens(contextLength);
		if (reserve !== MIN_RESERVE_TOKENS) {
			overrides[key] = { reserveTokens: reserve };
		}
	}
	if (Object.keys(overrides).length === 0) {
		return {};
	}
	return { compaction: { modelOverrides: overrides } };
}

/** Fetch id → declared context_length from the OpenRouter public catalog. */
export async function fetchOpenRouterContextLengths(fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
	const response = await fetchImpl(CATALOG_URL);
	if (!response.ok) {
		throw new Error(`OpenRouter catalog request failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: unknown };
	const lengths = new Map<string, number>();
	if (!Array.isArray(payload.data)) {
		return lengths;
	}
	for (const entry of payload.data) {
		if (isRecord(entry)) {
			// biome-ignore lint/style/useNamingConvention: OpenRouter API field name
			const { id, context_length: contextLength } = entry as { id?: unknown; context_length?: unknown };
			if (typeof id === "string" && typeof contextLength === "number" && contextLength > 0) {
				lengths.set(id, contextLength);
			}
		}
	}
	return lengths;
}

/** Map override keys (`openrouter/<id>`) to declared context lengths. */
export function mapModelContexts(
	keys: readonly string[],
	catalog: ReadonlyMap<string, number>,
): { contexts: Map<string, number>; unknownKeys: string[] } {
	const contexts = new Map<string, number>();
	const unknownKeys: string[] = [];
	for (const key of keys) {
		const length = catalog.get(key.slice(OPENROUTER_PREFIX.length));
		if (length === undefined) {
			unknownKeys.push(key);
		} else {
			contexts.set(key, length);
		}
	}
	return { contexts, unknownKeys };
}

export interface TuneResult {
	/** Targets to apply: the base targets with the compaction fragment merged in. */
	readonly targets: readonly ConfigTarget[];
	/** Override keys that received a non-default compaction threshold. */
	readonly tuned: readonly string[];
	/** Non-fatal problems; tuning was skipped for the affected models. */
	readonly warnings: readonly string[];
}

/**
 * Compute the config targets for `/openrouter-pin`: the shipped static
 * targets plus, when the OpenRouter catalog answers, compaction
 * overrides for every enabled `openrouter/*` model whose threshold
 * differs from the built-in default. Any failure degrades to the base
 * targets with a warning — static pinning still applies.
 */
export async function tuneConfigTargets(
	agentDir: string,
	baseTargets: readonly ConfigTarget[],
	io: Pick<FileSystemPort, "readFile"> = nodeFileSystem,
	fetchImpl: typeof fetch = fetch,
): Promise<TuneResult> {
	const warnings: string[] = [];
	let settings: JsonValue | undefined;
	try {
		const raw = await io.readFile(join(agentDir, SETTINGS_FILE));
		if (raw === undefined) {
			settings = undefined;
		} else {
			settings = JSON.parse(raw) as JsonValue;
		}
	} catch {
		warnings.push("settings.json is not valid JSON; compaction tuning skipped");
		return { targets: baseTargets, tuned: [], warnings };
	}

	const keys = extractOpenRouterModelKeys(settings);
	if (keys.length === 0) {
		return { targets: baseTargets, tuned: [], warnings };
	}

	const catalog = await fetchOpenRouterContextLengths(fetchImpl).catch((error: unknown) => {
		warnings.push(`compaction tuning skipped: ${describeError(error)}`);
	});
	if (catalog === undefined) {
		return { targets: baseTargets, tuned: [], warnings };
	}

	const { contexts, unknownKeys } = mapModelContexts(keys, catalog);
	if (unknownKeys.length > 0) {
		warnings.push(`not in OpenRouter catalog, threshold left at default: ${unknownKeys.join(", ")}`);
	}

	const tuned = [...contexts]
		.filter(([, contextLength]) => computeReserveTokens(contextLength) !== MIN_RESERVE_TOKENS)
		.map(([key]) => key);
	if (tuned.length === 0) {
		return { targets: baseTargets, tuned: [], warnings };
	}

	const targets = withCompactionTarget(baseTargets, buildCompactionFragment(contexts));
	return { targets, tuned, warnings };
}
