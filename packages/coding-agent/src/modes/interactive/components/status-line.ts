import { execSync } from "node:child_process";
import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { AgentSession } from "../../../core/agent-session";
import { theme } from "../theme/theme";

// Thinking level icons (Nerd Font)
const THINKING_ICONS: Record<string, string> = {
	minimal: "🤨 min",
	low: "🤔 low",
	medium: "🤓 mid",
	high: "🤯 high",
	xhigh: "🧠 xhi",
};

// Nerd Font icons
const ICONS = {
	model: "\uec19", //  robot/model
	folder: "\uf115 ", //  folder
	branch: "\ue725", //  git branch
	sep: "\ue0b1", //  powerline thin chevron
	tokens: "\ue26b", //  coins
	context: "\ue70f", //  window
	auto: "\udb80\udc68", //  auto
	pi: "\ue22c", //  pi
} as const;

/** Create a colored text segment with background */
function plSegment(content: string, fgAnsi: string, bgAnsi: string): string {
	return `${bgAnsi}${fgAnsi} ${content} \x1b[0m`;
}

/** Create separator with background */
function plSep(sepAnsi: string, bgAnsi: string): string {
	return `${bgAnsi}${sepAnsi}${ICONS.sep}\x1b[0m`;
}

/** Create end cap - solid arrow transitioning bg to terminal default */
function plEnd(bgAnsi: string): string {
	// Use the bg color as fg for the arrow (creates the triangle effect)
	const fgFromBg = bgAnsi.replace("\x1b[48;", "\x1b[38;");
	return `${fgFromBg}\ue0b0\x1b[0m`;
}

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Find the git root directory by walking up from cwd.
 * Returns the path to .git/HEAD if found, null otherwise.
 */
function findGitHeadPath(): string | null {
	let dir = process.cwd();
	while (true) {
		const gitHeadPath = join(dir, ".git", "HEAD");
		if (existsSync(gitHeadPath)) {
			return gitHeadPath;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			// Reached filesystem root
			return null;
		}
		dir = parent;
	}
}

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class StatusLineComponent implements Component {
	private session: AgentSession;
	private cachedBranch: string | null | undefined = undefined; // undefined = not checked yet, null = not in git repo, string = branch name
	private gitWatcher: FSWatcher | null = null;
	private onBranchChange: (() => void) | null = null;
	private autoCompactEnabled: boolean = true;
	private hookStatuses: Map<string, string> = new Map();

	// Git status caching (1s TTL to avoid excessive subprocess spawns)
	private cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	private gitStatusLastFetch = 0;

	constructor(session: AgentSession) {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Set hook status text to display in the footer.
	 * Text is sanitized (newlines/tabs replaced with spaces) and truncated to terminal width.
	 * ANSI escape codes for styling are preserved.
	 * @param key - Unique key to identify this status
	 * @param text - Status text, or undefined to clear
	 */
	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.hookStatuses.delete(key);
		} else {
			this.hookStatuses.set(key, text);
		}
	}

	/**
	 * Set up a file watcher on .git/HEAD to detect branch changes.
	 * Call the provided callback when branch changes.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.onBranchChange = onBranchChange;
		this.setupGitWatcher();
	}

	private setupGitWatcher(): void {
		// Clean up existing watcher
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		const gitHeadPath = findGitHeadPath();
		if (!gitHeadPath) {
			return;
		}

		try {
			this.gitWatcher = watch(gitHeadPath, () => {
				this.cachedBranch = undefined; // Invalidate cache
				if (this.onBranchChange) {
					this.onBranchChange();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
	}

	invalidate(): void {
		// Invalidate cached branch so it gets re-read on next render
		this.cachedBranch = undefined;
	}

	/**
	 * Get current git branch by reading .git/HEAD directly.
	 * Returns null if not in a git repo, branch name otherwise.
	 */
	private getCurrentBranch(): string | null {
		// Return cached value if available
		if (this.cachedBranch !== undefined) {
			return this.cachedBranch;
		}

		try {
			const gitHeadPath = findGitHeadPath();
			if (!gitHeadPath) {
				this.cachedBranch = null;
				return null;
			}
			const content = readFileSync(gitHeadPath, "utf8").trim();

			if (content.startsWith("ref: refs/heads/")) {
				// Normal branch: extract branch name
				this.cachedBranch = content.slice(16);
			} else {
				// Detached HEAD state
				this.cachedBranch = "detached";
			}
		} catch {
			// Not in a git repo or error reading file
			this.cachedBranch = null;
		}

		return this.cachedBranch;
	}

	/**
	 * Get git status indicators (staged, unstaged, untracked counts).
	 * Returns null if not in a git repo.
	 * Cached for 1s to avoid excessive subprocess spawns.
	 */
	private getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		const now = Date.now();
		if (now - this.gitStatusLastFetch < 1000) {
			return this.cachedGitStatus;
		}

		try {
			const output = execSync("git status --porcelain 2>/dev/null", {
				encoding: "utf8",
				timeout: 1000,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let staged = 0;
			let unstaged = 0;
			let untracked = 0;

			for (const line of output.split("\n")) {
				if (!line) continue;
				const x = line[0]; // Index (staged) status
				const y = line[1]; // Working tree status

				// Untracked files
				if (x === "?" && y === "?") {
					untracked++;
					continue;
				}

				// Staged changes (first column is not space or ?)
				if (x && x !== " " && x !== "?") {
					staged++;
				}

				// Unstaged changes (second column is not space)
				if (y && y !== " ") {
					unstaged++;
				}
			}

			this.cachedGitStatus = { staged, unstaged, untracked };
			this.gitStatusLastFetch = now;
			return this.cachedGitStatus;
		} catch {
			this.cachedGitStatus = null;
			this.gitStatusLastFetch = now;
			return null;
		}
	}

	private buildStatusLine(): string {
		const state = this.session.state;

		// Get context percentage from last assistant message
		const lastAssistantMessage = state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = state.model?.contextWindow || 0;
		const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		// Format helpers
		const formatTokens = (n: number): string => {
			if (n < 1000) return n.toString();
			if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
			if (n < 1000000) return `${Math.round(n / 1000)}k`;
			if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
			return `${Math.round(n / 1000000)}M`;
		};

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 1: Model
		// ═══════════════════════════════════════════════════════════════════════
		let modelName = state.model?.name || state.model?.id || "no-model";
		// Strip "Claude " prefix for brevity
		if (modelName.startsWith("Claude ")) {
			modelName = modelName.slice(7);
		}
		let modelContent = `${ICONS.model} ${modelName}`;
		if (state.model?.reasoning) {
			const level = state.thinkingLevel || "off";
			if (level !== "off") {
				modelContent += ` · ${THINKING_ICONS[level] ?? level}`;
			}
		}

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 2: Path
		// ═══════════════════════════════════════════════════════════════════════
		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}
		if (pwd.startsWith("/work/")) {
			pwd = pwd.slice(6);
		}
		const pathContent = `${ICONS.folder} ${pwd}`;

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 3: Git Branch + Status
		// ═══════════════════════════════════════════════════════════════════════
		const branch = this.getCurrentBranch();
		let gitContent = "";
		let gitColorName: "statusLineGitClean" | "statusLineGitDirty" = "statusLineGitClean";
		if (branch) {
			const gitStatus = this.getGitStatus();
			const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);
			gitColorName = isDirty ? "statusLineGitDirty" : "statusLineGitClean";

			gitContent = `${ICONS.branch} ${branch}`;

			if (gitStatus) {
				const indicators: string[] = [];
				if (gitStatus.unstaged > 0) {
					indicators.push(theme.fg("statusLineDirty", `*${gitStatus.unstaged}`));
				}
				if (gitStatus.staged > 0) {
					indicators.push(theme.fg("statusLineStaged", `+${gitStatus.staged}`));
				}
				if (gitStatus.untracked > 0) {
					indicators.push(theme.fg("statusLineUntracked", `?${gitStatus.untracked}`));
				}
				if (indicators.length > 0) {
					gitContent += ` ${indicators.join(" ")}`;
				}
			}
		}

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 4: Context (window usage)
		// ═══════════════════════════════════════════════════════════════════════
		const autoIndicator = this.autoCompactEnabled ? ` ${ICONS.auto}` : "";
		const contextText = `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
		let contextContent: string;
		if (contextPercentValue > 90) {
			contextContent = `${ICONS.context} ${theme.fg("error", contextText)}`;
		} else if (contextPercentValue > 70) {
			contextContent = `${ICONS.context} ${theme.fg("warning", contextText)}`;
		} else {
			contextContent = `${ICONS.context} ${contextText}`;
		}

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 5: Spend (tokens + cost)
		// ═══════════════════════════════════════════════════════════════════════
		const spendParts: string[] = [];

		const { input, output, cacheRead, cacheWrite, cost } = this.session.sessionManager.getUsageStatistics();
		const totalTokens = input + output + cacheRead + cacheWrite;
		if (totalTokens) {
			spendParts.push(`${ICONS.tokens} ${formatTokens(totalTokens)}`);
		}

		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (cost || usingSubscription) {
			const costDisplay = `$${cost.toFixed(2)}${usingSubscription ? " (sub)" : ""}`;
			spendParts.push(costDisplay);
		}

		const spendContent = theme.fg("statusLineCost", spendParts.join(" · "));

		// ═══════════════════════════════════════════════════════════════════════
		// Assemble: [Model] > [Path] > [Git?] > [Context] > [Spend] >
		// ═══════════════════════════════════════════════════════════════════════
		const bgAnsi = theme.getBgAnsi("statusLineBg");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		let statusLine = "";

		// Pi segment
		statusLine += plSegment(`${ICONS.pi} `, theme.getFgAnsi("statusLineContext"), bgAnsi);
		statusLine += plSep(sepAnsi, bgAnsi);

		// Model segment
		statusLine += plSegment(modelContent, theme.getFgAnsi("statusLineModel"), bgAnsi);
		statusLine += plSep(sepAnsi, bgAnsi);

		// Path segment
		statusLine += plSegment(pathContent, theme.getFgAnsi("statusLinePath"), bgAnsi);

		if (gitContent) {
			statusLine += plSep(sepAnsi, bgAnsi);
			statusLine += plSegment(gitContent, theme.getFgAnsi(gitColorName), bgAnsi);
		}

		// Context segment
		statusLine += plSep(sepAnsi, bgAnsi);
		statusLine += plSegment(contextContent, theme.getFgAnsi("statusLineContext"), bgAnsi);

		// Spend segment
		statusLine += plSep(sepAnsi, bgAnsi);
		statusLine += plSegment(spendContent, theme.getFgAnsi("statusLineSpend"), bgAnsi);

		// End cap (solid arrow to terminal bg)
		statusLine += plEnd(bgAnsi);

		return statusLine;
	}

	/**
	 * Get the status line content for use as editor top border.
	 * Returns the content string and its visible width.
	 */
	getTopBorder(_width: number): { content: string; width: number } {
		const content = this.buildStatusLine();
		return {
			content,
			width: visibleWidth(content),
		};
	}

	/**
	 * Render only hook statuses (if any).
	 * Used when footer is integrated into editor border.
	 */
	render(width: number): string[] {
		// Only render hook statuses - main status is in editor's top border
		if (this.hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width, theme.fg("statusLineSep", "…"))];
	}
}
