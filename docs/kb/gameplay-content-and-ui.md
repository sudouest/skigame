---
title: Gameplay Loop, Declarative Content Registries, Input & HUD/UI
scope: Game modes, stages/biomes/palettes, characters, hazards, creatures, presents, delivery zones, scenery rules, InputManager, GameUI
tags: [gameplay, content, stages, characters, hazards, presents, delivery-zones, input, ui, hud]
source_files:
  - src/content/types.ts
  - src/content/stages.ts
  - src/content/characters.ts
  - src/content/hazards.ts
  - src/content/creatures.ts
  - src/content/presents.ts
  - src/content/deliveryZones.ts
  - src/content/sceneryRules.ts
  - src/core/input.ts
  - src/ui/gameUi.ts
  - src/ui/hudFormatting.ts
  - src/ui/styles.ts
  - src/ui/types.ts
  - index.html
last_verified: 2026-11-25
---

# Gameplay Loop, Content Registries, Input & HUD/UI

## 1. Core Gameplay Loop & Modes

1. **Collect Presents:** Ski through magnetic pickup radii (`2.3–2.6 m`, ×`1.15` with Pip's perk) to score small immediate `pickupPoints` and stack gifts diegetically onto the skier's back (up to character `presentCapacity`).
2. **Deliver & Build Combos:** Carve through glowing **Delivery Zones** (guaranteed every `150–220 m`, accelerated when bag `>= 75%` full) to auto-toss carried presents in parabolic arcs. Points scale by `comboMultiplier` (`8 s` combo timer) × `stage.scoreMultiplier`.
3. **Choose Forks:** Every `~260–360 m` the trail splits at twin iconographic entrance gates (`circle` green, `square` blue, `diamond` black) with a `50 m` obstacle-free runway, balancing risk vs. `1.0x–2.5x` score multipliers.
4. **Wipeout & Recover:**
   - **Endless mode** (default in `src/main.ts:54`): Stumbles (`boulder_small`) drop 1 gift and slow to 58%; full wipeouts scatter up to 3 gifts (2 on chasm fall), reset active combo, tumble for `1.1–1.2 s`, then recover upright with `1.5 s` invulnerability.
   - **Score Attack mode** (`gameMode: 'scoreAttack'`, supported in `SkiSimulation` & `GameUI` `'gameover'` overlay): 3 lives; full wipeout decrements `livesRemaining`, ending the run at `0`.

---

## 2. Declarative Content Registries (`src/content/`)

All content modules are pure data with zero `three`, DOM, or `sim` dependencies (`content.test.ts` validates hex colors, probabilities, curvature safety, fog floor `>= 65 m`, and registry completeness).

### Stages / Biomes (`src/content/stages.ts`)

| Stage ID | Name & Difficulty | Role / Mult | Pitch (°) | HalfWidth (m) | Left Landscape | Right Landscape | Weather | `forkTargets` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `powder-bowl` | Powder Bowl Meadow (`green` ●) | breather / `1.0x` | `[9, 14]` | `[16, 20]` | `alpineBowl` (`22m`) | `alpineBowl` (`24m`) | `weather_sunny` | `sunny-blue`, `granite-gorge`, `icy-black` |
| `sunny-blue` *(default)* | Sunny Blue Run (`blue` ■) | breather / `1.0x` | `[10, 16]` | `[14, 18]` | `rollingHills` (`14m`) | `rollingHills` (`14m`) | `weather_sunny` | `powder-bowl`, `granite-gorge`, `icy-black` |
| `granite-gorge` | Granite Gorge (`blue` ■) | intense / `1.5x` | `[16, 23]` | `[11, 14]` | `canyonWalls` (`26m`) | `canyonWalls` (`28m`) | `weather_crisp_mountain` | `powder-bowl`, `sunny-blue`, `icy-black`, `blizzard-ridge` |
| `icy-black` | Icy Black Diamond (`black` ◆) | intense / `2.0x` | `[24, 33]` | `[8.5, 11.5]` | `canyonWalls` (`24m`) | `chasm` (`-34m`, wipe `22m`, farRim `75m`) | `weather_crisp_mountain` | `powder-bowl`, `sunny-blue`, `granite-gorge`, `blizzard-ridge` |
| `blizzard-ridge` | Blizzard Ridge (`black` ◆) | intense / `2.5x` | `[22, 30]` | `[9.5, 12.5]` | `chasm` (`-36m`, wipe `22m`, farRim `80m`) | `alpineBowl` (`26m`) | `weather_blizzard` | `powder-bowl`, `sunny-blue`, `granite-gorge`, `icy-black` |

### Weather Profiles (`src/content/stages.ts:3-31`)

| ID | Snow Particles | Wind Lateral | Fog Min / Max (m) | `blizzardDim` |
| :--- | :---: | :---: | :---: | :---: |
| `weather_sunny` | `24` | `1.5 m/s` | `145 / 280` | `0.00` |
| `weather_crisp_mountain` | `85` | `4.5 m/s` | `100 / 210` | `0.12` |
| `weather_blizzard` | `240` | `12.5 m/s` | `68 / 125` (floor `65 m`) | `0.35` |

### Skier Characters (`src/content/characters.ts`)

| ID | Name | `maxSpeed` | `carveGrip` | `jumpImpulse` | Bag Cap | Wipeout / Invuln | Perk |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `skier_alpine` *(default)* | Pip the Alpine Courier | `34 m/s` | `1.00` | `8.6` | `12` | `1.2 s` / `1.5 s` | `pickupMagnet: 1.15` (+15% radius) |
| `skier_carver` | Sora the Ice Carver | `36 m/s` | `1.15` | `8.4` | `10` | `1.1 s` / `1.5 s` | `iceGrip: 1.6` (+60% ice traction) |

### Hazards, Ramps & Creatures (`hazards.ts`, `creatures.ts`)

| ID | Type | Collider (`r × h`) | Impact Effect | Dropped | Speed Ret. | Lethal (`safeX` protected) |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: |
| `boulder_small` | Hazard | `0.95 m × 0.72 m` *(jumpable)* | `stumble` | `1` | `0.58` | `false` |
| `boulder_large` | Hazard | `1.85 m × 2.35 m` | `wipeout` | `3` | `0.0` | `true` |
| `pine_tree` | Hazard | `0.80 m × 6.50 m` | `wipeout` | `3` | `0.0` | `true` |
| `ski_ramp_standard` | Ramp | `4.2 m W × 6.5 m L × 1.35 m H` | `+18°` lip boost | — | — | — |
| `bear_patrol` | Creature | `1.20 m × 1.85 m` | `wipeout` | `3` | `0.0` | `false` (dynamic patrol) |

> **Note:** `ogreThrower` and `yetiFlankAmbush` exist in `CreatureBehaviorConfig` (`src/content/types.ts:265-276`), and `yetiRepellent` exists in `SkierPerk` (`:322`), but only `bear_patrol` is implemented.

### Presents & Delivery Zones (`presents.ts`, `deliveryZones.ts`)

- **Presents:** `gift_standard` (`100` base, `25` pickup, `r = 2.3 m`), `gift_golden` (`350` base, `75` pickup, `r = 2.6 m`).
- **Delivery Zones:** `child_solo` (`r = 7.5 m`, `len = 16 m`, `+0.25/gift`, lantern), `sled_duo` (`r = 8.0 m`, `len = 18 m`, `+0.35/gift`, lantern arch, 2 children), `village_plaza` (`r = 9.0 m`, `len = 20 m`, `+0.50/gift`, cabin, 3 children). All accept `'all'` carried gifts.

### Default Off-Piste Scenery Rules (`src/content/sceneryRules.ts`)

5 rules evaluated per off-piste tile candidate by `scenerySelector.ts`:
- **Canopy layer (`canopyMinRadius`):** `pine_green` (`minNormalY = 0.78`), `pine_frosted` (`0.78`).
- **Ground layer (`groundMinRadius`):** `snow_shrub` (`0.80`), `alpine_rock` (`0.72`), `rock_crag` (`0.72`).

---

## 3. Input Handling (`src/core/input.ts`)

`InputManager` attaches to injectable DOM targets (`window` + `#viewport` in `src/main.ts:307`) or accepts direct synthetic calls in Node tests, writing zero-allocation snapshots via `sampleFrameInto(out)`.

| Action | Desktop Keyboard (`code` / `key`) | Touch / Pointer (`#viewport`) |
| :--- | :--- | :--- |
| **Carve Left / Right** | `KeyA`/`ArrowLeft`, `KeyD`/`ArrowRight` | Relative horizontal drag (`accumulatedDragPx / viewportWidth * dragSensitivity`); `main.ts` scales ×`3.2`, `skiPhysics` ×`8.0` |
| **Jump (edge)** | `Space`, `KeyW`, `ArrowUp` (repeat-guarded) | Short tap (`<= 240 ms`, `<= 12 px`) OR quick swipe-up (`dy <= -36 px` within `220 ms`) |
| **Snowplow Brake (held)** | `KeyS`, `ArrowDown` | 2+ simultaneous fingers/pointers (`activePointers.size >= 2`) |
| **Toggles (edge)** | `KeyB` (blizzard), `KeyG` (3D debug), `KeyP` (stats), `Escape` (pause) | HUD / Pause modal buttons |

- **Pointer/Touch Deduplication (`:134, 320-391`):** Tracks `activeInputMode: 'none' | 'pointer' | 'touch'` so browsers firing both pointer and touch events never double-count drags or taps.
- **120/144 Hz Edge Safety (`src/main.ts:256-272`):** `jumpPressed` and `pointerSteerDelta` accumulate across frames with 0 physics substeps and clear only after the first `sim.step()` consumes them.
- **Focus Loss Safety:** `blur` and `visibilitychange` (`hidden`) clear held inputs (`resetHeldInputs`) and pause active runs.

---

## 4. HUD & UI Architecture (`src/ui/`)

`GameUI` (`src/ui/gameUi.ts`, styled by `src/ui/styles.ts` "Alpine Broadcast × Frosted Crystal") builds its entire DOM tree **once** in the constructor (zero per-frame DOM node creation, enforced by `gameUi.test.ts:138`) and uses string/boolean dirty-checking caches (`:172-192`) on every `update()`.

### Layout & Notification Channels (Designed to Keep Center Sightline Clear)

- **Top-Left Capsule:** Score, combo multiplier badge + decay bar, carried bag (`count/cap`, `FULL` tag), delivered total. Tucked beneath it: **Coalesced Pickup / Stumble Micro-Chip** (`pushPickupBurst` merges rapid pickups within `1.45 s`; `showStumbleChip` + peripheral orange vignette flash on stumble).
- **Top-Right Capsule + Utility Row:** Stage pill (iconographic badge shape/color + name + multiplier; pulses inline on `FORK_ENTERED`), distance, Pause/Resume button, and desktop toggle buttons (`Snow [B]`, `Debug [G]`, `Stats [P]`, mirrored inside Pause modal for mobile).
- **Top Broadcast Rail (Single-Slot Ribbon):** Displays `PRESENT_DELIVERED` score/combo ribbons and center-ahead `CREATURE_TELEGRAPH` alerts strictly above the horizon.
- **Peripheral Edge Beacons:** Left/right pulsing bear + chevron + distance badges for off-center `CREATURE_TELEGRAPH` events.
- **Wipeout Banner:** Centered progress bar visible only while `simState.skierState === 'wipeout'`.
- **Lazy Onboarding Hint (`:21, 780-788`):** Appears only if `!hasSteered` after `8.0 s` of active play.
- **Telemetry & Leak Panel (`:460-476, 1013-1042`):** Displays FPS, Frame cur/avg ms, Sim/Rnd/Strm ms, Draws/Tris, Chunks (active/queued), Origin Rebases, GPU Objects/Resources (active + cached), Geos/Textures, and Leak Check summary.
- **Modal Overlay (`overlayMode: 'start' | 'playing' | 'paused' | 'gameover'`):** Skier switcher (works mid-run while paused!), run summary stats, controls cheat-sheet, and Start/Resume/Restart/Play Again CTAs.
- **Safe-Area & Mobile Lock (`index.html:28-33`, `styles.ts:27-35`):** `env(safe-area-inset-*)`, `touch-action: none`, `overscroll-behavior: none`, `user-select: none`, and `@supports not (backdrop-filter)` solid fallback.

---

## 5. Gotchas / Don't Break

- **Keep `src/ui/` decoupled from `three` and `sim` internals (`uiFormatting.test.ts:302-328`):** Only import types from `../sim/contracts`, pure data from `../content/*`, and helpers from `../core/*`.
- **Keep `GameUI` testable with lightweight mock DOM (`gameUi.test.ts`):** Notice `setAttr` guards `typeof el.setAttribute === 'function'` (`gameUi.ts:1099-1103`) and `hudFormatting.ts` holds pure formatting logic so tests run fast in Vitest's Node environment without jsdom.
- **Blur buttons on click (`gameUi.ts:196-226`):** All HUD buttons call `.blur()` on click so pressing `Space` to jump never accidentally re-triggers the last clicked HUD toggle!
- **Adding a stage:** Must register in `STAGES` + `getAllStages()` (`stages.ts:704-730`), satisfy `content.test.ts` (curvature clamp `<= 0.4`, fog `>= 65 m`, valid `forkTargets`, hex palette), and appear in `soak50km.test.ts:227-229` (soak test asserts **every** stage returned by `getAllStages()` is visited at least once over 50 km!).
