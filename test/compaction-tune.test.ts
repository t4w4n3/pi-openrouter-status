import { describe, expect, test } from "bun:test";
import { applyConfig, type FileSystemPort } from "../src/apply-config.ts";
import {
	buildCompactionFragment,
	COMPACT_TARGET_TOKENS,
	computeReserveTokens,
	extractOpenRouterModelKeys,
	fetchOpenRouterContextLengths,
	MIN_RESERVE_TOKENS,
	mapModelContexts,
	tuneConfigTargets,
} from "../src/compaction-tune.ts";
import { CONFIG_TARGETS, retryFragment } from "../src/fragments.ts";
import { deepContains, deepMerge, type JsonValue } from "../src/json-merge.ts";

const AGENT_DIR = "/agent";
const SETTINGS_PATH = `${AGENT_DIR}/settings.json`;

/** OpenRouter catalog payload as raw JSON (keeps snake_case field names). */
const CATALOG = JSON.parse(`{
	"data": [
		{ "id": "z-ai/glm-5.3-flash", "context_length": 200000 },
		{ "id": "google/gemini-3-pro", "context_length": 1000000 },
		{ "id": "broken/entry", "context_length": "NaN" },
		{ "id": "negative/entry", "context_length": -5 },
		{ "notAnId": true }
	]
}`) as unknown;

/** In-memory file system: paths -> contents. */
function memoryIo(files: Map<string, string>): Pick<FileSystemPort, "readFile"> {
	return {
		readFile: (path) => Promise.resolve(files.get(path)),
	};
}

function ioWithSettings(contents: string | undefined): Pick<FileSystemPort, "readFile"> {
	const files = new Map<string, string>();
	if (contents !== undefined) {
		files.set(SETTINGS_PATH, contents);
	}
	return memoryIo(files);
}

/** Fake fetch backed by a static payload. */
function fakeFetch(payload: unknown, status = 200): typeof fetch {
	return (() => Promise.resolve(new Response(JSON.stringify(payload), { status }))) as unknown as typeof fetch;
}

const settingsWithModels = JSON.stringify({
	enabledModels: ["openrouter/z-ai/glm-5.3-flash", "openrouter/google/gemini-3-pro"],
});

describe("computeReserveTokens", () => {
	test("large window: compaction triggers at the target", () => {
		expect(computeReserveTokens(1_000_000)).toBe(1_000_000 - COMPACT_TARGET_TOKENS);
	});
	test("small window: clamped to the built-in default reserve", () => {
		expect(computeReserveTokens(200_000)).toBe(MIN_RESERVE_TOKENS);
	});
	test("boundary: exactly target + default reserve keeps the default", () => {
		expect(computeReserveTokens(COMPACT_TARGET_TOKENS + MIN_RESERVE_TOKENS)).toBe(MIN_RESERVE_TOKENS);
		expect(computeReserveTokens(COMPACT_TARGET_TOKENS + MIN_RESERVE_TOKENS + 1)).toBe(MIN_RESERVE_TOKENS + 1);
	});
	test("invalid lengths fall back to the default reserve", () => {
		expect(computeReserveTokens(0)).toBe(MIN_RESERVE_TOKENS);
		expect(computeReserveTokens(-1)).toBe(MIN_RESERVE_TOKENS);
		expect(computeReserveTokens(Number.NaN)).toBe(MIN_RESERVE_TOKENS);
	});
});

describe("extractOpenRouterModels", () => {
	test("reads enabledModels from parsed settings.json", () => {
		const settings: JsonValue = { enabledModels: ["openrouter/z-ai/glm-5.3-flash", "anthropic/claude"] };
		expect(extractOpenRouterModelKeys(settings)).toEqual(["openrouter/z-ai/glm-5.3-flash"]);
	});
	test("is case-insensitive on the provider prefix", () => {
		const settings: JsonValue = { enabledModels: ["OpenRouter/z-ai/glm-5.3-flash"] };
		expect(extractOpenRouterModelKeys(settings)).toEqual(["OpenRouter/z-ai/glm-5.3-flash"]);
	});
	test("returns empty for missing or malformed settings", () => {
		expect(extractOpenRouterModelKeys(undefined)).toEqual([]);
		expect(extractOpenRouterModelKeys({})).toEqual([]);
		expect(extractOpenRouterModelKeys({ enabledModels: "nope" })).toEqual([]);
		expect(extractOpenRouterModelKeys(["enabledModels"])).toEqual([]);
	});
});

describe("buildOverrides", () => {
	test("writes overrides only above the default reserve", () => {
		const fragment = buildCompactionFragment(
			new Map([
				["openrouter/google/gemini-3-pro", 1_000_000],
				["openrouter/z-ai/glm-5.3-flash", 200_000],
			]),
		);
		expect(fragment).toEqual({
			compaction: { modelOverrides: { "openrouter/google/gemini-3-pro": { reserveTokens: 650_000 } } },
		});
	});
	test("returns an empty fragment when no model needs an override", () => {
		expect(buildCompactionFragment(new Map([["openrouter/z-ai/glm-5.3-flash", 200_000]]))).toEqual({});
		expect(buildCompactionFragment(new Map())).toEqual({});
	});
});

describe("fetchOpenRouterContextLengths", () => {
	test("collects valid id/context_length pairs", async () => {
		const lengths = await fetchOpenRouterContextLengths(fakeFetch(CATALOG));
		expect(lengths.get("z-ai/glm-5.3-flash")).toBe(200_000);
		expect(lengths.get("google/gemini-3-pro")).toBe(1_000_000);
		expect(lengths.size).toBe(2);
	});
	test("rejects on HTTP errors", async () => {
		await expect(fetchOpenRouterContextLengths(fakeFetch({}, 500))).rejects.toThrow("HTTP 500");
	});
	test("tolerates a malformed payload", async () => {
		const lengths = await fetchOpenRouterContextLengths(fakeFetch({ data: "nope" }));
		expect(lengths.size).toBe(0);
	});
});

describe("mapModelContexts", () => {
	test("maps override entries to catalog lengths and reports unknowns", () => {
		const catalog = new Map([
			["z-ai/glm-5.3-flash", 200_000],
			["google/gemini-3-pro", 1_000_000],
		]);
		const { contexts, unknownKeys } = mapModelContexts(
			["openrouter/z-ai/glm-5.3-flash", "openrouter/google/gemini-3-pro", "openrouter/ghost/model"],
			catalog,
		);
		expect(contexts.get("openrouter/google/gemini-3-pro")).toBe(1_000_000);
		expect(contexts.has("openrouter/z-ai/glm-5.3-flash")).toBe(true);
		expect(unknownKeys).toEqual(["openrouter/ghost/model"]);
	});
});

const EXPECTED_SETTINGS_FRAGMENT = deepMerge(retryFragment, {
	compaction: { modelOverrides: { "openrouter/google/gemini-3-pro": { reserveTokens: 650_000 } } },
});

describe("tuneConfigTargets", () => {
	test("merges the compaction fragment into the settings target", async () => {
		const { targets, tuned, warnings } = await tuneConfigTargets(
			AGENT_DIR,
			CONFIG_TARGETS,
			ioWithSettings(settingsWithModels),
			fakeFetch(CATALOG),
		);
		expect(warnings).toEqual([]);
		expect(tuned).toEqual(["openrouter/google/gemini-3-pro"]);
		const settingsTarget = targets.find((target) => target.file === "settings.json");
		expect(settingsTarget?.fragment).toEqual(EXPECTED_SETTINGS_FRAGMENT);
		// The models target is passed through untouched.
		expect(targets.find((target) => target.file === "models.json")?.fragment).toEqual(
			CONFIG_TARGETS.find((target) => target.file === "models.json")?.fragment,
		);
	});

	test("returns base targets when no openrouter model is enabled", async () => {
		const { targets, tuned, warnings } = await tuneConfigTargets(
			AGENT_DIR,
			CONFIG_TARGETS,
			ioWithSettings(JSON.stringify({ enabledModels: ["anthropic/claude"] })),
			fakeFetch(CATALOG),
		);
		expect(targets).toBe(CONFIG_TARGETS);
		expect(tuned).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("degrades to base targets with a warning when the catalog fails", async () => {
		const { targets, tuned, warnings } = await tuneConfigTargets(
			AGENT_DIR,
			CONFIG_TARGETS,
			ioWithSettings(settingsWithModels),
			fakeFetch({}, 503),
		);
		expect(targets).toBe(CONFIG_TARGETS);
		expect(tuned).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("HTTP 503");
	});

	test("warns about invalid settings.json instead of throwing", async () => {
		const { targets, warnings } = await tuneConfigTargets(
			AGENT_DIR,
			CONFIG_TARGETS,
			ioWithSettings("{not json"),
			fakeFetch(CATALOG),
		);
		expect(targets).toBe(CONFIG_TARGETS);
		expect(warnings[0]).toContain("not valid JSON");
	});
});

describe("tuneConfigTargets end to end", () => {
	/** Mutable in-memory file system exercising the full apply pipeline. */
	function writableIo(): FileSystemPort & { files: Map<string, string> } {
		const files = new Map<string, string>([
			[SETTINGS_PATH, settingsWithModels],
			[`${AGENT_DIR}/models.json`, "{}"],
		]);
		return {
			files,
			readFile: (path) => Promise.resolve(files.get(path)),
			writeFile: (path, contents) => {
				files.set(path, contents);
				return Promise.resolve();
			},
			backup: (path, contents) => {
				files.set(`${path}.bak`, contents);
				return Promise.resolve(`${path}.bak`);
			},
		};
	}

	test("applying tuned targets writes the expected threshold", async () => {
		const io = writableIo();
		const { targets } = await tuneConfigTargets(AGENT_DIR, CONFIG_TARGETS, io, fakeFetch(CATALOG));
		await applyConfig(AGENT_DIR, targets, io);
		const parsed = JSON.parse(must(io.files.get(SETTINGS_PATH))) as JsonValue;
		expect(
			deepContains(parsed, {
				compaction: { modelOverrides: { "openrouter/google/gemini-3-pro": { reserveTokens: 650_000 } } },
			}),
		).toBe(true);
	});

	test("a second tune + apply run is a no-op", async () => {
		const io = writableIo();
		const first = await tuneConfigTargets(AGENT_DIR, CONFIG_TARGETS, io, fakeFetch(CATALOG));
		await applyConfig(AGENT_DIR, first.targets, io);
		const contents = must(io.files.get(SETTINGS_PATH));
		const second = await tuneConfigTargets(AGENT_DIR, CONFIG_TARGETS, io, fakeFetch(CATALOG));
		const outcomes = await applyConfig(AGENT_DIR, second.targets, io);
		expect(outcomes.every((outcome) => outcome.status === "unchanged")).toBe(true);
		expect(io.files.get(SETTINGS_PATH)).toBe(contents);
	});
});

/** Unwrap an optional value or fail the test. */
function must<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) {
		throw new Error("expected value to be present");
	}
	return value;
}
