import type JoltNS from 'jolt-physics/wasm';

export type JoltModule = typeof JoltNS & {
  _webidl_malloc(bytes: number): number;
  _webidl_free(ptr: number): void;
};

export interface JoltRefTarget {
  Release(): void;
}

/**
 * Deterministic LIFO resource owner for Jolt WASM handles, RefTargets, raw WebIDL
 * heap buffers, and custom teardown hooks. Enforces exact 0-byte leaks across lifecycles.
 */
export class DisposableScope {
  private readonly jolt: JoltModule;
  private readonly entries: Array<{ kind: 0 | 1 | 2 | 3; value: unknown }> = [];
  private disposed = false;

  constructor(jolt: JoltModule) {
    this.jolt = jolt;
  }

  track<T>(obj: T): T {
    this.entries.push({ kind: 0, value: obj });
    return obj;
  }

  trackRef<T extends JoltRefTarget>(obj: T): T {
    this.entries.push({ kind: 1, value: obj });
    return obj;
  }

  trackAlloc(ptr: number): number {
    this.entries.push({ kind: 2, value: ptr });
    return ptr;
  }

  onDispose(fn: () => void): void {
    this.entries.push({ kind: 3, value: fn });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === 0) {
        this.jolt.destroy(e.value);
      } else if (e.kind === 1) {
        (e.value as JoltRefTarget).Release();
      } else if (e.kind === 2) {
        this.jolt._webidl_free(e.value as number);
      } else {
        (e.value as () => void)();
      }
    }
    this.entries.length = 0;
  }
}

export interface JoltWorldSlot {
  readonly slotIndex: number;
  readonly staticLayer: number;
  readonly movingLayer: number;
  /** Persistent static terrain BodyID owned by the slot (avoids Jolt NotifyShapeChanged growth across sim lifecycles). */
  readonly terrainBodyId: JoltNS.BodyID;
}

export interface JoltRuntimeOptions {
  readonly maxWorldSlots?: number;
  readonly maxBodies?: number;
  readonly maxBodyPairs?: number;
  readonly maxContactConstraints?: number;
}

/**
 * Dependency-injected Jolt WASM runtime owning ONE shared `JoltInterface` partitioned into
 * isolated `ObjectLayerPairFilterTable` slots so concurrent or sequential `SkiSimulation`
 * instances never collide with one another and never touch `Factory::sInstance` per sim.
 */
export class JoltRuntime {
  readonly jolt: JoltModule;
  readonly joltInterface: JoltNS.JoltInterface;
  readonly physicsSystem: JoltNS.PhysicsSystem;
  readonly bodyInterface: JoltNS.BodyInterface;
  readonly tempAllocator: JoltNS.TempAllocator;
  readonly maxBodies: number;
  readonly maxWorldSlots: number;

  private readonly freeSlots: number[] = [];
  private readonly emptyTerrainShape: JoltNS.EmptyShape;
  private readonly slotTerrainBodyIds: JoltNS.BodyID[] = [];
  private disposed = false;

  constructor(jolt: JoltModule, options: JoltRuntimeOptions = {}) {
    this.jolt = jolt;
    this.maxWorldSlots = Math.max(1, options.maxWorldSlots ?? 32);
    this.maxBodies = options.maxBodies ?? 1024;
    const maxBodyPairs = options.maxBodyPairs ?? 2048;
    const maxContactConstraints = options.maxContactConstraints ?? 1024;

    const numObjectLayers = this.maxWorldSlots * 2;
    const numBroadPhaseLayers = 2;

    // Note: ~JoltInterface() implicitly owns & deletes these 3 filter/interface tables!
    const objectFilter = new jolt.ObjectLayerPairFilterTable(numObjectLayers);
    const bpInterface = new jolt.BroadPhaseLayerInterfaceTable(
      numObjectLayers,
      numBroadPhaseLayers,
    );
    const bpNonMoving = new jolt.BroadPhaseLayer(0);
    const bpMoving = new jolt.BroadPhaseLayer(1);

    for (let slot = 0; slot < this.maxWorldSlots; slot++) {
      const staticLayer = slot * 2;
      const movingLayer = slot * 2 + 1;
      objectFilter.EnableCollision(staticLayer, movingLayer);
      objectFilter.EnableCollision(movingLayer, movingLayer);
      bpInterface.MapObjectToBroadPhaseLayer(staticLayer, bpNonMoving);
      bpInterface.MapObjectToBroadPhaseLayer(movingLayer, bpMoving);
    }

    const objVsBpFilter = new jolt.ObjectVsBroadPhaseLayerFilterTable(
      bpInterface,
      numBroadPhaseLayers,
      objectFilter,
      numObjectLayers,
    );

    const settings = new jolt.JoltSettings();
    settings.mMaxBodies = this.maxBodies;
    settings.mMaxBodyPairs = maxBodyPairs;
    settings.mMaxContactConstraints = maxContactConstraints;
    settings.mObjectLayerPairFilter = objectFilter;
    settings.mBroadPhaseLayerInterface = bpInterface;
    settings.mObjectVsBroadPhaseLayerFilter = objVsBpFilter;

    this.joltInterface = new jolt.JoltInterface(settings);
    jolt.destroy(bpNonMoving);
    jolt.destroy(bpMoving);
    jolt.destroy(settings);

    this.physicsSystem = this.joltInterface.GetPhysicsSystem();
    this.bodyInterface = this.physicsSystem.GetBodyInterface();
    this.tempAllocator = this.joltInterface.GetTempAllocator();

    // Pre-allocate one persistent static terrain BodyID per world slot backed by a shared EmptyShape.
    // Warm up PhysicsMaterial::sDefault & NotifyShapeChanged once so every simulation lifecycle leaks exact 0 B.
    const warmup = new jolt.SphereShape(0.5);
    warmup.AddRef();
    warmup.Release();

    this.emptyTerrainShape = new jolt.EmptyShape();
    this.emptyTerrainShape.AddRef();
    const zeroPos = new jolt.RVec3(0, 0, 0);
    const zeroVec = new jolt.Vec3(0, 0, 0);
    const idQuat = new jolt.Quat(0, 0, 0, 1);

    for (let slot = 0; slot < this.maxWorldSlots; slot++) {
      const bcs = new jolt.BodyCreationSettings(
        this.emptyTerrainShape,
        zeroPos,
        idQuat,
        jolt.EMotionType_Static,
        slot * 2,
      );
      const body = this.bodyInterface.CreateBody(bcs);
      const bid = new jolt.BodyID(body.GetID().GetIndexAndSequenceNumber());
      jolt.destroy(bcs);
      this.bodyInterface.AddBody(bid, jolt.EActivation_DontActivate);
      this.bodyInterface.NotifyShapeChanged(bid, zeroVec, false, jolt.EActivation_DontActivate);
      this.slotTerrainBodyIds.push(bid);
    }

    jolt.destroy(zeroPos);
    jolt.destroy(zeroVec);
    jolt.destroy(idQuat);
    this.physicsSystem.OptimizeBroadPhase();

    for (let slot = this.maxWorldSlots - 1; slot >= 0; slot--) {
      this.freeSlots.push(slot);
    }
  }

  acquireWorldSlot(): JoltWorldSlot {
    if (this.disposed) {
      throw new Error('Cannot acquire Jolt world slot from a disposed JoltRuntime');
    }
    const slotIndex = this.freeSlots.pop();
    if (slotIndex === undefined) {
      throw new Error(
        `JoltRuntime exhausted all ${this.maxWorldSlots} world slots — call sim.dispose() on finished simulations`,
      );
    }
    return {
      slotIndex,
      staticLayer: slotIndex * 2,
      movingLayer: slotIndex * 2 + 1,
      terrainBodyId: this.slotTerrainBodyIds[slotIndex]!,
    };
  }

  releaseWorldSlot(slot: JoltWorldSlot): void {
    if (this.disposed) return;
    this.bodyInterface.SetShape(
      slot.terrainBodyId,
      this.emptyTerrainShape,
      false,
      this.jolt.EActivation_DontActivate,
    );
    if (!this.freeSlots.includes(slot.slotIndex)) {
      this.freeSlots.push(slot.slotIndex);
    }
  }

  getActiveWorldSlotCount(): number {
    return this.maxWorldSlots - this.freeSlots.length;
  }

  getFreeMemory(): number {
    return this.jolt.JoltInterface.prototype.sGetFreeMemory();
  }

  getTotalMemory(): number {
    return this.jolt.JoltInterface.prototype.sGetTotalMemory();
  }

  getUsedMemory(): number {
    return this.getTotalMemory() - this.getFreeMemory();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < this.slotTerrainBodyIds.length; i++) {
      const bid = this.slotTerrainBodyIds[i]!;
      if (this.bodyInterface.IsAdded(bid)) {
        this.bodyInterface.RemoveBody(bid);
      }
      this.bodyInterface.DestroyBody(bid);
      this.jolt.destroy(bid);
    }
    this.slotTerrainBodyIds.length = 0;
    this.emptyTerrainShape.Release();
    this.freeSlots.length = 0;
    this.jolt.destroy(this.joltInterface);
  }
}

let defaultPhysicsRuntime: JoltRuntime | null = null;

/**
 * Registers a process-wide default `JoltRuntime` (used by test setups so synchronous
 * `new SkiSimulation()` calls work without explicit wiring while keeping zero singletons).
 */
export function setDefaultPhysicsRuntime(runtime: JoltRuntime | null): void {
  defaultPhysicsRuntime = runtime;
}

export function resolveDefaultPhysicsRuntime(): JoltRuntime | null {
  return defaultPhysicsRuntime;
}
