import test from "node:test";
import assert from "node:assert/strict";
import { detectKind } from "../src/lib/distill.js";

test("kind markers classify durable content", () => {
  assert.equal(detectKind("We decided to go with BuildKit registry cache instead of local layers"), "decision");
  assert.equal(detectKind("Turns out the root cause was the float64 join keys"), "gotcha");
  assert.equal(detectKind("Always write unit, never home, in prose"), "preference");
  assert.equal(detectKind("The daemon listens on port 4319 and the config lives at ~/.recall/config.json"), "reference");
});

test("kind markers pass on narration and questions", () => {
  assert.equal(detectKind("Perfect! Now let me run the tests again to check."), null);
  assert.equal(detectKind("can you look at the failing build for me please, it broke an hour ago"), null);
});
