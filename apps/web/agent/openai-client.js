// Thin, reusable wrapper around OpenAI's structured-output Responses API.
// requirement-extractor, verifier, and planner all call this with their own
// instructions/schema — the HTTP mechanics (screenshot attach, strict JSON
// schema, error handling) live in exactly one place.

function extractResponseText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

/**
 * @param {Object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {string} args.instructions plain-text system instructions
 * @param {Object} args.payload JSON-serializable context (screenshot stripped automatically)
 * @param {string} [args.screenshotDataUrl] data:image/... URL, attached as input_image
 * @param {Object} args.schema JSON schema for the structured output
 * @param {string} args.schemaName
 * @param {number} [args.maxOutputTokens]
 * @returns {Promise<Object>} parsed structured output
 */
async function callStructured({ apiKey, model, instructions, payload, screenshotDataUrl = "", schema, schemaName, maxOutputTokens = 900 }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const promptPayload = payload && payload.page
    ? { ...payload, page: { ...payload.page, screenshotDataUrl: screenshotDataUrl ? "[attached separately]" : "" } }
    : payload;

  let lastParseError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: attempt === 0
          ? instructions
          : `${instructions}\n\nYour previous structured response was invalid or truncated JSON. Return only compact valid JSON matching the schema; keep all strings short.`,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: JSON.stringify(promptPayload) },
              ...(screenshotDataUrl ? [{ type: "input_image", image_url: screenshotDataUrl }] : [])
            ]
          }
        ],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        max_output_tokens: attempt === 0 ? maxOutputTokens : Math.min(Math.max(maxOutputTokens * 2, 1800), 3200)
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI ${schemaName} request failed: ${response.status} ${errorText.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = extractResponseText(data);
    if (!text) throw new Error(`OpenAI ${schemaName} returned no output text`);
    try {
      return JSON.parse(text);
    } catch (error) {
      lastParseError = error;
      if (attempt === 0) continue;
    }
  }
  throw new Error(`OpenAI ${schemaName} returned invalid JSON after retry: ${lastParseError?.message || "parse failed"}`);
}

module.exports = { callStructured, extractResponseText };
