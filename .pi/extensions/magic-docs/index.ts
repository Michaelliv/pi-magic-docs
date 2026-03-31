import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	serializeConversation,
	convertToLlm,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";

const MAGIC_HEADER = /^# MAGIC DOC:/;

interface TrackedDoc {
	path: string;
	title: string;
	instruction?: string;
}

function parseHeader(content: string): { title: string; instruction?: string } | null {
	const lines = content.split("\n");
	const idx = lines.findIndex((l) => l.trim() !== "");
	if (idx === -1 || !MAGIC_HEADER.test(lines[idx])) return null;

	const title = lines[idx].replace(/^# MAGIC DOC:\s*/, "").trim();
	if (!title) return null;

	const next = lines[idx + 1]?.trim();
	const instruction =
		next?.startsWith("*") && next.endsWith("*") ? next.slice(1, -1).trim() : undefined;

	return { title, instruction };
}

function buildUpdateMessage(docs: TrackedDoc[]): string {
	const list = docs
		.map((d) => {
			let s = `- \`${d.path}\` — "${d.title}"`;
			if (d.instruction) s += ` (focus: ${d.instruction})`;
			return s;
		})
		.join("\n");

	return (
		`Update ${docs.length} magic doc(s):\n\n${list}\n\n` +
		`Re-read each, edit in-place with anything new from our conversation. ` +
		`Be terse, high signal only. Document architecture and WHY things exist. ` +
		`Never duplicate what's obvious from code. Delete outdated sections. ` +
		`Never append "Previously..." or "Updated to..." notes. ` +
		`Fix typos and broken formatting. If nothing meaningful changed, skip silently.`
	);
}

async function checkWithHaiku(
	docs: TrackedDoc[],
	recentMessages: any[],
): Promise<boolean> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	if (!model) return true; // fallback: always update

	try {
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		let decision: boolean | undefined;

		const loader = new DefaultResourceLoader({
			extensionFactories: [
				(api) => {
					api.registerTool({
						name: "report_decision",
						label: "Report Decision",
						description: "Report whether the magic docs should be updated",
						parameters: Type.Object({
							should_update: Type.Boolean({
								description: "Whether the docs need updating",
							}),
							reason: Type.String({
								description: "Brief reason for the decision",
							}),
						}),
						execute: async (_id, params) => {
							decision = params.should_update;
							return {
								content: [{ type: "text" as const, text: "Decision recorded." }],
								details: {},
							};
						},
					});
				},
			],
		});
		await loader.reload();

		const { session } = await createAgentSession({
			model,
			thinkingLevel: "off",
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: loader,
			tools: [],
		});

		const docList = docs.map((d) => `- "${d.title}" (${d.path})`).join("\n");
		const conversationText = serializeConversation(convertToLlm(recentMessages));

		await session.prompt(
			`You decide whether living documentation files need updating based on a conversation.\n\n` +
				`Tracked docs:\n${docList}\n\n` +
				`Recent conversation:\n${conversationText}\n\n` +
				`Does this conversation contain new information (decisions, architecture changes, new features, ` +
				`corrections) that would meaningfully improve these docs? ` +
				`Ignore small talk, questions with no answers, or conversations unrelated to the docs.\n\n` +
				`Call report_decision with your answer.`,
		);

		session.dispose();
		return decision ?? true;
	} catch {
		return true; // fallback on any error
	}
}

export default function (pi: ExtensionAPI) {
	const tracked = new Map<string, TrackedDoc>();
	let agentRunHadToolCalls = false;
	let consecutiveIdleRuns = 0;
	let lastUpdateTime = 0;
	const IDLE_RUN_THRESHOLD = 2;
	const COOLDOWN_MS = 5 * 60 * 1000;

	function detect(filePath: string, content: string) {
		const parsed = parseHeader(content);
		if (!parsed) return;
		tracked.set(filePath, { path: filePath, ...parsed });
	}

	function detectFromDisk(filePath: string) {
		try {
			detect(filePath, fs.readFileSync(filePath, "utf-8"));
		} catch {}
	}

	function textFrom(content: any[]): string | null {
		const first = content?.[0];
		return first && typeof first === "object" && first.type === "text" ? first.text : null;
	}

	// Detect magic docs when agent reads, edits, or writes files
	pi.on("tool_result", async (event) => {
		const input = (event as any).input;
		if (event.toolName === "read") {
			const text = textFrom(event.content);
			if (input?.path && text) detect(input.path, text);
		} else if (event.toolName === "edit" || event.toolName === "write") {
			if (input?.path) detectFromDisk(input.path);
		}
	});

	pi.on("agent_start", async () => {
		agentRunHadToolCalls = false;
	});

	// Track whether any turn in this agent run had tool calls
	pi.on("turn_end", async (event) => {
		if (((event as any).toolResults?.length ?? 0) > 0) {
			agentRunHadToolCalls = true;
		}
	});

	// Fire update after N consecutive idle agent runs
	pi.on("agent_end", async (_event, ctx) => {
		if (tracked.size === 0) return;

		if (agentRunHadToolCalls) {
			consecutiveIdleRuns = 0;
			return;
		}

		consecutiveIdleRuns++;
		if (consecutiveIdleRuns < IDLE_RUN_THRESHOLD) return;
		if (Date.now() - lastUpdateTime < COOLDOWN_MS) return;

		// Prune deleted or no-longer-magic files
		for (const [path] of tracked) {
			try {
				if (!parseHeader(fs.readFileSync(path, "utf-8"))) tracked.delete(path);
			} catch {
				tracked.delete(path);
			}
		}
		if (tracked.size === 0) return;

		// Get recent conversation messages for Haiku to evaluate
		const recentMessages = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "message")
			.map((e) => (e as any).message)
			.slice(-30);

		const docs = Array.from(tracked.values());
		const shouldUpdate = await checkWithHaiku(docs, recentMessages);

		if (!shouldUpdate) {
			consecutiveIdleRuns = 0;
			lastUpdateTime = Date.now();
			return;
		}

		pi.sendMessage(
			{
				customType: "magic-docs-update",
				content: buildUpdateMessage(docs),
				display: true,
			},
			{ triggerTurn: true },
		);

		consecutiveIdleRuns = 0;
		lastUpdateTime = Date.now();
	});

	// Restore tracking from session history
	pi.on("session_start", async (_event, ctx) => {
		tracked.clear();
		agentRunHadToolCalls = false;
		consecutiveIdleRuns = 0;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult") continue;
			if (msg.toolName === "read") {
				const text = textFrom(msg.content);
				if (msg.input?.path && text) detect(msg.input.path, text);
			} else if (msg.toolName === "edit" || msg.toolName === "write") {
				if (msg.input?.path) detectFromDisk(msg.input.path);
			}
		}

		if (tracked.size > 0) {
			ctx.ui.notify(`Tracking ${tracked.size} magic doc(s)`, "info");
		}
	});

	pi.registerCommand("magic-docs", {
		description: "Force an immediate magic docs update",
		handler: async (_args, ctx) => {
			if (tracked.size === 0) {
				ctx.ui.notify("No magic docs tracked in this session", "info");
				return;
			}

			const docs = Array.from(tracked.values());

			pi.sendMessage(
				{
					customType: "magic-docs-update",
					content: buildUpdateMessage(docs),
					display: true,
				},
				{ triggerTurn: true },
			);

			lastUpdateTime = Date.now();
			consecutiveIdleRuns = 0;
		},
	});

	// Inject tracking info into system prompt
	pi.on("before_agent_start", async (event) => {
		if (tracked.size === 0) return;

		const list = Array.from(tracked.values())
			.map((d) => `  - ${d.path} ("${d.title}")`)
			.join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n## Magic Docs\n\nYou are tracking living documents (files starting with \`# MAGIC DOC:\`). ` +
				`They update themselves from the conversation. Currently tracking:\n${list}\n\n` +
				`When asked to update them: re-read, edit in-place, be terse, delete stale sections. Never narrate changes.`,
		};
	});
}
