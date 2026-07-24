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
 * @param {boolean} [args.returnMeta] when true, returns { data, meta }
 * @returns {Promise<Object>} parsed structured output
 */
const MAX_MODEL_PACKET_BYTES = 32_768;

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

async function callStructured({ apiKey, model, instructions, payload, screenshotDataUrl = "", schema, schemaName, maxOutputTokens = 900, returnMeta = false, maxPayloadBytes = MAX_MODEL_PACKET_BYTES }) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const promptPayload = payload && payload.page
    ? { ...payload, page: { ...payload.page, screenshotDataUrl: screenshotDataUrl ? "[attached separately]" : "" } }
    : payload;
  const packetBytes = serializedBytes(promptPayload);
  if (packetBytes > Math.min(Number(maxPayloadBytes || MAX_MODEL_PACKET_BYTES), MAX_MODEL_PACKET_BYTES)) {
    const error = new Error(`Model packet exceeds the hard serialized budget (${packetBytes} bytes).`);
    error.code = "MODEL_PACKET_TOO_LARGE";
    error.packetBytes = packetBytes;
    error.maxPayloadBytes = Math.min(Number(maxPayloadBytes || MAX_MODEL_PACKET_BYTES), MAX_MODEL_PACKET_BYTES);
    throw error;
  }

  let lastParseError = null;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptStartedAt = Date.now();
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
    const outputText = extractResponseText(data);
    if (!outputText) {
      const incompleteReason = data?.incomplete_details?.reason || "";
      const outputTypes = (data?.output || []).flatMap((item) => (
        (item?.content || []).map((content) => content?.type).filter(Boolean)
      ));
      lastParseError = new Error(
        `OpenAI ${schemaName} returned no output text`
        + `${data?.status ? ` (status=${data.status})` : ""}`
        + `${incompleteReason ? ` (incomplete_reason=${incompleteReason})` : ""}`
        + `${outputTypes.length ? ` (output_types=${outputTypes.join(",")})` : ""}`
      );
      if (attempt === 0) continue;
      throw lastParseError;
    }
    try {
      const parsed = JSON.parse(outputText);
      const meta = {
        schemaName,
        model: data.model || model,
        durationMs: Date.now() - startedAt,
        attemptDurationMs: Date.now() - attemptStartedAt,
        attempts: attempt + 1,
        input_tokens: Number(data.usage?.input_tokens || 0),
        output_tokens: Number(data.usage?.output_tokens || 0),
        total_tokens: Number(data.usage?.total_tokens || 0),
        packetBytes
      };
      return returnMeta ? { data: parsed, meta } : parsed;
    } catch (error) {
      lastParseError = error;
      if (attempt === 0) continue;
    }
  }
  throw new Error(`OpenAI ${schemaName} returned invalid JSON after retry: ${lastParseError?.message || "parse failed"}`);
}

module.exports = { callStructured, extractResponseText, MAX_MODEL_PACKET_BYTES, serializedBytes };
