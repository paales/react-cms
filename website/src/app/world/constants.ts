/**
 * World geometry. A tile is the atomic 16px grid cell — and the em
 * square of the world's type: every character advances exactly one
 * tile. A chunk is 32×32 tiles (512px) and is the content parton. The
 * plane above the chunk is a QUADTREE of cullable quad tiles: the
 * 32768px world splits into four 16384px roots, each subdividing in
 * half per level down to 1024px leaves that place 2×2 chunks. Every
 * level materializes its four children only near the viewport, so the
 * placed tree is O(visible chunks + log₂ world) — a viewport costs
 * the same whether the plane is 32768px or a million.
 *
 * Chunk coordinates are signed: cx,cy ∈ [-32, 31], so chunk 0,0's
 * top-left corner is the exact center of the plane — where the
 * scroller starts.
 */
export const TILE_PX = 16
export const CHUNK_TILES = 32
export const CHUNK_PX = TILE_PX * CHUNK_TILES // 512

export const WORLD_PX = 32768
/** One quadtree root — a quarter of the plane. */
export const QUAD_ROOT_PX = WORLD_PX / 2 // 16384
/** The smallest quad tile; its four children are chunks. */
export const QUAD_LEAF_PX = CHUNK_PX * 2 // 1024

/** Plane coordinate of the world center — chunk 0,0's top-left. */
export const CENTER_PX = WORLD_PX / 2

/** The cold-seed viewport estimate: a 1920×1080 box centered on the
 *  plane's center. Every quad level and the chunks seed off the same
 *  test — a tile renders content before any client measurement iff
 *  its box intersects this estimate. Larger real viewports see the
 *  outer ring as skeletons for one measurement round-trip. */
const SEED_HALF_W = 960
const SEED_HALF_H = 540

/** Does the plane-coordinate box [x, x+size)² intersect the seed
 *  viewport estimate? */
export const seedIntersects = (x: number, y: number, size: number): boolean =>
  x < CENTER_PX + SEED_HALF_W &&
  x + size > CENTER_PX - SEED_HALF_W &&
  y < CENTER_PX + SEED_HALF_H &&
  y + size > CENTER_PX - SEED_HALF_H

/** A chunk's plane-coordinate box origin. */
export const chunkOrigin = (c: number): number => CENTER_PX + c * CHUNK_PX
