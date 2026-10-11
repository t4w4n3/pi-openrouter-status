/**
 * OpenRouter status line state for the Pi footer: the provider actually
 * resolved (from SSE chunk fields), its quantization (from the OpenRouter
 * /models/{id}/endpoints API), and the number of Pi retries of the current
 * turn (shown when > 0).
 *
 * - provider: `provider` field of OpenRouter SSE chunks
 * - quantization: endpoint tag from /models/{id}/endpoints (e.g. "fp8")
 * - retries: assistant messages that ended in error (`stopReason: "error"`)
 *   during the current turn. The internal auto_retry_start event is not
 *   exposed to extensions, and after_provider_response is not emitted for
 *   non-2xx responses (the OpenAI SDK throws first). Every retryable error
 *   is followed by a Pi retry, so counting errors counts retries. The last
 *   failure of an exhausted run also counts: shown as N+1 after a final
 *   failure following N retries.
 *
 * This module is side-effect free: state lives in `StatusLineState`,
 * rendering helpers live in `footer-render.ts`, and Pi wiring happens in
 * `index.ts`.
 */

const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1/models";

export function formatTokens(count: number): string {
	const Thousand = 1000;
	const TenThousand = 10_000;
	const Million = 1_000_000;
	const TenMillion = 10_000_000;
	if (count < Thousand) {
		return count.toString();
	}
	if (count < TenThousand) {
		return `${(count / Thousand).toFixed(1)}k`;
	}
	if (count < Million) {
		return `${Math.round(count / Thousand)}k`;
	}
	if (count < TenMillion) {
		return `${(count / Million).toFixed(1)}M`;
	}
	return `${Math.round(count / Million)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) {
		return cwd;
	}
	if (!cwd.startsWith(home)) {
		return cwd;
	}
	if (cwd === home) {
		return "~";
	}
	return `~${cwd.slice(home.length)}`;
}

// --- Narrow structural types (real Pi types are structurally compatible) ---

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

export interface ContextUsageLike {
	percent?: number | null;
	contextWindow?: number;
}

export interface ModelLike {
	id: string;
	reasoning?: boolean;
	contextWindow?: number;
}

export interface MessageEndEventLike {
	message: { role: string; stopReason?: string };
}

export interface ProviderStreamEventLike {
	provider: string;
	model?: string;
	data: unknown;
}

export interface CompactionEventLike {
	reason: string;
}

export interface QuantizationEndpoint {
	// biome-ignore lint/style/useNamingConvention: field name from the OpenRouter API payload
	provider_name?: string;
	tag?: string;
}

export interface QuantizationResponse {
	data?: { endpoints?: QuantizationEndpoint[] };
}

export type FetchLike = (input: string) => Promise<Response>;

export interface StatusLineOptions {
	/** Injectable fetch for tests; defaults to the global fetch. */
	fetch?: FetchLike;
}

export interface StatusLine {
	/** Record an assistant message end (retry/error counting). */
	onMessageEnd: (event: MessageEndEventLike) => void;
	/** Track the resolved OpenRouter provider from a stream chunk. */
	onProviderStreamEvent: (event: ProviderStreamEventLike) => Promise<void>;
	/** Confirm auto-compaction when a threshold/overflow compaction runs. */
	onBeforeCompaction: (event: CompactionEventLike) => void;
	/** Reset the retry counter at the start of a new turn. */
	onBeforeAgentStart: () => void;
	/** Current inline provider fragment, e.g. "⇢ StreamLake · fp8 ↻1". */
	providerPart: () => string | undefined;
	/** Whether auto-compaction is considered enabled (drives the "(auto)" hint). */
	isAutoCompact: () => boolean;
	/** Hook the render pump installed by the footer. */
	attachRender: (render: () => void) => void;
	detachRender: () => void;
}

/** Stateful part of the status line: event counters plus quantization lookup. */
export class StatusLineState implements StatusLine {
	private readonly fetchJson: FetchLike;
	private readonly quantByProvider = new Map<string, Set<string>>();
	private render: (() => void) | undefined;
	private lastProvider: string | undefined;
	private retries = 0;
	private activeModel: string | undefined;
	// "(auto)" indicator: auto-compaction enabled (confirmed when an
	// automatic compaction is observed; Pi enables it by default)
	private autoCompact = true;

	constructor(fetchJson: FetchLike) {
		this.fetchJson = fetchJson;
	}

	onMessageEnd(event: MessageEndEventLike): void {
		if (event.message.role !== "assistant" || event.message.stopReason !== "error") {
			return;
		}
		this.retries += 1;
		this.updateStatus();
	}

	async onProviderStreamEvent(event: ProviderStreamEventLike): Promise<void> {
		if (event.provider !== "openrouter") {
			return;
		}
		const data = event.data as { provider?: unknown } | null;
		if (!data || typeof data.provider !== "string") {
			return;
		}
		if (!this.activeModel) {
			this.activeModel = event.model;
		}
		if (data.provider === this.lastProvider) {
			return;
		}
		this.lastProvider = data.provider;
		this.updateStatus();
		if (this.activeModel) {
			await this.loadQuantization(this.activeModel);
		}
	}

	onBeforeCompaction(event: CompactionEventLike): void {
		// A threshold/overflow compaction confirms auto-compaction is on.
		if (event.reason !== "manual") {
			this.autoCompact = true;
		}
	}

	onBeforeAgentStart(): void {
		// New turn: reset the counter; keep the last known provider.
		this.retries = 0;
		this.updateStatus();
	}

	providerPart(): string | undefined {
		if (!this.lastProvider) {
			return undefined;
		}
		let suffix = "";
		const quants = this.quantByProvider.get(this.lastProvider.toLowerCase());
		if (quants && quants.size > 0) {
			suffix += ` · ${[...quants].sort().join("/")}`;
		}
		if (this.retries > 0) {
			suffix += ` ↻${this.retries}`;
		}
		return `⇢ ${this.lastProvider}${suffix}`;
	}

	isAutoCompact(): boolean {
		return this.autoCompact;
	}

	attachRender(render: () => void): void {
		this.render = render;
	}

	detachRender(): void {
		this.render = undefined;
	}

	private updateStatus(): void {
		this.render?.();
	}

	private async loadQuantization(model: string): Promise<void> {
		if (this.quantByProvider.size > 0 || !model) {
			return;
		}
		let json: QuantizationResponse;
		try {
			const res = await this.fetchJson(`${OPENROUTER_API_BASE_URL}/${model}/endpoints`);
			if (!res.ok) {
				return;
			}
			json = (await res.json()) as QuantizationResponse;
		} catch {
			// network unavailable: quantization stays absent, never blocks
			return;
		}
		this.recordEndpoints(json.data?.endpoints ?? []);
		this.updateStatus();
	}

	private recordEndpoints(endpoints: readonly QuantizationEndpoint[]): void {
		for (const endpoint of endpoints) {
			const name = endpoint.provider_name?.toLowerCase();
			if (name) {
				// tag "streamlake/fp8" -> quantization "fp8"; missing tag -> "native"
				const quant = endpoint.tag?.split("/")[1] ?? "native";
				let set = this.quantByProvider.get(name);
				if (!set) {
					set = new Set<string>();
					this.quantByProvider.set(name, set);
				}
				set.add(quant);
			}
		}
	}
}

/** Create the status line state used by the footer and event handlers. */
export function createStatusLine(options: StatusLineOptions = {}): StatusLine {
	const fetchJson: FetchLike = options.fetch ?? ((input: string) => fetch(input));
	return new StatusLineState(fetchJson);
}
