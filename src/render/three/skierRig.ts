import * as THREE from 'three';
import { getSkierDef } from '../../content/characters';
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
  private readonly leftSkiGroup: THREE.Group;
  private readonly rightSkiGroup: THREE.Group;
  private readonly leftArmGroup: THREE.Group;
  private readonly rightArmGroup: THREE.Group;

  private activeSkierId = '';
  private skiBankRad = 0;
  private readonly gfx: GraphicsUtils;
  private readonly materials: SharedToonMaterials;
  private readonly outlineMat: THREE.Material;

  constructor(
    gfx: GraphicsUtils,
    materials: SharedToonMaterials,
    outlineMat: THREE.Material,
    initialSkierId = 'skier_alpine',
  ) {
    this.gfx = gfx;
    this.materials = materials;
    this.outlineMat = outlineMat;

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
    this.leftSkiGroup.position.set(-0.22, 0.04, 0);
    this.rightSkiGroup = new THREE.Group();
    this.rightSkiGroup.position.set(0.22, 0.04, 0);
    this.bodyGroup.add(this.leftSkiGroup, this.rightSkiGroup);

    this.upperBodyGroup = new THREE.Group();
    this.upperBodyGroup.position.set(0, 0.42, 0);
    this.bodyGroup.add(this.upperBodyGroup);

    this.leftArmGroup = new THREE.Group();
    this.leftArmGroup.position.set(-0.34, 0.62, 0);
    this.rightArmGroup = new THREE.Group();
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

  private buildMeshes(skierId: string): void {
    this.activeSkierId = skierId;
    const def = getSkierDef(skierId);
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
    this.clearChildren(this.leftArmGroup);
    this.clearChildren(this.rightArmGroup);

    // Remove previous torso/head/leg meshes in upperBodyGroup & bodyGroup except arm/backpack anchors
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

    // Torso, legs, scarf, helmet, goggles
    const bodyGeo = buildMergedColoredGeometry(
      [
        // Legs
        { geometry: new THREE.BoxGeometry(0.18, 0.42, 0.22), color: pantsColor, tx: -0.15, ty: -0.14 },
        { geometry: new THREE.BoxGeometry(0.18, 0.42, 0.22), color: pantsColor, tx: 0.15, ty: -0.14 },
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

  sync(simState: ReadonlySimState, alpha: number): void {
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

    // Wipeout tumble vs normal skiing / braking / airborne pose
    if (simState.skierState === 'wipeout') {
      const duration = Math.max(0.1, simState.wipeoutDurationSec);
      const progress = clamp(1 - simState.wipeoutTimerSec / duration, 0, 1);
      const tumbleSpin = progress * Math.PI * 4;
      this.skiBankRad = 0;
      this.bodyGroup.position.set(0, Math.sin(progress * Math.PI) * 0.45 + 0.25, 0);
      this.bodyGroup.rotation.set(tumbleSpin, progress * Math.PI * 2.5, Math.sin(progress * Math.PI * 3) * 0.9);
      this.leftSkiGroup.position.y = 0.04;
      this.rightSkiGroup.position.y = 0.04;
      this.leftSkiGroup.rotation.y = -0.5;
      this.rightSkiGroup.rotation.y = 0.5;
      this.leftSkiGroup.rotation.z = 0;
      this.rightSkiGroup.rotation.z = 0;
      this.upperBodyGroup.position.y = 0.42;
      this.upperBodyGroup.rotation.x = 0;
      return;
    }

    this.bodyGroup.position.set(0, 0, 0);
    this.bodyGroup.rotation.set(0, 0, 0);

    const braking = curr.braking;
    const grounded = curr.grounded;
    const speedNorm = clamp(speed / 35, 0, 1);

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

    // Snowplow V-wedge skis when braking (`yaw = -0.3` toes left ski inward toward +X, `+0.3` toes right ski inward toward -X).
    const wedgeYaw = braking ? 0.34 : 0;
    const skiYOffset = 0.22 * Math.sin(this.skiBankRad);
    this.leftSkiGroup.position.y = 0.04 - skiYOffset;
    this.rightSkiGroup.position.y = 0.04 + skiYOffset;
    this.leftSkiGroup.rotation.y = -wedgeYaw;
    this.rightSkiGroup.rotation.y = wedgeYaw;
    this.leftSkiGroup.rotation.z = this.skiBankRad - carveAngleRad * 0.25;
    this.rightSkiGroup.rotation.z = this.skiBankRad - carveAngleRad * 0.25;

    // Tuck crouch when braking, carving hard, or airborne
    const crouchY = !grounded ? 0.31 : braking ? 0.28 : 0.42 - speedNorm * 0.08;
    const forwardLeanX = !grounded ? -0.35 : braking ? 0.12 : -0.18 - speedNorm * 0.16;
    this.upperBodyGroup.position.y = crouchY;
    this.upperBodyGroup.rotation.x = forwardLeanX;

    // Rhythmic pole/arm motion
    const armSwing = grounded ? Math.sin(simState.elapsedSec * 7.5) * 0.12 * speedNorm : -0.35;
    this.leftArmGroup.rotation.x = armSwing;
    this.rightArmGroup.rotation.x = -armSwing;
    this.leftArmGroup.rotation.z = !grounded ? -0.45 : -0.15;
    this.rightArmGroup.rotation.z = !grounded ? 0.45 : 0.15;
  }

  dispose(): void {
    this.gfx.disposeObject(this.rootGroup);
  }
}
