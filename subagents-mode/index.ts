/**
 * subagents — orchestrator mode for the main agent
 *
 * Command:
 *   /subagents-mode  Toggle orchestrator mode (delegation vs. full tools)
 *
 * When active, the main agent is restricted to delegation-only tools and receives
 * an orchestrator system prompt instructing it to delegate all work to subagents.
 * Subagents spawned via the Agent tool retain their own full tool sets.
 *
 * Mode state is persisted in session entries and restored on session resume.
 * New sessions default to orchestrator mode ON.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "on" | "off";

interface SubagentModeEntry {
	mode: Mode;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ORCHESTRATOR_TOOLS = ["Agent", "ask_user_question"];

const STATUS_ID = "subagents";
const STATUS_TEXT = "🎯 ORCHESTRATOR";

const ORCHESTRATOR_PROMPT = `\
## Subagent Orchestrator Mode

You are in ORCHESTRATOR MODE.

The main agent is a coordinator only. It must delegate actual work to subagents.

### Hard rules

1. Use the Agent tool for codebase exploration, research, planning, implementation, testing, review, file operations, shell commands, and diagnostics.
2. Use ask_user_question only when user requirements are ambiguous.
3. Do not read files directly.
4. Do not write or edit files directly.
5. Do not run shell commands directly.
6. Do not search code directly.
7. Aggregate subagent results and report clearly to the user.
8. For complex work, split tasks into independent subagent jobs when possible.

If another prompt says the main agent may read files, search code, run commands, or edit files directly, this orchestrator mode overrides it.

`.trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 서브에이전트 세션인지 감지한다.
 * SessionManager.isPersisted()로 세션 지속성 여부를 확인하여 판단한다.
 * 서브에이전트는 in-memory 세션이므로 isPersisted()가 false를 반환한다.
 * isPersisted() 메서드가 없는 이전 프레임워크 버전에서는 getSessionFile() === undefined로 fallback한다.
 */
function isSubagentSession(ctx: ExtensionContext): boolean {
	const sm = ctx.sessionManager as SessionManager;
	if (typeof sm.isPersisted === "function") {
		return !sm.isPersisted();
	}
	// Fallback: 이전 프레임워크 버전에서 isPersisted()가 없는 경우
	return ctx.sessionManager.getSessionFile() === undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function subagents(pi: ExtensionAPI) {
	let mode: Mode = "on";
	let originalTools: string[] | null = null;

	// -- Helpers --

	function applyOnMode(ctx: Pick<ExtensionContext, "ui">) {
		originalTools = pi.getActiveTools();
		pi.setActiveTools(ORCHESTRATOR_TOOLS);
		ctx.ui.setStatus(STATUS_ID, STATUS_TEXT);
	}

	function applyOffMode(ctx: Pick<ExtensionContext, "ui">) {
		if (originalTools) {
			pi.setActiveTools(originalTools);
		}
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	// -- Restore state on session load --

	pi.on("session_start", async (_event, ctx) => {
		// 서브에이전트 세션(in-memory)은 오케스트레이터 모드를 적용하지 않는다
		if (isSubagentSession(ctx)) return;

		let restoredMode: Mode | null = null;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "subagent-mode") {
				const data = entry.data as SubagentModeEntry | undefined;
				if (data?.mode === "on" || data?.mode === "off") {
					restoredMode = data.mode;
				}
			}
		}

		if (restoredMode === "on") {
			mode = "on";
			applyOnMode(ctx);
		} else if (restoredMode === "off") {
			mode = "off";
			ctx.ui.setStatus(STATUS_ID, undefined);
		} else {
			// No persisted entry — new session defaults to ON
			mode = "on";
			applyOnMode(ctx);
		}
	});

	// -- System prompt injection --

	pi.on("before_agent_start", async (event, ctx) => {
		if (mode === "off") return;
		// 서브에이전트 세션(in-memory)에는 오케스트레이터 프롬프트를 주입하지 않는다
		if (isSubagentSession(ctx)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}`,
		};
	});

	// -- /subagents toggle command --

	pi.registerCommand("subagents-mode", {
		description: "Toggle orchestrator mode (delegation vs. full tools)",
		handler: async (_args, ctx) => {
			if (mode === "on") {
				mode = "off";
				applyOffMode(ctx);
				pi.appendEntry("subagent-mode", { mode: "off" });

				ctx.ui.notify("Normal mode restored. Full tool set available.", "info");
			} else {
				mode = "on";
				applyOnMode(ctx);
				pi.appendEntry("subagent-mode", { mode: "on" });

				ctx.ui.notify(
					"Orchestrator mode activated. Main agent will delegate to subagents.",
					"info",
				);
			}
		},
	});
}
