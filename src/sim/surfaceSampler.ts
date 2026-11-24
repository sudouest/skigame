import { clamp, lerp } from '../core/math';
import {
  createActiveTrackProjectionOut,
  createMountainSampleOut,
  type ActiveTrackProjectionOut,
  type ActiveTrackProjector,
  type MountainFieldView,
  type MountainSampleOut,
  type SurfaceQueryView,
  type SurfaceSample,
} from './contracts';

/**
 * Acyclic zero-allocation surface query composer bridging `ActiveTrackProjector`
 * (4-slot gameplay topology) and `MountainFieldView` (continuous heightfield/normals/chasm).
 */
export class MountainSurfaceSampler implements SurfaceQueryView {
  private readonly trackProjector: ActiveTrackProjector;
  private readonly mountainField: MountainFieldView;

  private readonly activeTrackScratch: ActiveTrackProjectionOut = createActiveTrackProjectionOut();
  private readonly mountainScratch: MountainSampleOut = createMountainSampleOut();

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

    const m = this.mountainField.evaluate(posX, posZ, this.mountainScratch);

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
    out.normalX = m.normalX;
    out.normalY = m.normalY;
    out.normalZ = m.normalZ;
    out.surfaceType = m.surfaceType;
    out.onPiste = m.onPiste;
    out.pisteWeight = m.pisteWeight;
    out.inDivider = m.inDivider;
    out.inChasmZone = m.inChasmZone;
    out.chasmWipeoutDepth = m.chasmWipeoutDepth;
    out.nearestSpineY = m.nearestSpineY;
    out.valid = true;

    const offPisteBlend = clamp(1 - m.pisteWeight, 0, 1);
    if (!activeTrack.valid) {
      out.tangentX = m.downhillX;
      out.tangentY = m.downhillY;
      out.tangentZ = m.downhillZ;
      return out;
    }

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

    return out;
  }
}
