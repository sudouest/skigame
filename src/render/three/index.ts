export {
  GraphicsTracker,
  type GraphicsTrackerOptions,
  type GraphicsTrackerStats,
  type LeakEntry,
  type LeakReport,
  type TrackedObjectKind,
  type TrackedResourceKind,
  type UntrackedObjectLeak,
  type RenderableObject3D,
} from './graphicsTracker';
export { GraphicsUtils, type CacheableTarget } from './graphicsUtils';
export { computeSmoothNormals } from './smoothNormals';
export {
  createSharedToonMaterials,
  type SharedLightingUniforms,
  type SharedToonMaterials,
} from './toonMaterials';
export { computeVerticalFovDeg, syncPerspectiveCamera } from './cameraSync';
export { createSmoothOutlineMaterial, type OutlineMaterialOptions } from './outlineShader';
export {
  ATLAS_COLS,
  ATLAS_FRAMES,
  ATLAS_HEIGHT,
  ATLAS_ROWS,
  ATLAS_WIDTH,
  createCartoonSpriteAtlasTexture,
  dilateAtlasEdges,
  type AtlasFrameRect,
  type BillboardFrameName,
} from './spriteAtlas';
export {
  createBillboardQuadGeometry,
  createCylindricalBillboardMaterial,
} from './billboardMaterial';
export {
  buildMergedColoredGeometry,
  buildPresentGeometry,
  buildUnitBoulderGeometry,
  buildUnitRampGeometry,
  createForkArchObject,
  createProceduralMeshAssets,
  type ColoredGeometryPart,
  type ProceduralMeshAssets,
} from './meshFactory';
export { SkierRig } from './skierRig';
export {
  RIBBON_COLS,
  RIBBON_POOL_CAPACITY,
  RIBBON_ROWS,
  RIBBON_VERT_COLS,
  RIBBON_VERT_ROWS,
  RibbonPool,
  type RibbonChunkSlot,
} from './ribbonPool';
export {
  ChunkStreamer,
  type ChunkSceneryItem,
  type ChunkStreamerOptions,
} from './chunkStreamer';
export { InstancePools } from './instancePools';
export { ContactShadows } from './contactShadows';
export { BackpackStack } from './backpackStack';
export { TossedPresents } from './tossedPresents';
export { SkiTracks } from './skiTracks';
export { MAX_SNOW_PARTICLES, SnowVfx } from './snowVfx';
export { DebugOverlay3D } from './debugOverlay';
export {
  ThreeRenderer,
  type ThreeRendererOptions,
  type ThreeRendererStats,
} from './renderer';
