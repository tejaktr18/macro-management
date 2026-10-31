// Food photo / description -> structured nutrition estimate, via Amazon Bedrock
// (Converse API with a forced tool call so the model must return valid JSON).
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const SYSTEM = `You are a nutrition estimator for one user: a 28-year-old Indian man in Seattle on a fat-loss cut.
He eats home-cooked Indian food (air-fried chicken thigh, rice with mixed veg, light onion-tomato curry, dal, roti, paneer)
and Indian restaurant food (biryani, butter chicken, naan, dosa, tandoori).

Identify each distinct food in the photo and/or description, estimate the eaten portion in grams, and estimate
calories and macros for that portion. Rules:
- Be realistic about restaurant food: account for oil, ghee, butter and cream that you cannot see.
- If the user says how much they ate (e.g. "ate half"), apply it.
- If an item is ambiguous, pick the most likely Indian/US version and say so in "assumption".
- Never refuse; give your best estimate and set confidence accordingly.
Always answer by calling the record_meal tool.`;

const TOOL = {
  toolSpec: {
    name: 'record_meal',
    description: 'Record the estimated foods and nutrition for one meal.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          meal_name: { type: 'string', description: 'Short name for the whole meal, e.g. "Chicken biryani + raita"' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                grams: { type: 'number', description: 'Estimated eaten portion in grams' },
                kcal: { type: 'number' },
                protein_g: { type: 'number' },
                carbs_g: { type: 'number' },
                fat_g: { type: 'number' },
                assumption: { type: 'string', description: 'What you assumed, if anything' },
              },
              required: ['name', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
            },
          },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          notes: { type: 'string', description: 'One short tip or caveat for the user' },
        },
        required: ['meal_name', 'items', 'confidence'],
      },
    },
  },
};

const r1 = (x) => Math.round(Number(x) || 0);

export function normalize(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, 20).map((it) => ({
    name: String(it.name || 'Food').slice(0, 80),
    grams: r1(it.grams),
    kcal: r1(it.kcal),
    p: r1(it.protein_g ?? it.p),
    c: r1(it.carbs_g ?? it.c),
    f: r1(it.fat_g ?? it.f),
    assumption: it.assumption ? String(it.assumption).slice(0, 200) : undefined,
  }));
  return {
    name: String(raw?.meal_name || items.map((i) => i.name).join(' + ') || 'Meal').slice(0, 100),
    items,
    confidence: ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : 'medium',
    notes: raw?.notes ? String(raw.notes).slice(0, 300) : '',
  };
}

export function bedrockAnalyzer({ region, modelId }) {
  const client = new BedrockRuntimeClient({ region });
  return async function analyze({ imageBytes, imageFormat = 'jpeg', text }) {
    const content = [];
    if (imageBytes) content.push({ image: { format: imageFormat, source: { bytes: imageBytes } } });
    content.push({ text: text ? `What I ate: ${text}` : 'Estimate this meal.' });
    const t0 = Date.now();
    const res = await client.send(new ConverseCommand({
      modelId,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content }],
      toolConfig: { tools: [TOOL], toolChoice: { tool: { name: 'record_meal' } } },
      inferenceConfig: { maxTokens: 1500 },
    }));
    const block = (res.output?.message?.content || []).find((b) => b.toolUse);
    if (!block) throw new Error('Model did not return a record_meal tool call');
    return {
      ...normalize(block.toolUse.input),
      meta: { modelId, ms: Date.now() - t0, usage: res.usage },
    };
  };
}

// Deterministic stand-in for local development and tests (no AWS calls).
export function mockAnalyzer() {
  return async function analyze({ imageBytes, text }) {
    return {
      ...normalize({
        meal_name: text ? `Mock: ${text}` : 'Mock: chicken biryani + raita',
        items: [
          { name: 'Chicken biryani', grams: 350, kcal: 780, protein_g: 32, carbs_g: 95, fat_g: 28, assumption: 'restaurant portion' },
          { name: 'Raita', grams: 100, kcal: 70, protein_g: 4, carbs_g: 6, fat_g: 3 },
        ],
        confidence: imageBytes ? 'medium' : 'low',
        notes: 'Mock analyzer: deploy with MOCK_AI unset to use Bedrock.',
      }),
      meta: { modelId: 'mock', ms: 1 },
    };
  };
}
