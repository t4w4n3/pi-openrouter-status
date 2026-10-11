import { describe, expect, test } from "bun:test";
import {
	applyConfig,
	ConfigSyntaxError,
	checkApplied,
	type FileSystemPort,
	getAgentDir,
	mergeRawConfig,
} from "../src/apply-config.ts";
import { CONFIG_TARGETS } from "../src/fragments.ts";
import { deepContains, type JsonValue } from "../src/json-merge.ts";

/** Unwrap an optional value or fail the test. */
function must<T>(value: T | undefined | null): T {
	if (value === undefined || value === null) {
		throw new Error("expected value to be present");
	}
	return value;
}

/** In-memory file system: paths -> contents. */
function memoryIo(files: Map<string, string>): FileSystemPort & { writes: string[]; backups: string[] } {
	const writes: string[] = [];
	const backups: string[] = [];
	return {
		writes,
		backups,
		readFile: (path) => Promise.resolve(files.get(path)),
		writeFile: (path, contents) => {
			files.set(path, contents);
			writes.push(path);
			return Promise.resolve();
		},
		backup: (path, contents) => {
			const backupPath = `${path}.bak`;
			files.set(backupPath, contents);
			backups.push(backupPath);
			return Promise.resolve(backupPath);
		},
	};
}

const AGENT_DIR = "/agent";

describe("getAgentDir", () => {
	test("honors PI_CODING_AGENT_DIR", () => {
		// biome-ignore lint/style/useNamingConvention: environment variable contract
		expect(getAgentDir({ PI_CODING_AGENT_DIR: "/custom" })).toBe("/custom");
	});
	test("falls back to ~/.pi/agent", () => {
		const dir = getAgentDir({});
		expect(dir.endsWith(".pi/agent") || dir.endsWith(".pi\\agent")).toBe(true);
	});
});

describe("mergeRawConfig", () => {
	test("merges into existing JSON and reports change", () => {
		const raw = JSON.stringify({ providers: { openrouter: { baseUrl: "https://x" } } });
		const { contents, changed } = mergeRawConfig(raw, must(CONFIG_TARGETS.at(0)).fragment);
		const parsed = JSON.parse(contents) as { providers: { openrouter: { baseUrl: string; modelOverrides?: object } } };
		expect(changed).toBe(true);
		expect(parsed.providers.openrouter.baseUrl).toBe("https://x");
		expect(parsed.providers.openrouter.modelOverrides).toBeDefined();
	});

	test("is idempotent when fragment already applied", () => {
		const raw = JSON.stringify(must(CONFIG_TARGETS.at(1)).fragment, null, "\t");
		const { changed, contents } = mergeRawConfig(raw, must(CONFIG_TARGETS.at(1)).fragment);
		expect(changed).toBe(false);
		expect(contents).toBe(raw);
	});

	test("a missing file always counts as changed", () => {
		const { changed } = mergeRawConfig(undefined, must(CONFIG_TARGETS.at(1)).fragment);
		expect(changed).toBe(true);
	});
});

describe("applyConfig", () => {
	test("creates missing files and reports created", async () => {
		const files = new Map<string, string>();
		const io = memoryIo(files);
		const outcomes = await applyConfig(AGENT_DIR, CONFIG_TARGETS, io);
		expect(outcomes.map((o) => o.status)).toEqual(["created", "created"]);
		const models = JSON.parse(must(files.get(`${AGENT_DIR}/models.json`))) as JsonValue;
		expect(deepContains(models, must(CONFIG_TARGETS.at(0)).fragment)).toBe(true);
		expect(io.backups).toEqual([]);
	});

	test("backs up before overwriting an existing file", async () => {
		const files = new Map<string, string>([[`${AGENT_DIR}/settings.json`, "{}"]]);
		const io = memoryIo(files);
		const outcomes = await applyConfig(AGENT_DIR, [must(CONFIG_TARGETS.at(1))], io);
		expect(outcomes.map((o) => o.status)).toEqual(["applied"]);
		expect(io.backups).toEqual([`${AGENT_DIR}/settings.json.bak`]);
		expect(files.get(`${AGENT_DIR}/settings.json.bak`)).toBe("{}");
	});

	test("second run is a no-op", async () => {
		const files = new Map<string, string>();
		const io = memoryIo(files);
		await applyConfig(AGENT_DIR, CONFIG_TARGETS, io);
		const writesAfterFirst = io.writes.length;
		const outcomes = await applyConfig(AGENT_DIR, CONFIG_TARGETS, io);
		expect(outcomes.map((o) => o.status)).toEqual(["unchanged", "unchanged"]);
		expect(io.writes.length).toBe(writesAfterFirst);
	});

	test("preserves unrelated user keys", async () => {
		const files = new Map<string, string>([
			[`${AGENT_DIR}/models.json`, JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost" } } })],
			[`${AGENT_DIR}/settings.json`, JSON.stringify({ theme: "light-adjusted" })],
		]);
		const io = memoryIo(files);
		await applyConfig(AGENT_DIR, CONFIG_TARGETS, io);
		const models = JSON.parse(must(files.get(`${AGENT_DIR}/models.json`))) as { providers: { ollama?: unknown } };
		const settings = JSON.parse(must(files.get(`${AGENT_DIR}/settings.json`))) as { theme: string };
		expect(models.providers.ollama).toBeDefined();
		expect(settings.theme).toBe("light-adjusted");
	});

	test("throws ConfigSyntaxError on malformed JSON without writing", async () => {
		const files = new Map<string, string>([[`${AGENT_DIR}/models.json`, "{ not json"]]);
		const io = memoryIo(files);
		let caught: unknown;
		try {
			await applyConfig(AGENT_DIR, CONFIG_TARGETS, io);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigSyntaxError);
		expect((caught as ConfigSyntaxError).file).toBe("models.json");
		expect(io.writes).toEqual([]);
	});
});

describe("checkApplied", () => {
	test("reports per-file application state", async () => {
		const files = new Map<string, string>();
		const io = memoryIo(files);
		let checks = await checkApplied(AGENT_DIR, CONFIG_TARGETS, io);
		expect(checks.map((c) => c.applied)).toEqual([false, false]);
		await applyConfig(AGENT_DIR, CONFIG_TARGETS, io);
		checks = await checkApplied(AGENT_DIR, CONFIG_TARGETS, io);
		expect(checks.map((c) => c.applied)).toEqual([true, true]);
	});
});
