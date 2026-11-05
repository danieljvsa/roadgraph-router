import type { TransitTimetable } from "./types";

/**
 * RAPTOR (Delling, Pajor and Werneck, 2012): round-based public transit
 * search. Round k finds the earliest arrival at every stop using at most k
 * rides; between rounds, walking transfers spread each improvement to nearby
 * stops. It needs no preprocessing beyond the pattern layout the compiler
 * already produces, and it yields the best journey for each number of rides
 * as a side effect, which is the trade-off a traveller actually weighs.
 */

const INF = 0x7fffffff;

const enum Label {
  None = 0,
  Access = 1,
  Ride = 2,
  Walk = 3,
}

/** Trips of one service day, shifted onto the query day's clock. */
export type DayLayer = {
  /** Seconds to add to this layer's trip times: −86 400 for the previous day, give or take DST. */
  shift: number;
  /** 1 where a service runs on this layer's day. */
  active: Uint8Array;
};

export type RaptorQuery = {
  /** Stops the traveller can reach on foot, and when they get there (query-day seconds). */
  sources: { stop: number; arrival: number }[];
  /** Stops the destination can be walked to from, and how long that walk takes. */
  targets: Map<number, number>;
  layers: DayLayer[];
  /** 1 where a pattern may be used (mode and operator filters). */
  patternAllowed: Uint8Array;
  maxRides: number;
  /** Extra time allowed when changing vehicle at the same stop. */
  minTransferSeconds: number;
};

export type RaptorRide = {
  pattern: number;
  trip: number;
  shift: number;
  boardPos: number;
  alightPos: number;
  departure: number;
  arrival: number;
};

export type RaptorStep =
  | { kind: "access"; stop: number; arrival: number }
  | { kind: "ride"; ride: RaptorRide }
  | { kind: "walk"; from: number; to: number; seconds: number; meters: number };

export type RaptorJourney = {
  rides: number;
  /** Arrival at the destination, egress walk included. */
  arrival: number;
  egressStop: number;
  egressSeconds: number;
  steps: RaptorStep[];
};

/** Which patterns serve each stop, and at which position. Built once per timetable. */
export type StopPatternIndex = { offset: Uint32Array; pattern: Uint32Array; position: Uint32Array };

export function buildStopPatternIndex(t: TransitTimetable): StopPatternIndex {
  const counts = new Uint32Array(t.stopCount + 1);
  for (let i = 0; i < t.patternStops.length; i += 1) counts[t.patternStops[i] + 1] += 1;
  for (let s = 0; s < t.stopCount; s += 1) counts[s + 1] += counts[s];
  const offset = counts.slice();
  const cursor = counts.slice();
  const pattern = new Uint32Array(t.patternStops.length);
  const position = new Uint32Array(t.patternStops.length);
  for (let p = 0; p < t.patternCount; p += 1) {
    for (let i = t.patternStopOffset[p]; i < t.patternStopOffset[p + 1]; i += 1) {
      const s = t.patternStops[i];
      pattern[cursor[s]] = p;
      position[cursor[s]] = i - t.patternStopOffset[p];
      cursor[s] += 1;
    }
  }
  return { offset, pattern, position };
}

export function raptor(t: TransitTimetable, index: StopPatternIndex, query: RaptorQuery): RaptorJourney[] {
  const n = t.stopCount;
  const K = query.maxRides;
  const rounds = K + 1;
  const arr = new Int32Array(rounds * n).fill(INF);
  const kind = new Uint8Array(rounds * n);
  /** The round in which each label was set, so an inherited label can be traced back. */
  const origin = new Uint8Array(rounds * n);
  const pPattern = new Int32Array(rounds * n);
  const pTrip = new Int32Array(rounds * n);
  const pShift = new Int32Array(rounds * n);
  const pBoard = new Int32Array(rounds * n);
  const pFrom = new Int32Array(rounds * n);
  const best = new Int32Array(n).fill(INF);
  let marked = new Uint8Array(n);
  let markedList: number[] = [];

  for (const { stop, arrival } of query.sources) {
    if (arrival < arr[stop]) {
      arr[stop] = arrival;
      best[stop] = arrival;
      kind[stop] = Label.Access;
      if (!marked[stop]) { marked[stop] = 1; markedList.push(stop); }
    }
  }

  let targetBest = INF;
  const journeys: RaptorJourney[] = [];
  const qPos = new Int32Array(t.patternCount).fill(-1);

  for (let k = 1; k <= K && markedList.length > 0; k += 1) {
    const base = k * n;
    const prev = (k - 1) * n;
    // Labels carry over: a stop reachable with k − 1 rides is reachable with k.
    arr.copyWithin(base, prev, prev + n);
    kind.copyWithin(base, prev, prev + n);
    origin.copyWithin(base, prev, prev + n);

    // Patterns to scan, each from the earliest marked stop along it.
    const queue: number[] = [];
    for (const s of markedList) {
      for (let i = index.offset[s]; i < index.offset[s + 1]; i += 1) {
        const p = index.pattern[i];
        if (!query.patternAllowed[p]) continue;
        const pos = index.position[i];
        if (qPos[p] < 0) { qPos[p] = pos; queue.push(p); }
        else if (pos < qPos[p]) qPos[p] = pos;
      }
    }
    for (const s of markedList) marked[s] = 0;
    markedList = [];
    const improvedByRide: number[] = [];

    for (const p of queue) {
      const from = qPos[p];
      qPos[p] = -1;
      const stopBase = t.patternStopOffset[p];
      const length = t.patternStopOffset[p + 1] - stopBase;
      let trip = -1;
      let shift = 0;
      let boardPos = -1;
      let tripBase = 0;
      for (let pos = from; pos < length; pos += 1) {
        const s = t.patternStops[stopBase + pos];
        if (trip >= 0) {
          const arrival = t.tripTimes[tripBase + 2 * pos] + shift;
          if (arrival < best[s] && arrival < targetBest) {
            arr[base + s] = arrival;
            best[s] = arrival;
            kind[base + s] = Label.Ride;
            origin[base + s] = k;
            pPattern[base + s] = p;
            pTrip[base + s] = trip;
            pShift[base + s] = shift;
            pBoard[base + s] = boardPos;
            if (!marked[s]) { marked[s] = 1; markedList.push(s); improvedByRide.push(s); }
          }
        }
        // Could an earlier trip be caught here, given how we got to this stop last round?
        const reached = arr[prev + s];
        if (reached === INF) continue;
        const ready = reached + (kind[prev + s] === Label.Ride ? query.minTransferSeconds : 0);
        if (trip >= 0 && t.tripTimes[tripBase + 2 * pos + 1] + shift <= ready) continue;
        const next = earliestTrip(t, query.layers, p, pos, ready);
        if (next && (trip < 0 || next.departure < t.tripTimes[tripBase + 2 * pos + 1] + shift)) {
          trip = next.trip;
          shift = next.shift;
          boardPos = pos;
          tripBase = t.tripTimeOffset[trip];
        }
      }
    }

    // Walking transfers from every stop a ride improved this round.
    for (const s of improvedByRide) {
      const start = arr[base + s];
      for (let i = t.transferOffset[s]; i < t.transferOffset[s + 1]; i += 1) {
        const to = t.transferTo[i];
        const arrival = start + t.transferSeconds[i];
        if (arrival < best[to] && arrival < targetBest && arrival < arr[base + to]) {
          arr[base + to] = arrival;
          best[to] = arrival;
          kind[base + to] = Label.Walk;
          origin[base + to] = k;
          pFrom[base + to] = s;
          pTrip[base + to] = i; // the transfer used, for its length
          if (!marked[to]) { marked[to] = 1; markedList.push(to); }
        }
      }
    }

    // Did this round reach the destination sooner than any earlier one?
    let roundBest = INF;
    let roundStop = -1;
    for (const [stop, egress] of query.targets) {
      const arrival = arr[base + stop];
      if (arrival === INF) continue;
      // A stop reached on foot from the origin and left on foot is not a
      // public transport journey: walking the whole way is offered separately,
      // and counting it here would prune every ride slower than the walk.
      if (origin[base + stop] === 0) continue;
      if (arrival + egress < roundBest) { roundBest = arrival + egress; roundStop = stop; }
    }
    if (roundStop >= 0 && roundBest < targetBest) {
      targetBest = roundBest;
      journeys.push({ rides: k, arrival: roundBest, egressStop: roundStop, egressSeconds: query.targets.get(roundStop)!, steps: trace(k, roundStop) });
    }
  }
  return journeys;

  function trace(round: number, stop: number): RaptorStep[] {
    const steps: RaptorStep[] = [];
    let k = round;
    let s = stop;
    for (let guard = 0; guard < 4 * (K + 2); guard += 1) {
      k = origin[k * n + s];
      const at = k * n + s;
      const label = kind[at];
      if (label === Label.Access) {
        steps.push({ kind: "access", stop: s, arrival: arr[at] });
        break;
      }
      if (label === Label.Walk) {
        const from = pFrom[at];
        const transfer = pTrip[at];
        steps.push({ kind: "walk", from, to: s, seconds: t.transferSeconds[transfer], meters: t.transferMeters[transfer] });
        s = from;
        continue;
      }
      if (label === Label.Ride) {
        const p = pPattern[at];
        const trip = pTrip[at];
        const shift = pShift[at];
        const boardPos = pBoard[at];
        const stopBase = t.patternStopOffset[p];
        let alightPos = boardPos + 1;
        while (t.patternStops[stopBase + alightPos] !== s) alightPos += 1;
        const tripBase = t.tripTimeOffset[trip];
        steps.push({
          kind: "ride",
          ride: {
            pattern: p, trip, shift, boardPos, alightPos,
            departure: t.tripTimes[tripBase + 2 * boardPos + 1] + shift,
            arrival: t.tripTimes[tripBase + 2 * alightPos] + shift,
          },
        });
        s = t.patternStops[stopBase + boardPos];
        k -= 1;
        continue;
      }
      throw new Error("Transit search lost track of a journey; this is a bug.");
    }
    return steps.reverse();
  }
}

/** The first trip of pattern p leaving position pos at or after `time`, on any day layer. */
function earliestTrip(t: TransitTimetable, layers: DayLayer[], p: number, pos: number, time: number) {
  const first = t.patternTripOffset[p];
  const last = t.patternTripOffset[p + 1];
  let bestTrip = -1;
  let bestDeparture = INF;
  let bestShift = 0;
  for (const layer of layers) {
    const wanted = time - layer.shift;
    // Departures at a given position are sorted within a pattern.
    let lo = first;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (t.tripTimes[t.tripTimeOffset[mid] + 2 * pos + 1] < wanted) lo = mid + 1;
      else hi = mid;
    }
    for (let trip = lo; trip < last; trip += 1) {
      const departure = t.tripTimes[t.tripTimeOffset[trip] + 2 * pos + 1] + layer.shift;
      if (departure >= bestDeparture) break;
      if (layer.active[t.tripService[trip]]) {
        bestTrip = trip;
        bestDeparture = departure;
        bestShift = layer.shift;
        break;
      }
    }
  }
  return bestTrip < 0 ? null : { trip: bestTrip, departure: bestDeparture, shift: bestShift };
}
