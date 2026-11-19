# TUI overlay dedup — fix for the "整屏都是同一份选项" symptom

Companion to [`tui-core-renderer.md`](./tui-core-renderer.md) (engine
invariants) and [`tui-runtime-internals.md`](./tui-runtime-internals.md) (runtime
flow). Scope: the `TUI.showOverlay` / `OverlayHandle` contract and its
dedup-by-component-instance rule.

---

## 1. The symptom

User reports: a single option list (e.g. a 4-item "save version?" prompt)
renders normally the first time it opens, but as soon as the user clicks
**any** option, the whole viewport fills with the same list, repeated. The
"clicked" state is irrelevant; what matters is that **a click landed at
all**.

Two diagnostics are observed:

- the viewport contains the same `SelectList` payload N times stacked
  vertically;
- the per-frame `render(width)` count on that component is N, where N is
  the number of "open" attempts that have not yet had their `handle.hide()`
  resolve.

## 2. Root cause

`TUI.overlayStack` is a plain array. Every `showOverlay(component, options)`
unconditionally pushed a new entry, and `#compositeOverlays` painted **every
entry** on the stack once per frame. The only thing that removed an entry
was the matching `OverlayHandle.hide()` — and that handle is created
synchronously inside `showOverlay`, so the only way for a handle to splice
its entry is for the caller to invoke `hide()` on it.

Three call paths left entries on the stack and produced the symptom:

1. **Async factory race.** `ExtensionUIContext.custom` (`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:806-825`)
   awaits the factory before attaching `showOverlay`. If `onSelect` fires
   during the await (user hammered Enter, or the factory resolved a value
   that the runtime was already closing on), the `close()` sentinel ran
   *before* `showOverlay` had a chance to fire — but if a *second* `custom`
   call landed between the await resolving and the first one closing, two
   `showOverlay` calls would push two entries onto the stack.
2. **Chained UI flows.** Selectors that re-open themselves on a follow-up
   action (`selector-controller.ts` does this for role assignment,
   `mcp-command-controller.ts` for the install wizard). Each follow-up
   `ctx.ui.custom(...)` is a fresh `showOverlay`; if the previous handle's
   `hide()` had not yet been spliced when the new one pushed, the stack
   held both for at least one frame.
3. **Re-entrant `onSelect`.** A `SelectList` whose `onSelect` callback
   synchronously triggers a `custom(...)` (common for "select X → next
   question Y" flows) races its own close against the next mount.

The unifying mechanism: `showOverlay` had no dedup. Two `showOverlay`
calls for the *same component instance* were indistinguishable from two
calls for *different* instances — the stack grew, the compositor painted
both.

## 3. The fix

`packages/tui/src/tui.ts:697-728` — `showOverlay` now looks up the
component on the stack first. If found, it reuses the entry (un-hides it
if it was hidden, refocuses if visible) and returns a fresh handle bound
to the same entry. Otherwise it pushes a new entry as before.

`packages/tui/src/tui.ts:730-772` — the inline handle factory was extracted
into `#buildOverlayHandle(component, entry)` so both code paths
(dedup-hit and fresh-push) can produce a handle bound to the same
`entry` reference. Every handle's `hide()` is therefore a closure over
the same `entry` variable, and `overlayStack.indexOf(entry)` always
finds it. A second `hide()` from any duplicate handle is a no-op
(`indexOf` returns `-1`), so closing from multiple call sites is safe.

**Options policy:** when a component is already mounted and a second
`showOverlay` arrives with new `options` (different anchor, width,
`visible` predicate), the *original* options are kept. Re-mounting with
new geometry should `hide()` first and then `showOverlay` with the new
options. This matches the "geometry change = new overlay" mental model
and avoids the silent surprise of having the user-visible size flip
under an in-flight overlay.

## 4. Invariants — MUST / NEVER

1. **NEVER push the same `component` instance twice onto `overlayStack`.**
   `showOverlay` is the only mutator of that stack on the push side; its
   dedup is the contract.
2. **NEVER rely on a new `OverlayHandle` being `===` to a previously
   issued one.** Handles are factory outputs; identity is per-call.
   Identity that *matters* is "all handles for the same entry splice the
   same row", and that is satisfied by `indexOf(entry)`.
3. **NEVER change overlay geometry on a re-show.** `showOverlay` on an
   already-mounted component preserves the original `options`. Callers
   that want new geometry must `hide()` first.
4. **NEVER splice the overlay stack from outside `TUI`.** `overlayStack`
   is a public field for test introspection only; production code goes
   through `showOverlay` / `OverlayHandle.hide` / `setHidden`.
5. **NEVER pair `showOverlay` with an "always hide after 1 frame"
   workaround.** If you find yourself adding a `setTimeout(hide, 0)`
   around a `showOverlay` to dodge the bug, that is a code smell — the
   caller is racing its own `close()` and the dedup is the right knob.

## 5. Tests

`packages/tui/test/issue-overlay-double-mount-repro.test.ts` — 4 cases:

| Case | Asserts |
|---|---|
| single mount | `render()` called once per frame, stack length 1 |
| dedup: same component, double `showOverlay` | `render()` called once, stack length 1 |
| different components, separate `showOverlay` | each rendered once, stack length 2, handles distinct, `hide()` of one does not affect the other |
| idempotent close | `hide()` from any duplicate handle splices the single entry; a second `hide()` is a no-op (no extra render, no error) |

When you change the dedup policy, edit the *expectations* in the
dedup-case, not the test scaffolding — the test scaffolding is the
contract.

## 6. What this fix does *not* cover

- **Stale references in `previousVisibleOverlayComponents`** are not
  pruned by dedup. If an entry was once on the stack and got spliced, the
  next `#planRender` clears it from the previous-visible set naturally
  (`tui.ts:2496-2497`). No additional bookkeeping is needed.
- **Per-overlay `key` based dedup** (e.g. "the same `SelectList` value
  reused across mounts") is *not* this fix. We dedup by object identity,
  not by content. If a caller wants to re-show a conceptually-new list
  that happens to render the same options, it should `new`-up a new
  component instance.
- **Async factory race in `ExtensionUIContext.custom` itself** is still
  a thing — the dedup narrows the window, but the `closed` sentinel +
  `Promise.try` sequence in
  `extension-ui-controller.ts:785-825` remains the structural answer for
  the "factory is still running, user already cancelled" path.

## 7. Before you touch `showOverlay` / `#buildOverlayHandle` — checklist

- [ ] Does your change still dedup on the same component instance?
- [ ] Does it preserve the original `options` on a dedup hit?
- [ ] Does it return a handle whose `hide()` is bound to the *current*
      entry (so dedup hits and fresh pushes splice the right row)?
- [ ] Did you run `packages/tui/test/issue-overlay-double-mount-repro.test.ts`
      and the full `packages/tui` suite (`bun test packages/tui`)?
- [ ] Did you confirm the `coding-agent` overlay-related unit tests
      (`autocomplete-max-visible`, `selector-controller-session-delete`)
      still pass?
