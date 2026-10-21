import { ConditionKind, MAX_STORED_VALUES, packEdgeConditions } from "./conditional";

const rowsWith = (distinct: number) => Array.from({ length: distinct }, (_, i) => ({
  edge: i,
  kind: ConditionKind.access,
  value: `no @ (Mo-Fr 07:00-19:00); no @ (Sa ${String(i).padStart(7, "0")})`,
}));

describe("the limit on distinct conditional values", () => {
  it("holds exactly as many as the index can name", () => {
    const table = packEdgeConditions(rowsWith(MAX_STORED_VALUES))!;
    expect(table.values).toHaveLength(MAX_STORED_VALUES);
    expect(table.edges).toHaveLength(MAX_STORED_VALUES);
    expect(Math.max(...table.rules)).toBe(MAX_STORED_VALUES - 1);
  });

  it("refuses the one past it rather than losing a restriction", () => {
    // Dropping it would turn a restricted road into an open one, silently.
    expect(() => packEdgeConditions(rowsWith(MAX_STORED_VALUES + 1))).toThrow(/more than 65536 distinct/);
  });

  it("says what to do about it", () => {
    expect(() => packEdgeConditions(rowsWith(MAX_STORED_VALUES + 1))).toThrow(/tile-size-km/);
  });

  it("counts values, not rows: a repeated restriction costs nothing", () => {
    const many = Array.from({ length: MAX_STORED_VALUES * 2 }, (_, i) => ({
      edge: i, kind: ConditionKind.access, value: "no @ (Mo-Fr 07:00-19:00)",
    }));
    const table = packEdgeConditions(many)!;
    expect(table.values).toHaveLength(1);
    expect(table.edges).toHaveLength(MAX_STORED_VALUES * 2);
  });
});
