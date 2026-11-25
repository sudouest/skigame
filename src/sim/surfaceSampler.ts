import { clamp, lerp } from '../core/math';
import {
  createActiveTrackProjectionOut,
  createMountainSampleOut,
  type ActiveTrackProjectionOut,
  type ActiveTrackProjector,
  type MountainFieldView,
  type MountainSampleOut,
  type SpineView,
  type SurfaceQueryView,
  type SurfaceSample,
} from './contracts';

const SPINE_CACHE_RADIUS_M = 10;
const SPINE_CACHE_PAD_M = 330; // > 310m + 10*sqrt(2) = 324.1m -> exact superset of MountainField.evaluate()!

/**
 * Acyclic zero-allocation surface query composer bridging `ActiveTrackProjector`
 * (4-slot gameplay topology) and `MountainFieldView` (continuous heightfield/normals/chasm).
 */
export class MountainSurfaceSampler implements SurfaceQueryView {
  private readonly trackProjector: ActiveTrackProjector;
  private readonly mountainField: MountainFieldView;

  private readonly activeTrackScratch: ActiveTrackProjectionOut = createActiveTrackProjectionOut();
  private readonly mountainScratch: MountainSampleOut = createMountainSampleOut();
  private readonly spinesCache: SpineView[] = [];
  private spinesCacheValid = false;
  private spinesCacheX = 0;
  private spinesCacheZ = 0;
  private spinesCacheOx = 0;
  private spinesCacheOz = 0;
  private spinesCacheRev = -1;

  constructor(trackProjector: ActiveTrackProjector, mountainField: MountainFieldView) {
    this.trackProjector = trackProjector;
    this.mountainField = mountainField;
  }

  evaluateHeight(wx: number, wz: number): number {
    return this.mountainField.evaluateHeight(wx, wz);
  }

  sampleSurface(
    posX: number,
    posZ: number,
    hintSegmentId: number,
    hintS: number,
    out: SurfaceSample,
  ): SurfaceSample {
    const activeTrack = this.trackProjector.projectActiveWindow(
      posX,
      posZ,
      hintSegmentId,
      hintS,
      this.activeTrackScratch,
    );

    let candidateSpines: readonly SpineView[] | undefined;
    const rev = this.mountainField.fieldRevision;
    if (typeof rev === 'number') {
      const ox = this.mountainField.originOffsetX;
      const oz = this.mountainField.originOffsetZ;
      if (
        !this.spinesCacheValid ||
        rev !== this.spinesCacheRev ||
        ox !== this.spinesCacheOx ||
        oz !== this.spinesCacheOz ||
        Math.abs(posX - this.spinesCacheX) > SPINE_CACHE_RADIUS_M ||
        Math.abs(posZ - this.spinesCacheZ) > SPINE_CACHE_RADIUS_M
      ) {
        this.spinesCache.length = 0;
        this.mountainField.collectSpinesInBounds(
          posX - 1,
          posX + 1,
          posZ - 1,
          posZ + 1,
          SPINE_CACHE_PAD_M,
          this.spinesCache,
        );
        this.spinesCacheValid = true;
        this.spinesCacheX = posX;
        this.spinesCacheZ = posZ;
        this.spinesCacheOx = ox;
        this.spinesCacheOz = oz;
        this.spinesCacheRev = rev;
      }
      if (this.spinesCache.length > 0) {
        candidateSpines = this.spinesCache;
      }
    }

    const m = this.mountainField.evaluate(posX, posZ, this.mountainScratch, candidateSpines);

    if (activeTrack.valid) {
      out.segmentId = activeTrack.segmentId;
      out.s = activeTrack.s;
      out.x = activeTrack.x;
      out.halfWidth = activeTrack.halfWidth;
    } else {
      out.segmentId = m.nearestSegmentId;
      out.s = m.nearestS;
      out.x = m.nearestSignedX;
      out.halfWidth = m.nearestHalfWidth;
    }

    out.groundY = m.heightY;
    out.macroY = m.macroY;
    out.normalX = m.normalX;
    out.normalY = m.normalY;
    out.normalZ = m.normalZ;
    out.surfaceType = m.surfaceType;
    out.onPiste = m.onPiste;
    out.pisteWeight = m.pisteWeight;
    out.inDivider = m.inDivider;
    out.inChasmZone = m.inChasmZone;
    out.chasmWipeoutDepth = m.chasmWipeoutDepth;
    out.chasmRelief = m.chasmRelief;
    out.nearestSpineY = m.nearestSpineY;
    out.valid = true;

    const offPisteBlend = clamp(1 - m.pisteWeight, 0, 1);
    if (!activeTrack.valid) {
      out.tangentX = m.downhillX;
      out.tangentY = m.downhillY;
      out.tangentZ = m.downhillZ;
    } else {
      const tx = lerp(activeTrack.tangentX, m.downhillX, offPisteBlend);
      const ty = lerp(activeTrack.tangentY, m.downhillY, offPisteBlend);
      const tz = lerp(activeTrack.tangentZ, m.downhillZ, offPisteBlend);
      const tLen = Math.hypot(tx, ty, tz);
      if (tLen <= 1e-6) {
        out.tangentX = m.downhillX;
        out.tangentY = m.downhillY;
        out.tangentZ = m.downhillZ;
      } else {
        const invLen = 1 / tLen;
        out.tangentX = tx * invLen;
        out.tangentY = ty * invLen;
        out.tangentZ = tz * invLen;
      }
    }

    // Compute true local steepest-descent unit vector (-grad H projected onto local tangent plane)
    const nx = out.normalX;
    const ny = out.normalY;
    const nz = out.normalZ;
    const fx = nx * ny;
    const fy = -(1 - ny * ny);
    const fz = nz * ny;
    const fLen = Math.hypot(fx, fy, fz);
    if (fLen > 1e-4) {
      const invF = 1 / fLen;
      out.fallLineX = fx * invF;
      out.fallLineY = fy * invF;
      out.fallLineZ = fz * invF;
    } else {
      out.fallLineX = out.tangentX;
      out.fallLineY = out.tangentY;
      out.fallLineZ = out.tangentZ;
    }

    return out;
  }
}
