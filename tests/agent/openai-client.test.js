const test = require("node:test");
const assert = require("node:assert/strict");

const { callStructured } = require("../../apps/web/agent/openai-client");
const { selectCandidate } = require("../../apps/web/agent/select-candidate");

test("authenticated empty model output is retried before being reported as unavailable", async () => {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return {
        ok: true,
        json: async () => ({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: []
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: "test-model",
        output_text: JSON.stringify({ candidateId: "obs_1:candidate_2" }),
        usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }
      })
    };
  };

  try {
    const result = await callStructured({
      apiKey: "test-key",
      model: "test-model",
      instructions: "Select one candidate.",
      payload: { candidates: ["obs_1:candidate_2"] },
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId"],
        properties: { candidateId: { type: "string", enum: ["obs_1:candidate_2"] } }
      },
      schemaName: "checkout_candidate_selection",
      maxOutputTokens: 400,
      returnMeta: true
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].max_output_tokens, 400);
    assert.equal(requests[1].max_output_tokens, 1800);
    assert.equal(result.data.candidateId, "obs_1:candidate_2");
    assert.equal(result.meta.attempts, 2);
    assert.equal(result.meta.total_tokens, 28);
  } finally {
    global.fetch = previousFetch;
  }
});

test("an empty current candidate set never calls OpenAI", async () => {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("fetch must not run");
  };
  try {
    await assert.rejects(
      selectCandidate({
        apiKey: "test-key",
        model: "test-model",
        goal: { goalId: "goal_bundle", semanticGoal: "decline bundle" },
        candidates: [],
        observation: { observationId: "obs_empty" }
      }),
      (error) => error.code === "NO_CURRENT_CANDIDATES"
    );
    assert.equal(calls, 0);
  } finally {
    global.fetch = previousFetch;
  }
});
