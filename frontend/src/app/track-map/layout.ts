/**
 * Where things are drawn. Coordinates follow the spec's track map image
 * (2000 × 347 px), so the drawing matches it one to one. They only matter
 * for the picture, so they live in the frontend.
 */

export interface Point {
  x: number;
  y: number;
}

export const VIEW_BOX = { width: 2000, height: 347 };

export const STATION_SIZE = { width: 196, height: 48 };

/** Centre of each platform and the yard. */
export const STATIONS: Record<string, Point> = {
  P3A: { x: 125, y: 68 },
  P3B: { x: 125, y: 280 },
  P2A: { x: 752, y: 68 },
  P2B: { x: 752, y: 280 },
  P1A: { x: 1379, y: 68 },
  P1B: { x: 1379, y: 280 },
  Y: { x: 1887, y: 68 },
};

/** The shaded boxes around each station's two platforms. */
export const STATION_GROUPS = [
  { name: 'S3', x: 12, y: 12, width: 225, height: 321 },
  { name: 'S2', x: 640, y: 12, width: 224, height: 321 },
  { name: 'S1', x: 1267, y: 12, width: 224, height: 321 },
];

/** The small circles where lines join or split. */
export const JUNCTIONS: Point[] = [
  { x: 438, y: 68 },
  { x: 432, y: 281 },
  { x: 1066, y: 68 },
  { x: 1071, y: 280 },
];

export interface BlockLine {
  id: string;
  /** Drawn from `from` to `to`, which is the direction of travel. */
  from: Point;
  to: Point;
  label: Point;
  /**
   * B1 and B2 are used both ways. When a vehicle is heading to this
   * station, it travels from `to` back to `from`.
   */
  backwardToward?: string;
}

export const BLOCK_LINES: BlockLine[] = [
  { id: 'B1', from: { x: 1477, y: 68 }, to: { x: 1789, y: 68 }, label: { x: 1633, y: 68 }, backwardToward: 'P1A' },
  { id: 'B2', from: { x: 1477, y: 276 }, to: { x: 1794, y: 93 }, label: { x: 1636, y: 184 }, backwardToward: 'P1B' },
  { id: 'B3', from: { x: 1281, y: 68 }, to: { x: 1066, y: 68 }, label: { x: 1176, y: 68 } },
  { id: 'B4', from: { x: 1281, y: 280 }, to: { x: 1066, y: 68 }, label: { x: 1080, y: 128 } },
  { id: 'B5', from: { x: 1066, y: 68 }, to: { x: 851, y: 68 }, label: { x: 956, y: 68 } },
  { id: 'B6', from: { x: 653, y: 68 }, to: { x: 438, y: 68 }, label: { x: 549, y: 68 } },
  { id: 'B7', from: { x: 438, y: 68 }, to: { x: 224, y: 68 }, label: { x: 328, y: 68 } },
  { id: 'B8', from: { x: 438, y: 68 }, to: { x: 224, y: 280 }, label: { x: 238, y: 222 } },
  { id: 'B9', from: { x: 224, y: 280 }, to: { x: 432, y: 281 }, label: { x: 325, y: 280 } },
  { id: 'B10', from: { x: 224, y: 68 }, to: { x: 432, y: 281 }, label: { x: 420, y: 222 } },
  { id: 'B11', from: { x: 432, y: 281 }, to: { x: 653, y: 280 }, label: { x: 546, y: 280 } },
  { id: 'B12', from: { x: 851, y: 280 }, to: { x: 1071, y: 280 }, label: { x: 958, y: 280 } },
  { id: 'B13', from: { x: 1071, y: 280 }, to: { x: 1281, y: 68 }, label: { x: 1273, y: 128 } },
  { id: 'B14', from: { x: 1071, y: 280 }, to: { x: 1281, y: 280 }, label: { x: 1179, y: 280 } },
];

export const BLOCK_LINE_BY_ID: ReadonlyMap<string, BlockLine> = new Map(BLOCK_LINES.map((b) => [b.id, b]));

/** The centre of the station whose box `p` is on, if any (block lines stop at the box). */
function stationAround(p: Point): Point | null {
  const reach = { x: STATION_SIZE.width / 2 + 2, y: STATION_SIZE.height / 2 + 2 };
  return Object.values(STATIONS).find((c) => Math.abs(p.x - c.x) <= reach.x && Math.abs(p.y - c.y) <= reach.y) ?? null;
}

/**
 * The points a vehicle runs through on each block, in the direction the line
 * is drawn. Lines stop at the edge of a station's box, but a stopped vehicle
 * is drawn at its centre. A run that touches a station goes from the centre
 * to the edge first (or back at the other end), then along the line: it
 * doesn't jump across half the box, and stays on the line where it slants.
 */
export const RUN_BY_BLOCK: ReadonlyMap<string, Point[]> = new Map(
  BLOCK_LINES.map((b) => {
    const [start, end] = [stationAround(b.from), stationAround(b.to)];
    return [b.id, [...(start ? [start] : []), b.from, b.to, ...(end ? [end] : [])]];
  }),
);
