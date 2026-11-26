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
  bindClipmapStoreToMaterial,
  createSharedToonMaterials,
  createTexturedToonMaterial,
  NOISE_ORIGIN_MOD_PERIOD,
  patchToonTint,
  positiveMod,
  type ClipmapShaderUniforms,
  type SharedLightingUniforms,
  type SharedToonMaterials,
} from './toonMaterials';
export { computeVerticalFovDeg, syncPerspectiveCamera } from './cameraSync';
export { createSmoothOutlineMaterial, type OutlineMaterialOptions } from './outlineShader';
export {
  ALL_TREE_FRAMES,
  ATLAS_COLS,
  ATLAS_FRAMES,
  ATLAS_HEIGHT,
  ATLAS_ROWS,
  ATLAS_WIDTH,
  createCartoonSpriteAtlasTexture,
  dilateAtlasEdges,
  FROSTED_TREE_FRAMES,
  GREEN_TREE_FRAMES,
  isFrostedTreeFrame,
  isGreenTreeFrame,
  isTreeBillboardFrame,
  TREE_FRAME_PROPORTIONS,
  type AtlasFrameRect,
  type BillboardFrameName,
  type TreeFrameProportion,
} from './spriteAtlas';
export {
  createBillboardQuadGeometry,
  createCylindricalBillboardMaterial,
} from './billboardMaterial';
export {
  buildChimneySmokeQuadGeometry,
  CABIN_SMOKE_CYCLE_SEC,
  CABIN_SMOKE_PUFFS_PER_CABIN,
  CABIN_SMOKE_RISE_HEIGHT_M,
  createChimneySmokeAssets,
  drawFolkSmokeSprite,
  FOLK_SMOKE_FRAMES,
  FOLK_SMOKE_HEIGHT,
  FOLK_SMOKE_WIDTH,
  type ChimneySmokeAssets,
  type FolkSmokeFrameRect,
} from './chimneySmoke';
export {
  createDefaultLandmarkRegistry,
  LandmarkModelRegistry,
  type ChimneyEmitterAnchor,
  type LandmarkInstanceHandle,
  type LandmarkModelDef,
} from './landmarkRegistry';
export {
  buildMergedTexturedGeometry,
  createProceduralCanvasTexture,
  drawFolkStar,
  drawRoundedRectPath,
  makeAtlasTile,
  makeHeadlessFallbackTexture,
  type AtlasTileRect,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './models/proceduralModelUtils';
export {
  buildFolkAFrameGeometries,
  createFolkAFrameLandmarkDef,
  drawFolkAFrameAtlas,
  FOLK_AFRAME_ATLAS_SIZE,
  FOLK_AFRAME_ATLAS_TILES,
  FOLK_AFRAME_SMOKE_ANCHOR,
  type FolkAFrameAtlasTile,
  type FolkAFrameGeometries,
  type FolkAFrameTileName,
} from './models/folkAFrameModel';
export {
  buildFolkCabinGeometries,
  createFolkCabinLandmarkDef,
  createFolkCabinMaterials,
  drawFolkCabinAtlas,
  FOLK_CABIN_ATLAS_SIZE,
  FOLK_CABIN_ATLAS_TILES,
  FOLK_CABIN_SMOKE_ANCHOR,
  FOLK_CABIN_SMOKE_ORIGIN,
  type FolkCabinAtlasTile,
  type FolkCabinGeometries,
  type FolkCabinMaterials,
  type FolkCabinTileName,
} from './models/folkCabinModel';
export {
  buildTrailGateGeometries,
  createTrailGateAssets,
  createTrailGateLandmarkDef,
  createTrailGateObject,
  drawTrailGateAtlas,
  TRAIL_GATE_ATLAS_SIZE,
  TRAIL_GATE_ATLAS_TILES,
  TRAIL_GATE_BEAM_Y,
  TRAIL_GATE_DEFAULT_HALF_SPAN,
  TRAIL_GATE_LOG_RADIUS,
  TRAIL_GATE_MAX_HALF_SPAN,
  TRAIL_GATE_MIN_HALF_SPAN,
  type TrailGateAssets,
  type TrailGateAtlasTile,
  type TrailGateGeometries,
  type TrailGateTileName,
} from './models/trailGateModel';
export {
  buildMergedColoredGeometry,
  buildPresentGeometry,
  buildUnitBoulderGeometry,
  buildUnitRampGeometry,
  createProceduralMeshAssets,
  type ColoredGeometryPart,
  type ProceduralMeshAssets,
} from './meshFactory';
export { SkierRig } from './skierRig';
export {
  CLIPMAP_ANCHOR_RECENTER_THRESHOLD_M,
  CLIPMAP_COMMITTED_SIZE,
  CLIPMAP_GUARD_HALF,
  CLIPMAP_GUARD_TEXELS,
  CLIPMAP_LAYERS,
  CLIPMAP_LAYER_TEXELS,
  CLIPMAP_PATCH_QUADS,
  CLIPMAP_SPACINGS_M,
  CLIPMAP_TEX_MASK,
  CLIPMAP_TEX_SIZE,
  CLIPMAP_TOTAL_TEXELS,
  ClipmapDataStore,
  DEFAULT_CLIPMAP_STREAM_BUDGET_MS,
  linearToSRGBChannel,
  srgbToLinearChannel,
  type ClipmapDataStoreOptions,
} from './clipmapDataStore';
export {
  buildClipmapPatchBaseGeometry,
  CLIPMAP_LOD_RANGES_M,
  CLIPMAP_MORPH_STARTS_M,
  CLIPMAP_PATCH_TRIANGLE_COUNT,
  CLIPMAP_PATCH_VERT_SPAN,
  CLIPMAP_PATCH_VERTEX_COUNT,
  MAX_CLIPMAP_PATCHES,
  TerrainClipmap,
} from './terrainClipmap';
export {
  applyTreeBillboardProportions,
  computeScenerySlopeSinkY,
  computeStageSceneryDensity,
  evaluateSceneryRuleFitness,
  selectWinningSceneryRule,
  speciesToBillboardFrame,
  type SceneryEnvSignal,
  type TerrainLodTier,
} from './scenerySelector';
export {
  DEFAULT_SCENERY_STREAM_BUDGET_MS,
  packSceneryCellKey,
  SCENERY_CELL_SIZE_M,
  SceneryCellStreamer,
  type SceneryCellStreamerOptions,
  type SceneryProvider,
  type TileSceneryItem,
} from './sceneryCellStreamer';
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
export { SkyDome, type SkyDomeUniforms } from './skyDome';
export { CarveSprayVfx, MAX_CARVE_SPRAY_PARTICLES } from './carveSprayVfx';
export { DebugOverlay3D } from './debugOverlay';
export {
  CAMERA_FAR_M,
  CAMERA_NEAR_M,
  DEFAULT_TERRAIN_STREAM_BUDGET_MS,
  ThreeRenderer,
  type ThreeRendererOptions,
  type ThreeRendererStats,
} from './renderer';
