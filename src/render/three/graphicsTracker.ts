import * as THREE from 'three';

export type TrackedObjectKind = 'Mesh' | 'InstancedMesh' | 'Line' | 'Points';
export type TrackedResourceKind = 'BufferGeometry' | 'Material' | 'Texture';

export interface GraphicsTrackerOptions {
  readonly nowSec?: () => number;
}

interface ResourceEntry {
  refCount: number;
  cached: boolean;
  label: string;
  createdAtSec: number;
  snapshotSeenCount: number;
}

interface ObjectEntry {
  kind: TrackedObjectKind;
  label: string;
  geometry: THREE.BufferGeometry | null;
  materials: THREE.Material[];
  cached: boolean;
  createdAtSec: number;
  snapshotSeenCount: number;
}

export interface LeakEntry {
  readonly kind: TrackedObjectKind | TrackedResourceKind;
  readonly label: string;
  readonly ageSec: number;
  readonly refCount: number;
  readonly snapshotSeenCount: number;
}

export interface UntrackedObjectLeak {
  readonly kind: TrackedObjectKind;
  readonly name: string;
  readonly type: string;
}

export interface LeakReport {
  readonly detachedObjects: readonly LeakEntry[];
  readonly uncollectedResources: readonly LeakEntry[];
  readonly untrackedSceneObjects: readonly UntrackedObjectLeak[];
  readonly totalLeaks: number;
  readonly persistingAcrossSnapshots: number;
}

export interface GraphicsTrackerStats {
  readonly activeGeometries: number;
  readonly cachedGeometries: number;
  readonly activeMaterials: number;
  readonly cachedMaterials: number;
  readonly activeTextures: number;
  readonly cachedTextures: number;
  readonly activeObjects: number;
  readonly cachedObjects: number;
  readonly totalRefCount: number;
  readonly disposedGeometries: number;
  readonly disposedMaterials: number;
  readonly disposedTextures: number;
  readonly peakObjects: number;
}

const MATERIAL_TEXTURE_FIELDS = [
  'map',
  'gradientMap',
  'alphaMap',
  'aoMap',
  'lightMap',
  'bumpMap',
  'normalMap',
  'displacementMap',
  'emissiveMap',
  'roughnessMap',
  'metalnessMap',
  'specularMap',
  'envMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'iridescenceMap',
  'sheenColorMap',
  'specularColorMap',
  'thicknessMap',
  'transmissionMap',
] as const;

export type RenderableObject3D =
  | THREE.Mesh
  | THREE.InstancedMesh
  | THREE.Line
  | THREE.Points;

export function getTrackedObjectKind(obj: THREE.Object3D): TrackedObjectKind | null {
  if ((obj as THREE.InstancedMesh).isInstancedMesh) return 'InstancedMesh';
  if ((obj as THREE.Mesh).isMesh) return 'Mesh';
  if ((obj as THREE.Line).isLine) return 'Line';
  if ((obj as THREE.Points).isPoints) return 'Points';
  return null;
}

export function isRenderableObject3D(obj: THREE.Object3D): obj is RenderableObject3D {
  return getTrackedObjectKind(obj) !== null;
}

export function collectMaterialTextures(
  material: THREE.Material,
  out: THREE.Texture[],
): void {
  out.length = 0;
  const record = material as unknown as Record<string, unknown>;
  for (let i = 0; i < MATERIAL_TEXTURE_FIELDS.length; i++) {
    const field = MATERIAL_TEXTURE_FIELDS[i]!;
    const value = record[field];
    if (value && (value as THREE.Texture).isTexture) {
      if (!out.includes(value as THREE.Texture)) {
        out.push(value as THREE.Texture);
      }
    }
  }

  const uniforms = record.uniforms as Record<string, { value?: unknown }> | undefined;
  if (uniforms && typeof uniforms === 'object') {
    for (const key in uniforms) {
      const uniform = uniforms[key];
      const val = uniform?.value;
      if (val && (val as THREE.Texture).isTexture) {
        if (!out.includes(val as THREE.Texture)) {
          out.push(val as THREE.Texture);
        }
      }
    }
  }

  const extraTextures = material.userData?.trackedTextures as unknown;
  if (Array.isArray(extraTextures)) {
    for (let i = 0; i < extraTextures.length; i++) {
      const val = extraTextures[i];
      if (val && (val as THREE.Texture).isTexture) {
        if (!out.includes(val as THREE.Texture)) {
          out.push(val as THREE.Texture);
        }
      }
    }
  }
}

function normalizeMaterialList(
  material: THREE.Material | THREE.Material[] | null | undefined,
  out: THREE.Material[],
): void {
  out.length = 0;
  if (!material) return;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) {
      const mat = material[i];
      if (mat) out.push(mat);
    }
  } else {
    out.push(material);
  }
}

/**
 * Reference-counted GPU resource and scene object tracker.
 * Prevents silent VRAM leaks across Geometries, Materials, Textures, and renderable Object3Ds.
 */
export class GraphicsTracker {
  private readonly nowSec: () => number;
  private readonly geometries = new Map<THREE.BufferGeometry, ResourceEntry>();
  private readonly materials = new Map<THREE.Material, ResourceEntry>();
  private readonly textures = new Map<THREE.Texture, ResourceEntry>();
  private readonly objects = new Map<THREE.Object3D, ObjectEntry>();

  private disposedGeometries = 0;
  private disposedMaterials = 0;
  private disposedTextures = 0;
  private peakObjects = 0;

  private readonly scratchTextures: THREE.Texture[] = [];
  private readonly scratchMaterials: THREE.Material[] = [];
  private readonly scratchSceneSet = new Set<THREE.Object3D>();
  private readonly scratchTraversalStack: THREE.Object3D[] = [];

  constructor(options: GraphicsTrackerOptions = {}) {
    this.nowSec = options.nowSec ?? (() => performance.now() * 0.001);
  }

  acquireGeometry(geometry: THREE.BufferGeometry, label = geometry.name || 'Geometry'): void {
    let entry = this.geometries.get(geometry);
    if (!entry) {
      entry = {
        refCount: 0,
        cached: false,
        label,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      };
      this.geometries.set(geometry, entry);
    }
    entry.refCount++;
  }

  releaseGeometry(geometry: THREE.BufferGeometry): void {
    const entry = this.geometries.get(geometry);
    if (!entry) return;
    if (entry.refCount > 0) {
      entry.refCount--;
    }
    if (entry.refCount <= 0 && !entry.cached) {
      geometry.dispose();
      this.geometries.delete(geometry);
      this.disposedGeometries++;
    }
  }

  acquireTexture(texture: THREE.Texture, label = texture.name || 'Texture'): void {
    let entry = this.textures.get(texture);
    if (!entry) {
      entry = {
        refCount: 0,
        cached: false,
        label,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      };
      this.textures.set(texture, entry);
    }
    entry.refCount++;
  }

  releaseTexture(texture: THREE.Texture): void {
    const entry = this.textures.get(texture);
    if (!entry) return;
    if (entry.refCount > 0) {
      entry.refCount--;
    }
    if (entry.refCount <= 0 && !entry.cached) {
      texture.dispose();
      this.textures.delete(texture);
      this.disposedTextures++;
    }
  }

  acquireMaterial(material: THREE.Material, label = material.name || material.type): void {
    let entry = this.materials.get(material);
    if (!entry) {
      entry = {
        refCount: 0,
        cached: false,
        label,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      };
      this.materials.set(material, entry);
    }
    entry.refCount++;

    collectMaterialTextures(material, this.scratchTextures);
    for (let i = 0; i < this.scratchTextures.length; i++) {
      const tex = this.scratchTextures[i]!;
      this.acquireTexture(tex, tex.name || `${label}:Texture`);
    }
  }

  releaseMaterial(material: THREE.Material): void {
    const entry = this.materials.get(material);
    if (!entry) return;

    collectMaterialTextures(material, this.scratchTextures);
    for (let i = 0; i < this.scratchTextures.length; i++) {
      this.releaseTexture(this.scratchTextures[i]!);
    }

    if (entry.refCount > 0) {
      entry.refCount--;
    }
    if (entry.refCount <= 0 && !entry.cached) {
      material.dispose();
      this.materials.delete(material);
      this.disposedMaterials++;
    }
  }

  registerObject(obj: THREE.Object3D, label?: string): void {
    this.scratchTraversalStack.length = 0;
    this.scratchTraversalStack.push(obj);

    while (this.scratchTraversalStack.length > 0) {
      const node = this.scratchTraversalStack.pop()!;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child) this.scratchTraversalStack.push(child);
      }

      const kind = getTrackedObjectKind(node);
      if (!kind || this.objects.has(node)) continue;

      const renderable = node as RenderableObject3D;
      const nodeLabel = label ?? (node.name || kind);
      const geometry = renderable.geometry ?? null;
      normalizeMaterialList(renderable.material, this.scratchMaterials);
      const materials = this.scratchMaterials.slice();

      if (geometry) {
        this.acquireGeometry(geometry, `${nodeLabel}:Geometry`);
      }
      for (let i = 0; i < materials.length; i++) {
        this.acquireMaterial(materials[i]!, `${nodeLabel}:Material`);
      }

      this.objects.set(node, {
        kind,
        label: nodeLabel,
        geometry,
        materials,
        cached: false,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      });

      if (this.objects.size > this.peakObjects) {
        this.peakObjects = this.objects.size;
      }
    }
  }

  assignMaterial(
    object: RenderableObject3D,
    newMaterial: THREE.Material | THREE.Material[],
  ): void {
    const entry = this.objects.get(object);
    normalizeMaterialList(newMaterial, this.scratchMaterials);
    const nextMaterials = this.scratchMaterials.slice();

    // Acquire new materials BEFORE releasing old ones so shared materials/textures never hit 0 transiently.
    const label = entry?.label ?? (object.name || object.type);
    for (let i = 0; i < nextMaterials.length; i++) {
      this.acquireMaterial(nextMaterials[i]!, `${label}:Material`);
    }

    if (entry) {
      for (let i = 0; i < entry.materials.length; i++) {
        this.releaseMaterial(entry.materials[i]!);
      }
      entry.materials = nextMaterials;
    } else {
      normalizeMaterialList(object.material, this.scratchMaterials);
      for (let i = 0; i < this.scratchMaterials.length; i++) {
        this.releaseMaterial(this.scratchMaterials[i]!);
      }
    }

    object.material = newMaterial;
  }

  assignGeometry(object: RenderableObject3D, newGeometry: THREE.BufferGeometry): void {
    const entry = this.objects.get(object);
    const label = entry?.label ?? (object.name || object.type);

    // Acquire new geometry BEFORE releasing old geometry in case both are identical.
    this.acquireGeometry(newGeometry, `${label}:Geometry`);

    if (entry) {
      if (entry.geometry) {
        this.releaseGeometry(entry.geometry);
      }
      entry.geometry = newGeometry;
    } else if (object.geometry) {
      this.releaseGeometry(object.geometry);
    }

    object.geometry = newGeometry;
  }

  markGeometryAsCache(geometry: THREE.BufferGeometry, label = geometry.name || 'CachedGeometry'): void {
    let entry = this.geometries.get(geometry);
    if (!entry) {
      entry = {
        refCount: 0,
        cached: true,
        label,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      };
      this.geometries.set(geometry, entry);
    } else {
      entry.cached = true;
    }
  }

  markTextureAsCache(texture: THREE.Texture, label = texture.name || 'CachedTexture'): void {
    let entry = this.textures.get(texture);
    if (!entry) {
      entry = {
        refCount: 0,
        cached: true,
        label,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      };
      this.textures.set(texture, entry);
    } else {
      entry.cached = true;
    }
  }

  markMaterialAsCache(material: THREE.Material, label = material.name || material.type): void {
    let entry = this.materials.get(material);
    if (!entry) {
      entry = {
        refCount: 0,
        cached: true,
        label,
        createdAtSec: this.nowSec(),
        snapshotSeenCount: 0,
      };
      this.materials.set(material, entry);
    } else {
      entry.cached = true;
    }

    collectMaterialTextures(material, this.scratchTextures);
    for (let i = 0; i < this.scratchTextures.length; i++) {
      const tex = this.scratchTextures[i]!;
      this.markTextureAsCache(tex, tex.name || `${label}:Texture`);
    }
  }

  markObjectAsCache(obj: THREE.Object3D, label?: string): void {
    this.registerObject(obj, label);
    this.scratchTraversalStack.length = 0;
    this.scratchTraversalStack.push(obj);

    while (this.scratchTraversalStack.length > 0) {
      const node = this.scratchTraversalStack.pop()!;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child) this.scratchTraversalStack.push(child);
      }

      const entry = this.objects.get(node);
      if (!entry) continue;
      entry.cached = true;
      if (entry.geometry) {
        this.markGeometryAsCache(entry.geometry, `${entry.label}:Geometry`);
      }
      for (let i = 0; i < entry.materials.length; i++) {
        this.markMaterialAsCache(entry.materials[i]!, `${entry.label}:Material`);
      }
    }
  }

  disposeObject(obj: THREE.Object3D): void {
    this.scratchTraversalStack.length = 0;
    this.scratchTraversalStack.push(obj);

    while (this.scratchTraversalStack.length > 0) {
      const node = this.scratchTraversalStack.pop()!;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child) this.scratchTraversalStack.push(child);
      }

      const entry = this.objects.get(node);
      if (!entry) continue;

      if (entry.geometry) {
        this.releaseGeometry(entry.geometry);
      }
      for (let i = 0; i < entry.materials.length; i++) {
        this.releaseMaterial(entry.materials[i]!);
      }

      if ((node as THREE.InstancedMesh).isInstancedMesh) {
        (node as THREE.InstancedMesh).dispose();
      }
      this.objects.delete(node);
    }

    if (obj.parent) {
      obj.removeFromParent();
    }
  }

  getGeometryRefCount(geometry: THREE.BufferGeometry): number {
    return this.geometries.get(geometry)?.refCount ?? 0;
  }

  getMaterialRefCount(material: THREE.Material): number {
    return this.materials.get(material)?.refCount ?? 0;
  }

  getTextureRefCount(texture: THREE.Texture): number {
    return this.textures.get(texture)?.refCount ?? 0;
  }

  isTracked(obj: THREE.Object3D): boolean {
    return this.objects.has(obj);
  }

  isCached(resource: THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.Object3D): boolean {
    if ((resource as THREE.BufferGeometry).isBufferGeometry) {
      return this.geometries.get(resource as THREE.BufferGeometry)?.cached ?? false;
    }
    if ((resource as THREE.Material).isMaterial) {
      return this.materials.get(resource as THREE.Material)?.cached ?? false;
    }
    if ((resource as THREE.Texture).isTexture) {
      return this.textures.get(resource as THREE.Texture)?.cached ?? false;
    }
    return this.objects.get(resource as THREE.Object3D)?.cached ?? false;
  }

  /**
   * Scans tracked objects/resources and an optional scene root for detached objects,
   * uncollected zero-ref resources, or untracked objects added directly to the scene graph.
   */
  checkLeaks(
    minAgeSec = 20,
    updateSnapshot = true,
    sceneRoot?: THREE.Object3D,
  ): LeakReport {
    const now = this.nowSec();
    const detachedObjects: LeakEntry[] = [];
    const uncollectedResources: LeakEntry[] = [];
    const untrackedSceneObjects: UntrackedObjectLeak[] = [];
    let persistingAcrossSnapshots = 0;

    this.scratchSceneSet.clear();
    if (sceneRoot) {
      this.scratchTraversalStack.length = 0;
      this.scratchTraversalStack.push(sceneRoot);
      while (this.scratchTraversalStack.length > 0) {
        const node = this.scratchTraversalStack.pop()!;
        this.scratchSceneSet.add(node);
        for (let i = 0; i < node.children.length; i++) {
          const child = node.children[i];
          if (child) this.scratchTraversalStack.push(child);
        }
        const kind = getTrackedObjectKind(node);
        if (kind && !this.objects.has(node)) {
          untrackedSceneObjects.push({
            kind,
            name: node.name || '(unnamed)',
            type: node.type,
          });
        }
      }
    }

    for (const [obj, entry] of this.objects) {
      if (entry.cached) continue;
      const ageSec = now - entry.createdAtSec;
      if (ageSec < minAgeSec) continue;

      const isDetached = sceneRoot ? !this.scratchSceneSet.has(obj) : obj.parent === null;
      if (isDetached) {
        if (updateSnapshot) {
          entry.snapshotSeenCount++;
        }
        if (entry.snapshotSeenCount >= 2) {
          persistingAcrossSnapshots++;
        }
        detachedObjects.push({
          kind: entry.kind,
          label: entry.label,
          ageSec,
          refCount: 1,
          snapshotSeenCount: entry.snapshotSeenCount,
        });
      }
    }

    const scanResourceMap = (
      kind: TrackedResourceKind,
      map: Map<THREE.BufferGeometry | THREE.Material | THREE.Texture, ResourceEntry>,
    ): void => {
      for (const [, entry] of map) {
        if (entry.cached || entry.refCount > 0) continue;
        const ageSec = now - entry.createdAtSec;
        if (ageSec < minAgeSec) continue;
        if (updateSnapshot) {
          entry.snapshotSeenCount++;
        }
        if (entry.snapshotSeenCount >= 2) {
          persistingAcrossSnapshots++;
        }
        uncollectedResources.push({
          kind,
          label: entry.label,
          ageSec,
          refCount: entry.refCount,
          snapshotSeenCount: entry.snapshotSeenCount,
        });
      }
    };

    scanResourceMap('BufferGeometry', this.geometries);
    scanResourceMap('Material', this.materials);
    scanResourceMap('Texture', this.textures);

    this.scratchSceneSet.clear();

    const totalLeaks =
      detachedObjects.length + uncollectedResources.length + untrackedSceneObjects.length;

    return {
      detachedObjects,
      uncollectedResources,
      untrackedSceneObjects,
      totalLeaks,
      persistingAcrossSnapshots,
    };
  }

  getStats(): GraphicsTrackerStats {
    let activeGeometries = 0;
    let cachedGeometries = 0;
    let totalRefCount = 0;
    for (const entry of this.geometries.values()) {
      if (entry.cached) cachedGeometries++;
      else activeGeometries++;
      totalRefCount += entry.refCount;
    }

    let activeMaterials = 0;
    let cachedMaterials = 0;
    for (const entry of this.materials.values()) {
      if (entry.cached) cachedMaterials++;
      else activeMaterials++;
      totalRefCount += entry.refCount;
    }

    let activeTextures = 0;
    let cachedTextures = 0;
    for (const entry of this.textures.values()) {
      if (entry.cached) cachedTextures++;
      else activeTextures++;
      totalRefCount += entry.refCount;
    }

    let activeObjects = 0;
    let cachedObjects = 0;
    for (const entry of this.objects.values()) {
      if (entry.cached) cachedObjects++;
      else activeObjects++;
    }

    return {
      activeGeometries,
      cachedGeometries,
      activeMaterials,
      cachedMaterials,
      activeTextures,
      cachedTextures,
      activeObjects,
      cachedObjects,
      totalRefCount,
      disposedGeometries: this.disposedGeometries,
      disposedMaterials: this.disposedMaterials,
      disposedTextures: this.disposedTextures,
      peakObjects: this.peakObjects,
    };
  }

  /**
   * Flags all tracked and cached textures and materials for GPU re-upload after WebGL context loss.
   */
  markAllForContextRestore(): void {
    for (const tex of this.textures.keys()) {
      tex.needsUpdate = true;
    }
    for (const mat of this.materials.keys()) {
      mat.needsUpdate = true;
    }
  }

  /**
   * Disposes all remaining tracked objects and cached resources on renderer shutdown.
   */
  disposeAll(): void {
    for (const [obj] of this.objects) {
      if ((obj as THREE.InstancedMesh).isInstancedMesh) {
        (obj as THREE.InstancedMesh).dispose();
      }
      if (obj.parent) {
        obj.removeFromParent();
      }
    }
    this.objects.clear();

    for (const [geo] of this.geometries) {
      geo.dispose();
      this.disposedGeometries++;
    }
    this.geometries.clear();

    for (const [mat] of this.materials) {
      mat.dispose();
      this.disposedMaterials++;
    }
    this.materials.clear();

    for (const [tex] of this.textures) {
      tex.dispose();
      this.disposedTextures++;
    }
    this.textures.clear();
  }
}
