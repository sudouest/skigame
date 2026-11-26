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
  buildMergedTexturedGeometry,
  type TexturedGeometryPart,
  type TileMappingSpec,
} from './models/proceduralModelUtils';
