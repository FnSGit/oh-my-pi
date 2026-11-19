import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Regression coverage for the overlay double-mount bug: when the same
 * component instance was mounted twice, `TUI.overlayStack` carried two
 * entries and `#compositeOverlays` painted the component twice per frame,
 * filling the screen with the same option list.
 *
 * Fix: `TUI.showOverlay` now dedups by component instance — a second call
 * for an already-mounted component reuses the existing entry (and its
 * handle factory, so all `OverlayHandle` references resolve to the same
 * `hide()` target). Original `options` are preserved; re-mounting with new
 * geometry should `hide()` first.
 */

class CountingOverlay implements Component {
	#renders = 0;
	#label: string;

	constructor(label: string) {
		this.#label = label;
	}

	get renders(): number {
		return this.#renders;
	}

	invalidate(): void {
		// No cached state.
	}

	render(width: number): string[] {
		this.#renders += 1;
		const line = `${this.#label}:${this.#renders}`.padEnd(width, " ").slice(0, width);
		return [line];
	}
}

async function flushRender(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(17);
	await term.flush();
}

describe("overlay double-mount repro", () => {
	it("renders a single overlay exactly once per frame", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		tui.start();
		await flushRender(term);

		const overlay = new CountingOverlay("single");
		const handle = tui.showOverlay(overlay, { anchor: "top-left" });
		await flushRender(term);

		// Single mount must yield exactly one render per frame.
		expect(overlay.renders).toBe(1);

		handle.hide();
	});

	it("dedups same component instance: double showOverlay paints once, stack length 1", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		tui.start();
		await flushRender(term);

		const overlay = new CountingOverlay("dedup");
		// Two back-to-back showOverlay calls for the same component instance.
		// Pre-fix: stack length 2, render() called twice per frame — the
		// "整屏都是同一份" symptom. Post-fix: dedup keeps the stack at 1 and
		// paints the overlay once.
		tui.showOverlay(overlay, { anchor: "top-left" });
		tui.showOverlay(overlay, { anchor: "top-left" });
		await flushRender(term);

		expect(overlay.renders).toBe(1);
		expect(tui.overlayStack.length).toBe(1);
		expect(tui.overlayStack[0]?.component).toBe(overlay);
	});

	it("does not dedup different component instances on the same stack", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		tui.start();
		await flushRender(term);

		const a = new CountingOverlay("a");
		const b = new CountingOverlay("b");
		const handleA = tui.showOverlay(a, { anchor: "top-left" });
		const handleB = tui.showOverlay(b, { anchor: "top-left" });
		await flushRender(term);

		// Two different instances must each be painted once and occupy two
		// stack slots. Returns are distinct handles.
		expect(tui.overlayStack.length).toBe(2);
		expect(a.renders).toBe(1);
		expect(b.renders).toBe(1);
		expect(handleA).not.toBe(handleB);

		// hide() on the first handle only splices its entry.
		handleA.hide();
		await flushRender(term);
		expect(tui.overlayStack.length).toBe(1);
		expect(tui.overlayStack[0]?.component).toBe(b);
	});

	it("hide() from any duplicate call splices the single entry (idempotent close)", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		tui.start();
		await flushRender(term);

		const overlay = new CountingOverlay("idempotent-close");
		const first = tui.showOverlay(overlay, { anchor: "top-left" });
		const second = tui.showOverlay(overlay, { anchor: "top-left" });
		await flushRender(term);

		// A single stack entry must back both handles' `hide()`, so a close
		// from either caller drops the overlay exactly once. The handles
		// themselves are fresh factory outputs — that is fine; what matters
		// is that calling `hide()` twice (once per handle) is a no-op the
		// second time, instead of a leak.
		expect(tui.overlayStack.length).toBe(1);
		expect(overlay.renders).toBe(1);

		first.hide();
		await flushRender(term);
		expect(tui.overlayStack.length).toBe(0);

		// A second `hide()` from the other handle must be a no-op — the
		// entry is already gone, no further render, no error.
		const rendersBeforeSecondHide = overlay.renders;
		second.hide();
		await flushRender(term);
		expect(tui.overlayStack.length).toBe(0);
		expect(overlay.renders).toBe(rendersBeforeSecondHide);
	});
});
