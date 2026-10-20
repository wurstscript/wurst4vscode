# Map Preview - WC3 binary data layouts

Reference for the experimental map terrain and placement editor
(`wurst.mapPlacementEditor`, opened by the `wurst.previewMap` command). The host
is `src/features/mapPreview.ts`; the page is `src/webview/mapPreviewWebview.ts`
with the WebGL scene in `src/webview/mapTerrainScene.ts`. It is a custom editor
on an exploded map's `war3mapUnits.doo` and reads the rest of the folder as
context:

| File | Contents | Parser |
| --- | --- | --- |
| `war3map.w3e` | terrain tilepoint grid, heights, ground tiles, cliff layers | `parseW3eTerrain` in `mapPreview.ts` |
| `war3map.doo` | doodad / destructable placement (read-only) | `parseDoo` in `casc-ts/formats/doo.ts` |
| `war3mapUnits.doo` | unit / item / start-location placement (edited) | `parseDoo` / `serializeDoo` in `casc-ts/formats/doo.ts` |
| `war3map.w3u` / `.w3t` | custom units / items for the placement picker | `parseObjMod` in `casc-ts` |
| `war3map.w3i` | version, editor build and player slots, to pick the player-index layout | `parseW3i` in `casc-ts` |

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
| 6 | u8 | `cliff / layer` | bits 0-3 = `layerHeight`, bits 4-7 = cliff texture index |

The preview uses the last byte for cliff texture/layer. Wider records may contain extra
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

Doodads and special doodads only contribute positioned markers. Units with
`typeId === 'sloc'` are start locations.

### 2.1 Unit record (`war3mapUnits.doo`, version 8)

Header: `"W3do"`, i32 version (8), i32 subversion (11 since TFT, still 11 in
Reforged), i32 record count. Each record:

| Field | Type | Notes |
| --- | --- | --- |
| typeId | id | `sloc` = start location |
| variation | i32 | |
| x, y, z | f32 x 3 | z is the terrain height under (x, y) |
| angle | f32 | radians; World Editor's default is 270° |
| scale x, y, z | f32 x 3 | |
| skinId | id, optional | Reforged only. Detected by peeking: flags never exceed 7, a rawcode byte always does |
| flags | u8 | World Editor writes 2 for units/items, 3 for start locations |
| owner | i32 | player index; neutral hostile / passive are 24 / 27 in 24-player maps (1.29+), 12 / 15 in older ones |
| unknown | u8 x 2 | preserved, World Editor writes 0 |
| life %, mana % | i32 x 2 | -1 = default |
| item table pointer | i32 | subversion >= 11 only |
| drop sets | i32 count, then per set i32 count + (id, i32 chance) pairs | |
| gold amount | i32 | World Editor writes 12500 for units and items, 0 for start locations |
| target acquisition | f32 | -1 = default, -2 = camp |
| hero level | i32 | 1 by default |
| hero str / agi / int | i32 x 3 | subversion >= 11 only |
| inventory | i32 count, then (i32 slot, id) pairs | |
| abilities | i32 count, then (id, i32 autocast, i32 level) | |
| random type | i32 | 0: u8 x 3 level + u8 class (World Editor writes `01 00 00 00`); 1: i32 group, i32 position; 2: i32 count + (id, i32 chance) pairs. Any other value is a parse error |
| custom color | i32 | -1 = player color |
| waygate target | i32 | -1 = none |
| creation number | i32 | `editorId`; the `gg_unit_<id>_<n>` suffix in generated scripts |

`serializeDoo` writes the same layout back. Bytes the parser does not interpret
(the two unknown bytes, a special-doodad section's presence, trailing data) are
kept on the parsed object, so an untouched file round-trips byte-for-byte.

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

Doodads, units, items and starts are positional points sitting on the sampled
terrain height (bilinear over the tilepoint grid). Hovering a marker shows the
rawcode/name, owner and map coordinates. Orbit camera: drag. Zoom: wheel. Pan:
right-drag. The height slider applies vertical exaggeration.

## 4. Editing

The document is the parsed `war3mapUnits.doo` on the shared
`EditableBinaryEditorProvider`, so every edit is one VS Code undo step and Save
writes the file back.

- **Select**: click a unit, item or start-location marker. The side panel shows
  name, rawcode, owner and x/y/z.
- **Move**: drag the selected marker. The page casts a ray from the cursor onto
  the terrain; the host rounds x/y to whole units, clamps them to the map and
  takes z from the terrain height there.
- **Delete**: the Delete key or the panel button.
- **Owner**: a select in the panel for units. Items always belong to Neutral
  Passive, as in World Editor.
- **Place**: pick a type in the panel (game units/items from the compiler
  knowledge base plus the map's custom `.w3u`/`.w3t` objects, named through
  `war3map.wts` when needed), choose the owner, click the terrain. Place mode
  stays on for repeated placement until Escape.

New records copy what World Editor writes for a fresh placement: variation 0,
facing 270°, scale 1, flags 2, life/mana -1, item table -1, gold 12500,
acquisition -1, hero level 1 with zero attribute overrides, random block
`01 00 00 00`, colour and waygate -1, and creation number = highest existing + 1.
They get a skin id when the map's existing units (or, with none, its doodads, or
with neither, a w3i version >= 31) use skin ids. The player-index layout is the
24-player one when the map was saved by a World Editor newer than build 6060 (the
last pre-1.29 editor; the 12/24 player limit follows this build), when the w3i
version is >= 28, or when a w3i player slot above 12 or an owner index above 15
exists.

Safety: when the file is opened, `serializeDoo(parseDoo(bytes))` must equal the
original bytes, otherwise the editor opens read-only (for example a
signalling-NaN float, which comes back quieted). Before every save the serialized bytes
are re-parsed and compared field by field with the edited model; any difference
refuses the write.

Start locations stay read-only because their position also lives in
`war3map.w3i`'s player records. Doodads are read-only: they live in
`war3map.doo`, a second file the document does not own.

## 5. Known limitations

- Requires an exploded map directory containing `war3map.w3e` and
  `war3mapUnits.doo` (the command offers to create an empty one). `.w3x`/MPQ
  archives are not extracted here.
- Placement is free-form: buildings are not snapped to the pathing grid, and
  unit properties beyond owner and position (facing, hero data, drops,
  inventory) are kept but not editable yet.
- Markers are points, not real models. A future pass can instance doodad/unit
  models via the existing inline `mdxViewer` infrastructure.
- Cliff rendering is structural, not the full Warcraft III cliff-model set. It
  shows cliff levels, blockers, corners, and ramps well enough to navigate the
  map, but it does not instance the game's cliff pieces yet.
- Requires WebGL; WebGL2 is preferred for large maps.
