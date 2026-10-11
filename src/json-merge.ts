/**
 * Minimal JSON tree utilities shared by the config fragments shipped with
 * this package. Pure functions only: file I/O lives in `apply-config.ts`.
 */

function jsonEquals(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
	if (a === b) {
		return true;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]));
	}
	if (isJsonObject(a) && isJsonObject(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) {
			return false;
		}
		return keys.every((key) => key in b && jsonEquals(a[key], b[key]));
	}
	return false;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deep-merge `patch` over `target` and return the result.
 *
 * Plain objects are merged key by key; every other JSON value (arrays,
 * scalars, null) replaces the target value wholesale. The inputs are never
 * mutated.
 */
export function deepMerge(target: JsonValue | undefined, patch: JsonValue): JsonValue {
	if (!(isJsonObject(target) && isJsonObject(patch))) {
		return patch;
	}
	const result: { [key: string]: JsonValue } = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		result[key] = deepMerge(result[key], value);
	}
	return result;
}

/**
 * Return true when every path and value of `expected` is present in
 * `target`. Used to decide whether a shipped config fragment has already
 * been applied to the user's files, making application idempotent.
 */
export function deepContains(target: JsonValue | undefined, expected: JsonValue): boolean {
	if (isJsonObject(expected)) {
		if (!isJsonObject(target)) {
			return false;
		}
		return Object.entries(expected).every(([key, value]) => deepContains(target[key], value));
	}
	return jsonEquals(target, expected);
}

export function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
