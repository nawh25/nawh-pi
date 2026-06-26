/**
 * Orchestrator routing prompt construction.
 *
 * This module builds the routing rules injected into the main LLM's
 * system prompt via the `before_agent_start` event. The prompt tells
 * the orchestrator LLM when to delegate to each specialist subagent,
 * how to parallelize, and how to route results for validation.
 *
 * All text is in English for optimal LLM comprehension (see design D9).
 */

import type { AgentRouting } from "./types";

/**
 * Routing rules for each agent type.
 *
 * Keyed by agent name. Each entry specifies when to delegate, when NOT
 * to delegate, and a quick decision heuristic ("rule of thumb").
 */
export const AGENT_DESCRIPTIONS: Record<string, AgentRouting> = {
	explorer: {
		delegateWhen: [
			"You don't know what files exist in the codebase",
			"Multiple parallel searches are needed across different areas",
			"The scope is broad or uncertain and you need to map the territory first",
			"You need to locate symbols, imports, or usages across many files",
		],
		dontDelegateWhen: [
			"You already know the exact file path",
			"It's a single specific lookup you can do with one grep/read",
			"You're about to edit the file you need to look at — read it directly",
		],
		ruleOfThumb:
			"If the question is 'where is X?' or 'what exists for Y?' → delegate to @explorer. If you know the path → read it directly.",
	},

	oracle: {
		delegateWhen: [
			"Architecture decisions need strategic analysis (e.g., choosing between approaches)",
			"Code review is needed for quality, maintainability, or design patterns",
			"Complex debugging requires root-cause analysis beyond a quick fix",
			"A second opinion on a high-stakes technical decision is warranted",
		],
		dontDelegateWhen: [
			"The task is straightforward implementation — use @fixer",
			"You need to explore the codebase to understand what exists — use @explorer",
			"It's a simple code question you can answer with a quick read",
			"You need external library/API documentation — use @librarian",
		],
		ruleOfThumb:
			"If the question is 'what's the best approach?' or 'is this design sound?' → delegate to @oracle. If the task is 'implement X' → use @fixer.",
	},

	librarian: {
		delegateWhen: [
			"You need official documentation, API specs, or library references",
			"You need to verify how a specific version of a library/API works",
			"You need code examples from external sources (docs, tutorials)",
			"You need to research a technology before deciding how to use it",
		],
		dontDelegateWhen: [
			"You need to explore the project's own codebase — use @explorer",
			"You already have the docs open or cached in conversation",
			"It's a code review or architecture question — use @oracle",
		],
		ruleOfThumb:
			"If the question is about external knowledge (library docs, API specs, third-party tooling) → delegate to @librarian. If it's about the project's own code → use @explorer.",
	},

	fixer: {
		delegateWhen: [
			"The task is a well-defined, bounded implementation change",
			"You have clear instructions on what files to edit and how",
			"Multiple independent file changes can run in parallel",
			"You need someone to write/edit code and verify it compiles/tests pass",
		],
		dontDelegateWhen: [
			"The task requires research or exploration first — use @explorer or @librarian",
			"The task is ambiguous and needs architectural analysis — use @oracle",
			"It's a trivial single-line edit you can do faster yourself",
			"The task involves UI/UX design decisions — use @designer",
		],
		ruleOfThumb:
			"If the task is 'change X in file Y' with a clear spec → delegate to @fixer. If you don't know where or what to change → explore first.",
	},

	designer: {
		delegateWhen: [
			"The task involves UI/UX changes (layout, styling, accessibility, components)",
			"You need to implement or modify visual elements in code",
			"Design system consistency, color contrast, or typography work is needed",
			"Responsive design, dark/light theme support, or animation/interaction work is required",
		],
		dontDelegateWhen: [
			"The task is backend logic, data processing, or non-visual code — use @fixer",
			"It's a pure logic/algorithm problem with no UI component — use @oracle or @fixer",
			"You need to review architecture (not visual design) — use @oracle",
		],
		ruleOfThumb:
			"If the task touches anything visual (CSS, components, layout, accessibility) → delegate to @designer. If it's backend or non-visual logic → use @fixer.",
	},

	council: {
		delegateWhen: [
			"A high-stakes architecture decision would benefit from multi-model consensus",
			"You need diverse perspectives from different LLMs on a critical design choice",
			"A costly or irreversible decision warrants cross-model validation",
			"The user explicitly requests a council review or multi-model discussion",
		],
		dontDelegateWhen: [
			"Routine implementation or simple tasks — use @fixer",
			"Standard code review — use @oracle (council is far more expensive)",
			"Exploration or research — use @explorer or @librarian",
			"The decision is low-risk and you're confident in your own judgment",
			"You need a quick answer — council spawns 3-5 subprocesses plus synthesis",
		],
		ruleOfThumb:
			"Council is the HIGHEST-COST path (multiple LLMs + synthesis). Do NOT auto-call frequently. Reserve for high-stakes, irreversible decisions or when the user explicitly requests multi-model consensus. When in doubt, use @oracle instead.",
	},

	observer: {
		delegateWhen: [
			"You need to analyze an image, screenshot, or visual mockup",
			"A PDF needs visual interpretation (not just text extraction)",
			"You need to understand a diagram (flowchart, wireframe, architecture diagram)",
			"OCR or visual element identification is needed from a non-text file",
		],
		dontDelegateWhen: [
			"The file is plain text or code — read it directly",
			"You need to explore the codebase — use @explorer",
			"It's a design implementation task, not analysis — use @designer",
		],
		ruleOfThumb:
			"If the input is an image, PDF, or diagram and you need to understand what's in it → delegate to @observer. If it's a text file → read it directly.",
	},
};

/**
 * Examples of parallel delegation patterns.
 *
 * These help the orchestrator LLM understand when it can call multiple
 * agents simultaneously. Each example is filtered at prompt build time
 * to exclude any that reference disabled agents.
 */
export const PARALLEL_DELEGATION_EXAMPLES: string[] = [
	"Multiple @explorer searches across different domains (e.g., find all API endpoints + find all test files)",
	"@explorer + @librarian research in parallel (explore codebase while fetching external docs)",
	"Two @fixer tasks for independent file changes (e.g., update types.ts and update render.ts simultaneously)",
	"@explorer + @oracle (explore to gather context while oracle analyzes a known architecture issue)",
	"@librarian + @fixer (research API docs while implementing a scaffold of the integration)",
	"Multiple @fixer tasks for independent features across separate modules",
	"@explorer reconnaissance of multiple subsystems before a large refactor",
];

/**
 * Validation routing rules — where to send results after a task completes.
 *
 * These guide the orchestrator to route outputs to the appropriate
 * reviewer agent. Filtered at prompt build time to exclude lines
 * referencing disabled agents.
 */
export const VALIDATION_ROUTING: string[] = [
	"After implementation → @oracle for code review (quality, maintainability, edge cases)",
	"After design changes → @oracle for architecture validation (does the change fit the system?)",
	"After research → @oracle for strategic assessment if the findings are high-stakes",
	"After exploration → proceed directly to implementation (@fixer or @designer) — no oracle needed unless architecture is uncertain",
	"After @fixer implementation → optionally @oracle to review if the change is complex or risky",
	"After @council consensus → act on the synthesized recommendation directly",
	"After @observer visual analysis → route findings to @designer if UI changes are needed",
];

/**
 * Check whether a string references any of the given agent names.
 *
 * Agent names are matched with the `@` prefix (e.g., `@explorer`) to
 * avoid false positives on common words.
 */
function referencesAgent(text: string, agentNames: string[]): boolean {
	return agentNames.some((name) => text.includes(`@${name}`));
}

/**
 * Build the full orchestrator routing prompt.
 *
 * The prompt is dynamically constructed based on which agents are
 * currently enabled. Disabled agents are excluded from agent
 * descriptions, parallel delegation examples, and validation routing.
 *
 * @param enabledAgents - Names of agents that are currently enabled.
 * @param disabledAgents - Names of agents that are explicitly disabled.
 * @returns The complete routing prompt string (in English).
 */
export function buildOrchestratorPrompt(
	enabledAgents: string[],
	disabledAgents: string[],
): string {
	const disabledSet = new Set(disabledAgents);

	// Filter agent descriptions to only enabled agents.
	const enabledDescriptions = Object.entries(AGENT_DESCRIPTIONS)
		.filter(([name]) => enabledAgents.includes(name) && !disabledSet.has(name))
		.map(([name, routing]) => {
			const delegateWhenList = routing.delegateWhen
				.map((item) => `  - ${item}`)
				.join("\n");
			const dontDelegateWhenList = routing.dontDelegateWhen
				.map((item) => `  - ${item}`)
				.join("\n");
			return `### @${name}

**Delegate when:**
${delegateWhenList}

**Don't delegate when:**
${dontDelegateWhenList}

**Rule of thumb:** ${routing.ruleOfThumb}`;
		})
		.join("\n\n");

	// Filter parallel delegation examples to exclude disabled agents.
	const enabledExamples = PARALLEL_DELEGATION_EXAMPLES.filter(
		(example) => !referencesAgent(example, disabledAgents),
	);

	// Filter validation routing to exclude disabled agents.
	const enabledValidation = VALIDATION_ROUTING.filter(
		(line) => !referencesAgent(line, disabledAgents),
	);

	const examplesSection = enabledExamples
		.map((example) => `- ${example}`)
		.join("\n");

	const validationSection = enabledValidation
		.map((line) => `- ${line}`)
		.join("\n");

	return `<Subagent Delegation Rules>

You have access to specialist subagents. Analyze each user request and delegate to the appropriate agent when beneficial. You can call multiple agents in parallel for independent tasks, or chain them sequentially when one's output feeds into another.

<Agents>
${enabledDescriptions}
</Agents>

<Workflow>
1. **Understand**: Parse the user's request into sub-tasks. Identify what needs exploration, research, implementation, review, or analysis.
2. **Path Selection**: For each sub-task, evaluate quality vs speed vs cost. Cheaper agents (explorer, fixer, librarian) are fast; oracle is thorough; council is expensive.
3. **Delegation Check**: Should I delegate? (see agent rules above). If the task is trivial and you can do it faster yourself, do it directly.
4. **Plan and Parallelize**: If multiple independent tasks exist, use parallel mode. If one task's output feeds the next, use chain mode with the {previous} placeholder.
5. **Execute**: Call the subagent tool with sufficient context. Include reference paths and line numbers — NOT full file contents. Subagents do NOT inherit your conversation history.
6. **Verify**: Check results; route to reviewer agent if needed (see Validation Routing below).
</Workflow>

<Communication>
- Include sufficient context in task text: reference paths/lines, NOT full file contents
- Subagents do NOT inherit your conversation history
- Use parallel mode for independent tasks
- Use chain mode when one task's output feeds the next
- Use {previous} placeholder in chain mode to reference prior step's output
</Communication>

<Parallel Delegation Examples>
${examplesSection}
</Parallel Delegation>

<Validation Routing>
${validationSection}
</Validation>`;
}
