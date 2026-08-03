import test from "node:test";
import assert from "node:assert/strict";
import {
  countCanonicalOccurrences,
  terminologyPromptDisclosure,
} from "../scripts/terminology-agent-eval.mjs";

test("live Agent evaluation counts canonical terms without accepting identifier prefixes or suffixes", () => {
  const text = [
    "Descheduler is ready.",
    "继续交给 Descheduler上面的接口。",
    "DeschedulerX must not count.",
    "XDescheduler must not count.",
    "_Descheduler must not count.",
    "最后再次确认 Descheduler。",
  ].join("\n");

  assert.equal(countCanonicalOccurrences(text, "Descheduler"), 3);
});

test("live Agent evaluation detects canonical and normalized alias leakage in context", () => {
  const terminology = {
    canonical: "Descheduler",
    aliases: ["dis scheduler", "Y调度"],
  };

  assert.deepEqual(terminologyPromptDisclosure("云原生 Kubernetes 调度周会", terminology), {
    canonical_supplied: false,
    aliases_supplied: false,
    disclosed_terms: [],
  });
  assert.deepEqual(terminologyPromptDisclosure("terms: Descheduler", terminology), {
    canonical_supplied: true,
    aliases_supplied: false,
    disclosed_terms: ["Descheduler"],
  });
  assert.deepEqual(terminologyPromptDisclosure("review DIS-SCHEDULER", terminology), {
    canonical_supplied: false,
    aliases_supplied: true,
    disclosed_terms: ["dis scheduler"],
  });
});
