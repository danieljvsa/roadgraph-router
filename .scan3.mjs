import { createOSMStream } from "osm-pbf-parser-node";
const BLOCKED = new Set(["no", "private", "destination", "customers", "delivery", "permit", "agricultural", "forestry"]);
const ACCESS = ["access", "vehicle", "motor_vehicle", "motorcar", "motorcycle", "hgv", "foot", "bicycle"];
let reopenable = 0, reopenExamples = [];
let condRestrictions = 0, condRestrictionExamples = [];
let totalRestrictions = 0;
for await (const e of createOSMStream(process.argv[2])) {
  if (e.type === "way" && e.tags?.highway) {
    // Plain tags shut it, a conditional could open it again.
    let shut = false;
    for (const key of ACCESS) if (e.tags[key] !== undefined) shut = BLOCKED.has(e.tags[key]);
    if (shut) {
      for (const key of ACCESS) {
        const value = e.tags[`${key}:conditional`];
        if (value && /^\s*(yes|designated|permissive)\s*@/i.test(value)) {
          reopenable += 1;
          if (reopenExamples.length < 4) reopenExamples.push(`${e.tags.highway}: ${key}=${e.tags[key]} + ${key}:conditional=${value}`.slice(0, 100));
          break;
        }
      }
    }
  }
  if (e.type === "relation" && e.tags?.type === "restriction") {
    totalRestrictions += 1;
    const conditional = Object.keys(e.tags).find((k) => k.startsWith("restriction") && k.endsWith(":conditional"));
    if (conditional) {
      condRestrictions += 1;
      if (condRestrictionExamples.length < 4) condRestrictionExamples.push(`${conditional}=${e.tags[conditional]}`.slice(0, 90));
    }
  }
}
console.log("ways a conditional could reopen:", reopenable);
for (const x of reopenExamples) console.log("   ", x);
console.log("turn restriction relations:", totalRestrictions, "of which conditional:", condRestrictions);
for (const x of condRestrictionExamples) console.log("   ", x);
