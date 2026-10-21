/**
 * How much of a region's conditional tagging this library acts on.
 *
 * Two of the limitations in the README are decisions rather than oversights,
 * and both rest on counting how rare the thing is. This is the counting, kept
 * so the numbers can be checked against another extract rather than taken on
 * trust.
 *
 *   node scripts/analysis/conditional-coverage.mjs portugal-latest.osm.pbf
 *
 * It reports, for one extract:
 *
 *   - ways a conditional value could reopen, which this library does not do:
 *     the plain tags shut the road and a conditional would open it again;
 *   - turn restriction relations carrying `restriction:conditional`, which
 *     are enforced at every hour rather than only at theirs.
 *
 * Measured on Portugal in October 2026: 27 reopenable ways, and 1 conditional
 * turn restriction out of 26,599.
 *
 * Not part of the published package; it is a development utility.
 */
import { createOSMStream } from "osm-pbf-parser-node";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/analysis/conditional-coverage.mjs <region.osm.pbf>");
  process.exit(1);
}

/** Values that shut a road to the vehicle whose key carries them. */
const BLOCKED = new Set(["no", "private", "destination", "customers", "delivery", "permit", "agricultural", "forestry"]);
/** The access ladder, general first, so the last one present wins. */
const ACCESS = ["access", "vehicle", "motor_vehicle", "motorcar", "motorcycle", "hgv", "foot", "bicycle"];
const OPENS = /^\s*(yes|designated|permissive)\s*@/i;

let reopenable = 0;
let restrictions = 0;
let conditionalRestrictions = 0;
const examples = { reopenable: [], restrictions: [] };

for await (const entity of createOSMStream(file)) {
  if (entity.type === "way" && entity.tags?.highway) {
    let shut = false;
    for (const key of ACCESS) if (entity.tags[key] !== undefined) shut = BLOCKED.has(entity.tags[key]);
    if (shut) {
      for (const key of ACCESS) {
        if (!OPENS.test(entity.tags[`${key}:conditional`] ?? "")) continue;
        reopenable += 1;
        if (examples.reopenable.length < 5) {
          examples.reopenable.push(`${entity.tags.highway}: ${key}=${entity.tags[key]} + ${key}:conditional=${entity.tags[`${key}:conditional`]}`);
        }
        break;
      }
    }
  }
  if (entity.type === "relation" && entity.tags?.type === "restriction") {
    restrictions += 1;
    const conditional = Object.keys(entity.tags).find((key) => key.startsWith("restriction") && key.endsWith(":conditional"));
    if (conditional) {
      conditionalRestrictions += 1;
      if (examples.restrictions.length < 5) examples.restrictions.push(`${conditional}=${entity.tags[conditional]}`);
    }
  }
}

const show = (title, lines) => { if (lines.length) { console.log(`  ${title}`); for (const line of lines) console.log(`    ${line.slice(0, 110)}`); } };

console.log(`\n${file}\n`);
console.log(`ways a conditional value could reopen: ${reopenable}`);
show("for example:", examples.reopenable);
console.log(`\nturn restriction relations: ${restrictions}`);
console.log(`  of those, carrying a conditional: ${conditionalRestrictions}`);
show("for example:", examples.restrictions);
