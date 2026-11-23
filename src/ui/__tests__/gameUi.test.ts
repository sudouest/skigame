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
});
