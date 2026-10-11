/**
 * Pure footer rendering for the OpenRouter status line.
 *
 * The provider renders inline on the footer stats line
 * (`↑3.5k ↓13 $0.001 ⇢ provider 0.3%/1.0M (auto)`), so the default footer
 * is replaced via setFooter() with an equivalent render (pwd line, stats +
 * provider line, other extensions' statuses) that inserts the provider.
 * All functions here are pure: no Pi state access beyond the arguments.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsageLike, ModelLike, StatusLine, UsageSnapshot } from "./status-line.ts";
import { formatCwdForFooter, formatTokens } from "./status-line.ts";

const CONTEXT_WARN_THRESHOLD = 70;
const CONTEXT_ERROR_THRESHOLD = 90;
const CONTEXT_FALLBACK_WINDOW = 0;
const MIN_RIGHT_SIDE_PADDING = 2;
const PERCENT_SCALE = 100;
const CACHE_RATE_PRECISION = 1;
const COST_PRECISION = 3;
const CONTEXT_PRECISION = 1;

type KnownSessionEntry =
	| { type: "usage"; usage: UsageSnapshot }
	| { type: "message"; message: { role: string; usage?: UsageSnapshot } }
	| { type: "branch_summary"; usage: UsageSnapshot }
	| { type: "compaction"; usage: UsageSnapshot };

function recordEntryUsage(totals: UsageTotals, entry: KnownSessionEntry): void {
	if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") {
		addUsage(totals, entry.usage);
		return;
	}
	if (entry.type === "message") {
		const { role, usage } = entry.message;
		if ((role === "assistant" || role === "toolResult") && usage) {
			addUsage(totals, usage);
		}
	}
}

function addUsage(totals: UsageTotals, usage: UsageSnapshot): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function recordAssistantCacheRate(totals: UsageTotals, entry: KnownSessionEntry): void {
	if (entry.type !== "message" || entry.message.role !== "assistant" || !entry.message.usage) {
		return;
	}
	const { input, cacheRead, cacheWrite } = entry.message.usage;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens > 0) {
		totals.latestCacheHitRate = (cacheRead / promptTokens) * PERCENT_SCALE;
	}
}

function buildPwdLine(args: FooterRenderArgs, theme: ThemeLike): string {
	let pwd = formatCwdForFooter(args.cwd, args.home);
	if (args.branch) {
		pwd += ` (${args.branch})`;
	}
	if (args.sessionName) {
		pwd += ` • ${args.sessionName}`;
	}
	return truncateToWidth(theme.fg("dim", pwd), args.width, theme.fg("dim", "..."));
}

function buildStatsLine(args: FooterRenderArgs, width: number, theme: ThemeLike): string {
	const totals = computeUsageTotals(args.entries);
	const statsLeft = `${buildStatsParts(totals, args.provider).join(" ")} ${buildContextPart(args.contextUsage, args.model?.contextWindow ?? CONTEXT_FALLBACK_WINDOW, args.autoCompact, theme)}`;
	const statsLine = assembleLine(statsLeft, buildRightSide(args), width);
	// Dim applied in two parts: statsLeft may embed color codes (context
	// percentage) that would terminate the dim prematurely.
	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length);
	return dimStatsLeft + theme.fg("dim", remainder);
}

function buildRightSide(args: FooterRenderArgs): string {
	const { model } = args;
	if (!model) {
		return "no-model";
	}
	if (model.reasoning) {
		return appendThinkingLevel(model.id, args.thinkingLevel ?? "off");
	}
	return model.id;
}

function appendThinkingLevel(modelId: string, level: string): string {
	if (level === "off") {
		return `${modelId} • thinking off`;
	}
	return `${modelId} • ${level}`;
}

function buildExtensionStatusLine(args: FooterRenderArgs, width: number): string | undefined {
	const statuses = args.footerData.getExtensionStatuses();
	if (statuses.size === 0) {
		return undefined;
	}
	const sorted = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) =>
			text
				.replace(/[\r\n\t]/g, " ")
				.replace(/ +/g, " ")
				.trim(),
		);
	return truncateToWidth(sorted.join(" "), width, args.theme.fg("dim", "..."));
}

// --- exports ---

/** Real Pi session entries are structurally compatible with this union. */
export type SessionEntryLike = KnownSessionEntry | { type: string };

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

export interface ThemeLike {
	fg: (color: "dim" | "error" | "warning", text: string) => string;
}

export interface FooterDataLike {
	getGitBranch: () => string | null | undefined;
	getExtensionStatuses: () => ReadonlyMap<string, string>;
}

export interface FooterRenderArgs {
	width: number;
	theme: ThemeLike;
	footerData: FooterDataLike;
	entries: readonly SessionEntryLike[];
	cwd: string;
	home: string | undefined;
	branch: string | null | undefined;
	sessionName: string | null | undefined;
	contextUsage: ContextUsageLike | undefined;
	model: ModelLike | undefined;
	thinkingLevel: string | undefined;
	autoCompact: boolean;
	provider: string | undefined;
}

export function computeUsageTotals(entries: readonly SessionEntryLike[]): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of entries) {
		const known = entry as KnownSessionEntry;
		recordEntryUsage(totals, known);
		recordAssistantCacheRate(totals, known);
	}
	return totals;
}

export function buildStatsParts(totals: UsageTotals, provider: string | undefined): string[] {
	const parts: string[] = [];
	if (totals.input) {
		parts.push(`↑${formatTokens(totals.input)}`);
	}
	if (totals.output) {
		parts.push(`↓${formatTokens(totals.output)}`);
	}
	if (totals.cacheRead) {
		parts.push(`R${formatTokens(totals.cacheRead)}`);
	}
	if (totals.cacheWrite) {
		parts.push(`W${formatTokens(totals.cacheWrite)}`);
	}
	const hasCache = totals.cacheRead > 0 || totals.cacheWrite > 0;
	if (hasCache && totals.latestCacheHitRate !== undefined) {
		parts.push(`CH${totals.latestCacheHitRate.toFixed(CACHE_RATE_PRECISION)}%`);
	}
	if (totals.cost) {
		parts.push(`$${totals.cost.toFixed(COST_PRECISION)}`);
	}
	if (provider) {
		parts.push(provider);
	}
	return parts;
}

export function buildContextPart(
	contextUsage: ContextUsageLike | undefined,
	modelContextWindow: number,
	autoCompact: boolean,
	theme: ThemeLike,
): string {
	const contextWindow = contextUsage?.contextWindow ?? modelContextWindow ?? CONTEXT_FALLBACK_WINDOW;
	const percent = contextUsage?.percent;
	const percentValue = percent ?? 0;
	let autoIndicator = "";
	if (autoCompact) {
		autoIndicator = " (auto)";
	}
	let display: string;
	if (percent === undefined || percent === null) {
		display = `?/${formatTokens(contextWindow)}${autoIndicator}`;
	} else {
		display = `${percentValue.toFixed(CONTEXT_PRECISION)}%/${formatTokens(contextWindow)}${autoIndicator}`;
	}
	if (percentValue > CONTEXT_ERROR_THRESHOLD) {
		return theme.fg("error", display);
	}
	if (percentValue > CONTEXT_WARN_THRESHOLD) {
		return theme.fg("warning", display);
	}
	return display;
}

/** Left/right footer assembly with the same fallbacks as the default footer. */
export function assembleLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (leftWidth + MIN_RIGHT_SIDE_PADDING + rightWidth <= width) {
		const padding = " ".repeat(width - leftWidth - rightWidth);
		return left + padding + right;
	}
	const availableForRight = width - leftWidth - MIN_RIGHT_SIDE_PADDING;
	if (availableForRight > 0) {
		const truncatedRight = truncateToWidth(right, availableForRight, "");
		const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)));
		return left + padding + truncatedRight;
	}
	return truncateToWidth(left, width, "...");
}

/** Build the full footer: pwd line, stats line, extension-status line. */
export function buildFooterLines(args: FooterRenderArgs): string[] {
	const lines = [buildPwdLine(args, args.theme), buildStatsLine(args, args.width, args.theme)];
	const statusLine = buildExtensionStatusLine(args, args.width);
	if (statusLine) {
		lines.push(statusLine);
	}
	return lines;
}

/**
 * Install the replacement footer on the Pi TUI context. Returns false when
 * the context is not a TUI session (no footer to replace).
 */
export function installOpenRouterFooter(ctx: ExtensionContext, line: StatusLine, home: string | undefined): boolean {
	if (ctx.mode !== "tui") {
		return false;
	}
	ctx.ui.setFooter((tui, theme, footerData) => {
		line.attachRender(() => tui.requestRender());
		return {
			dispose() {
				line.detachRender();
			},
			// The footer component contract requires invalidate(); this
			// component keeps no per-frame state.
			// biome-ignore lint/suspicious/noEmptyBlockStatements: no-op per contract
			invalidate() {},
			render(width: number): string[] {
				return buildFooterLines({
					width,
					theme,
					footerData,
					entries: ctx.sessionManager.getEntries(),
					cwd: ctx.sessionManager.getCwd(),
					home,
					branch: footerData.getGitBranch(),
					sessionName: ctx.sessionManager.getSessionName(),
					contextUsage: ctx.getContextUsage(),
					model: ctx.model,
					thinkingLevel: ctx.thinkingLevel,
					autoCompact: line.isAutoCompact(),
					provider: line.providerPart(),
				});
			},
		};
	});
	return true;
}
