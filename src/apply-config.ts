/**
 * Apply the shipped config fragments to the Pi agent directory.
 *
 * The merge logic is pure (`json-merge.ts`); this module only adds the
 * file I/O boundary, kept behind a small port so tests can run against
 * in-memory file systems.
 *
 * Application is idempotent: fragments already contained in the target
 * file are detected via `deepContains` and skipped, so running
 * `/openrouter-pin` twice never rewrites anything.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { ConfigTarget } from "./fragments.ts";
import { deepContains, deepMerge, type JsonValue } from "./json-merge.ts";

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

async function checkTarget(agentDir: string, target: ConfigTarget, io: FileSystemPort): Promise<ConfigCheck> {
	const raw = await io.readFile(join(agentDir, target.file));
	const current = parseCurrent(target.file, raw);
	return { file: target.file, applied: deepContains(current, target.fragment) };
}

async function applyTarget(agentDir: string, target: ConfigTarget, io: FileSystemPort): Promise<ApplyOutcome> {
	const path = join(agentDir, target.file);
	const raw = await io.readFile(path);
	const current = parseCurrent(target.file, raw);
	if (deepContains(current, target.fragment)) {
		return { file: target.file, status: "unchanged" };
	}
	const { contents } = mergeRawConfig(raw, target.fragment);
	if (raw !== undefined) {
		await io.backup(path, raw);
	}
	await io.writeFile(path, contents);
	let status: ApplyStatus = "created";
	if (raw !== undefined) {
		status = "applied";
	}
	return { file: target.file, status };
}

function parseCurrent(file: string, raw: string | undefined): JsonValue {
	if (raw === undefined) {
		return {};
	}
	try {
		return JSON.parse(raw) as JsonValue;
	} catch (error) {
		throw new ConfigSyntaxError(file, { cause: error });
	}
}

/**
 * Merge every target fragment into the agent directory. Missing files are
 * created; existing files are backed up to `<file>.bak` before the first
 * write of this run.
 */
export async function applyConfig(
	agentDir: string,
	targets: readonly ConfigTarget[],
	io: FileSystemPort = nodeFileSystem,
): Promise<ApplyOutcome[]> {
	const outcomes: ApplyOutcome[] = [];
	// Sequential on purpose: fail fast on the first error (e.g. malformed
	// JSON) so later config files are never half-updated.
	for (const target of targets) {
		// biome-ignore lint/performance/noAwaitInLoops: intentional fail-fast ordering
		outcomes.push(await applyTarget(agentDir, target, io));
	}
	return outcomes;
}

/** Port over the file system, injectable for tests. */
export interface FileSystemPort {
	/** File contents, or undefined when the file does not exist. */
	readFile: (path: string) => Promise<string | undefined>;
	/** Persist file contents. */
	writeFile: (path: string, contents: string) => Promise<void>;
	/** Back up the current contents before overwriting; returns backup path. */
	backup: (path: string, contents: string) => Promise<string>;
}

/** Default port backed by `node:fs/promises`. */
export const nodeFileSystem: FileSystemPort = {
	readFile: async (path) => {
		try {
			return await fsReadFile(path, "utf8");
		} catch (error) {
			if (isNotFoundError(error)) {
				return;
			}
			throw error;
		}
	},
	writeFile: async (path, contents) => {
		await fsWriteFile(path, contents, "utf8");
	},
	backup: async (path, contents) => {
		const backupPath = `${path}.bak`;
		await fsWriteFile(backupPath, contents, "utf8");
		return backupPath;
	},
};

/** Error thrown when a target file exists but is not valid JSON. */
export class ConfigSyntaxError extends Error {
	readonly file: string;

	constructor(file: string, options: { cause: unknown }) {
		super(`${file} is not valid JSON; fix it manually before applying config fragments`, options);
		this.file = file;
		this.name = "ConfigSyntaxError";
	}
}

export type ApplyStatus = "applied" | "created" | "unchanged";

export interface ApplyOutcome {
	readonly file: string;
	readonly status: ApplyStatus;
}

export interface ConfigCheck {
	readonly file: string;
	readonly applied: boolean;
}

/** Resolve the Pi agent directory (respects `PI_CODING_AGENT_DIR`). */
// biome-ignore lint/style/noProcessEnv: agent dir resolution is the documented extension contract
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const { PI_CODING_AGENT_DIR } = env;
	return PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Pure computation: merge a fragment into raw JSON file contents.
 * Returns the serialized result and whether anything actually changed.
 */
export function mergeRawConfig(raw: string | undefined, fragment: JsonValue): { contents: string; changed: boolean } {
	let current: JsonValue = {};
	if (raw !== undefined) {
		current = JSON.parse(raw) as JsonValue;
	}
	if (deepContains(current, fragment)) {
		let unchanged = "";
		if (raw !== undefined) {
			unchanged = raw;
		}
		return { contents: unchanged, changed: false };
	}
	const merged = deepMerge(current, fragment);
	return { contents: `${JSON.stringify(merged, null, "\t")}\n`, changed: true };
}

/** Check which targets are already applied, without writing anything. */
export function checkApplied(
	agentDir: string,
	targets: readonly ConfigTarget[],
	io: FileSystemPort = nodeFileSystem,
): Promise<ConfigCheck[]> {
	// Read-only checks are independent, so they run concurrently.
	return Promise.all(targets.map((target) => checkTarget(agentDir, target, io)));
}
