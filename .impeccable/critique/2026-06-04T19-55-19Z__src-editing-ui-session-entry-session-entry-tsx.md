---
target: Enter edit session modal
total_score: 29
p0_count: 0
p1_count: 2
timestamp: 2026-06-04T19-55-19Z
slug: src-editing-ui-session-entry-session-entry-tsx
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Per-layer loading + memory meter are strong; no spinner/feedback on submit (button just disables) |
| 2 | Match System / Real World | 4 | Domain language is precise and plain for the neuroscience audience |
| 3 | User Control and Freedom | 3 | Cancel / backdrop / close present, but no Esc-to-close |
| 4 | Consistency and Standards | 3 | Exit flow uses native `window.confirm` while entry is a fully custom modal |
| 5 | Error Prevention | 3 | Open gated on bbox+editable, image can't be Editable, discard confirm — but over-budget opens silently |
| 6 | Recognition Rather Than Recall | 3 | Visible toggles + rich tooltips + smart defaults |
| 7 | Flexibility and Efficiency | 2 | No keyboard shortcuts, no Esc, no bulk "set all" action |
| 8 | Aesthetic and Minimalist Design | 3 | Clean and focused; minor noise from tiny uppercase labels |
| 9 | Error Recovery | 2 | Errors surface at the footer (far from source) and aren't announced (no aria-live) |
| 10 | Help and Documentation | 3 | Contextual tooltips + section captions |
| **Total** | | **29/40** | **Good** |

## Anti-Patterns Verdict

**LLM assessment**: Not AI slop. This is genuinely bespoke, domain-driven UI: a memory-budget meter, a three-state role toggle with smart per-layer defaults, and precise plain-language microcopy. None of the slop tells are present (no gradient text, glassmorphism, hero-metric template, identical card grids, or side-stripe borders). The only mild tell is the tiny uppercase tracked section labels (REGION / LAYERS).

**Deterministic scan**: 1 finding — `layout-transition` (warning) at `session_entry.css:443`: the memory-meter fill animates `width`. Minor perf; everything else clean.

**Browser overlays**: Not run. Browser automation isn't available in this session and live inspection would require a full Neuroglancer build + iframe host. Assessment B relied on the CLI detector + full source review.

## Overall Impression

A confident, well-built modal that knows its domain. The biggest opportunity is not aesthetics — it's two correctness/accessibility gaps hiding under the polish: the resolution dropdown is clipped by an `overflow: hidden` ancestor, and the modal skips standard dialog semantics (Esc, focus trap, `role="dialog"`, announced errors).

## What's Working

1. **Three-state role toggle with smart defaults** (`layer_row.tsx`): seg→Editable, image→Reference, hidden→Off; Editable is disabled for image layers with an explanatory tooltip. Excellent error prevention + recognition.
2. **Memory meter** (`session_entry.tsx:564`): proactive safe/near/over feedback before the user commits. Real visibility-of-system-status, and the dual color+text signal avoids color-alone meaning.
3. **Microcopy**: precise, plain, budget-aware ("Off layers load dynamically and don't use the budget"). No jargon bloat.

## Priority Issues

- **[P1] Resolution dropdown is clipped**: `.neuroglancer-edit-session-entry-modal-layers-card { overflow: hidden }` (css:222) wraps the layer rows, and the resolution picker panel is `position: absolute` (css:193). The dropdown for multi-resolution layers will be cut off by the card edge. **Fix**: render the panel in a portal / `position: fixed`, or use the native popover API, so it escapes the clipping context. **Command**: /impeccable harden
- **[P1] Missing dialog semantics & keyboard control**: the modal `<div>` has no `role="dialog"`, `aria-modal`, or `aria-labelledby` tying it to the "Enter Edit Session" header; there's no Esc-to-close, no focus trap, and no autofocus. Screen-reader and keyboard users are stranded. **Fix**: add dialog roles, label the header via `aria-labelledby`, trap focus, autofocus the first control, and close on Esc. **Command**: /impeccable harden
- **[P2] Validation errors are far from their cause and silent to AT**: errors like "Pick at least one resolution for layer X" render in the footer (css:485), not next to the offending row, and the error container has no `aria-live`. **Fix**: add `role="alert"`/`aria-live="assertive"` to the error region; consider inline per-row errors. **Command**: /impeccable clarify
- **[P2] Low-contrast dimmed text**: `--text-dim: #6b7280` on the dark surface is ≈3.6:1 — below WCAG AA 4.5:1. Used for "(loading…)", the empty-layers message, and the dropdown caret. **Fix**: lighten `--text-dim` toward the muted end (≈#8b929c+) so it clears 4.5:1. **Command**: /impeccable audit
- **[P2] Exit flow breaks consistency at a high-stakes moment**: discarding a dirty session uses native `window.confirm` (`topbar_edit_button.tsx:43`) while entry is a fully styled modal. The destructive "discard unsaved changes" moment deserves the better-styled, on-brand treatment, not an OS dialog. **Fix**: route the discard confirm through the same modal system. **Command**: /impeccable harden

## Persona Red Flags

**Alex (Power User)**: No Esc to dismiss. No keyboard shortcut to open/confirm. No bulk action ("set all to Reference") when prepping many layers — every layer is toggled one at a time. Tab order/focus trap unverified, so keyboard-only flow likely leaks to the page behind the modal.

**Sam (Accessibility)**: No `role="dialog"`/`aria-modal`, so AT doesn't announce a modal context. Validation errors aren't in a live region — a blocked submit is silent. `#6b7280` dim text fails 4.5:1. Focus isn't trapped or returned to the trigger on close.

**Riley (Stress Tester)**: Over-budget ("Over budget — only part of the region will be loaded") still lets the user Open session with no extra confirmation — easy to commit to a region that won't fully load. A layer with a load error blocks submit with a footer error but the offending row isn't highlighted. Multi-resolution dropdown clipping is exactly the kind of edge that breaks when many scales exist.

## Minor Observations

- `layout-transition` on the meter fill `width` (css:443) — animate `transform: scaleX()` instead for a cheaper repaint.
- Tiny uppercase tracked section labels (REGION / LAYERS) are a faint AI-grammar tell; fine as functional labels but could be sentence-case for warmth.
- `min-width: 560px` with no responsive fallback will overflow narrow viewports (low priority for a desktop tool).
- Close glyph is a raw `&times;` — fine, but an aria-label="Close" on the button would help (the `title` helps sighted users only).

## Questions to Consider

- Should "Over budget" be a soft warning or a hard gate? Right now nothing stops a user from opening a session that can't fully load.
- Does the discard-changes confirmation deserve the same care as the entry modal, given it's the higher-stakes moment?
- Could a "set all layers to Reference / Off" affordance save power users from per-row toggling on large layer lists?
