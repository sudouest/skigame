import type { DeliveryZoneDef, LandmarkColliderSpec } from './types';

export const FOLK_LOG_COLLIDER: LandmarkColliderSpec = {
  id: 'building_folk_log',
  shape: 'box',
  halfWidth: 2.55,
  halfDepth: 3.3,
  height: 5.4,
  skirtDepth: 2.0,
  offsetX: 0,
  offsetZ: -0.4,
  impact: {
    effect: 'wipeout',
    presentsDropped: 3,
    speedRetention: 0,
  },
};

export const FOLK_AFRAME_COLLIDER: LandmarkColliderSpec = {
  id: 'building_folk_aframe',
  shape: 'box',
  halfWidth: 3.0,
  halfDepth: 2.85,
  height: 5.6,
  skirtDepth: 2.0,
  offsetX: -0.15,
  offsetZ: 0,
  impact: {
    effect: 'wipeout',
    presentsDropped: 3,
    speedRetention: 0,
  },
};

export const DELIVERY_CHILD_SOLO: DeliveryZoneDef = {
  id: 'child_solo',
  name: 'Trailside Camper',
  maxAcceptCount: 'all',
  deliveryRadius: 7.5,
  deliveryLength: 16,
  comboBonusPerGift: 0.25,
  childVisuals: [
    {
      kind: 'procedural',
      preset: 'child',
      palette: ['#ef476f', '#ffd166', '#118ab2'],
      scale: 1.0,
      variant: 'scarf_red',
      outline: true,
    },
  ],
  landmarkVisual: {
    kind: 'procedural',
    preset: 'lantern',
    palette: ['#c8842a', '#2e3138', '#f8fafc', '#fde68a', '#f59e0b'],
    scale: 1.0,
    variant: 'single',
    outline: true,
  },
  requiredSceneryId: 'delivery_lantern',
};

export const DELIVERY_SLED_DUO: DeliveryZoneDef = {
  id: 'sled_duo',
  name: 'Sledding Siblings',
  maxAcceptCount: 'all',
  deliveryRadius: 8.0,
  deliveryLength: 18,
  comboBonusPerGift: 0.35,
  childVisuals: [
    {
      kind: 'procedural',
      preset: 'child',
      palette: ['#06d6a0', '#ffd166', '#073b4c'],
      scale: 1.0,
      variant: 'coat_teal',
      outline: true,
    },
    {
      kind: 'procedural',
      preset: 'child',
      palette: ['#f77f00', '#fcbf49', '#003049'],
      scale: 0.94,
      variant: 'coat_orange',
      outline: true,
    },
  ],
  landmarkVisual: {
    kind: 'procedural',
    preset: 'lantern',
    palette: ['#c8842a', '#2e3138', '#f8fafc', '#fde68a', '#f59e0b'],
    scale: 1.0,
    variant: 'double',
    outline: true,
  },
  requiredSceneryId: 'delivery_lantern_double',
};

export const DELIVERY_VILLAGE_PLAZA: DeliveryZoneDef = {
  id: 'village_plaza',
  name: 'Alpine Cabin Plaza',
  maxAcceptCount: 'all',
  deliveryRadius: 9.0,
  deliveryLength: 20,
  comboBonusPerGift: 0.5,
  childVisuals: [
    {
      kind: 'procedural',
      preset: 'child',
      palette: ['#ef476f', '#ffffff', '#1d3557'],
      scale: 1.0,
      variant: 'plaza_1',
      outline: true,
    },
    {
      kind: 'procedural',
      preset: 'child',
      palette: ['#3a86ff', '#ffbe0b', '#1d3557'],
      scale: 0.96,
      variant: 'plaza_2',
      outline: true,
    },
    {
      kind: 'procedural',
      preset: 'child',
      palette: ['#8338ec', '#ff006e', '#ffffff'],
      scale: 0.92,
      variant: 'plaza_3',
      outline: true,
    },
  ],
  landmarkVisual: {
    kind: 'procedural',
    preset: 'cabin',
    palette: ['#c48636', '#4d2612', '#356b4e', '#ffe066', '#faf6ee'],
    scale: 1.0,
    variant: 'folk_log',
    outline: true,
  },
  landmarkYawPolicy: 'faceTrail',
  landmarkCollider: FOLK_LOG_COLLIDER,
  landmarkVisualPool: [
    {
      visual: {
        kind: 'procedural',
        preset: 'cabin',
        palette: ['#c48636', '#4d2612', '#356b4e', '#ffe066', '#faf6ee'],
        scale: 1.0,
        variant: 'folk_log',
        outline: true,
      },
      weight: 1,
      clearanceRadius: 4.5,
      lateralOffsetM: 6.2,
      yawPolicy: 'faceTrail',
      collider: FOLK_LOG_COLLIDER,
    },
    {
      visual: {
        kind: 'procedural',
        preset: 'cabin',
        palette: ['#cc8a32', '#2f5e42', '#a82d26', '#ffe066', '#d5e4f0'],
        scale: 1.0,
        variant: 'folk_aframe',
        outline: true,
      },
      weight: 1,
      clearanceRadius: 4.8,
      lateralOffsetM: 6.0,
      yawPolicy: 'faceTrail',
      collider: FOLK_AFRAME_COLLIDER,
    },
  ],
  requiredSceneryId: 'delivery_cabin',
};

export const DELIVERY_ZONES: Readonly<Record<string, DeliveryZoneDef>> = {
  [DELIVERY_CHILD_SOLO.id]: DELIVERY_CHILD_SOLO,
  [DELIVERY_SLED_DUO.id]: DELIVERY_SLED_DUO,
  [DELIVERY_VILLAGE_PLAZA.id]: DELIVERY_VILLAGE_PLAZA,
};

export function getDeliveryZoneDef(id: string): DeliveryZoneDef | undefined {
  return DELIVERY_ZONES[id];
}
