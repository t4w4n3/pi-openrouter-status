import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	assembleLine,
	buildContextPart,
	buildFooterLines,
	buildStatsParts,
	computeUsageTotals,
	type FooterRenderArgs,
	type SessionEntryLike,
} from "../src/footer-render.ts";
import {
	createStatusLine,
	type FetchLike,
	formatCwdForFooter,
	formatTokens,
	type ProviderStreamEventLike,
} from "../src/status-line.ts";

/** Identity theme: keeps color assertions simple. */
const theme = {
	fg(color: "dim" | "error" | "warning", text: string): string {
		return `[${color}]${text}`;
	},
};

const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map<string, string>(),
};

function makeArgs(overrides: Partial<FooterRenderArgs> = {}): FooterRenderArgs {
	return {
		width: 120,
		theme,
		footerData,
		entries: [],
		cwd: "/home/dev/project",
		home: "/home/dev",
		branch: "main",
		sessionName: undefined,
		contextUsage: { percent: 12.3, contextWindow: 1_000_000 },
		model: { id: "z-ai/glm-5.3-flash", reasoning: true },
		thinkingLevel: "high",
		autoCompact: true,
		provider: undefined,
		...overrides,
	};
}

describe("formatTokens", () => {
	test("formats token counts with k/M suffixes", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(3500)).toBe("3.5k");
		expect(formatTokens(12_345)).toBe("12k");
		expect(formatTokens(1_500_000)).toBe("1.5M");
		expect(formatTokens(12_000_000)).toBe("12M");
	});
});

describe("formatCwdForFooter", () => {
	test("shortens home prefix to ~", () => {
		expect(formatCwdForFooter("/home/dev/project", "/home/dev")).toBe("~/project");
		expect(formatCwdForFooter("/home/dev", "/home/dev")).toBe("~");
		expect(formatCwdForFooter("/elsewhere", "/home/dev")).toBe("/elsewhere");
		expect(formatCwdForFooter("/elsewhere", undefined)).toBe("/elsewhere");
	});
});

describe("computeUsageTotals", () => {
	test("sums usage across entry kinds and tracks cache hit rate", () => {
		const entries: SessionEntryLike[] = [
			{ type: "usage", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 200, output: 20, cacheRead: 150, cacheWrite: 50, cost: { total: 0.002 } },
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			},
			{ type: "compaction", usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
		];
		const totals = computeUsageTotals(entries);
		expect(totals.input).toBe(1305);
		expect(totals.output).toBe(31);
		expect(totals.cacheRead).toBe(150);
		expect(totals.cacheWrite).toBe(50);
		expect(totals.cost).toBeCloseTo(0.003);
		expect(totals.latestCacheHitRate).toBeCloseTo((150 / 400) * 100);
	});
});

describe("buildStatsParts / buildContextPart", () => {
	test("builds stat fragments in order, provider last", () => {
		const parts = buildStatsParts(
			{ input: 3500, output: 13, cacheRead: 0, cacheWrite: 0, cost: 0.001, latestCacheHitRate: undefined },
			"⇢ StreamLake · fp8",
		);
		expect(parts).toEqual(["↑3.5k", "↓13", "$0.001", "⇢ StreamLake · fp8"]);
	});

	test("cache hit rate only shown when cache tokens exist", () => {
		const parts = buildStatsParts(
			{ input: 1, output: 1, cacheRead: 100, cacheWrite: 50, cost: 0, latestCacheHitRate: 66.7 },
			undefined,
		);
		expect(parts).toContain("R100");
		expect(parts).toContain("W50");
		expect(parts).toContain("CH66.7%");
	});

	test("context part colorizes by threshold and appends (auto)", () => {
		expect(buildContextPart({ percent: 12.3, contextWindow: 1_000_000 }, 0, true, theme)).toBe("12.3%/1.0M (auto)");
		expect(buildContextPart({ percent: 75, contextWindow: 128_000 }, 0, false, theme)).toBe("[warning]75.0%/128k");
		expect(buildContextPart({ percent: 95, contextWindow: 128_000 }, 0, false, theme)).toBe("[error]95.0%/128k");
		expect(buildContextPart(undefined, 128_000, false, theme)).toBe("?/128k");
	});
});

describe("assembleLine", () => {
	test("pads between left and right", () => {
		const line = assembleLine("left", "right", 20);
		expect(line).toBe(`left${" ".repeat(11)}right`);
	});

	test("truncates the right side when too long (truncateToWidth appends ANSI resets)", () => {
		const line = assembleLine("left", "x".repeat(50), 20);
		expect(line.startsWith("left  ")).toBe(true);
		expect(visibleWidth(line)).toBe(20);
	});

	test("truncates left when right cannot fit at all", () => {
		const line = assembleLine("y".repeat(50), "right", 10);
		expect(stripTerminalSequences(line)).toBe("yyyyyyy...");
		expect(visibleWidth(line)).toBe(10);
	});
});

describe("buildFooterLines", () => {
	test("renders pwd, stats with provider, and model on the right", () => {
		const lines = buildFooterLines(makeArgs({ provider: "⇢ StreamLake · fp8 ↻1" }));
		expect(lines[0]).toBe("[dim]~/project (main)");
		expect(lines[1]).toContain("⇢ StreamLake · fp8 ↻1");
		expect(lines[1]).toContain("z-ai/glm-5.3-flash • high");
		expect(lines[1]).toContain("12.3%/1.0M (auto)");
	});

	test("appends session name to pwd line", () => {
		const lines = buildFooterLines(makeArgs({ sessionName: "fix-bug" }));
		expect(lines[0]).toContain("• fix-bug");
	});

	test("renders other extension statuses sorted on a dedicated line", () => {
		const lines = buildFooterLines(
			makeArgs({
				footerData: {
					getGitBranch: () => undefined,
					getExtensionStatuses: () =>
						new Map([
							["zeta", "zeta-status"],
							["alpha", "alpha\tstatus"],
						]),
				},
			}),
		);
		expect(lines[2]).toBe("alpha status zeta-status");
	});

	test("falls back to no-model", () => {
		const lines = buildFooterLines(makeArgs({ model: undefined, thinkingLevel: undefined }));
		expect(lines[1]).toContain("no-model");
	});
});

// --- createStatusLine ---

/** Minimal fetch stub matching the package FetchLike contract. */
function fetchStub(response: object, ok = true): FetchLike & { calls: string[] } {
	const calls: string[] = [];
	// biome-ignore lint/correctness/useQwikValidLexicalScope: Qwik-only rule, misfires here
	const fn = (url: string) => {
		calls.push(url);
		let status = 404;
		if (ok) {
			status = 200;
		}
		return Promise.resolve(new Response(JSON.stringify(response), { status }));
	};
	return Object.assign(fn, { calls }) as FetchLike & { calls: string[] };
}

describe("createStatusLine", () => {
	test("counts retryable errors per turn and resets on new agent start", () => {
		const line = createStatusLine();
		line.onMessageEnd({ message: { role: "user", stopReason: "error" } });
		expect(line.providerPart()).toBeUndefined();
		line.onMessageEnd({ message: { role: "assistant", stopReason: "end_turn" } });
		line.onMessageEnd({ message: { role: "assistant", stopReason: "error" } });
		line.onMessageEnd({ message: { role: "assistant", stopReason: "error" } });
		line.onBeforeAgentStart();
		expect(line.isAutoCompact()).toBe(true);
		// providerPart only appears once a provider is seen
		expect(line.providerPart()).toBeUndefined();
	});

	test("manual compaction does not flip the auto indicator", () => {
		const line = createStatusLine();
		line.onBeforeCompaction({ reason: "manual" });
		expect(line.isAutoCompact()).toBe(true);
		line.onBeforeCompaction({ reason: "threshold" });
		expect(line.isAutoCompact()).toBe(true);
	});

	test("attach/detach controls the render pump", () => {
		let renders = 0;
		const line = createStatusLine();
		line.attachRender(() => {
			renders += 1;
		});
		line.onBeforeAgentStart();
		line.onMessageEnd({ message: { role: "assistant", stopReason: "error" } });
		expect(renders).toBe(2);
		line.detachRender();
		line.onMessageEnd({ message: { role: "assistant", stopReason: "error" } });
		expect(renders).toBe(2);
	});
});

describe("createStatusLine · provider resolution", () => {
	test("tracks resolved provider and fetches quantization once", async () => {
		const fetchMock = fetchStub({
			data: {
				endpoints: [
					// biome-ignore lint/style/useNamingConvention: OpenRouter API field
					{ provider_name: "StreamLake", tag: "streamlake/fp8" },
					// biome-ignore lint/style/useNamingConvention: OpenRouter API field
					{ provider_name: "gmicloud", tag: "gmicloud/fp8" },
					// biome-ignore lint/style/useNamingConvention: OpenRouter API field
					{ provider_name: "novita" },
				],
			},
		});
		const line = createStatusLine({ fetch: fetchMock });
		const event: ProviderStreamEventLike = {
			provider: "openrouter",
			model: "z-ai/glm-5.3-flash",
			data: { provider: "StreamLake" },
		};
		await line.onProviderStreamEvent(event);
		expect(line.providerPart()).toBe("⇢ StreamLake · fp8");
		await line.onProviderStreamEvent({ ...event, data: { provider: "GMICloud" } });
		expect(line.providerPart()).toBe("⇢ GMICloud · fp8");
		await line.onProviderStreamEvent({ ...event, data: { provider: "Novita" } });
		// tag-less endpoint falls back to "native"
		expect(line.providerPart()).toBe("⇢ Novita · native");
		// endpoints fetched exactly once for the model
		expect(fetchMock.calls).toEqual(["https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints"]);
	});

	test("ignores non-openrouter and malformed stream events", async () => {
		const fetchMock = fetchStub({ data: { endpoints: [] } });
		const line = createStatusLine({ fetch: fetchMock });
		await line.onProviderStreamEvent({ provider: "anthropic", data: { provider: "bedrock" } });
		await line.onProviderStreamEvent({ provider: "openrouter", data: { provider: 42 } });
		await line.onProviderStreamEvent({ provider: "openrouter", data: null });
		expect(line.providerPart()).toBeUndefined();
		expect(fetchMock.calls).toEqual([]);
	});

	test("survives network errors and non-2xx responses", async () => {
		// biome-ignore lint/correctness/useQwikValidLexicalScope: Qwik-only rule, misfires here
		const failing: FetchLike = () => Promise.reject(new Error("offline"));
		const line = createStatusLine({ fetch: failing });
		await line.onProviderStreamEvent({ provider: "openrouter", model: "m", data: { provider: "X" } });
		expect(line.providerPart()).toBe("⇢ X");
		const httpError = createStatusLine({ fetch: fetchStub({}, false) });
		await httpError.onProviderStreamEvent({ provider: "openrouter", model: "m", data: { provider: "Y" } });
		expect(httpError.providerPart()).toBe("⇢ Y");
	});
});
