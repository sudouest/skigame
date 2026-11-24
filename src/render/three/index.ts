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
  INNER_TILE_POOL_CAPACITY,
  INNER_TILE_QUADS,
  INNER_TILE_SIZE_M,
  INNER_TILE_SKIRT_DEPTH_M,
  INNER_TILE_SPACING_M,
  INNER_TILE_VERT_SPAN,
  OUTER_TILE_POOL_CAPACITY,
  OUTER_TILE_QUADS,
  OUTER_TILE_SIZE_M,
  OUTER_TILE_SKIRT_DEPTH_M,
  OUTER_TILE_SPACING_M,
  OUTER_TILE_VERT_SPAN,
  TERRAIN_LOD_SPECS,
  TerrainTilePool,
  type TerrainLodSpec,
  type TerrainLodTier,
  type TerrainTilePoolOptions,
  type TerrainTileSlot,
} from './terrainTilePool';
export {
  computeScenerySlopeSinkY,
  computeStageSceneryDensity,
  evaluateSceneryRuleFitness,
  selectWinningSceneryRule,
  speciesToBillboardFrame,
  type SceneryEnvSignal,
} from './scenerySelector';
export {
  TerrainStreamer,
  packTileKey,
  type SceneryProvider,
  type TerrainStreamerOptions,
  type TileSceneryItem,
} from './terrainStreamer';
export {
  LandmarkStreamer,
  type LandmarkStreamerOptions,
} from './landmarkStreamer';
export { InstancePools, MAX_STATIC_BILLBOARDS } from './instancePools';
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
