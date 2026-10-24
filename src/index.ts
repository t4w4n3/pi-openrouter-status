/**
 * Pi extension: OpenRouter status line.
 *
 * Footer status line: resolved provider, quantization, retry count. The
 * provider replaces Pi's default footer with an equivalent render (pwd,
 * token/cost totals, context percentage, model + thinking level, other
 * extensions' statuses) with the provider inline on the stats line.
 *
 * This is the extension's only job: it writes no config, registers no
 * command, and touches no request payload.
 */

import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installOpenRouterFooter } from "./footer-render.ts";
import { createStatusLine } from "./status-line.ts";

// Pi discovers extensions through the module's default export; this is the
// loading contract, not a style choice.
// biome-ignore lint/style/noDefaultExport: required by the Pi extension loader
export default function (pi: ExtensionAPI) {
	const line = createStatusLine();
	let footerInstalled = false;
	// Extensions read HOME (and honor PI_CODING_AGENT_DIR via getAgentDir);
	// there is no alternative in the Pi runtime contract.
	// biome-ignore lint/style/noProcessEnv: home resolution for footer cwd display
	const { HOME, USERPROFILE } = process.env;
	const home = HOME ?? USERPROFILE;

	pi.on("message_end", (event) => {
		line.onMessageEnd(event);
	});

	pi.on("provider_stream_event", async (event) => {
		await line.onProviderStreamEvent(event);
	});

	pi.on("session_before_compact", (event) => {
		line.onBeforeCompaction(event);
	});

	pi.on("before_agent_start", () => {
		line.onBeforeAgentStart();
	});

	pi.on("session_start", (_event, ctx) => {
		if (!footerInstalled) {
			footerInstalled = installOpenRouterFooter(ctx, line, home);
		}
	});
}
