/**
 * Pi extension: OpenRouter status line + shipped OpenRouter/retry config.
 *
 * - Footer status line: resolved provider, quantization, retry count.
 * - `/openrouter-pin`: idempotently merge the shipped config fragments
 *   (provider pinning + retry policy) into `models.json`/`settings.json`
 *   of the Pi agent directory, plus per-model compaction thresholds
 *   resolved from the context lengths OpenRouter declares for the
 *   enabled `openrouter/*` models (auto-compact at ~350K tokens for
 *   large windows; built-in default below that). A one-time hint is
 *   shown on session start when the static fragments are not applied yet.
 */

import process from "node:process";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyConfig, checkApplied, getAgentDir } from "./apply-config.ts";
import { tuneConfigTargets } from "./compaction-tune.ts";
import { installOpenRouterFooter } from "./footer-render.ts";
import { CONFIG_TARGETS } from "./fragments.ts";
import { ProviderPin } from "./provider-pin.ts";
import { createStatusLine } from "./status-line.ts";

const COMMAND_NAME = "openrouter-pin";

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function applyShippedConfig(ctx: ExtensionCommandContext): Promise<void> {
	let confirmed = true;
	if (ctx.mode === "tui") {
		confirmed = await ctx.ui.confirm(
			COMMAND_NAME,
			"Merge pinned providers + retry policy + per-model compaction thresholds into models.json and settings.json?",
		);
	}
	if (!confirmed) {
		ctx.ui.notify("Aborted, nothing was written.", "info");
		return;
	}
	try {
		// Augment the static targets with per-model compaction thresholds
		// resolved from the OpenRouter catalog; failures degrade to the
		// static targets and are reported as warnings.
		const { targets, tuned, warnings } = await tuneConfigTargets(getAgentDir(), CONFIG_TARGETS);
		for (const warning of warnings) {
			ctx.ui.notify(`${COMMAND_NAME}: ${warning}`, "warning");
		}
		const outcomes = await applyConfig(getAgentDir(), targets);
		reportOutcomes(ctx, outcomes);
		if (
			tuned.length > 0 &&
			outcomes.some((outcome) => outcome.file === "settings.json" && outcome.status !== "unchanged")
		) {
			ctx.ui.notify(
				`${COMMAND_NAME}: compaction thresholds pinned for ${tuned.length} model(s) — restart Pi or run /reload to apply`,
				"info",
			);
		}
	} catch (error) {
		ctx.ui.notify(`${COMMAND_NAME}: ${describeError(error)}`, "error");
	}
}

function reportOutcomes(ctx: ExtensionCommandContext, outcomes: Awaited<ReturnType<typeof applyConfig>>): void {
	const applied = outcomes.filter((outcome) => outcome.status !== "unchanged");
	if (applied.length === 0) {
		ctx.ui.notify(`${COMMAND_NAME}: config already applied, nothing to do.`, "info");
		return;
	}
	for (const outcome of applied) {
		ctx.ui.notify(`${COMMAND_NAME}: ${outcome.status} ${outcome.file}`, "info");
	}
}

async function hintMissingConfig(ctx: ExtensionContext, hinted: { shown: boolean }): Promise<void> {
	if (hinted.shown) {
		return;
	}
	hinted.shown = true;
	try {
		const checks = await checkApplied(getAgentDir(), CONFIG_TARGETS);
		notifyMissing(
			ctx,
			checks.filter((check) => !check.applied).map((check) => check.file),
		);
	} catch {
		// config dir unreadable: stay silent, /openrouter-pin reports errors
	}
}

function notifyMissing(ctx: ExtensionContext, missing: readonly string[]): void {
	if (missing.length > 0) {
		ctx.ui.notify(`${COMMAND_NAME}: shipped config not applied (${missing.join(", ")}) — run /${COMMAND_NAME}`, "info");
	}
}

// Pi discovers extensions through the module's default export; this is the
// loading contract, not a style choice.
// biome-ignore lint/style/noDefaultExport: required by the Pi extension loader
export default function (pi: ExtensionAPI) {
	const line = createStatusLine();
	const pin = new ProviderPin();
	let footerInstalled = false;
	const hinted = { shown: false };
	// Extensions read HOME (and honor PI_CODING_AGENT_DIR via getAgentDir);
	// there is no alternative in the Pi runtime contract.
	// biome-ignore lint/style/noProcessEnv: agent dir + home resolution
	const { HOME, USERPROFILE } = process.env;
	const home = HOME ?? USERPROFILE;

	pi.on("message_end", (event) => {
		line.onMessageEnd(event);
		const message = event.message as { role?: string; stopReason?: string };
		pin.onMessageEnd(message.role, message.stopReason);
	});

	// Rewrite every GLM request to the active endpoint so OpenRouter never
	// fails over silently: upstream 429s reach Pi's retry layer, which
	// re-issues the same payload (same endpoint) with backoff.
	pi.on("before_provider_request", (event) => {
		pin.onBeforeProviderRequest(event.payload);
	});

	pi.on("provider_stream_event", async (event) => {
		await line.onProviderStreamEvent(event);
	});

	pi.on("session_before_compact", (event) => {
		line.onBeforeCompaction(event);
	});

	pi.on("before_agent_start", () => {
		line.onBeforeAgentStart();
		pin.onBeforeAgentStart();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!footerInstalled) {
			footerInstalled = installOpenRouterFooter(ctx, line, home);
		}
		await hintMissingConfig(ctx, hinted);
	});

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Apply the shipped OpenRouter provider pin and retry policy plus per-model compaction thresholds to models.json/settings.json",
		handler: async (_args, ctx) => {
			await applyShippedConfig(ctx);
		},
	});
}
