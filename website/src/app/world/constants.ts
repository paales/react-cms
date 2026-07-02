/**
 * World geometry. A tile is the atomic 16px grid cell; a chunk is
 * 32×32 tiles (512px square) and is the parton unit — one `<WorldChunk>`
 * per chunk, individually addressable and refetchable. Larger
 * aggregates (8×8 chunks = a bigChunk) window the world so only the
 * region around the camera is in the tree.
 */
export const TILE_PX = 16
export const CHUNK_TILES = 32
export const CHUNK_PX = TILE_PX * CHUNK_TILES // 512

/** Chunks rendered per axis around the origin: cx,cy ∈ [-RADIUS, RADIUS]. */
export const WORLD_RADIUS = 2
export const WORLD_CHUNKS = WORLD_RADIUS * 2 + 1
export const PLANE_PX = WORLD_CHUNKS * CHUNK_PX
