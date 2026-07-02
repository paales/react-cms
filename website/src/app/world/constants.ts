/**
 * World geometry. A tile is the atomic 16px grid cell — and the em
 * square of the world's type: every character advances exactly one
 * tile. A chunk is 32×32 tiles (512px) and is the content parton; a
 * bigChunk is 8×8 chunks (4096px) and is the LOAD unit — a cullable
 * parton that materializes its chunks only near the viewport. The
 * world is 8×8 bigChunks: 64×64 chunks, a 32768px-square plane.
 *
 * Chunk coordinates are signed: cx,cy ∈ [-32, 31], so chunk 0,0's
 * top-left corner is the exact center of the plane — where the
 * scroller starts.
 */
export const TILE_PX = 16
export const CHUNK_TILES = 32
export const CHUNK_PX = TILE_PX * CHUNK_TILES // 512

export const BIG_CHUNKS = 8
export const BIG_PX = BIG_CHUNKS * CHUNK_PX // 4096

export const WORLD_BIGS = 8
export const WORLD_PX = WORLD_BIGS * BIG_PX // 32768

/** bx,by ∈ [BIG_MIN, -BIG_MIN - 1] */
export const BIG_MIN = -WORLD_BIGS / 2

export const bigLeft = (b: number): number => (b - BIG_MIN) * BIG_PX

/** Plane coordinate of the world center — chunk 0,0's top-left. */
export const CENTER_PX = WORLD_PX / 2
