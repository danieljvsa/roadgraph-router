/**
 * The lorry a truck route iscalculated for.
 *
 * A caller who says nothing still gets a vehicle, because refusing to route
 * until a form is filled in is worse than routing for a stated default. The
 * danger is not having a default, it is a default nobody can see, so the
 * resolved dimensions ride on every truck route.
 *
 * There is no globally neutral lorry. EU general circulation is 2.55m wide,
 * 16.5m long articulated and 40t on a five-axle vehicle no taller than 4m;
 * a US semi is wider and taller at 2.59m and about 4.11m but lighter at
 * 36.3t, and Nordic combinations run longer and heavier still. Guessing large
 * on every axis is not safe either: `maxheight=4.0` and `maxweight=40` are
 * among the commonly tagged limits in Europe, so a 4.2m default would refuse
 * bridges an ordinary lorry crosses daily. The presets below are therefore
 * vehicle classes a caller picks, not a guess about where they are.
 */

export type VehicleDimensions = {
  heightMeters: number;
  widthMeters: number;
  lengthMeters: number;
  weightTonnes: number;
};

export const VEHICLE_PRESETS: Record<string, VehicleDimensions> = {
  van: { heightMeters: 2.6, widthMeters: 2.1, lengthMeters: 6.0, weightTonnes: 3.5 },
  rigid: { heightMeters: 3.8, widthMeters: 2.55, lengthMeters: 10.0, weightTonnes: 18 },
  articulated: { heightMeters: 4.0, widthMeters: 2.55, lengthMeters: 16.5, weightTonnes: 40 },
  "road-train": { heightMeters: 4.0, widthMeters: 2.55, lengthMeters: 18.75, weightTonnes: 44 },
  "us-semi": { heightMeters: 4.11, widthMeters: 2.59, lengthMeters: 22.0, weightTonnes: 36.3 },
};

/**
 * What a truck route uses when nothing else says otherwise. An articulated
 * lorry is what most people mean by "truck" for freight, and it matches the
 * envelope European road data is implicitly tagged against.
 */
export const DEFAULT_VEHICLE_PRESET = "articulated";

/** A preset name, a full set of dimensions, or a preset with fields overridden. */
export type VehicleInput = string | Partial<VehicleDimensions> & { preset?: string };

export function vehiclePreset(name: string): VehicleDimensions {
  const preset = VEHICLE_PRESETS[name];
  if (!preset) throw new Error(`Unknown vehicle preset "${name}". Available: ${Object.keys(VEHICLE_PRESETS).join(", ")}.`);
  return { ...preset };
}

/**
 * Resolves what a caller asked for against a preset, so `{ preset:
 * "articulated", heightMeters: 4.3 }` is a standard lorry with a taller load
 * rather than a vehicle with three dimensions missing.
 */
export function resolveVehicle(input: VehicleInput | undefined, fallbackPreset = DEFAULT_VEHICLE_PRESET): VehicleDimensions {
  if (typeof input === "string") return vehiclePreset(input);
  const base = vehiclePreset(input?.preset ?? fallbackPreset);
  if (!input) return base;
  const resolved: VehicleDimensions = {
    heightMeters: input.heightMeters ?? base.heightMeters,
    widthMeters: input.widthMeters ?? base.widthMeters,
    lengthMeters: input.lengthMeters ?? base.lengthMeters,
    weightTonnes: input.weightTonnes ?? base.weightTonnes,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Vehicle ${name} must be a positive number.`);
  }
  return resolved;
}
