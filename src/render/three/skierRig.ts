import * as THREE from 'three';
import { getSkierDef } from '../../content/characters';
import {
  CHARACTER_SCALE_TUNING,
  extractVisualScale,
  resolveSkierVisualScale,
  type CharacterScaleTuning,
} from '../../content/visibilityTuning';
import { clamp, lerp, lerpAngle } from '../../core/math';
import type { ReadonlySimState } from '../../sim/contracts';
import type { GraphicsUtils } from './graphicsUtils';
import { buildMergedColoredGeometry } from './meshFactory';
import type { SharedToonMaterials } from './toonMaterials';

/**
 * Stylized low-poly 3D skier character rig respecting right-handed `+Y`-up, `-Z`-forward
 * Euler `'YXZ'` conventions. Includes skis (snowplow wedge on brake), poles, torso crouch/carve lean,
 * wipeout tumble animation, invulnerability blink, smooth-normal inverted-hull outlines,
 * and a `backpackAnchor` Group for `BackpackStack`.
 */
export class SkierRig {
  readonly rootGroup: THREE.Group;
  readonly backpackAnchor: THREE.Group;

  private readonly leanGroup: THREE.Group;
  private readonly bodyGroup: THREE.Group;
  private readonly upperBodyGroup: THREE.Group;
  private readonly leftLegGroup: THREE.Group;
  private readonly rightLegGroup: THREE.Group;
  private readonly leftSkiGroup: THREE.Group;
  private readonly rightSkiGroup: THREE.Group;
  private readonly leftArmGroup: THREE.Group;
  private readonly rightArmGroup: THREE.Group;

  private activeSkierId = '';
  private currentVisualScale = 1.0;
  private skiBankRad = 0;
  private walkBlend = 0;
  private readonly gfx: GraphicsUtils;
  private readonly materials: SharedToonMaterials;
  private readonly outlineMat: THREE.Material;
  private readonly scaleTuning: CharacterScaleTuning;

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    outlineMat: THREE.Material,
    initialSkierId = 'skier_alpine',
    scaleTuning: CharacterScaleTuning = CHARACTER_SCALE_TUNING,
  ) {
    this.gfx = gfx;
    this.materials = materials;
    this.outlineMat = outlineMat;
    this.scaleTuning = scaleTuning;

    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'SkierRoot';
    this.rootGroup.rotation.order = 'YXZ';

    this.leanGroup = new THREE.Group();
    this.leanGroup.name = 'SkierLeanGroup';
    this.rootGroup.add(this.leanGroup);

    this.bodyGroup = new THREE.Group();
    this.bodyGroup.name = 'SkierBodyGroup';
    this.leanGroup.add(this.bodyGroup);

    this.leftSkiGroup = new THREE.Group();
    this.leftSkiGroup.name = 'SkierLeftSkiGroup';
    this.leftSkiGroup.rotation.order = 'YXZ';
    this.leftSkiGroup.position.set(-0.22, 0.04, 0);
    this.rightSkiGroup = new THREE.Group();
    this.rightSkiGroup.name = 'SkierRightSkiGroup';
    this.rightSkiGroup.rotation.order = 'YXZ';
    this.rightSkiGroup.position.set(0.22, 0.04, 0);
    this.bodyGroup.add(this.leftSkiGroup, this.rightSkiGroup);

    this.leftLegGroup = new THREE.Group();
    this.leftLegGroup.name = 'SkierLeftLegGroup';
    this.leftLegGroup.rotation.order = 'YXZ';
    this.leftLegGroup.position.set(-0.15, 0.47, 0);
    this.rightLegGroup = new THREE.Group();
    this.rightLegGroup.name = 'SkierRightLegGroup';
    this.rightLegGroup.rotation.order = 'YXZ';
    this.rightLegGroup.position.set(0.15, 0.47, 0);
    this.bodyGroup.add(this.leftLegGroup, this.rightLegGroup);

    this.upperBodyGroup = new THREE.Group();
    this.upperBodyGroup.name = 'SkierUpperBodyGroup';
    this.upperBodyGroup.position.set(0, 0.42, 0);
    this.bodyGroup.add(this.upperBodyGroup);

    this.leftArmGroup = new THREE.Group();
    this.leftArmGroup.name = 'SkierLeftArmGroup';
    this.leftArmGroup.position.set(-0.34, 0.62, 0);
    this.rightArmGroup = new THREE.Group();
    this.rightArmGroup.name = 'SkierRightArmGroup';
    this.rightArmGroup.position.set(0.34, 0.62, 0);
    this.upperBodyGroup.add(this.leftArmGroup, this.rightArmGroup);

    // Backpack rack mounts on the skier's back (+Z is behind the -Z forward facing skier).
    this.backpackAnchor = new THREE.Group();
    this.backpackAnchor.name = 'SkierBackpackAnchor';
    this.backpackAnchor.position.set(0, 0.56, 0.34);
    this.backpackAnchor.rotation.x = 0.14;
    this.upperBodyGroup.add(this.backpackAnchor);

    this.buildMeshes(initialSkierId);
  }

  get visualScale(): number {
    return this.currentVisualScale;
  }

  private buildMeshes(skierId: string): void {
    this.activeSkierId = skierId;
    const def = getSkierDef(skierId);
    this.currentVisualScale = resolveSkierVisualScale(
      extractVisualScale(def?.visual),
      this.scaleTuning,
    );
    this.rootGroup.scale.setScalar(this.currentVisualScale);
    const palette =
      def?.visual.kind === 'procedural'
        ? def.visual.palette
        : ['#e63946', '#1d3557', '#ffd166', '#f8fafc'];

    const jacketColor = palette[0] ?? '#e63946';
    const pantsColor = palette[1] ?? '#1d3557';
    const accentColor = palette[2] ?? '#ffd166';
    const skiColor = palette[3] ?? '#f8fafc';

    this.clearChildren(this.leftSkiGroup);
    this.clearChildren(this.rightSkiGroup);
    this.clearChildren(this.leftLegGroup);
    this.clearChildren(this.rightLegGroup);
    this.clearChildren(this.leftArmGroup);
    this.clearChildren(this.rightArmGroup);

    // Remove previous torso/head meshes in upperBodyGroup except arm/backpack anchors
    for (let i = this.upperBodyGroup.children.length - 1; i >= 0; i--) {
      const child = this.upperBodyGroup.children[i]!;
      if (child !== this.leftArmGroup && child !== this.rightArmGroup && child !== this.backpackAnchor) {
        this.gfx.disposeObject(child);
      }
    }

    // Skis with upturned -Z tips
    const makeSki = (side: string): THREE.Mesh => {
      const geo = buildMergedColoredGeometry(
        [
          { geometry: new THREE.BoxGeometry(0.14, 0.05, 1.55), color: accentColor, ty: 0.025 },
          { geometry: new THREE.BoxGeometry(0.14, 0.05, 0.34), color: skiColor, ty: 0.11, tz: -0.88, rx: 0.52 },
          { geometry: new THREE.BoxGeometry(0.16, 0.18, 0.24), color: '#1e293b', ty: 0.12, tz: 0.04 },
        ],
        `SkiGeo_${side}`,
        true,
      );
      const mesh = this.gfx.createMesh(geo, this.materials.propToonMaterial, `Ski_${side}`);
      mesh.castShadow = true;
      const outline = this.gfx.createMesh(geo, this.outlineMat, `SkiOutline_${side}`);
      outline.castShadow = false;
      mesh.add(outline);
      return mesh;
    };

    this.leftSkiGroup.add(makeSki('L'));
    this.rightSkiGroup.add(makeSki('R'));

    // Articulated hip-pivoted legs + ski boot cuffs
    const makeLeg = (side: string): THREE.Mesh => {
      const geo = buildMergedColoredGeometry(
        [
          { geometry: new THREE.BoxGeometry(0.18, 0.32, 0.21), color: pantsColor, ty: -0.16 },
          { geometry: new THREE.BoxGeometry(0.17, 0.14, 0.24), color: '#1e293b', ty: -0.35, tz: -0.02 },
        ],
        `SkierLegGeo_${skierId}_${side}`,
        true,
      );
      const legMesh = this.gfx.createMesh(geo, this.materials.propToonMaterial, `SkierLeg_${side}`);
      legMesh.castShadow = true;
      const legOutline = this.gfx.createMesh(geo, this.outlineMat, `SkierLegOutline_${side}`);
      legOutline.castShadow = false;
      legMesh.add(legOutline);
      return legMesh;
    };

    this.leftLegGroup.add(makeLeg('L'));
    this.rightLegGroup.add(makeLeg('R'));

    // Torso, scarf, helmet, goggles
    const bodyGeo = buildMergedColoredGeometry(
      [
        // Jacket torso
        { geometry: new THREE.BoxGeometry(0.56, 0.62, 0.36), color: jacketColor, ty: 0.36 },
        // Scarf collar
        { geometry: new THREE.BoxGeometry(0.46, 0.14, 0.4), color: accentColor, ty: 0.7 },
        // Head + cheeks
        { geometry: new THREE.IcosahedronGeometry(0.22, 1), color: '#ffd7ba', ty: 0.94 },
        // Helmet / Beanie
        { geometry: new THREE.SphereGeometry(0.245, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.58), color: jacketColor, ty: 0.96 },
        { geometry: new THREE.OctahedronGeometry(0.09, 0), color: skiColor, ty: 1.24 },
        // Goggles facing -Z forward
        { geometry: new THREE.BoxGeometry(0.32, 0.12, 0.12), color: '#0f172a', ty: 0.97, tz: -0.19 },
        { geometry: new THREE.BoxGeometry(0.26, 0.08, 0.04), color: '#38bdf8', ty: 0.97, tz: -0.24 },
      ],
      `SkierBodyGeo_${skierId}`,
      true,
    );
    const bodyMesh = this.gfx.createMesh(bodyGeo, this.materials.propToonMaterial, 'SkierBody');
    bodyMesh.castShadow = true;
    const bodyOutline = this.gfx.createMesh(bodyGeo, this.outlineMat, 'SkierBodyOutline');
    bodyOutline.castShadow = false;
    bodyMesh.add(bodyOutline);
    this.upperBodyGroup.add(bodyMesh);

    // Arms + ski poles angled backward
    const makeArmAndPole = (side: string, sign: number): THREE.Mesh => {
      const geo = buildMergedColoredGeometry(
        [
          { geometry: new THREE.BoxGeometry(0.15, 0.42, 0.16), color: jacketColor, tx: sign * 0.06, ty: -0.18, rz: sign * 0.25 },
          { geometry: new THREE.OctahedronGeometry(0.09, 0), color: accentColor, tx: sign * 0.12, ty: -0.38, tz: -0.05 },
          // Ski pole angled backward (+Z)
          { geometry: new THREE.CylinderGeometry(0.018, 0.018, 1.05, 6), color: '#cbd5e1', tx: sign * 0.14, ty: -0.48, tz: 0.38, rx: -0.78 },
          { geometry: new THREE.CylinderGeometry(0.06, 0.06, 0.03, 8), color: accentColor, tx: sign * 0.14, ty: -0.78, tz: 0.72, rx: -0.78 },
        ],
        `SkierArmGeo_${side}`,
        true,
      );
      const armMesh = this.gfx.createMesh(geo, this.materials.propToonMaterial, `SkierArm_${side}`);
      armMesh.castShadow = true;
      return armMesh;
    };

    this.leftArmGroup.add(makeArmAndPole('L', -1));
    this.rightArmGroup.add(makeArmAndPole('R', 1));
  }

  private clearChildren(group: THREE.Group): void {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      if (child) {
        this.gfx.disposeObject(child);
      }
    }
  }

  sync(simState: ReadonlySimState, alpha: number, frameDtSec = 1 / 60): void {
    if (simState.skierId !== this.activeSkierId) {
      this.buildMeshes(simState.skierId);
    }

    const t = clamp(alpha, 0, 1);
    const prev = simState.prevSkier;
    const curr = simState.currSkier;

    const posX = lerp(prev.posX, curr.posX, t);
    const posY = lerp(prev.posY, curr.posY, t);
    const posZ = lerp(prev.posZ, curr.posZ, t);
    const headingRad = lerpAngle(prev.headingRad, curr.headingRad, t);
    const pitchRad = lerp(prev.pitchRad, curr.pitchRad, t);
    const carveAngleRad = lerp(prev.carveAngleRad, curr.carveAngleRad, t);
    const speed = lerp(prev.speed, curr.speed, t);

    this.rootGroup.position.set(posX, posY, posZ);
    this.rootGroup.rotation.set(pitchRad, headingRad, 0, 'YXZ');

    // Positive carveAngleRad leans right (+X): clockwise around +Z is negative Z rotation.
    this.leanGroup.rotation.z = -carveAngleRad * 0.9;

    // Invulnerability blink during recovery
    if (simState.invulnerableTimerSec > 0) {
      this.rootGroup.visible = Math.floor(simState.elapsedSec * 22) % 2 === 0;
    } else {
      this.rootGroup.visible = true;
    }

    // Wipeout tumble vs normal skiing / braking / walking / airborne pose
    if (simState.skierState === 'wipeout') {
      const duration = Math.max(0.1, simState.wipeoutDurationSec);
      const progress = clamp(1 - simState.wipeoutTimerSec / duration, 0, 1);
      const tumbleSpin = progress * Math.PI * 4;
      this.skiBankRad = 0;
      this.walkBlend = 0;
      this.bodyGroup.position.set(0, Math.sin(progress * Math.PI) * 0.45 + 0.25, 0);
      this.bodyGroup.rotation.set(tumbleSpin, progress * Math.PI * 2.5, Math.sin(progress * Math.PI * 3) * 0.9);
      this.leftLegGroup.position.set(-0.15, 0.47, 0);
      this.rightLegGroup.position.set(0.15, 0.47, 0);
      this.leftLegGroup.rotation.set(0.35, 0, -0.2);
      this.rightLegGroup.rotation.set(-0.25, 0, 0.2);
      this.leftSkiGroup.position.set(-0.22, 0.04, 0);
      this.rightSkiGroup.position.set(0.22, 0.04, 0);
      this.leftSkiGroup.rotation.set(0, -0.5, 0);
      this.rightSkiGroup.rotation.set(0, 0.5, 0);
      this.upperBodyGroup.position.y = 0.42;
      this.upperBodyGroup.rotation.set(0, 0, 0);
      this.leftArmGroup.rotation.set(-0.4, 0, -0.45);
      this.rightArmGroup.rotation.set(-0.4, 0, 0.45);
      return;
    }

    this.bodyGroup.position.set(0, 0, 0);
    this.bodyGroup.rotation.set(0, 0, 0);

    const braking = curr.braking;
    const grounded = curr.grounded;
    const speedNorm = clamp(speed / 35, 0, 1);
    const safeDt = clamp(frameDtSec, 0, 0.1);
    const targetWalk = curr.walking && grounded ? 1 : 0;
    if (simState.tickCount === 0) {
      this.walkBlend = targetWalk;
    } else if (safeDt > 0) {
      this.walkBlend = lerp(this.walkBlend, targetWalk, 1 - Math.exp(-12 * safeDt));
    }

    const walkPhase = lerp(prev.walkPhaseRad, curr.walkPhaseRad, t);
    const legSin = Math.sin(walkPhase);
    const legCos = Math.cos(walkPhase);
    const leftLift = Math.max(0, legCos);
    const rightLift = Math.max(0, -legCos);
    const wb = this.walkBlend;

    // Align grounded skis smoothly to cross-slope terrain bank (normal projected onto right axis)
    let targetBankRad = 0;
    if (grounded) {
      const nx = lerp(prev.normalX, curr.normalX, t);
      const ny = lerp(prev.normalY, curr.normalY, t);
      const nz = lerp(prev.normalZ, curr.normalZ, t);
      const rightX = Math.cos(headingRad);
      const rightZ = -Math.sin(headingRad);
      const dotRight = nx * rightX + nz * rightZ;
      targetBankRad = clamp(Math.atan2(-dotRight, Math.max(0.35, ny)), -0.6, 0.6);
    }
    this.skiBankRad = lerp(this.skiBankRad, targetBankRad, grounded ? 0.28 : 0.14);

    // Snowplow V-wedge on brake (`yaw = -0.34` toes left ski inward), blended to diagonal stride /
    // uphill herringbone V-splay when walking (`+yaw` toes left ski outward).
    const wedgeYaw = braking ? 0.34 : 0;
    const uphillRatio = clamp((pitchRad - 0.03) / 0.35, 0, 1);
    const herringboneYaw = lerp(0.06, 0.34, uphillRatio);
    const skiYOffset = 0.22 * Math.sin(this.skiBankRad);
    this.leftSkiGroup.position.set(
      -0.22,
      0.04 - skiYOffset + wb * leftLift * 0.13,
      -wb * legSin * 0.24,
    );
    this.rightSkiGroup.position.set(
      0.22,
      0.04 + skiYOffset + wb * rightLift * 0.13,
      wb * legSin * 0.24,
    );
    this.leftSkiGroup.rotation.set(
      wb * leftLift * 0.16,
      lerp(-wedgeYaw, herringboneYaw, wb),
      this.skiBankRad - carveAngleRad * 0.25,
    );
    this.rightSkiGroup.rotation.set(
      wb * rightLift * 0.16,
      lerp(wedgeYaw, -herringboneYaw, wb),
      this.skiBankRad - carveAngleRad * 0.25,
    );

    // Torso crouch / upright walking posture + weight shift & stride bob
    const skiCrouchY = !grounded ? 0.31 : braking ? 0.28 : 0.42 - speedNorm * 0.08;
    const skiLeanX = !grounded ? -0.35 : braking ? 0.12 : -0.18 - speedNorm * 0.16;
    const walkTorsoY = 0.44 + Math.abs(legSin) * 0.045;
    const walkLeanX = -0.06 - uphillRatio * 0.16;
    const upperY = lerp(skiCrouchY, walkTorsoY, wb);
    this.upperBodyGroup.position.y = upperY;
    this.upperBodyGroup.rotation.x = lerp(skiLeanX, walkLeanX, wb);
    this.upperBodyGroup.rotation.z = wb * legSin * 0.065;

    // Articulated hip-pivoted legs synced to stride (+rx swings downward leg forward toward -Z)
    const hipY = upperY + 0.05;
    this.leftLegGroup.position.set(-0.15, hipY, 0);
    this.rightLegGroup.position.set(0.15, hipY, 0);
    this.leftLegGroup.rotation.set(wb * legSin * 0.50, lerp(0, herringboneYaw * 0.4, wb), 0);
    this.rightLegGroup.rotation.set(-wb * legSin * 0.50, lerp(0, -herringboneYaw * 0.4, wb), 0);

    // Rhythmic pole/arm motion (diagonal stride opposite to leg swing when walking)
    const skiArmSwing = grounded ? Math.sin(simState.elapsedSec * 7.5) * 0.12 * speedNorm : -0.35;
    const skiArmZ = !grounded ? -0.45 : -0.15;
    this.leftArmGroup.rotation.x = lerp(skiArmSwing, -legSin * 0.45 + 0.15, wb);
    this.rightArmGroup.rotation.x = lerp(-skiArmSwing, legSin * 0.45 + 0.15, wb);
    this.leftArmGroup.rotation.z = lerp(skiArmZ, -0.18, wb);
    this.rightArmGroup.rotation.z = lerp(-skiArmZ, 0.18, wb);
  }

  dispose(): void {
    this.gfx.disposeObject(this.rootGroup);
  }
}
