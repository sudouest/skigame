import { describe, expect, it } from 'vitest';
import { getAllStages } from '../../content/stages';
import { FIXED_DT } from '../../core/fixedLoop';
import { angleDelta, clamp } from '../../core/math';
import { createMutablePlayerIntent, createSurfaceSample } from '../contracts';
import { SkiSimulation } from '../skiSimulation';

describe('50 km Headless PCG & Simulation Soak Test', () => {
  it('simulates 50+ km across 100+ forks with zero safeX lethal overlaps, zero NaNs, O(1) counts, and Delivery Zone cadence', () => {
    const sim = new SkiSimulation({ seed: 2026, skierId: 'skier_alpine' });
    const intent = createMutablePlayerIntent();

    let forkCount = 0;
    const seenSegmentIds = new Set<number>();
    const seenStageIds = new Set<string>();
    const checkedHazardSegments = new Set<number>();
    const deliveryCadences: number[] = [];

    // Track delivery distance along each branch path via segment graph
    const segLastDeliveryS = new Map<number, number>();
    const segLengthMap = new Map<number, number>();

    let maxActiveHazards = 0;
    let maxActivePresents = 0;
    let maxActiveZones = 0;
    let maxActiveCreatures = 0;

    sim.eventBus.on('FORK_ENTERED', () => {
      forkCount++;
    });

    const sampleScratch = createSurfaceSample();
    const maxTicks = 180000;
    let lastCheckedSegmentId = -1;

    for (let tick = 0; tick < maxTicks; tick++) {
      const st = sim.getState();
      if (st.distanceM >= 50500 && forkCount >= 105) {
        break;
      }

      // Inspect newly baked segments for hard PCG invariants when segment window advances
      if (st.trailWindow.curr.id !== lastCheckedSegmentId) {
        lastCheckedSegmentId = st.trailWindow.curr.id;
        const windowSegs = [
          st.trailWindow.prev,
          st.trailWindow.curr,
          st.trailWindow.nextLeft,
          st.trailWindow.nextRight,
        ];
        for (let w = 0; w < windowSegs.length; w++) {
          const seg = windowSegs[w];
          if (!seg) continue;
          seenSegmentIds.add(seg.id);
          seenStageIds.add(seg.stageId);
          segLengthMap.set(seg.id, seg.length);

          if (!checkedHazardSegments.has(seg.id)) {
            checkedHazardSegments.add(seg.id);

            // Check all hazards belonging to this segment
            const hazards = st.entities.hazards;
            for (let i = 0; i < hazards.count; i++) {
              if (hazards.segmentIds[i] !== seg.id) continue;
              let bestDistSq = Infinity;
              let bestS = 0;
              const segPoly = seg as unknown as {
                polyCount: number;
                polyS: Float32Array;
                polyX: Float64Array;
                polyZ: Float64Array;
              };
              const hx = hazards.posX[i]!;
              const hz = hazards.posZ[i]!;
              for (let p = 0; p < segPoly.polyCount - 1; p++) {
                const ax = segPoly.polyX[p]!;
                const az = segPoly.polyZ[p]!;
                const bx = segPoly.polyX[p + 1]!;
                const bz = segPoly.polyZ[p + 1]!;
                const dx = bx - ax;
                const dz = bz - az;
                const lenSq = dx * dx + dz * dz;
                const t = lenSq > 1e-8 ? clamp(((hx - ax) * dx + (hz - az) * dz) / lenSq, 0, 1) : 0;
                const ex = hx - (ax + t * dx);
                const ez = hz - (az + t * dz);
                const dSq = ex * ex + ez * ez;
                if (dSq < bestDistSq) {
                  bestDistSq = dSq;
                  bestS = segPoly.polyS[p]! + t * (segPoly.polyS[p + 1]! - segPoly.polyS[p]!);
                }
              }
              sim.sampleSurface(hx, hz, seg.id, bestS, sampleScratch);
              // Fork runway (final 50m) must be obstacle-free
              if (sampleScratch.segmentId !== seg.id || sampleScratch.s >= seg.fork.obstacleFreeStartS) {
                throw new Error(
                  `Hazard violated 50m fork runway: seg=${seg.id}, sampleSeg=${sampleScratch.segmentId}, s=${sampleScratch.s}, limit=${seg.fork.obstacleFreeStartS}`,
                );
              }

              const defId = hazards.defIds[i];
              if (defId === 'boulder_large' || defId === 'pine_tree') {
                const safeX = seg.sampleSafeX(sampleScratch.s);
                const distFromSafe = Math.abs(sampleScratch.x - safeX);
                if (distFromSafe < 2.5) {
                  throw new Error(
                    `Lethal hazard '${defId}' inside safeX clearance: dist=${distFromSafe}m at seg=${seg.id} s=${sampleScratch.s}`,
                  );
                }
              }
            }

            // Check Delivery Zone cadence along segment path
            const zones = st.entities.deliveryZones;
            const zoneSList: number[] = [];
            for (let i = 0; i < zones.count; i++) {
              if (zones.segmentIds[i] !== seg.id) continue;
              let bestDistSq = Infinity;
              let bestS = 0;
              const segPoly = seg as unknown as {
                polyCount: number;
                polyS: Float32Array;
                polyX: Float64Array;
                polyZ: Float64Array;
              };
              const zx = zones.posX[i]!;
              const zz = zones.posZ[i]!;
              for (let p = 0; p < segPoly.polyCount - 1; p++) {
                const ax = segPoly.polyX[p]!;
                const az = segPoly.polyZ[p]!;
                const bx = segPoly.polyX[p + 1]!;
                const bz = segPoly.polyZ[p + 1]!;
                const dx = bx - ax;
                const dz = bz - az;
                const lenSq = dx * dx + dz * dz;
                const t = lenSq > 1e-8 ? clamp(((zx - ax) * dx + (zz - az) * dz) / lenSq, 0, 1) : 0;
                const ex = zx - (ax + t * dx);
                const ez = zz - (az + t * dz);
                const dSq = ex * ex + ez * ez;
                if (dSq < bestDistSq) {
                  bestDistSq = dSq;
                  bestS = segPoly.polyS[p]! + t * (segPoly.polyS[p + 1]! - segPoly.polyS[p]!);
                }
              }
              sim.sampleSurface(zx, zz, seg.id, bestS, sampleScratch);
              zoneSList.push(sampleScratch.s);
            }
            zoneSList.sort((a, b) => a - b);

            if (zoneSList.length > 0) {
              const prevS =
                seg.prevSegmentId !== null ? (segLastDeliveryS.get(seg.prevSegmentId) ?? null) : null;
              const prevLen =
                seg.prevSegmentId !== null ? (segLengthMap.get(seg.prevSegmentId) ?? 0) : 0;
              for (let z = 0; z < zoneSList.length; z++) {
                const curS = zoneSList[z]!;
                if (z === 0 && prevS !== null) {
                  deliveryCadences.push(prevLen - prevS + curS);
                } else if (z > 0) {
                  deliveryCadences.push(curS - zoneSList[z - 1]!);
                }
              }
              segLastDeliveryS.set(seg.id, zoneSList[zoneSList.length - 1]!);
            }
          }
        }
      }

      // Smooth PD autopilot following safeX(s) and alternating left/right fork selection
      const activeSegId = st.surfaceSample.segmentId;
      const activeSeg =
        st.trailWindow.curr.id === activeSegId
          ? st.trailWindow.curr
          : st.trailWindow.nextLeft?.id === activeSegId
            ? st.trailWindow.nextLeft
            : st.trailWindow.nextRight?.id === activeSegId
              ? st.trailWindow.nextRight
              : st.trailWindow.curr;

      const lookAheadS = clamp(st.surfaceSample.s + 14, 0, activeSeg.length);
      let targetX = activeSeg.sampleSafeX(lookAheadS);

      if (
        activeSeg.id === st.trailWindow.curr.id &&
        activeSeg.fork.hasFork &&
        st.surfaceSample.s > activeSeg.length - 45
      ) {
        const chooseRight = forkCount % 2 === 1;
        targetX = chooseRight ? 9.0 : -9.0;
      }

      const downhillYaw = Math.atan2(-st.surfaceSample.tangentX, -st.surfaceSample.tangentZ);
      const latErr = targetX - st.surfaceSample.x;
      // Right offset (+latErr) requires clockwise (-yaw) relative to downhillYaw
      const desiredYaw = downhillYaw - clamp(latErr * 0.065, -0.55, 0.55);
      const headingErr = angleDelta(st.currSkier.headingRad, desiredYaw);
      // Negative headingErr means we must turn right (+steer)
      intent.steer = clamp(-headingErr * 2.2, -1, 1);

      sim.savePreviousPoses();
      sim.step(FIXED_DT, intent);

      const post = sim.getState();
      if (
        !Number.isFinite(post.currSkier.posX) ||
        !Number.isFinite(post.currSkier.posY) ||
        !Number.isFinite(post.currSkier.posZ) ||
        !Number.isFinite(post.currSkier.velX) ||
        !Number.isFinite(post.currSkier.velY) ||
        !Number.isFinite(post.currSkier.velZ) ||
        !Number.isFinite(post.currCamera.posY) ||
        !Number.isFinite(post.surfaceSample.groundY)
      ) {
        throw new Error(`Non-finite simulation value at tick ${tick}`);
      }

      if (post.entities.hazards.count > maxActiveHazards) maxActiveHazards = post.entities.hazards.count;
      if (post.entities.presents.count > maxActivePresents) maxActivePresents = post.entities.presents.count;
      if (post.entities.deliveryZones.count > maxActiveZones) maxActiveZones = post.entities.deliveryZones.count;
      if (post.entities.creatures.count > maxActiveCreatures) maxActiveCreatures = post.entities.creatures.count;
    }

    const finalState = sim.getState();
    expect(finalState.distanceM).toBeGreaterThanOrEqual(50000);
    expect(forkCount).toBeGreaterThanOrEqual(100);
    expect(finalState.rebase.rebaseCount).toBeGreaterThan(200);
    expect(seenSegmentIds.size).toBeGreaterThan(150);
    for (const stage of getAllStages()) {
      expect(seenStageIds.has(stage.id)).toBe(true);
    }

    // O(1) bounded active pool counts despite 50+ km traveled
    expect(maxActiveHazards).toBeLessThan(finalState.entities.hazards.capacity);
    expect(maxActivePresents).toBeLessThan(finalState.entities.presents.capacity);
    expect(maxActiveZones).toBeLessThan(finalState.entities.deliveryZones.capacity);
    expect(maxActiveCreatures).toBeLessThan(finalState.entities.creatures.capacity);

    // Verify Delivery Zone cadence across 50 km stays strictly bounded
    expect(deliveryCadences.length).toBeGreaterThan(150);
    for (let i = 0; i < deliveryCadences.length; i++) {
      expect(deliveryCadences[i]!).toBeGreaterThanOrEqual(70);
      expect(deliveryCadences[i]!).toBeLessThanOrEqual(250);
    }
  }, 20_000);
});
