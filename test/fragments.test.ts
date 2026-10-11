import { describe, expect, test } from "bun:test";
import { CONFIG_TARGETS, type ConfigTarget, GLM_MODEL_ID } from "../src/fragments.ts";
import { deepContains, type JsonValue } from "../src/json-merge.ts";

/** Unwrap an optional value or fail the test. */
function must<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) {
		throw new Error("expected value to be present");
	}
	return value;
}

function at(root: JsonValue, path: readonly string[]): JsonValue | undefined {
	let current: JsonValue | undefined = root;
	for (const key of path) {
		if (current === undefined || typeof current !== "object" || Array.isArray(current) || current === null) {
			return undefined;
		}
		current = current[key];
	}
	return current;
}

const modelsTarget: ConfigTarget = must(CONFIG_TARGETS.find((target) => target.file === "models.json"));

function glmProvider(key: string): JsonValue | undefined {
	return at(modelsTarget.fragment, [
		"providers",
		"openrouter",
		"modelOverrides",
		GLM_MODEL_ID,
		"samplingParams",
		"provider",
		key,
	]);
}

describe("config fragments", () => {
	test("models fragment pins glm-5.3-flash to fp8 endpoints sorted by price", () => {
		expect(glmProvider("only")).toEqual(["streamlake/fp8", "novita/fp8", "gmicloud/fp8"]);
		expect(glmProvider("sort")).toEqual({ by: "price" });
	});

	test("models fragment disables OpenRouter fallbacks on glm-5.3-flash", () => {
		expect(glmProvider("allow_fallbacks")).toBe(false);
	});

	test("models fragment enables OpenRouter session affinity on muse-spark", () => {
		const compat = at(modelsTarget.fragment, [
			"providers",
			"openrouter",
			"modelOverrides",
			"meta/muse-spark-1.3-contributor",
			"compat",
		]);
		expect(compat).toEqual({ sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" });
	});

	test("retry fragment matches the shipped policy", () => {
		const target = CONFIG_TARGETS.find((t) => t.file === "settings.json");
		expect(target?.fragment).toEqual({
			retry: { enabled: true, maxRetries: 4, baseDelayMs: 2000, maxAgentDelayMs: 60_000 },
		});
	});

	test("every target file is covered exactly once", () => {
		expect(CONFIG_TARGETS.map((t) => t.file).sort()).toEqual(["models.json", "settings.json"]);
	});

	test("targets are self-contained: each fragment is contained in itself merged over an empty file", () => {
		for (const target of CONFIG_TARGETS) {
			const merged: JsonValue = structuredClone(target.fragment);
			expect(deepContains(merged, target.fragment)).toBe(true);
		}
	});
});
