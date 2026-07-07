# Map Preview - WC3 binary data layouts

Reference for the experimental map terrain preview (`wurst.previewMap`,
`src/features/mapPreview.ts`). It renders an exploded map directory from:

| File | Contents | Parser |
| --- | --- | --- |
| `war3map.w3e` | terrain tilepoint grid, heights, ground tiles, cliff layers | `parseW3eTerrain` in `mapPreview.ts` |
| `war3map.doo` | doodad / destructable placement | `parseDoo` in `casc-ts/formats/doo.ts` |
| `war3mapUnits.doo` | unit / item / start-location placement | `parseDoo` in `casc-ts/formats/doo.ts` |

All multi-byte integers/floats are little-endian. `id` means four ASCII bytes
(a rawcode, for example `Hpea`). Offsets below are sequential; there is no
padding.

## 1. `war3map.w3e` - terrain / heightmap

The header is also parsed by `parseW3e` in `src/features/mapDataPreview.ts`.
The 3D preview re-parses it including the full tilepoint array.

### 1.1 Header

| Field | Type | Notes |
| --- | --- | --- |
| magic | id (4) | `"W3E!"` |
| version | i32 | commonly `11`; newer maps may use wider tilepoint records |
| tileset | u8 char | single tileset letter, for example `L` |
| customTileset | i32 | `0`/`1` boolean |
| groundTileCount | i32 | N |
| groundTiles | id x N | ground tile rawcodes |
| cliffTileCount | i32 | M |
| cliffTiles | id x M | cliff tile rawcodes |
| width | i32 | tilepoint columns = map tiles in X + 1 |
| height | i32 | tilepoint rows = map tiles in Y + 1 |
| centerOffsetX | f32 | world X of tilepoint column 0 |
| centerOffsetY | f32 | world Y of tilepoint row 0 |

### 1.2 Tilepoint array

Immediately after the header: `width * height` tilepoints, stored row-major
from the south-west corner: column 0..width-1 for row 0, then row 1, etc.

The classic record is 7 bytes. Some newer maps use a wider record; the preview
derives the stride from the payload size.

| Bytes | Type | Field | Decode |
| --- | --- | --- | --- |
| 0-1 | i16 | `groundHeight` | signed, centered at `0x2000` |
| 2-3 | u16 | `waterLevel & flags` | bits 0-13 = water level, bit 14 = edge/boundary flag |
| 4 | u8 | `flags / texture` | bits 0-3 = flags, bits 4-7 = ground texture index |
| 5 | u8 | `textureDetails` | variation/detail |
| 6 | u8 | `cliff / layer` | bits 0-3 = cliff texture index, bits 4-7 = `layerHeight` in classic records |

The preview uses byte 6 for cliff texture/layer. Wider records may contain extra
detail bytes after the classic payload, but those bytes are not treated as cliff
levels.

### 1.3 Final terrain height

The visible terrain height combines fine ground height with the discrete cliff
layer. One cliff layer step is 128 world units; `layerHeight == 2` is the base
layer:

```text
finalZ = (groundHeight - 0x2000) / 4 + (layerHeight - 2) * 128
```

Heights are quantized to `Int16` for compact webview transport.

### 1.4 World to grid coordinates

Each tile is 128 world units. The world position of tilepoint `(i, j)`:

```text
worldX = centerOffsetX + i * 128
worldY = centerOffsetY + j * 128
```

To place a doodad/unit:

```text
i = (doodad.x - centerOffsetX) / 128
j = (doodad.y - centerOffsetY) / 128
```

## 2. `.doo` placement

`war3map.doo` and `war3mapUnits.doo` both start with magic `"W3do"`, version,
and subversion. The filename selects the doodad or unit layout in `parseDoo`.

The terrain preview consumes:

- Doodads: `typeId`, `x`, `y`, `z`, `flags`.
- Special doodads: `typeId`, `x`, `y`, `z`.
- Units: `typeId`, `x`, `y`, `z`, `ownerIndex`, `flags`.
- Units with `typeId === 'sloc'` are rendered as start-location markers.

## 3. Rendering

The webview is a raw-WebGL scene. The terrain uses duplicated per-cell vertices
so every map tile can carry its own texture and atlas variation. The host loads
`TerrainArt\Terrain.slk` from CASC, resolves each ground tile rawcode to its
game texture, decodes BLP/DDS/TGA to PNG, and packs those images into a small
atlas. Each terrain texture is treated as a 4x4 tile atlas; the preview chooses a
subtile from the same-neighbor mask around the current tile, with
`textureDetails` as a fallback. If CASC is unavailable, it falls back to
deterministic terrain colors.

Cliff levels feed the actual mesh height. High cliff levels tint the terrain
surface, a darkened cliff-face overlay is drawn where neighboring cells differ by
cliff level, and ramp-flagged terrain is tinted warm so passable cliff ramps are
visible while scanning the scene.

Water uses the W3E water-level field plus the water flag to draw a shallow
transparent mesh above affected terrain cells.

Doodads, units, and starts are positional points sitting on the sampled terrain
height. Hovering a marker shows the rawcode/name, owner when available, and map
coordinates. Orbit camera: drag. Zoom: wheel. Pan: right-drag. The height slider
applies vertical exaggeration.

## 4. Known limitations

- Requires an exploded map directory containing `war3map.w3e` and optionally the
  `.doo` files. `.w3x`/MPQ archives are not extracted here.
- Markers are points, not real models. A future pass can instance doodad/unit
  models via the existing inline `mdxViewer` infrastructure.
- Cliff rendering is structural, not the full Warcraft III cliff-model set. It
  shows cliff levels, blockers, corners, and ramps well enough to navigate the
  map, but it does not instance the game's cliff pieces yet.
- Requires WebGL; WebGL2 is preferred for large maps.
