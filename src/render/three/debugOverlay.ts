import * as THREE from 'three';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';

const MAX_LINE_VERTICES = 4096;
const MAX_COLLIDERS = 160;
const MAX_DELIVERY_RINGS = 32;
const CIRCLE_SEGMENTS = 16;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _colSafe = new THREE.Color('#22c55e');
const _colStumble = new THREE.Color('#f59e0b');
const _colLethal = new THREE.Color('#ef4444');
const _colCreature = new THREE.Color('#e879f9');
const _colDelivery = new THREE.Color('#facc15');
const _colFork = new THREE.Color('#fb923c');
const _colChunk = new THREE.Color('#38bdf8');
const _colNormal = new THREE.Color('#4ade80');
const _colDownhill = new THREE.Color('#60a5fa');
const _colVelocity = new THREE.Color('#fde047');

/**
 * Dev-mode visualizer rendering `DebugDrawView` buffers (`safeX(s)` path, collider cylinders/heights,
 * delivery radii, fork V-wedges, chunk boundaries, and skier surface/velocity vectors)
 * with zero per-frame allocations.
 */
export class DebugOverlay3D {
  readonly rootGroup: THREE.Group;

  private readonly linePositions: Float32Array;
  private readonly lineColors: Float32Array;
  private readonly linePosAttr: THREE.BufferAttribute;
  private readonly lineColAttr: THREE.BufferAttribute;
  private readonly lineGeometry: THREE.BufferGeometry;
  private readonly lineSegments: THREE.Line;

  private readonly colliderCylinders: THREE.InstancedMesh;
  private readonly deliveryRings: THREE.InstancedMesh;
  private lineVertCount = 0;

  constructor(gfx: GraphicsUtils) {
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'DebugOverlay3DRoot';
    this.rootGroup.visible = false;

    this.linePositions = new Float32Array(MAX_LINE_VERTICES * 3);
    this.lineColors = new Float32Array(MAX_LINE_VERTICES * 3);
    this.linePosAttr = new THREE.BufferAttribute(this.linePositions, 3);
    this.linePosAttr.setUsage(THREE.DynamicDrawUsage);
    this.lineColAttr = new THREE.BufferAttribute(this.lineColors, 3);
    this.lineColAttr.setUsage(THREE.DynamicDrawUsage);

    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.name = 'DebugLinesGeo';
    this.lineGeometry.setAttribute('position', this.linePosAttr);
    this.lineGeometry.setAttribute('color', this.lineColAttr);

    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: true,
      transparent: true,
      opacity: 0.92,
    });
    lineMat.name = 'DebugLineMaterial';
    gfx.markAsCache(lineMat, 'DebugLineMaterial');

    this.lineSegments = gfx.createLine(this.lineGeometry, lineMat, 'DebugLinesMesh', true);
    this.lineSegments.frustumCulled = false;
    this.rootGroup.add(this.lineSegments);

    // Unit open-ended wireframe-like collider cylinder (radius 1, height 1, bottom at y = 0)
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    cylGeo.translate(0, 0.5, 0);
    cylGeo.name = 'DebugColliderCylGeo';
    gfx.markAsCache(cylGeo, 'DebugColliderCylGeo');

    const cylMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.65,
    });
    cylMat.name = 'DebugColliderMat';
    gfx.markAsCache(cylMat, 'DebugColliderMat');

    this.colliderCylinders = gfx.createInstancedMesh(
      cylGeo,
      cylMat,
      MAX_COLLIDERS,
      'DebugColliderCylinders',
    );
    this.colliderCylinders.frustumCulled = false;
    this.colliderCylinders.count = 0;
    this.rootGroup.add(this.colliderCylinders);

    // Unit ground ring for Delivery Zones & fork noses
    const ringGeo = new THREE.RingGeometry(0.92, 1.0, CIRCLE_SEGMENTS);
    ringGeo.rotateX(-Math.PI * 0.5);
    ringGeo.name = 'DebugDeliveryRingGeo';
    gfx.markAsCache(ringGeo, 'DebugDeliveryRingGeo');

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
    });
    ringMat.name = 'DebugDeliveryRingMat';
    gfx.markAsCache(ringMat, 'DebugDeliveryRingMat');

    this.deliveryRings = gfx.createInstancedMesh(
      ringGeo,
      ringMat,
      MAX_DELIVERY_RINGS,
      'DebugDeliveryRings',
    );
    this.deliveryRings.frustumCulled = false;
    this.deliveryRings.count = 0;
    this.rootGroup.add(this.deliveryRings);
  }

  private pushSegment(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    col: THREE.Color,
  ): void {
    if (this.lineVertCount + 2 > MAX_LINE_VERTICES) return;
    const b = this.lineVertCount * 3;
    this.linePositions[b] = x0;
    this.linePositions[b + 1] = y0;
    this.linePositions[b + 2] = z0;
    this.linePositions[b + 3] = x1;
    this.linePositions[b + 4] = y1;
    this.linePositions[b + 5] = z1;

    this.lineColors[b] = col.r;
    this.lineColors[b + 1] = col.g;
    this.lineColors[b + 2] = col.b;
    this.lineColors[b + 3] = col.r;
    this.lineColors[b + 4] = col.g;
    this.lineColors[b + 5] = col.b;
    this.lineVertCount += 2;
  }

  sync(simState: ReadonlySimState): void {
    const dbg = simState.debugDraw;
    if (!dbg.enabled) {
      this.rootGroup.visible = false;
      return;
    }
    this.rootGroup.visible = true;

    this.lineVertCount = 0;

    // 1. safeX(s) spline polyline (break across segment IDs so fork branches stay separate)
    const safePts = dbg.safePathPoints;
    const safeSegIds = dbg.safePathSegmentIds;
    for (let i = 0; i < dbg.safePathPointCount - 1; i++) {
      if (safeSegIds[i] !== safeSegIds[i + 1]) continue;
      const a = i * 3;
      const b = (i + 1) * 3;
      this.pushSegment(
        safePts[a]!,
        safePts[a + 1]! + 0.15,
        safePts[a + 2]!,
        safePts[b]!,
        safePts[b + 1]! + 0.15,
        safePts[b + 2]!,
        _colSafe,
      );
    }

    // 2. Fork V-wedges
    for (let i = 0; i < dbg.forkCount; i++) {
      const a = i * 3;
      const ax = dbg.forkApexPositions[a]!;
      const ay = dbg.forkApexPositions[a + 1]! + 0.25;
      const az = dbg.forkApexPositions[a + 2]!;
      this.pushSegment(
        ax,
        ay,
        az,
        dbg.forkLeftTargets[a]!,
        dbg.forkLeftTargets[a + 1]! + 0.25,
        dbg.forkLeftTargets[a + 2]!,
        _colFork,
      );
      this.pushSegment(
        ax,
        ay,
        az,
        dbg.forkRightTargets[a]!,
        dbg.forkRightTargets[a + 1]! + 0.25,
        dbg.forkRightTargets[a + 2]!,
        _colFork,
      );
    }

    // 3. Chunk boundaries
    for (let i = 0; i < dbg.chunkBoundaryCount; i++) {
      const b = i * 6;
      this.pushSegment(
        dbg.chunkBoundaryLines[b]!,
        dbg.chunkBoundaryLines[b + 1]! + 0.12,
        dbg.chunkBoundaryLines[b + 2]!,
        dbg.chunkBoundaryLines[b + 3]!,
        dbg.chunkBoundaryLines[b + 4]! + 0.12,
        dbg.chunkBoundaryLines[b + 5]!,
        _colChunk,
      );
    }

    // 4. Skier vectors (surface normal, downhill tangent, velocity)
    if (dbg.skierPos.length >= 3) {
      const sx = dbg.skierPos[0]!;
      const sy = dbg.skierPos[1]! + 0.15;
      const sz = dbg.skierPos[2]!;
      if (dbg.skierNormal.length >= 3) {
        this.pushSegment(
          sx,
          sy,
          sz,
          sx + dbg.skierNormal[0]! * 2.5,
          sy + dbg.skierNormal[1]! * 2.5,
          sz + dbg.skierNormal[2]! * 2.5,
          _colNormal,
        );
      }
      if (dbg.skierDownhill.length >= 3) {
        this.pushSegment(
          sx,
          sy,
          sz,
          sx + dbg.skierDownhill[0]! * 4,
          sy + dbg.skierDownhill[1]! * 4,
          sz + dbg.skierDownhill[2]! * 4,
          _colDownhill,
        );
      }
      if (dbg.skierVelocity.length >= 3) {
        this.pushSegment(
          sx,
          sy,
          sz,
          sx + dbg.skierVelocity[0]! * 0.25,
          sy + dbg.skierVelocity[1]! * 0.25,
          sz + dbg.skierVelocity[2]! * 0.25,
          _colVelocity,
        );
      }
    }

    // 4b. Solid structure oriented bounding boxes (12 edges in red/lethal)
    const structures = simState.entities.structures;
    for (let i = 0; i < structures.count; i++) {
      const cx = structures.posX[i]!;
      const cy = structures.posY[i]!;
      const cz = structures.posZ[i]!;
      const yaw = structures.yawRad[i]!;
      const hw = structures.halfWidth[i]!;
      const hd = structures.halfDepth[i]!;
      const topY = cy + structures.height[i]!;
      const botY = cy - structures.skirtDepth[i]!;

      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);

      // Local corners rotated around +Y: worldX = cx + lx*cosY + lz*sinY, worldZ = cz - lx*sinY + lz*cosY
      const x00 = cx + (-hw * cosY + -hd * sinY);
      const z00 = cz + (hw * sinY + -hd * cosY);
      const x10 = cx + (hw * cosY + -hd * sinY);
      const z10 = cz + (-hw * sinY + -hd * cosY);
      const x11 = cx + (hw * cosY + hd * sinY);
      const z11 = cz + (-hw * sinY + hd * cosY);
      const x01 = cx + (-hw * cosY + hd * sinY);
      const z01 = cz + (hw * sinY + hd * cosY);

      // Bottom loop
      this.pushSegment(x00, botY, z00, x10, botY, z10, _colLethal);
      this.pushSegment(x10, botY, z10, x11, botY, z11, _colLethal);
      this.pushSegment(x11, botY, z11, x01, botY, z01, _colLethal);
      this.pushSegment(x01, botY, z01, x00, botY, z00, _colLethal);
      // Top loop
      this.pushSegment(x00, topY, z00, x10, topY, z10, _colLethal);
      this.pushSegment(x10, topY, z10, x11, topY, z11, _colLethal);
      this.pushSegment(x11, topY, z11, x01, topY, z01, _colLethal);
      this.pushSegment(x01, topY, z01, x00, topY, z00, _colLethal);
      // Vertical pillars
      this.pushSegment(x00, botY, z00, x00, topY, z00, _colLethal);
      this.pushSegment(x10, botY, z10, x10, topY, z10, _colLethal);
      this.pushSegment(x11, botY, z11, x11, topY, z11, _colLethal);
      this.pushSegment(x01, botY, z01, x01, topY, z01, _colLethal);
    }

    this.linePosAttr.needsUpdate = true;
    this.lineColAttr.needsUpdate = true;
    this.lineGeometry.setDrawRange(0, this.lineVertCount);

    // 5. Collider cylinders & jump heights
    const colCount = Math.min(dbg.colliderCount, MAX_COLLIDERS);
    for (let i = 0; i < colCount; i++) {
      const p = i * 3;
      const r = Math.max(0.1, dbg.colliderRadii[i]!);
      const h = Math.max(0.2, dbg.colliderHeights[i]!);
      _pos.set(dbg.colliderPositions[p]!, dbg.colliderPositions[p + 1]!, dbg.colliderPositions[p + 2]!);
      _quat.identity();
      _scale.set(r, h, r);
      _mat4.compose(_pos, _quat, _scale);
      this.colliderCylinders.setMatrixAt(i, _mat4);

      const kind = dbg.colliderKinds[i]!;
      this.colliderCylinders.setColorAt(
        i,
        kind === 2 ? _colCreature : kind === 1 ? _colLethal : _colStumble,
      );
    }
    this.colliderCylinders.count = colCount;
    if (colCount > 0) {
      this.colliderCylinders.instanceMatrix.needsUpdate = true;
      if (this.colliderCylinders.instanceColor) {
        this.colliderCylinders.instanceColor.needsUpdate = true;
      }
    }

    // 6. Delivery zone circles + fork apex soft nose rings
    let ringCount = 0;
    for (let i = 0; i < dbg.deliveryZoneCount && ringCount < MAX_DELIVERY_RINGS; i++) {
      const p = i * 3;
      const r = Math.max(0.5, dbg.deliveryRadii[i]!);
      _pos.set(
        dbg.deliveryPositions[p]!,
        dbg.deliveryPositions[p + 1]! + 0.14,
        dbg.deliveryPositions[p + 2]!,
      );
      _quat.identity();
      _scale.set(r, 1, r);
      _mat4.compose(_pos, _quat, _scale);
      this.deliveryRings.setMatrixAt(ringCount, _mat4);
      this.deliveryRings.setColorAt(ringCount, _colDelivery);
      ringCount++;
    }
    for (let i = 0; i < dbg.forkCount && ringCount < MAX_DELIVERY_RINGS; i++) {
      const p = i * 3;
      const r = Math.max(0.5, dbg.forkNoseRadii[i]!);
      _pos.set(
        dbg.forkApexPositions[p]!,
        dbg.forkApexPositions[p + 1]! + 0.18,
        dbg.forkApexPositions[p + 2]!,
      );
      _quat.identity();
      _scale.set(r, 1, r);
      _mat4.compose(_pos, _quat, _scale);
      this.deliveryRings.setMatrixAt(ringCount, _mat4);
      this.deliveryRings.setColorAt(ringCount, _colFork);
      ringCount++;
    }

    this.deliveryRings.count = ringCount;
    if (ringCount > 0) {
      this.deliveryRings.instanceMatrix.needsUpdate = true;
      if (this.deliveryRings.instanceColor) {
        this.deliveryRings.instanceColor.needsUpdate = true;
      }
    }
  }
}
