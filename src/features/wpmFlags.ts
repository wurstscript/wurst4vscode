'use strict';

/**
 * WPM cell flags shared by the host-side legend and the webview's picker.
 *
 * The primary movement bits are the long-established WPM meanings. The newer
 * names for 0x10/0x40/0x80 follow WC3's 1.31 pathing API rather than the old
 * WPM documentation's "unused"/"unknown" labels. In particular, 0x40 is a
 * pathing/floatability state, not proof that the terrain visibly contains
 * water; terrain water itself lives in W3E.
 */

export interface WpmFlagDefinition {
    bit: number;
    label: string;
    description: string;
    color: [number, number, number];
    primary?: boolean;
}

/** The only WPM header version with a documented byte layout. */
export const WPM_KNOWN_VERSION = 0;

export const WPM_FLAG_DEFS: readonly WpmFlagDefinition[] = [
    { bit: 0x01, label: 'Reserved', description: 'Reserved bit; standard maps normally leave it clear.', color: [160, 160, 160] },
    { bit: 0x02, label: 'Unwalkable', description: 'Ground units cannot walk through this cell.', color: [255, 0, 0], primary: true },
    { bit: 0x04, label: 'Unflyable', description: 'Flying units cannot pass through this cell.', color: [0, 255, 0], primary: true },
    { bit: 0x08, label: 'Unbuildable', description: 'Buildings cannot be placed on this cell.', color: [0, 0, 255], primary: true },
    { bit: 0x10, label: 'No Peon Harvest', description: 'Peons cannot harvest resources from this cell.', color: [240, 170, 40] },
    { bit: 0x20, label: 'Blighted', description: 'The cell is marked as blight.', color: [190, 80, 0] },
    { bit: 0x40, label: 'No Water / Unfloatable', description: 'The WC3 pathing state for no water / unfloatable movement. It is commonly set on ordinary dry ground; terrain water is stored in W3E.', color: [120, 120, 120] },
    { bit: 0x80, label: 'Unamphibious', description: 'The WC3 pathing state for amphibious movement.', color: [180, 80, 220] },
];

function blend(base: [number, number, number], overlay: [number, number, number]): [number, number, number] {
    return [
        (base[0] + overlay[0]) >> 1,
        (base[1] + overlay[1]) >> 1,
        (base[2] + overlay[2]) >> 1,
    ];
}

/** Returns the display RGB for a raw WPM flag byte. */
export function wpmCellRgb(flag: number): [number, number, number] {
    let rgb: [number, number, number] = [0, 0, 0];
    for (const definition of WPM_FLAG_DEFS) {
        if ((flag & definition.bit) === 0) continue;
        if (definition.primary) {
            rgb = [
                definition.bit === 0x02 ? definition.color[0] : rgb[0],
                definition.bit === 0x04 ? definition.color[1] : rgb[1],
                definition.bit === 0x08 ? definition.color[2] : rgb[2],
            ];
        } else {
            rgb = blend(rgb, definition.color);
        }
    }
    return rgb;
}

export function wpmFlagLabels(flag: number): string[] {
    return WPM_FLAG_DEFS.filter((definition) => (flag & definition.bit) !== 0).map((definition) => definition.label);
}

export function wpmColorTable(): Array<[number, number, number]> {
    return Array.from({ length: 256 }, (_, flag) => wpmCellRgb(flag));
}
