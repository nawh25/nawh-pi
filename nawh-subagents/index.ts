/**
 * Extension entry point for the nawh-subagents extension.
 *
 * This module ties together all submodules into a pi coding-agent
 * extension. It registers:
 *
 * - A `session_start` handler that loads config and discovers agents.
 * - A `before_agent_start` handler that injects routing rules into the
 *   system prompt.
 * - A `subagent` tool that the main LLM can call to delegate work to
 *   specialist subagents (single, parallel, chain, or council mode).
 * - A `/subagents` command for interactive agent management.
 * - A `session_shutdown` handler that cleans up subprocesses and state.
 *
 * The default export is a factory function that receives the pi
 * {@link ExtensionAPI} and sets up all of the above.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ChildProcess } from "node:child_process";

import type {
	AgentDefinition,
	AgentScope,
	PantheonConfig,
	CouncillorConfig,
	SubagentDetails,
} from "./types";

import {
	discoverAgents,
	formatAgentList,
	findNearestProjectAgentsDir,
} from "./agents";
import { loadConfig, resolveCouncilConfig } from "./config";
import { buildOrchestratorPrompt } from "./orchestrator-prompt";
import {
	execute as executeSubagent,
	type SubagentToolArgs,
	type ToolResult,
} from "./runner";
import { runCouncil } from "./council";
import { clearWidget } from "./widget";
import {
	renderCall as renderCallStr,
	renderResult as renderResultStr,
} from "./render";

// ---------------------------------------------------------------------------
// Typebox schema for the subagent tool parameters
// ---------------------------------------------------------------------------

const subagentSchema = Type.Object({
	agent: Type.Optional(
		Type.String({
			description:
				"Agent name for single mode (e.g. 'explorer', 'oracle', 'council')",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task description for single mode" }),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name" }),
				task: Type.String({ description: "Task description" }),
				cwd: Type.Optional(
					Type.String({ description: "Working directory override" }),
				),
			}),
			{
				description: "Parallel tasks array — run multiple agents concurrently",
			},
		),
	),
	chain: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name" }),
				task: Type.String({
					description:
						"Task description (use {previous} to reference prior step output)",
				}),
				cwd: Type.Optional(
					Type.String({ description: "Working directory override" }),
				),
			}),
			{
				description: "Sequential chain — each step runs after the previous one",
			},
		),
	),
	agentScope: Type.Optional(
		Type.Union(
			[Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
			{
				description:
					"Which agent sources to discover: user, project, or both (default: both)",
			},
		),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Whether to confirm before running project-level agents",
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for single-mode execution" }),
	),
});

/**
 * Manual interface matching what pi infers from the schema.
 * Typebox's `Static<typeof subagentSchema>` makes inner fields optional
 * due to Optional-wrapping, which is what pi's registerTool also infers.
 * We define it explicitly to avoid the `Static` import and ensure compatibility.
 */
interface SubagentParams {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent?: string; task?: string; cwd?: string }>;
	chain?: Array<{ agent?: string; task?: string; cwd?: string }>;
	agentScope?: "user" | "project" | "both";
	confirmProjectAgents?: boolean;
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Simple Component wrapper for string-based rendering
// ---------------------------------------------------------------------------

/**
 * A minimal Component implementation that renders a string as lines.
 * Used to bridge the string-based render.ts functions to pi's Component
 * interface.
 */
class TextComponent {
	private lines: string[];
	private cached: string[] | undefined;
	private cachedWidth: number | undefined;

	constructor(text: string) {
		this.lines = text.split("\n");
	}

	render(width: number): string[] {
		// Simple word-wrapping: if a line exceeds the width, hard-wrap it
		if (this.cachedWidth === width && this.cached) {
			return this.cached;
		}
		const wrapped: string[] = [];
		for (const line of this.lines) {
			if (line.length <= width) {
				wrapped.push(line);
			} else {
				// Hard-wrap at width boundary
				let remaining = line;
				while (remaining.length > width) {
					wrapped.push(remaining.slice(0, width));
					remaining = remaining.slice(width);
				}
				if (remaining.length > 0) {
					wrapped.push(remaining);
				}
			}
		}
		this.cached = wrapped;
		this.cachedWidth = width;
		return wrapped;
	}

	invalidate(): void {
		this.cached = undefined;
		this.cachedWidth = undefined;
	}
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Mutable state shared across event handlers and tool execution.
 * Populated during `session_start` and used throughout the session.
 */
interface SessionState {
	config: PantheonConfig;
	agents: AgentDefinition[];
	/** Running subprocesses for cleanup on shutdown. */
	activeProcesses: Set<ChildProcess>;
}

// ---------------------------------------------------------------------------
// Task 10.1 — Default export factory function
// ---------------------------------------------------------------------------

/**
 * Pi extension factory.
 *
 * Called by pi when the extension is loaded. Sets up event handlers,
 * registers the `subagent` tool and the `/subagents` command, and
 * manages session state.
 */
export default function (pi: ExtensionAPI): void {
	// Session state — populated on session_start
	let state: SessionState | null = null;

	// -------------------------------------------------------------------------
	// Task 10.2 — before_agent_start handler
	// -------------------------------------------------------------------------

	pi.on("before_agent_start", (event, _ctx) => {
		if (!state) return;

		const { config, agents } = state;

		// Determine enabled agent names (discovered minus disabled)
		const enabledAgentNames = agents
			.map((a) => a.name)
			.filter((name) => !config.disabledAgents.includes(name));

		// Build the routing prompt
		const routingPrompt = buildOrchestratorPrompt(
			enabledAgentNames,
			config.disabledAgents,
		);

		// Append routing prompt to the system prompt
		const augmentedSystemPrompt = event.systemPrompt + "\n\n" + routingPrompt;

		return {
			systemPrompt: augmentedSystemPrompt,
		};
	});

	// -------------------------------------------------------------------------
	// session_start handler
	// -------------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		// Load config and discover agents
		const config = loadConfig();
		const agents = discoverAgents(process.cwd(), "both");

		state = {
			config,
			agents,
			activeProcesses: new Set(),
		};

		// Clear the widget initially
		clearWidget(ctx);
	});

	// -------------------------------------------------------------------------
	// Task 10.6 — session_shutdown handler
	// -------------------------------------------------------------------------

	pi.on("session_shutdown", (_event, ctx) => {
		// Clear the widget
		clearWidget(ctx);

		// Kill any running subprocesses
		if (state) {
			for (const proc of state.activeProcesses) {
				try {
					proc.kill("SIGTERM");
					// Schedule SIGKILL after grace period
					setTimeout(() => {
						try {
							proc.kill("SIGKILL");
						} catch {
							// Process already exited
						}
					}, 5000);
				} catch {
					// Process already exited
				}
			}
			state.activeProcesses.clear();
		}

		state = null;
	});

	// -------------------------------------------------------------------------
	// Task 10.3 + 10.4 — Register subagent tool
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate work to specialist subagents.\n\n" +
			"Modes:\n" +
			"- Single: { agent, task } — run one agent\n" +
			"- Parallel: { tasks: [{ agent, task }, ...] } — run multiple agents concurrently\n" +
			"- Chain: { chain: [{ agent, task }, ...] } — run agents sequentially, use {previous} to reference prior output\n" +
			"\n" +
			"Use /subagents command to see available agents.",

		parameters: subagentSchema,

		promptSnippet:
			"delegate work to specialist subagents (explorer, oracle, fixer, etc.)",

		promptGuidelines: [
			"Use the `subagent` tool to delegate to specialist agents. Include sufficient context (paths, line numbers) — subagents do NOT inherit your conversation history.",
			"Use parallel mode ({ tasks: [...] }) for independent tasks, chain mode ({ chain: [...] }) when one task's output feeds the next.",
			"Use the council agent only for high-stakes decisions requiring multi-model consensus — it is the most expensive path.",
		],

		renderShell: "self",

		/**
		 * Render the tool call display (before and during execution).
		 */
		renderCall(args: SubagentParams, theme: any, context: any): any {
			// Bridge render.ts string output to a Component
			const text = renderCallStr(args as any, theme, context);
			return new TextComponent(text);
		},

		/**
		 * Render the tool result display (collapsed and expanded views).
		 */
		renderResult(result: any, options: any, theme: any, context: any): any {
			const rendered = renderResultStr(result, theme, context);
			// Combine collapsed and expanded based on the expanded flag
			const text = options?.expanded ? rendered.expanded : rendered.collapsed;
			return new TextComponent(text);
		},

		/**
		 * Execute the subagent tool.
		 *
		 * Dispatches to single/parallel/chain mode via runner.ts, or to
		 * council mode via council.ts when the agent is "council".
		 */
		async execute(
			_toolCallId: string,
			params: SubagentParams,
			signal: AbortSignal | undefined,
			onUpdate: ((partialResult: any) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<any> {
			// Ensure session state is available
			if (!state) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: subagent session not initialized. Try reloading the extension.",
						},
					],
					details: { error: "Session not initialized" },
				};
			}

			const { config } = state;

			// Determine agent scope and re-discover agents if needed
			const agentScope: AgentScope =
				(params.agentScope as AgentScope) || "both";
			const effectiveAgents =
				agentScope === "both" && state.agents.length > 0
					? state.agents
					: discoverAgents(process.cwd(), agentScope);

			// -------------------------------------------------------------------------
			// Task 10.4 — confirmProjectAgents check
			// -------------------------------------------------------------------------

			const confirmed = await checkProjectAgentConfirmation(
				params,
				ctx,
				config,
			);
			if (!confirmed) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Project agent execution cancelled by user.",
						},
					],
					details: { error: "User declined project agent execution" },
				};
			}

			// Build the SubagentToolArgs from the tool params
			const args: SubagentToolArgs = {
				agent: params.agent,
				task: params.task,
				tasks: params.tasks as SubagentToolArgs["tasks"],
				chain: params.chain as SubagentToolArgs["chain"],
				agentScope,
				confirmProjectAgents: params.confirmProjectAgents,
				cwd: params.cwd,
			};

			// Create registerProcess callback for lifecycle tracking
			const registerProcess = (child: ChildProcess): (() => void) => {
				state!.activeProcesses.add(child);
				return () => {
					state!.activeProcesses.delete(child);
				};
			};

			// --- Council routing ---
			// If single mode with agent "council", route to runCouncil
			if (params.agent === "council" && params.task !== undefined) {
				return await executeCouncil(
					params.task,
					params.cwd || ctx.cwd,
					effectiveAgents,
					config,
					signal,
					onUpdate,
					ctx,
					registerProcess,
				);
			}

			// --- Standard execution (single / parallel / chain) ---
			const runnerCtx = {
				cwd: ctx.cwd,
				signal: signal ?? ctx.signal,
				ui: ctx.ui as ExtensionUIContext | undefined,
				registerProcess,
			};

			const result: ToolResult = await executeSubagent(
				args,
				runnerCtx,
				effectiveAgents,
				config,
				signal ?? ctx.signal,
			);

			// Build the AgentToolResult
			const outputText = result.error
				? (result.output ? result.output + "\n\n" : "") +
					"Error: " +
					result.error
				: result.output;

			const details = {
				output: result.output,
				error: result.error,
				details: result.details,
			};

			// Send a final update if callback is available
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text" as const, text: outputText }],
					details,
				});
			}

			return {
				content: [{ type: "text" as const, text: outputText }],
				details,
			};
		},
	});

	// -------------------------------------------------------------------------
	// Task 10.5 — Register /subagents command
	// -------------------------------------------------------------------------

	pi.registerCommand("subagents", {
		description:
			"Manage subagents: view running agents, agent types, and settings",

		async handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
			if (!state) {
				ctx.ui.notify("Subagents not initialized yet.", "warning");
				return;
			}

			const { config, agents } = state;

			// Build menu lines
			const lines: string[] = [];

			// --- Settings section ---
			lines.push("╭─ Settings ─────────────────────────╮");
			lines.push(`│ Preset:           ${config.preset}`);
			lines.push(`│ Max concurrency:  ${config.maxConcurrency}`);
			lines.push(`│ Max parallel:     ${config.maxParallel}`);
			lines.push(`│ Confirm project:  ${config.confirmProjectAgents}`);
			lines.push("╰────────────────────────────────────╯");

			// --- Disabled agents ---
			if (config.disabledAgents.length > 0) {
				lines.push("");
				lines.push("Disabled agents:");
				for (const name of config.disabledAgents) {
					lines.push(`  ✗ ${name}`);
				}
			}

			// --- Agent types ---
			lines.push("");
			lines.push("╭─ Agents ───────────────────────────╮");
			for (const agent of agents) {
				const sourceTag =
					agent.source.type === "project"
						? "[project]"
						: agent.source.type === "extension"
							? "[builtin]"
							: "[user]";
				const isDisabled = config.disabledAgents.includes(agent.name);
				const status = isDisabled ? "✗" : "✓";
				const councilTag = agent.isCouncil ? " (council)" : "";
				const lockedTag = agent.locked ? " 🔒" : "";
				lines.push(
					`│ ${status} ${agent.name}${councilTag}${lockedTag} ${sourceTag}`,
				);
				if (agent.description) {
					lines.push(`│   ${agent.description}`);
				}
			}
			lines.push("╰────────────────────────────────────╯");

			// --- Running agents ---
			const runningCount = state.activeProcesses.size;
			lines.push("");
			if (runningCount > 0) {
				lines.push(`Running: ${runningCount} agent(s) active`);
			} else {
				lines.push("No agents currently running.");
			}

			// Display the info
			const menuText = lines.join("\n");

			// Use the UI to show the information
			if (ctx.hasUI) {
				// Offer a simple selection for settings management
				const options = [
					"View agent details",
					"Toggle agent enable/disable",
					"Change preset",
					"Change max concurrency",
					"Exit",
				];

				while (true) {
					const choice = await ctx.ui.select("Subagents Management", options);

					if (!choice || choice === "Exit") {
						// Show the info text before exiting
						ctx.ui.notify(menuText, "info");
						break;
					}

					if (choice === "View agent details") {
						// Show all agent info
						ctx.ui.notify(menuText, "info");
					} else if (choice === "Toggle agent enable/disable") {
						const agentNames = agents.map((a) => a.name);
						const agentChoice = await ctx.ui.select(
							"Select agent to toggle",
							agentNames,
						);
						if (agentChoice) {
							const isDisabled = config.disabledAgents.includes(agentChoice);
							if (isDisabled) {
								config.disabledAgents = config.disabledAgents.filter(
									(n) => n !== agentChoice,
								);
								ctx.ui.notify(`Enabled agent: ${agentChoice}`, "info");
							} else {
								config.disabledAgents.push(agentChoice);
								ctx.ui.notify(`Disabled agent: ${agentChoice}`, "info");
							}
						}
					} else if (choice === "Change preset") {
						const presetNames = Object.keys(config.presets);
						if (presetNames.length === 0) {
							ctx.ui.notify("No presets configured in config.", "warning");
						} else {
							const presetChoice = await ctx.ui.select(
								"Select preset",
								presetNames,
							);
							if (presetChoice) {
								config.preset = presetChoice;
								ctx.ui.notify(`Preset changed to: ${presetChoice}`, "info");
							}
						}
					} else if (choice === "Change max concurrency") {
						const input = await ctx.ui.input(
							"Max concurrency (1-20)",
							String(config.maxConcurrency),
						);
						if (input) {
							const val = parseInt(input, 10);
							if (Number.isInteger(val) && val >= 1 && val <= 20) {
								config.maxConcurrency = val;
								ctx.ui.notify(`Max concurrency set to: ${val}`, "info");
							} else {
								ctx.ui.notify(
									"Invalid value. Must be an integer 1-20.",
									"error",
								);
							}
						}
					}
				}
			} else {
				// No UI — just write to stderr
				process.stderr.write(menuText + "\n");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Task 10.4 — confirmProjectAgents check (helper function)
// ---------------------------------------------------------------------------

/**
 * Check whether the user should be prompted before running project-level
 * agents.
 *
 * If `agentScope` is "project" or "both" AND project agents exist (a
 * `.pi/agents/` directory is found) AND `confirmProjectAgents` is true
 * (from config or args override) AND the UI is available, prompt the
 * user with a warning about running project-local agents.
 *
 * If the user declines, `false` is returned and the caller should abort.
 * If no UI is available, confirmation is skipped (returns `true`).
 *
 * @param args - The tool parameters.
 * @param ctx - The extension context.
 * @param config - The loaded pantheon configuration.
 * @returns `true` if execution should proceed, `false` if the user declined.
 */
async function checkProjectAgentConfirmation(
	args: SubagentParams,
	ctx: ExtensionContext,
	config: PantheonConfig,
): Promise<boolean> {
	const scope: AgentScope = (args.agentScope as AgentScope) || "both";

	// Only confirm for project/both scope
	if (scope === "user") return true;

	// Check if confirmation is needed (args override takes precedence)
	const confirm = args.confirmProjectAgents ?? config.confirmProjectAgents;
	if (!confirm) return true;

	// Check if project agents directory exists
	const projectDir = findNearestProjectAgentsDir(process.cwd());
	if (!projectDir) return true; // no project agents to confirm

	// If no UI available, proceed without confirmation
	if (!ctx?.hasUI) return true;

	// Prompt the user
	const confirmed = await ctx.ui.confirm(
		"Project-local agents detected",
		"Running project agents from .pi/agents/ may execute untrusted code. Continue?",
	);

	return confirmed;
}

// ---------------------------------------------------------------------------
// Council execution helper
// ---------------------------------------------------------------------------

/**
 * Execute the council agent by running all councillors in parallel,
 * then synthesizing their responses.
 *
 * @param task - The question posed to the council.
 * @param cwd - Working directory.
 * @param agents - Discovered agent definitions.
 * @param config - The loaded pantheon configuration.
 * @param signal - Optional abort signal.
 * @param onUpdate - Optional update callback for streaming.
 * @param ctx - Extension context.
 * @returns An AgentToolResult with the council synthesis and details.
 */
async function executeCouncil(
	task: string,
	cwd: string,
	agents: AgentDefinition[],
	config: PantheonConfig,
	signal: AbortSignal | undefined,
	onUpdate: ((partialResult: any) => void) | undefined,
	_ctx: ExtensionContext,
	registerProcess?: (child: ChildProcess) => () => void,
): Promise<any> {
	// Find the council agent definition
	const councilAgentDef = agents.find(
		(a) => a.name === "council" || a.isCouncil,
	);

	if (!councilAgentDef) {
		return {
			content: [
				{
					type: "text" as const,
					text:
						'Error: No "council" agent found. Available agents:\n' +
						formatAgentList(agents),
				},
			],
			details: { error: "Council agent not found" },
		};
	}

	// Resolve the councillor configurations from the preset
	const councillors: CouncillorConfig[] = resolveCouncilConfig(
		councilAgentDef,
		config,
	);

	if (councillors.length === 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: No councillors configured for the council agent.",
				},
			],
			details: { error: "No councillors configured" },
		};
	}

	// Build a details snapshot factory for runCouncil
	const startTime = Date.now();
	const detailsBase: SubagentDetails = {
		name: "council",
		type: "council",
		task,
		status: "running",
		turnCount: 0,
		toolUseCount: 0,
		tokenCount: 0,
		contextPercent: 0,
		elapsedMs: 0,
		currentActivity: "council convening…",
		messages: [],
	};

	const makeDetails = (): SubagentDetails => ({
		...detailsBase,
		elapsedMs: Date.now() - startTime,
	});

	const onCouncilUpdate = (): void => {
		if (onUpdate) {
			const d = makeDetails();
			onUpdate({
				content: [
					{
						type: "text" as const,
						text: `Council in progress: ${d.currentActivity}`,
					},
				],
				details: d,
			});
		}
	};

	// Execute the council
	const result = await runCouncil(
		task,
		councillors,
		councilAgentDef,
		cwd,
		config,
		signal,
		onCouncilUpdate,
		makeDetails,
		registerProcess,
	);

	// Build the output text
	const outputText = result.error
		? (result.output ? result.output + "\n\n" : "") + "Error: " + result.error
		: result.output;

	const details = {
		output: result.output,
		error: result.error,
		usage: result.usage,
		details: result.details,
		messages: result.messages,
	};

	return {
		content: [{ type: "text" as const, text: outputText }],
		details,
	};
}
