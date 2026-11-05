import { VarintReader, VarintWriter } from "../varint";
import type { TransitMode, TransitTimetable } from "./types";

/**
 * EFTT: a compiled transit timetable on disk.
 *
 *   magic "EFTT" (u32 LE) · version (u32 LE) · gzip( body )
 *   body = u32 LE JSON length · JSON (names and ids) · varint stream (numbers)
 *
 * A city's timetable is a few megabytes before compression and is needed
 * whole by the first search, so it is one gzip stream rather than the
 * range-addressable tiles a road bundle uses. Numbers are stored as
 * differences from a neighbour wherever that keeps them small: consecutive
 * stop times within a trip, consecutive points along a ride.
 */
const MAGIC = 0x54544645; // "EFTT"
const VERSION = 1;
const COORDINATE_SCALE = 1_000_000;

type Strings = {
  feeds: TransitTimetable["feeds"];
  timezone: string;
  stopIds: string[];
  stopNames: string[];
  routeIds: string[];
  routeShortNames: string[];
  routeLongNames: string[];
  routeColors: string[];
  routeTextColors: string[];
  routeModes: TransitMode[];
  patternHeadsigns: string[];
};

export async function encodeTransitTimetable(t: TransitTimetable): Promise<Uint8Array> {
  const strings: Strings = {
    feeds: t.feeds, timezone: t.timezone, stopIds: t.stopIds, stopNames: t.stopNames, routeIds: t.routeIds,
    routeShortNames: t.routeShortNames, routeLongNames: t.routeLongNames, routeColors: t.routeColors,
    routeTextColors: t.routeTextColors, routeModes: t.routeModes, patternHeadsigns: t.patternHeadsigns,
  };
  const json = new TextEncoder().encode(JSON.stringify(strings));
  const w = new VarintWriter(1 << 20);

  w.push(t.stopCount);
  writeCoords(w, t.stopLat, t.stopLng);
  writeArray(w, t.stopFeed);

  w.push(t.routeCount);
  writeArray(w, t.routeFeed);

  w.pushSigned(t.firstDay);
  w.push(t.dayCount);
  w.push(t.serviceCount);
  writeArray(w, t.serviceFeed);
  w.push(t.serviceDays.length);
  for (const byte of t.serviceDays) w.push(byte);

  w.push(t.patternCount);
  writeArray(w, t.patternRoute);
  writeIncreasing(w, t.patternStopOffset);
  writeArray(w, t.patternStops);
  writeIncreasing(w, t.patternTripOffset);
  writeArray(w, t.patternGeometry);

  w.push(t.tripCount);
  writeArray(w, t.tripService);
  // Trip times: the first departure as is, every later value as a step from
  // the one before it. Offsets follow from the pattern layout on decode.
  for (let p = 0; p < t.patternCount; p += 1) {
    const stops = t.patternStopOffset[p + 1] - t.patternStopOffset[p];
    for (let trip = t.patternTripOffset[p]; trip < t.patternTripOffset[p + 1]; trip += 1) {
      const base = t.tripTimeOffset[trip];
      let previous = 0;
      for (let i = 0; i < stops * 2; i += 1) {
        const value = t.tripTimes[base + i];
        w.pushSigned(value - previous);
        previous = value;
      }
    }
  }

  writeIncreasing(w, t.transferOffset);
  writeArray(w, t.transferTo);
  writeArray(w, t.transferSeconds);
  writeArray(w, t.transferMeters);

  w.push(t.geometryCount);
  writeIncreasing(w, t.geometryHopOffset);
  writeIncreasing(w, t.hopPointOffset);
  writeArray(w, t.hopSource);
  const points = t.hopCoords.length / 2;
  let lastLng = 0;
  let lastLat = 0;
  for (let i = 0; i < points; i += 1) {
    const lng = Math.round(t.hopCoords[2 * i] * COORDINATE_SCALE);
    const lat = Math.round(t.hopCoords[2 * i + 1] * COORDINATE_SCALE);
    w.pushSigned(lng - lastLng);
    w.pushSigned(lat - lastLat);
    lastLng = lng;
    lastLat = lat;
  }

  const numbers = w.toUint8Array();
  const body = new Uint8Array(4 + json.length + numbers.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(numbers, 4 + json.length);
  const compressed = await gzip(body);
  const out = new Uint8Array(8 + compressed.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  out.set(compressed, 8);
  return out;
}

export async function decodeTransitTimetable(input: ArrayBuffer | Uint8Array): Promise<TransitTimetable> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8) throw new Error("Not a transit timetable: too short.");
  const head = new DataView(bytes.buffer, bytes.byteOffset, 8);
  if (head.getUint32(0, true) !== MAGIC) throw new Error("Not a transit timetable (EFTT).");
  const version = head.getUint32(4, true);
  if (version !== VERSION) throw new Error(`Transit timetable version ${version} is not supported by this release.`);
  const body = await gunzip(bytes.subarray(8));
  const jsonLength = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
  const strings = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + jsonLength))) as Strings;
  const r = new VarintReader(body, 4 + jsonLength);

  const stopCount = r.read();
  const { lat: stopLat, lng: stopLng } = readCoords(r, stopCount);
  const stopFeed = readArray(r, Uint16Array);
  const routeCount = r.read();
  const routeFeed = readArray(r, Uint16Array);
  const firstDay = r.readSigned();
  const dayCount = r.read();
  const serviceCount = r.read();
  const serviceFeed = readArray(r, Uint16Array);
  const serviceDays = new Uint8Array(r.read());
  for (let i = 0; i < serviceDays.length; i += 1) serviceDays[i] = r.read();

  const patternCount = r.read();
  const patternRoute = readArray(r, Uint32Array);
  const patternStopOffset = readIncreasing(r);
  const patternStops = readArray(r, Uint32Array);
  const patternTripOffset = readIncreasing(r);
  const patternGeometry = readArray(r, Uint32Array);

  const tripCount = r.read();
  const tripService = readArray(r, Uint32Array);
  const tripTimeOffset = new Uint32Array(tripCount);
  let totalTimes = 0;
  for (let p = 0; p < patternCount; p += 1) {
    const stops = patternStopOffset[p + 1] - patternStopOffset[p];
    for (let trip = patternTripOffset[p]; trip < patternTripOffset[p + 1]; trip += 1) {
      tripTimeOffset[trip] = totalTimes;
      totalTimes += stops * 2;
    }
  }
  const tripTimes = new Int32Array(totalTimes);
  for (let p = 0; p < patternCount; p += 1) {
    const stops = patternStopOffset[p + 1] - patternStopOffset[p];
    for (let trip = patternTripOffset[p]; trip < patternTripOffset[p + 1]; trip += 1) {
      const base = tripTimeOffset[trip];
      let previous = 0;
      for (let i = 0; i < stops * 2; i += 1) {
        previous += r.readSigned();
        tripTimes[base + i] = previous;
      }
    }
  }

  const transferOffset = readIncreasing(r);
  const transferTo = readArray(r, Uint32Array);
  const transferSeconds = readArray(r, Uint32Array);
  const transferMeters = readArray(r, Uint32Array);

  const geometryCount = r.read();
  const geometryHopOffset = readIncreasing(r);
  const hopPointOffset = readIncreasing(r);
  const hopSource = readArray(r, Uint8Array);
  const points = hopPointOffset[hopPointOffset.length - 1];
  const hopCoords = new Float64Array(points * 2);
  let lng = 0;
  let lat = 0;
  for (let i = 0; i < points; i += 1) {
    lng += r.readSigned();
    lat += r.readSigned();
    hopCoords[2 * i] = lng / COORDINATE_SCALE;
    hopCoords[2 * i + 1] = lat / COORDINATE_SCALE;
  }

  return {
    ...strings,
    stopCount, stopLat, stopLng, stopFeed,
    routeCount, routeFeed,
    firstDay, dayCount, serviceCount, serviceFeed, serviceDays,
    patternCount, patternRoute, patternStopOffset, patternStops, patternTripOffset, patternGeometry,
    tripCount, tripService, tripTimeOffset, tripTimes,
    transferOffset, transferTo, transferSeconds, transferMeters,
    geometryCount, geometryHopOffset, hopPointOffset, hopCoords, hopSource,
  };
}

function writeArray(w: VarintWriter, values: ArrayLike<number>) {
  w.push(values.length);
  for (let i = 0; i < values.length; i += 1) w.push(values[i]);
}

function writeIncreasing(w: VarintWriter, values: ArrayLike<number>) {
  w.push(values.length);
  let previous = 0;
  for (let i = 0; i < values.length; i += 1) {
    w.push(values[i] - previous);
    previous = values[i];
  }
}

function writeCoords(w: VarintWriter, lat: ArrayLike<number>, lng: ArrayLike<number>) {
  let lastLat = 0;
  let lastLng = 0;
  for (let i = 0; i < lat.length; i += 1) {
    const a = Math.round(lat[i] * COORDINATE_SCALE);
    const b = Math.round(lng[i] * COORDINATE_SCALE);
    w.pushSigned(a - lastLat);
    w.pushSigned(b - lastLng);
    lastLat = a;
    lastLng = b;
  }
}

type ArrayCtor<T> = { new (length: number): T };

function readArray<T extends { [index: number]: number }>(r: VarintReader, Ctor: ArrayCtor<T>): T {
  const length = r.read();
  const out = new Ctor(length);
  for (let i = 0; i < length; i += 1) out[i] = r.read();
  return out;
}

function readIncreasing(r: VarintReader): Uint32Array {
  const length = r.read();
  const out = new Uint32Array(length);
  let previous = 0;
  for (let i = 0; i < length; i += 1) {
    previous += r.read();
    out[i] = previous;
  }
  return out;
}

function readCoords(r: VarintReader, count: number) {
  const lat = new Float64Array(count);
  const lng = new Float64Array(count);
  let a = 0;
  let b = 0;
  for (let i = 0; i < count; i += 1) {
    a += r.readSigned();
    b += r.readSigned();
    lat[i] = a / COORDINATE_SCALE;
    lng[i] = b / COORDINATE_SCALE;
  }
  return { lat, lng };
}

async function gzip(bytes: Uint8Array) {
  if (!("CompressionStream" in globalThis)) throw new Error("This runtime cannot gzip a transit timetable.");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array) {
  if (!("DecompressionStream" in globalThis)) throw new Error("This browser cannot decompress the transit timetable.");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
