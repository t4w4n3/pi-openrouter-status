import { describe, expect, test } from "bun:test";
import { deepContains, deepMerge, isJsonObject, type JsonValue } from "../src/json-merge.ts";

describe("isJsonObject", () => {
	test("accepts plain objects only", () => {
		expect(isJsonObject({})).toBe(true);
		expect(isJsonObject({ a: 1 })).toBe(true);
		expect(isJsonObject([])).toBe(false);
		expect(isJsonObject(null)).toBe(false);
		expect(isJsonObject("x")).toBe(false);
		expect(isJsonObject(undefined)).toBe(false);
	});
});

describe("deepMerge", () => {
	test("replaces scalars and arrays, merges objects", () => {
		const target: JsonValue = { a: "1", list: ["1", "2"], nested: { x: "1", keep: true } };
		const patch: JsonValue = { a: "2", list: ["3"], nested: { x: "2" } };
		expect(deepMerge(target, patch)).toEqual({ a: "2", list: ["3"], nested: { x: "2", keep: true } });
	});

	test("creates missing branches", () => {
		expect(deepMerge(undefined, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
		expect(deepMerge({}, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
	});

	test("does not mutate inputs", () => {
		const target: JsonValue = { a: { b: 1 } };
		deepMerge(target, { a: { c: 2 } });
		expect(target).toEqual({ a: { b: 1 } });
	});

	test("patch over non-object target replaces it", () => {
		expect(deepMerge("scalar", { a: 1 })).toEqual({ a: 1 });
		expect(deepMerge({ a: 1 }, "scalar")).toBe("scalar");
	});
});

describe("deepContains", () => {
	test("true when expected tree is present", () => {
		const target: JsonValue = { retry: { enabled: true, maxRetries: 4 }, other: 1 };
		expect(deepContains(target, { retry: { enabled: true, maxRetries: 4 } })).toBe(true);
	});

	test("false on missing key or different value", () => {
		expect(deepContains({ retry: { maxRetries: 3 } }, { retry: { maxRetries: 4 } })).toBe(false);
		expect(deepContains({}, { retry: { enabled: true } })).toBe(false);
		expect(deepContains(undefined, { a: 1 })).toBe(false);
	});

	test("arrays compare exactly", () => {
		expect(deepContains({ only: ["a", "b"] }, { only: ["a", "b"] })).toBe(true);
		expect(deepContains({ only: ["a", "b"] }, { only: ["b", "a"] })).toBe(false);
		expect(deepContains({ only: ["a"] }, { only: ["a", "b"] })).toBe(false);
	});

	test("extra keys in target are allowed", () => {
		expect(deepContains({ retry: { maxRetries: 4, timeout: 1 } }, { retry: { maxRetries: 4 } })).toBe(true);
	});
});
