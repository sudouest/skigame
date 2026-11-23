import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/eventBus';
import type { ProfilerSnapshot } from '../../core/profiler';
import type { SimEventMap } from '../../sim/contracts';
import { SkiSimulation } from '../../sim/skiSimulation';
import { GameUI } from '../gameUi';
import { createLeakCheckStatus, createRenderTelemetryStats, type GameUICallbacks } from '../types';

class MockClassList {
  private readonly classes = new Set<string>();
  constructor(private readonly owner: MockElement) {}

  syncFromString(str: string): void {
    this.classes.clear();
    for (const part of str.split(/\s+/)) {
      if (part) this.classes.add(part);
    }
  }

  add(...tokens: string[]): void {
    for (const t of tokens) this.classes.add(t);
    this.owner._syncClassName(Array.from(this.classes).join(' '));
  }

  remove(...tokens: string[]): void {
    for (const t of tokens) this.classes.delete(t);
    this.owner._syncClassName(Array.from(this.classes).join(' '));
  }

  toggle(token: string, force?: boolean): boolean {
    const next = force !== undefined ? force : !this.classes.has(token);
    if (next) this.classes.add(token);
    else this.classes.delete(token);
    this.owner._syncClassName(Array.from(this.classes).join(' '));
    return next;
  }

  contains(token: string): boolean {
    return this.classes.has(token);
  }
}

class MockElement {
  readonly children: MockElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList: MockClassList;
  parentElement: MockElement | null = null;
  textContent = '';
  innerHTML = '';
  type = '';
  private _className = '';
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    readonly tagName: string,
    readonly ownerDocument: MockDocument,
  ) {
    this.classList = new MockClassList(this);
  }

  get className(): string {
    return this._className;
  }

  set className(val: string) {
    this._className = val;
    this.classList.syncFromString(val);
  }

  _syncClassName(val: string): void {
    this._className = val;
  }

  append(...nodes: MockElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }

  appendChild(node: MockElement): MockElement {
    if (node.parentElement) {
      node.parentElement.removeChild(node);
    }
    node.parentElement = this;
    this.children.push(node);
    return node;
  }

  removeChild(node: MockElement): MockElement {
    const idx = this.children.indexOf(node);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      node.parentElement = null;
    }
    return node;
  }

  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) {
      fn();
    }
  }

  blur(): void {}

  findByClass(cls: string): MockElement[] {
    const out: MockElement[] = [];
    const visit = (el: MockElement): void => {
      if (el.classList.contains(cls)) out.push(el);
      for (const child of el.children) visit(child);
    };
    visit(this);
    return out;
  }
}

class MockDocument {
  createdCount = 0;
  createElement(tag: string): MockElement {
    this.createdCount++;
    return new MockElement(tag, this);
  }
}

describe('GameUI lifecycle, pooled popups, banners, and dispose', () => {
  it('updates HUD without per-frame DOM node creation, fires pooled event popups, and cleans up on dispose()', () => {
    const doc = new MockDocument();
    const mountEl = new MockElement('div', doc);
    const eventBus = new EventBus<SimEventMap>();
    const sim = new SkiSimulation({ seed: 42, eventBus });

    let startCalls = 0;
    let blizzardCalls = 0;
    let selectedSkier = '';
    const callbacks: GameUICallbacks = {
      onStart: () => {
        startCalls++;
      },
      onResume: () => {},
      onRestart: () => {},
      onSelectSkier: (id) => {
        selectedSkier = id;
      },
      onTogglePause: () => {},
      onToggleBlizzard: () => {
        blizzardCalls++;
      },
      onToggleDebugDraw: () => {},
      onToggleTelemetry: () => {},
    };

    const ui = new GameUI(mountEl as unknown as HTMLElement, eventBus, callbacks);
    const createdAtInit = doc.createdCount;
    expect(eventBus.listenerCount()).toBe(5);
    expect(mountEl.children.length).toBe(1);

    const profiler: ProfilerSnapshot = {
      frameMs: 4.2,
      simMs: 1.1,
      renderMs: 2.8,
      streamMs: 0.3,
      avgFrameMs: 16.6,
      avgSimMs: 1.0,
      avgRenderMs: 2.5,
      maxFrameMs: 8.0,
      maxSimMs: 2.0,
      fps: 60.2,
      simSteps: 1,
    };
    const renderStats = {
      ...createRenderTelemetryStats(),
      drawCalls: 28,
      triangles: 12500,
      activeChunks: 12,
      activeObjects: 16,
      activeResources: 24,
      geometries: 10,
      textures: 3,
    };
    const leakStatus = {
      ...createLeakCheckStatus(),
      hasRun: true,
      totalLeaks: 0,
    };

    // Click Start + Skier card + Snow toggle button
    mountEl.findByClass('sg-cta-primary')[0]!.click();
    mountEl.findByClass('sg-skier-card')[1]!.click();
    mountEl.findByClass('sg-btn-snow')[0]!.click();
    expect(startCalls).toBe(1);
    expect(selectedSkier).toBe('skier_carver');
    expect(blizzardCalls).toBe(1);

    // Emit multiple events to saturate & recycle the 5-slot popup pool
    for (let i = 0; i < 8; i++) {
      eventBus.emit('PRESENT_PICKED_UP', {
        presentDefId: i % 2 === 0 ? 'gift_standard' : 'gift_golden',
        worldX: 0,
        worldY: 0,
        worldZ: -i * 5,
        pickupPoints: 25,
        carriedCount: i + 1,
        maxCapacity: 12,
      });
    }
    eventBus.emit('CREATURE_TELEGRAPH', {
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: -4,
      worldY: 0,
      worldZ: -25,
      distanceToPlayerM: 24,
      showEdgeIndicator: true,
      edgeSide: 'left',
    });

    // Advance 9 seconds without steering -> lazy hint appears
    for (let s = 0; s < 9; s++) {
      ui.update(
        {
          simState: sim.getState(),
          profiler,
          renderStats,
          leakStatus,
          hasSteered: false,
          debugDrawEnabled: true,
          telemetryVisible: true,
          overlayMode: 'playing',
        },
        1.0,
      );
    }

    // Zero additional DOM elements created during updates or event bursts!
    expect(doc.createdCount).toBe(createdAtInit);
    expect(mountEl.findByClass('sg-hint-pill')[0]!.classList.contains('sg-hidden')).toBe(false);
    expect(mountEl.findByClass('sg-telemetry')[0]!.classList.contains('sg-hidden')).toBe(false);
    expect(mountEl.findByClass('sg-overlay')[0]!.classList.contains('sg-hidden')).toBe(true);

    // Dispose unsubscribes every EventBus listener and unmounts cleanly
    ui.dispose();
    expect(eventBus.listenerCount()).toBe(0);
    expect(mountEl.children.length).toBe(0);
  });

  function createHarness() {
    const doc = new MockDocument();
    const mountEl = new MockElement('div', doc);
    const eventBus = new EventBus<SimEventMap>();
    const sim = new SkiSimulation({ seed: 99, eventBus });
    const callbacks: GameUICallbacks = {
      onStart: () => {},
      onResume: () => {},
      onRestart: () => {},
      onSelectSkier: () => {},
      onTogglePause: () => {},
      onToggleBlizzard: () => {},
      onToggleDebugDraw: () => {},
      onToggleTelemetry: () => {},
    };
    const ui = new GameUI(mountEl as unknown as HTMLElement, eventBus, callbacks);
    const createdAtInit = doc.createdCount;
    const profiler: ProfilerSnapshot = {
      frameMs: 4.0,
      simMs: 1.0,
      renderMs: 2.5,
      streamMs: 0.5,
      avgFrameMs: 16.6,
      avgSimMs: 1.0,
      avgRenderMs: 2.5,
      maxFrameMs: 8.0,
      maxSimMs: 2.0,
      fps: 60,
      simSteps: 1,
    };
    const renderStats = createRenderTelemetryStats();
    const leakStatus = createLeakCheckStatus();
    const stepUi = (dtSec: number): void => {
      ui.update(
        {
          simState: sim.getState(),
          profiler,
          renderStats,
          leakStatus,
          hasSteered: true,
          debugDrawEnabled: false,
          telemetryVisible: false,
          overlayMode: 'playing',
        },
        dtSec,
      );
    };
    return { doc, mountEl, eventBus, ui, createdAtInit, stepUi };
  }

  it('coalesces rapid PRESENT_PICKED_UP events into a single pickup chip with zero DOM allocation', () => {
    const { doc, mountEl, eventBus, ui, createdAtInit, stepUi } = createHarness();
    const chip = mountEl.findByClass('sg-pickup-chip')[0]!;
    const pointsEl = mountEl.findByClass('sg-pickup-points')[0]!;
    const starEl = mountEl.findByClass('sg-pickup-star')[0]!;
    const countEl = mountEl.findByClass('sg-pickup-count')[0]!;

    eventBus.emit('PRESENT_PICKED_UP', {
      presentDefId: 'gift_standard',
      worldX: 0,
      worldY: 0,
      worldZ: -10,
      pickupPoints: 25,
      carriedCount: 1,
      maxCapacity: 12,
    });
    expect(chip.classList.contains('sg-hidden')).toBe(false);
    expect(chip.dataset.tone).toBe('gift');
    expect(pointsEl.textContent).toBe('+25');
    expect(starEl.classList.contains('sg-hidden')).toBe(true);
    expect(countEl.classList.contains('sg-hidden')).toBe(true);

    eventBus.emit('PRESENT_PICKED_UP', {
      presentDefId: 'gift_golden',
      worldX: 0,
      worldY: 0,
      worldZ: -20,
      pickupPoints: 75,
      carriedCount: 2,
      maxCapacity: 12,
    });
    expect(chip.dataset.tone).toBe('gold');
    expect(pointsEl.textContent).toBe('+100');
    expect(starEl.classList.contains('sg-hidden')).toBe(false);
    expect(countEl.classList.contains('sg-hidden')).toBe(false);
    expect(countEl.textContent).toBe('×2');
    expect(doc.createdCount).toBe(createdAtInit);

    stepUi(1.5);
    expect(chip.classList.contains('sg-hidden')).toBe(true);
    ui.dispose();
  });

  it('shows PRESENT_DELIVERED in the single-slot broadcast ribbon and replaces prior ribbon cleanly', () => {
    const { mountEl, eventBus, ui, stepUi } = createHarness();
    const ribbon = mountEl.findByClass('sg-broadcast-ribbon')[0]!;
    const primary = mountEl.findByClass('sg-ribbon-primary')[0]!;
    const detail = mountEl.findByClass('sg-ribbon-detail')[0]!;
    const combo = mountEl.findByClass('sg-ribbon-combo')[0]!;

    eventBus.emit('PRESENT_DELIVERED', {
      deliveryZoneId: 'child_solo',
      countDelivered: 2,
      pointsAwarded: 400,
      comboMultiplier: 1,
      totalScore: 400,
      worldX: 0,
      worldY: 0,
      worldZ: -50,
    });
    expect(ribbon.classList.contains('sg-hidden')).toBe(false);
    expect(ribbon.dataset.tone).toBe('delivery');
    expect(primary.textContent).toBe('+400');
    expect(detail.textContent).toBe('2 DELIVERED');
    expect(combo.classList.contains('sg-hidden')).toBe(true);

    eventBus.emit('PRESENT_DELIVERED', {
      deliveryZoneId: 'village_plaza',
      countDelivered: 4,
      pointsAwarded: 1400,
      comboMultiplier: 3,
      totalScore: 1800,
      worldX: 0,
      worldY: 0,
      worldZ: -90,
    });
    expect(mountEl.findByClass('sg-broadcast-ribbon').length).toBe(1);
    expect(primary.textContent).toBe('+1,400');
    expect(detail.textContent).toBe('4 DELIVERED');
    expect(combo.classList.contains('sg-hidden')).toBe(false);
    expect(combo.textContent).toBe('×3');

    stepUi(2.2);
    expect(ribbon.classList.contains('sg-hidden')).toBe(true);
    ui.dispose();
  });

  it('routes left/right creature telegraphs to edge beacons and center telegraphs to top ribbon', () => {
    const { mountEl, eventBus, ui, stepUi } = createHarness();
    const leftBeacon = mountEl.findByClass('sg-edge-left')[0]!;
    const rightBeacon = mountEl.findByClass('sg-edge-right')[0]!;
    const ribbon = mountEl.findByClass('sg-broadcast-ribbon')[0]!;

    eventBus.emit('CREATURE_TELEGRAPH', {
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: -6,
      worldY: 0,
      worldZ: -30,
      distanceToPlayerM: 34,
      showEdgeIndicator: false,
      edgeSide: 'left',
    });
    expect(leftBeacon.classList.contains('sg-hidden')).toBe(false);
    expect(leftBeacon.classList.contains('sg-edge-active')).toBe(true);
    expect(leftBeacon.findByClass('sg-edge-dist')[0]!.textContent).toBe('34m');
    expect(rightBeacon.classList.contains('sg-hidden')).toBe(true);
    expect(ribbon.classList.contains('sg-hidden')).toBe(true);

    eventBus.emit('CREATURE_TELEGRAPH', {
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: 6,
      worldY: 0,
      worldZ: -25,
      distanceToPlayerM: 21,
      showEdgeIndicator: false,
      edgeSide: 'right',
    });
    expect(rightBeacon.classList.contains('sg-hidden')).toBe(false);
    expect(rightBeacon.findByClass('sg-edge-dist')[0]!.textContent).toBe('21m');
    expect(ribbon.classList.contains('sg-hidden')).toBe(true);

    eventBus.emit('CREATURE_TELEGRAPH', {
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: 0,
      worldY: 0,
      worldZ: -18,
      distanceToPlayerM: 18,
      showEdgeIndicator: false,
      edgeSide: 'center',
    });
    expect(ribbon.classList.contains('sg-hidden')).toBe(false);
    expect(ribbon.dataset.tone).toBe('warning');
    expect(ribbon.findByClass('sg-ribbon-primary')[0]!.textContent).toContain('MOUNTAIN BEAR');
    expect(ribbon.findByClass('sg-ribbon-detail')[0]!.textContent).toBe('18m');

    stepUi(2.0);
    expect(leftBeacon.classList.contains('sg-hidden')).toBe(true);
    expect(rightBeacon.classList.contains('sg-hidden')).toBe(true);
    expect(ribbon.classList.contains('sg-hidden')).toBe(true);
    ui.dispose();
  });

  it('announces FORK_ENTERED inline on stage pill, handles stumble chip/flash, and resets cleanly', () => {
    const { mountEl, eventBus, ui, stepUi } = createHarness();
    const stagePill = mountEl.findByClass('sg-stage-pill')[0]!;
    const chip = mountEl.findByClass('sg-pickup-chip')[0]!;
    const flash = mountEl.findByClass('sg-stumble-flash')[0]!;
    const ribbon = mountEl.findByClass('sg-broadcast-ribbon')[0]!;
    const leftBeacon = mountEl.findByClass('sg-edge-left')[0]!;

    eventBus.emit('FORK_ENTERED', {
      chosenSide: 'right',
      newSegmentId: 2,
      newStageId: 'icy-black',
      previousStageId: 'sunny-blue',
    });
    expect(stagePill.classList.contains('sg-stage-announce')).toBe(true);
    stepUi(2.3);
    expect(stagePill.classList.contains('sg-stage-announce')).toBe(false);

    eventBus.emit('PLAYER_WIPEOUT', {
      hazardId: 'boulder_small',
      effect: 'stumble',
      presentsDropped: 1,
      worldX: 0,
      worldY: 0,
      worldZ: -40,
      recoverySec: 0,
    });
    expect(chip.classList.contains('sg-hidden')).toBe(false);
    expect(chip.dataset.tone).toBe('stumble');
    expect(chip.findByClass('sg-pickup-points')[0]!.textContent).toBe('STUMBLE · -1');
    expect(flash.classList.contains('sg-stumble-active')).toBe(true);

    stepUi(0.35);
    expect(flash.classList.contains('sg-stumble-active')).toBe(false);

    eventBus.emit('FORK_ENTERED', {
      chosenSide: 'left',
      newSegmentId: 3,
      newStageId: 'sunny-blue',
      previousStageId: 'icy-black',
    });
    eventBus.emit('PRESENT_DELIVERED', {
      deliveryZoneId: 'child_solo',
      countDelivered: 1,
      pointsAwarded: 100,
      comboMultiplier: 1,
      totalScore: 100,
      worldX: 0,
      worldY: 0,
      worldZ: -60,
    });
    eventBus.emit('CREATURE_TELEGRAPH', {
      creatureDefId: 'bear_patrol',
      soundId: 'bear_roar',
      worldX: -4,
      worldY: 0,
      worldZ: -70,
      distanceToPlayerM: 25,
      showEdgeIndicator: false,
      edgeSide: 'left',
    });

    ui.resetRunState();
    expect(stagePill.classList.contains('sg-stage-announce')).toBe(false);
    expect(chip.classList.contains('sg-hidden')).toBe(true);
    expect(ribbon.classList.contains('sg-hidden')).toBe(true);
    expect(leftBeacon.classList.contains('sg-hidden')).toBe(true);
    expect(flash.classList.contains('sg-stumble-active')).toBe(false);
    ui.dispose();
  });
});
