# Precision and recovery

Mark IDs identify a snapshot. They do not follow scrolling. Actions validate the window identity, geometry and sampled pixels, then refuse STALE_MARK on mismatch. Refresh and select the intended element from its new ID; never substitute an old ordinal. A sampled fingerprint can miss small changes, so refresh after known navigation or scrolling. UIA actions refuse ambiguous/incomplete searches; specify hwnd and exact AutomationId when available. Read these details only when grounding, focus or recovery needs them.

## The loop

Identify target → activate → act → read back at a natural checkpoint. Use text/UIA when sufficient and pixels when they answer the remaining question. Reuse returned state; obtain a fresh element map only when it may have changed.

computer_batch runs serially and stops subsequent steps on failed activation, error, cancellation or a brake. Its default shot:"auto" skips an extra image for pure observation or a final readback/screenshot, and after failure, cancellation or pause. Use shot:"always" or "never" when the task justifies it. An action's ok reports its return status; assess the business result from the evidence.

### Kickoff: activate before the first screenshot

Use an already-known live target, or computer_state {windows:true} to find it. Call computer_window {op:"activate", hwnd:...} and require activated:true. Activation already tries restore and foreground methods. If it fails, inspect the returned cause and choose a current target before input; do not loop blindly. Only then capture if pixels are needed. A UIA query or a relevant text read is an alternative observation, not an additional mandatory step.

Do not begin by capturing the agent desktop. Do not automatically copy the whole document: it may select the wrong field and gives rendered client text, not proof of server persistence.

## Speed with accuracy: verify at the POINT OF ACTION

Speed and accuracy are not a trade-off here — they are the same discipline: **spend the cheapest
check that can falsify the action, at the last possible moment before acting.**

A screen observation is a snapshot of a world that keeps changing. A rect read 30 seconds ago is a
hypothesis, not a fact: windows move, get covered, get minimized, and Chromium's accessibility tree
goes stale or cold. So separate the two jobs:

- **Observation may be cached** — do it once per window and reuse it (see Screenshots below).
- **Native input guards remain live** at dispatch. Reuse model-side observations while their window/content remains valid; refresh after a relevant change. Do not turn each keystroke into another UIA or screenshot round trip.

Cost ladder — always use the cheapest rung that can answer the question:

| check | cost | answers |
|---|---|---|
| `computer_uia {at:"x,y"}` / click's own occlusion check | text; provider-dependent | who owns this pixel? is it covered? is the rect stale? |
| `focus.match` in a click/key/type result | free (already returned) | did my keystrokes reach the window I meant? |
| `computer_wait {mode:"change"}` | bounded wait | did the click do anything at all? |
| `computer_uia {role/name}` | text; provider-dependent | where exactly is the control, and how wide is it? |
| `computer_shot` (attached image; `read_image` only for path-only fallback) | capture + vision tokens | what does it look like? |

The three failure modes this kills, all of which look like "the tool lied":

1. **Occlusion.** A window can be *visible* and yet have every pixel of it owned by another window
   on top. Clicking it lands on the cover and every tool reports success. `computer_click` now
   refuses such a click outright (error names the covering window and its pid) unless the cover
   belongs to the same process (menus/popups) or you pass `allowCovered:true`.
   **If a click is refused as OCCLUDED, the window is behind something: activate it, move it, or
   bring it into view — do NOT hunt for another coordinate.**
2. **Stale rects** — re-read immediately before use; reject empty rects.
3. **Cold hit-tests** — the first query on a Chromium window answers with an ancestor; query again.

Corollary: **never conclude "the target is not there" from a failure to click it.** Ask who owns the
pixel first; the answer is usually "something is in front of it".

## Grounding: traps that cost real time

- **Depth.** Web-app DOM lives ~20 levels down. `computer_uia` defaults to depth 16 (maximum 24) and
  `computer_marks` defaults to depth 14; use computer_uia with greater depth for deeply nested controls; if a control "does not exist", raise depth before
  concluding it is absent.
- **Chromium's a11y tree is LAZY.** The first query on a Chromium window returns browser chrome
  (~12 nodes), and a cold hit-test returns the nearest *ancestor* instead of the control. Query
  twice, ~1 s apart, before believing a negative — including `computer_uia {at:...}`.
- **Stale rects.** A window just moved/dragged/minimized can report a pre-move rect (occasionally
  `0,0 0x0` for seconds). Re-read a rect right before clicking it; reject empty rects.
- **A wrong filter parameter is silently ignored.** `computer_uia` filters by **`name`**, **`role`** and exact **`id`**; passing anything else (e.g. `nameContains`) returns the ENTIRE tree with no error, and
  that wall of output reads exactly like "the control is not there". **If a filtered query returns
  implausibly many elements, assume the filter did not apply.** Measured: `computer_uia {role:"Button",
  name:"Microsoft Edge"}` → `Appid: MSEdge  x=558 y=1516 w=77 h=84`, one call.
- **The taskbar is a container, and its flyouts are transient.** `computer_uia {at:"x,y"}` over the
  taskbar answers `Shell_TrayWnd` / `MSTaskSwWClass` even for points that are ON a button, so measure
  app buttons **by name** instead. A preview thumbnail must be measured and clicked in the same burst:
  a click arriving after the flyout closed goes to whatever is on top and is correctly refused as
  `HOST-GUARDED` — **that refusal means the pixel is not the thumbnail, NOT that the app cannot be
  activated.**

Two Edit boxes are common (a 9 px search box beside a real input) — check the width.

## Screenshots: few, well-timed, and mined once

Capture → attached image → reasoning still costs vision tokens. Each shot must earn its place.

`computer_shot` attaches the image directly when the current DSH model route supports images.
When `imageStatus:"attached"`, inspect that image without calling `read_image` again. A saved
`path` alone is not visual evidence: if `imageStatus:"path-only"`, follow `view`; a text-only
model requires UIA/text or switching to an image-capable model. `settled:false` still requires
a fresh shot. `computer_batch` attaches at most its latest screenshot and labels when it was
captured; earlier frames remain available by path. An earlier frame does not verify later actions.
`computer_marks {shot:true}` retains its existing annotated-file path behavior.

Use screen coordinates for input. For a measured point `(u,v)` in the attached image,
`x = region.x + u * region.width / imageWidth` and
`y = region.y + v * region.height / imageHeight` (see `coordinates` in the result).
This also handles cropped images and monitors with negative screen origins.

### The rule that matters most: anchor + offset, never absolute pixels

**An absolute pixel is valid only until your next click** — clicking a field scrolls it into view and
the whole layout shifts. Measured cost of ignoring this in one session: 6 wasted clicks chasing a
24 px icon, and two saves that silently missed by 13 px.

So the first shot is not "the coordinates I need now"; it is **the geometry**:

1. **Measure once, from one shot** — column x centres, the action-column icon x, the row pitch, and
   any popup offsets (a date panel's `«` sits at `field.x − 78`; its day cells at `field.x + 82`).
2. **Store offsets, not pixels.** Before each action, re-read ONE cheap text anchor — the section
   header's `y`, or the 增加 button's `rect` — and compute the rest (`row_y = addButton.y − 96`).
   Re-anchoring from text costs milliseconds and never goes stale; a screenshot costs seconds and
   vision tokens. Shoot again only when the anchoring control itself is gone.
3. **A control that repeats per row keeps its x; only y moves.**

### Choose a witness that CANNOT move — hunt the outline first

The best witness is an element **fixed in the viewport**: an outline / anchor menu, a sidebar, a tab
bar, a breadcrumb, a toolbar, a window title. Their rects do not change when content scrolls, so the
stale-epoch problem largely disappears for them and **one read stays valid for a whole session**.

- **A page built around an outline is telling you where its stable frame is: the outline itself.**
  Docs sites, admin consoles, form wizards and SPA dashboards almost always have one. Find it in the
  first `computer_uia {role:"Hyperlink"}` sweep and note *its* rects as the reference frame.
- Anchor everything scroll-dependent (table rows, form fields) **relative to that fixed frame** —
  never to absolute pixels, and never to another scrolling element.
- Prefer a witness whose text also carries state: an outline entry reading `学术成果 完成` makes ONE
  read prove both "where am I" and "did the save land". That single trick replaced a whole
  screenshot-and-look loop.
- Hunting the fixed frame is worth one extra call, every time. If genuinely nothing is fixed, fall
  back to the weaker form of the same rule: re-read the anchor's rect before every action group.

### Tiling ("frame chaining") when the region is wider than 900 px

A crop wider than 900 px is downscaled, and **a downscaled crop cannot be measured**. When you need
1:1 truth across a wide or tall area, take **adjacent tiles** rather than one big shot:

- tile size **≤ 900 px** (1:1 guaranteed), a **fixed step**, and a **~48 px overlap** so no control
  is bisected by a seam;
- tile *k*'s origin is `base + k × step` — a deterministic additive mapping, so one arithmetic
  relation covers every tile instead of one measurement per tile;
- use it when the next few actions march in a known direction across a known area (one table row,
  one form column): **the end of one tile is the start of the next**.

### The screen model: cache MEASUREMENTS, not pixels

Write the geometry you derive into a **task-level text file** (see *Where lessons go*), keyed by
window + scroll epoch, each line carrying its **witness**:

```
win=3147256  epoch=frameSig:9f3c  anchor="增加" rect(1556,786,129,51)   rows: pitch93 y0=540
cols: date=1655  pencil=2373  trash=2415  save=2370      popup: dayCell=+56px  `«`=field-78
```

Rules that make a cache safe — the user's own worry ("if it scrolls, does re-anchoring cost more?")
is answered by the first one:

- **A stored coordinate is a HYPOTHESIS.** Before acting on it, re-read ONE cheap text fact (the
  anchor's rect, or `frameSig`) and compare: match ⇒ valid; mismatch ⇒ the **epoch changed and the
  whole model is void**. Invalidation costs ONE comparison, not a re-derivation — the store's size
  never inflates the cost of finding out it is stale.
- **The danger is not size, it is trust**: a stale coordinate is worse than no coordinate, because
  it converts "I don't know" into a confident wrong click. Cache OBSERVATION — never VERIFICATION
  (the same rule as above, now with a file behind it).
- **Never store pixels for reuse.** Re-reading an image is the expensive operation; a number is
  free to read back. Keep shots in the shots dir and record in the task file *which shot showed
  what* — the index is the useful part, not the image.
- Cap it: one screen model per window per epoch, and delete/replace it when the epoch changes,
  so it can never grow into something you have to read whole.

### Define the witness BEFORE you act

Every action needs ONE cheap text signal that proves it worked — pick it first, then act:

- **save a row** → the section's anchor text flips to `完成` (UIA, zero pixels)
- **follow an anchor / navigate** → the URL **hash** changes (`#4`) — read `Document.value`
- **type** → `focus.match` plus the field's value
- **any click** → `receiver` + `changedPct` (already in the result)

### Mine the first shot properly

- **Mine the first shot of a window.** On entering a window, one full shot pays for itself many
  times over: read not just your target but the **peripheral entries** — toolbar buttons, tabs,
  side panels, breadcrumbs, status bar — and note what each does. Positions in an unchanged window
  do not move, so the first screenshot is an investment, not a cost.
- **Then reuse instead of re-shooting.** `computer_marks` caches the landmark map per window: the
  first call builds it (`reused:false`); later calls on an unchanged window cost ONE pixel hash and
  return the same ids with `reused:true` — no capture, no vision. Add `shot:true` only when you
  actually need to *look*.
- **Let text decide when text can.** Window titles, UIA names, `focus.match`, the clipboard and
  `computer_uia` answer most "did it work?" questions with zero pixels.
- **Check readiness without assuming failure.** `computer_shot` can return `settled:false`
  because of unrelated animation or a caret. For a pixel wait, use `computer_wait
  {mode:"stable",hwnd}` on the observed target window; use UIA readback when its own pixels
  keep animating. `{mode:"change",hwnd}` reports sampled pixel change, not whether a click
  succeeded. Inspect state before repeating an action. Do not stack repeated full timeouts.
- **Crop to the decision**, and crop **1:1** when you must hit a small icon: a scaled crop is a
  guessing game, a 1:1 crop is a measurement.
- **Never shoot twice for the same fact**, and never re-derive a coordinate you already have.

### After ONE miss, change channel — do not guess again

A click that produced no sampled change has an unverified result. Inspect state, then choose another channel if needed:

`1:1 crop (measure, don't guess) → computer_uia {at} (who owns it?) → uia_act (drive it by name) →
keyboard → re-anchor from a fresh text read → new screenshot`

### Known widgets (learned the hard way)

- **Ant date inputs: typing WORKS — with the panel closed.** Click the input **body**, type
  `2023.10.01`, `Tab` to commit. Measured 2026-09-12: **3 calls per date vs 8–12** driving the panel.
  (The old blanket claim "date pickers are read-only" was wrong and cost a whole round.)
  - With the panel **open**, `Enter` accepts the *highlighted default* — i.e. **today**. Never Enter then.
  - The suffix **calendar icon is a trap**: on hover it turns into a clear-✕, so "click the calendar
    icon" **wipes the value**. Click the body.
  - When typing is rejected, fall back to the panel: `«` = year, `‹ ›` = month, then the day cell.
- **A long value can LOOK empty**: the input scrolls horizontally, so `CFA一级` may render as
  `A一级` and a filled field can look blank. Verify with the field clipboard, never with a glance.
- **Table rows have two modes**: a read-only display row, and an edit row. Clicking a display cell
  does nothing (`changedPct: 0` is the tell) — click the row's **pencil** first.
- **A saved table may RE-SORT** (here: by date, descending), so "row 2" after the save is a
  different record. Identify rows by their VALUES, never by their row number.
- **Ant dropdowns may render to the LEFT of the field**: a crop starting at the field's x shows only
  half the options.
- **A required field blocks the save without disabling the button**: the save icon still looks
  enabled and clicking it does nothing at all. After the first no-op, look for a red 必填项 and
  STOP — leave the row empty rather than inventing a value.
- **Never F5 as a "clean up" move**: a reload resets client-side state (e.g. which of several
  resumes is open) and can silently switch you to a different record. Use the row's own undo.

### Filling a table row (the batch pattern)

One row = one `computer_batch`: **pencil → (click cell, type value) × N → save icon**. It is the
single best use of batch: every step returns `focus.match` and `changedPct`, so the batch is also
the witness, and a row costs one round trip instead of ten.

- Dates and short values: type, then `Tab` (commits without opening a panel).
- Long text: type, then verify with `Ctrl+A`/`Ctrl+C` on that field (its own clipboard).
- Selects: click, then click the option — read the open dropdown's coordinates from a 1:1 crop
  first; option rows sit ~48 px apart.
- After saving, confirm the row **left edit mode** (a 1:1 crop of the row) and confirm the section's
  status text flipped (`未完成` → `完成`) — two independent witnesses for one action.

### The zero-risk probe

Unsure whether a control accepts something? Do the cheapest **reversible** thing and LOOK before
committing: type without Enter; hover without clicking; click a field's body rather than its icon.
A probe that cannot change state costs one call; a blind commit costs a recovery — and sometimes a
wrong value written into a real record.

## Focus: where do the keystrokes actually go?

Synthetic keyboard input is **not addressed to a window** — it goes to whatever owns the
foreground. A click can land perfectly and still be followed by text that goes somewhere else.

- `computer_click`, `computer_key` and `computer_type` return a `focus` report:
  `{hwnd, title, match, refocused, warning}`. **`match:false` means the keystroke went to another
  window** — fix the window before retrying; never retype blindly.
- Before keyboard ops the worker re-asserts the window you last activated/clicked in (the "sticky
  target"); `refocused` says which method was needed.
- **Activate at kickoff or after losing the target.** Reuse a confirmed target until focus or content changes.
  A window moved with `op:"move"` is not necessarily foreground — activate before typing if needed.
  - **A MINIMIZED window is not an occluded window.** `activate` already attempts restore and foreground methods.
    If it still returns `activated:false`, inspect the window; an explicit **`restore`, then `activate`**
    is one recovery option. The tell is ONE read — `computer_state {windows:true}` shows
    `"minimized": true` and a `-32000,-32000` rect. **Read that field before concluding that
    something is covering the window.** (2026-09-13: two Edge windows sat minimized while three
    rounds were spent attacking occlusion — `activate`, a taskbar-button click, a preview-thumbnail
    click; `restore` then worked on the first try, and `focus.match` was `true` for every keystroke
    afterwards.)
  - **Do not report an environment block from one failed call.** "foreground lock refused every
    method" is one method's report about one window state — not a finding about the machine. Walk the
    documented escalation to the END (restore → activate → taskbar thumbnail, measured and clicked
    before the flyout closes) before telling the human "the environment blocked it". A wrong blocker
    report is worse than the miss it hides: it stops the other routes from being tried, and it moves
    your own mistake onto the machine.
  - **Pick an instrument that can answer the question.** A window's TITLE says what it is; it cannot
    say whether the window can receive input. `Get-Process | MainWindowTitle` returned a perfectly
    healthy Edge title for a window that was minimized and un-activatable. The window list
    (`computer_state {windows:true}`) carries `minimized`, `active`, `rect`, `pid` — that is the read
    that answers "can I drive this?".
- To fill a field: click it → check `focus.match` → type. To clear it: `computer_key
  {combo:"ctrl+a"}` then `{combo:"delete"}`, and confirm with `computer_uia` that the value is
  empty before typing — a keystroke delivered while the field has lost focus does nothing, and the
  leftover text corrupts the next verification.
- `warning: ELEVATED TARGET` means Windows (UIPI) silently discards synthetic input to that window;
  only the human can fix it (both apps at the same elevation).
- If state, focus and modal inspection point to an input-path issue, use computer_ctrl selftest. Calibrate only for evidence of coordinate mismatch; calibration moves the pointer.

## Reading browser state: text before pixels

Tabs expose their titles through UIA (`computer_uia {hwnd, role:"TabItem"}`) while the window title
only says "…and 2 more pages" — so text is *more* precise than a screenshot here. **Switch tabs with
`computer_uia_act {role:"TabItem", action:"select"}`**: a current selector and no pointer travel. Supply hwnd plus a unique id/name and verify the returned result. The same tool presses buttons, expands combos, fills fields and selects list items — reach
for it before clicking any ordinary control.

## Failure recovery

- Wrong element → refresh the relevant target using text/UIA or an image, then correct course.
  Ask only if the intended target remains ambiguous; do not force both a screenshot and a new map.
- Unexpected or missing feedback → inspect the actual result before retrying. Change method with evidence; ask only for a decision or fact you cannot obtain yourself.
- App not responding → `computer_state {windows:true}` (hung? modal?), then
  `computer_window {op:"activate"}`, else report.

