import * as THREE from 'three';
import {
  GraphicsTracker,
  RenderableObject3D,
  isRenderableObject3D,
} from './graphicsTracker';

export type CacheableTarget =
  | THREE.BufferGeometry
  | THREE.Material
  | THREE.Texture
  | THREE.Object3D;

/**
 * Mandatory factory & lifecycle wrapper for Three.js objects and GPU resources.
 * Ensures every Mesh, InstancedMesh, Line, Points, Geometry, Material, and Texture
 * is tracked and reference-counted through GraphicsTracker.
 */
export class GraphicsUtils {
  readonly tracker: GraphicsTracker;

  constructor(tracker: GraphicsTracker) {
    this.tracker = tracker;
  }

  createMesh<
    TGeometry extends THREE.BufferGeometry = THREE.BufferGeometry,
    TMaterial extends THREE.Material | THREE.Material[] = THREE.Material | THREE.Material[],
  >(
    geometry: TGeometry,
    material: TMaterial,
    label = 'Mesh',
  ): THREE.Mesh<TGeometry, TMaterial> {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = label;
    this.tracker.registerObject(mesh, label);
    return mesh;
  }

  createInstancedMesh<
    TGeometry extends THREE.BufferGeometry = THREE.BufferGeometry,
    TMaterial extends THREE.Material | THREE.Material[] = THREE.Material | THREE.Material[],
  >(
    geometry: TGeometry,
    material: TMaterial,
    count: number,
    label = 'InstancedMesh',
  ): THREE.InstancedMesh<TGeometry, TMaterial> {
    const instanced = new THREE.InstancedMesh(geometry, material, count);
    instanced.name = label;
    instanced.frustumCulled = false;
    this.tracker.registerObject(instanced, label);
    return instanced;
  }

  createLine<
    TGeometry extends THREE.BufferGeometry = THREE.BufferGeometry,
    TMaterial extends THREE.Material | THREE.Material[] = THREE.Material | THREE.Material[],
  >(
    geometry: TGeometry,
    material: TMaterial,
    label = 'Line',
    segments = false,
  ): THREE.Line<TGeometry, TMaterial> {
    const line = segments
      ? new THREE.LineSegments(geometry, material)
      : new THREE.Line(geometry, material);
    line.name = label;
    this.tracker.registerObject(line, label);
    return line;
  }

  createPoints<
    TGeometry extends THREE.BufferGeometry = THREE.BufferGeometry,
    TMaterial extends THREE.Material | THREE.Material[] = THREE.Material | THREE.Material[],
  >(
    geometry: TGeometry,
    material: TMaterial,
    label = 'Points',
  ): THREE.Points<TGeometry, TMaterial> {
    const points = new THREE.Points(geometry, material);
    points.name = label;
    this.tracker.registerObject(points, label);
    return points;
  }

  registerObject<T extends THREE.Object3D>(object: T, label?: string): T {
    this.tracker.registerObject(object, label);
    return object;
  }

  registerGeometry<T extends THREE.BufferGeometry>(geometry: T, label?: string): T {
    this.tracker.acquireGeometry(geometry, label);
    return geometry;
  }

  registerMaterial<T extends THREE.Material>(material: T, label?: string): T {
    this.tracker.acquireMaterial(material, label);
    return material;
  }

  registerTexture<T extends THREE.Texture>(texture: T, label?: string): T {
    this.tracker.acquireTexture(texture, label);
    return texture;
  }

  /**
   * Clones an Object3D hierarchy without cloning GPU geometries or materials,
   * registering all newly created renderable nodes with GraphicsTracker.
   */
  cloneObject<T extends THREE.Object3D>(source: T, label?: string): T {
    const clone = this.cloneNodeRecursive(source, label);
    return clone as T;
  }

  assignMaterial(
    object: RenderableObject3D,
    material: THREE.Material | THREE.Material[],
  ): void {
    this.tracker.assignMaterial(object, material);
  }

  assignGeometry(object: RenderableObject3D, geometry: THREE.BufferGeometry): void {
    this.tracker.assignGeometry(object, geometry);
  }

  markAsCache<T extends CacheableTarget>(target: T, label?: string): T {
    if ((target as THREE.BufferGeometry).isBufferGeometry) {
      this.tracker.markGeometryAsCache(target as THREE.BufferGeometry, label);
      return target;
    }
    if ((target as THREE.Material).isMaterial) {
      this.tracker.markMaterialAsCache(target as THREE.Material, label);
      return target;
    }
    if ((target as THREE.Texture).isTexture) {
      this.tracker.markTextureAsCache(target as THREE.Texture, label);
      return target;
    }
    this.tracker.markObjectAsCache(target as THREE.Object3D, label);
    return target;
  }

  disposeObject(object: THREE.Object3D): void {
    this.tracker.disposeObject(object);
  }

  private cloneNodeRecursive(source: THREE.Object3D, labelOverride?: string): THREE.Object3D {
    const nodeLabel = labelOverride ?? (source.name || source.type);
    let cloned: THREE.Object3D;

    if ((source as THREE.InstancedMesh).isInstancedMesh) {
      const srcInst = source as THREE.InstancedMesh;
      const maxCount = srcInst.instanceMatrix.count;
      const inst = this.createInstancedMesh(srcInst.geometry, srcInst.material, maxCount, nodeLabel);
      inst.count = srcInst.count;
      inst.instanceMatrix.copy(srcInst.instanceMatrix);
      inst.instanceMatrix.needsUpdate = true;
      if (srcInst.instanceColor) {
        inst.instanceColor = new THREE.InstancedBufferAttribute(
          new Float32Array(srcInst.instanceColor.array),
          srcInst.instanceColor.itemSize,
        );
      }
      cloned = inst;
    } else if ((source as THREE.Mesh).isMesh) {
      const srcMesh = source as THREE.Mesh;
      cloned = this.createMesh(srcMesh.geometry, srcMesh.material, nodeLabel);
    } else if ((source as THREE.LineSegments).isLineSegments) {
      const srcLine = source as THREE.LineSegments;
      cloned = this.createLine(srcLine.geometry, srcLine.material, nodeLabel, true);
    } else if ((source as THREE.Line).isLine) {
      const srcLine = source as THREE.Line;
      cloned = this.createLine(srcLine.geometry, srcLine.material, nodeLabel, false);
    } else if ((source as THREE.Points).isPoints) {
      const srcPts = source as THREE.Points;
      cloned = this.createPoints(srcPts.geometry, srcPts.material, nodeLabel);
    } else {
      cloned = new THREE.Group();
      cloned.name = nodeLabel;
    }

    cloned.position.copy(source.position);
    cloned.rotation.copy(source.rotation);
    cloned.scale.copy(source.scale);
    cloned.visible = source.visible;
    cloned.castShadow = source.castShadow;
    cloned.receiveShadow = source.receiveShadow;
    cloned.renderOrder = source.renderOrder;
    cloned.frustumCulled = isRenderableObject3D(cloned) && (cloned as THREE.InstancedMesh).isInstancedMesh
      ? false
      : source.frustumCulled;

    for (let i = 0; i < source.children.length; i++) {
      const child = source.children[i];
      if (!child) continue;
      cloned.add(this.cloneNodeRecursive(child));
    }

    return cloned;
  }
}
