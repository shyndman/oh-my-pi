import {
	Editor,
	isCapsLock,
	isCtrlC,
	isCtrlD,
	isCtrlG,
	isCtrlL,
	isCtrlO,
	isCtrlP,
	isCtrlT,
	isCtrlV,
	isCtrlY,
	isCtrlZ,
	isEscape,
	isShiftCtrlP,
	isShiftTab,
	type KeyId,
	matchesKey,
} from "@oh-my-pi/pi-tui";

/**
 * Custom editor that handles Escape and Ctrl+C keys for coding-agent
 */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onCtrlD?: () => void;
	public onShiftTab?: () => void;
	public onCtrlP?: () => void;
	public onShiftCtrlP?: () => void;
	public onCtrlL?: () => void;
	public onCtrlR?: () => void;
	public onCtrlO?: () => void;
	public onCtrlT?: () => void;
	public onCtrlG?: () => void;
	public onCtrlZ?: () => void;
	public onQuestionMark?: () => void;
	public onCapsLock?: () => void;
	public onCtrlY?: () => void;
	/** Called when Ctrl+V is pressed. Returns true if handled (image found), false to fall through to text paste. */
	public onCtrlV?: () => Promise<boolean>;
	/** Called when Alt+Up is pressed (dequeue keybinding). */
	public onAltUp?: () => void;

	/** Custom key handlers from extensions */
	private customKeyHandlers = new Map<KeyId, () => void>();

	/**
	 * Register a custom key handler. Extensions use this for shortcuts.
	 */
	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.customKeyHandlers.set(key, handler);
	}

	/**
	 * Remove a custom key handler.
	 */
	removeCustomKeyHandler(key: KeyId): void {
		this.customKeyHandlers.delete(key);
	}

	/**
	 * Clear all custom key handlers.
	 */
	clearCustomKeyHandlers(): void {
		this.customKeyHandlers.clear();
	}

	handleInput(data: string): void {
		if (isCapsLock(data) && this.onCapsLock) {
			this.onCapsLock();
			return;
		}

		// Intercept Ctrl+V for image paste (async - fires and handles result)
		if (isCtrlV(data) && this.onCtrlV) {
			void this.onCtrlV();
			return;
		}

		// Intercept Ctrl+G for external editor
		if (isCtrlG(data) && this.onCtrlG) {
			this.onCtrlG();
			return;
		}

		// Intercept Ctrl+Y for voice input
		if (isCtrlY(data) && this.onCtrlY) {
			this.onCtrlY();
			return;
		}

		// Intercept Ctrl+Z for suspend
		if (isCtrlZ(data) && this.onCtrlZ) {
			this.onCtrlZ();
			return;
		}

		// Intercept Ctrl+T for thinking block visibility toggle
		if (isCtrlT(data) && this.onCtrlT) {
			this.onCtrlT();
			return;
		}

		// Intercept Ctrl+Y for role-based model cycling
		if (isCtrlY(data) && this.onCtrlY) {
			this.onCtrlY();
			return;
		}

		// Intercept Ctrl+L for model selector
		if (isCtrlL(data) && this.onCtrlL) {
			this.onCtrlL();
			return;
		}

		// Intercept Ctrl+R for history search
		if (matchesKey(data, "ctrl+r") && this.onCtrlR) {
			this.onCtrlR();
			return;
		}

		// Intercept Ctrl+O for tool output expansion
		if (isCtrlO(data) && this.onCtrlO) {
			this.onCtrlO();
			return;
		}

		// Intercept Shift+Ctrl+P for backward model cycling (check before Ctrl+P)
		if (isShiftCtrlP(data) && this.onShiftCtrlP) {
			this.onShiftCtrlP();
			return;
		}

		// Intercept Ctrl+P for model cycling
		if (isCtrlP(data) && this.onCtrlP) {
			this.onCtrlP();
			return;
		}

		// Intercept Shift+Tab for thinking level cycling
		if (isShiftTab(data) && this.onShiftTab) {
			this.onShiftTab();
			return;
		}

		// Intercept Escape key - but only if autocomplete is NOT active
		// (let parent handle escape for autocomplete cancellation)
		if (isEscape(data) && this.onEscape && !this.isShowingAutocomplete()) {
			this.onEscape();
			return;
		}

		// Intercept Ctrl+C
		if (isCtrlC(data) && this.onCtrlC) {
			this.onCtrlC();
			return;
		}

		// Intercept Ctrl+D (only when editor is empty)
		if (isCtrlD(data)) {
			if (this.getText().length === 0 && this.onCtrlD) {
				this.onCtrlD();
			}
			// Always consume Ctrl+D (don't pass to parent)
			return;
		}

		// Intercept Alt+Up for dequeue (restore queued message to editor)
		if (matchesKey(data, "alt+up") && this.onAltUp) {
			this.onAltUp();
			return;
		}

		// Intercept ? when editor is empty to show hotkeys
		if (data === "?" && this.getText().length === 0 && this.onQuestionMark) {
			this.onQuestionMark();
			return;
		}

		// Check custom key handlers (extensions)
		for (const [keyId, handler] of this.customKeyHandlers) {
			if (matchesKey(data, keyId)) {
				handler();
				return;
			}
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}
}
