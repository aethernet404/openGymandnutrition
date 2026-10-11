/* Prompts for estimating a meal. Kept in code (not a .md build step) because there are two of
 * them and the nutrition module is meant to stay a self-contained folder. */

export const SYSTEM_PROMPT = [
  'You are the openGym nutrition estimator.',
  'You are given a photo or a short description of a meal and return exactly one JSON object — no prose, no code fence.',
  'You have no tools, filesystem access, external services, or memory; use only what you are given.'
].join(' ');

const FORMAT = `Return this JSON shape and nothing else:
{
  "meal_name": "short name for the whole plate",
  "confidence": "low" | "medium" | "high",
  "items": [
    { "name": "food", "portion": "human size, e.g. 1 cup / 2 slices", "grams": number or null,
      "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
  ],
  "notes": "one short sentence on the biggest uncertainty (hidden oil, sauce, portion size)"
}
Rules:
- One entry per distinct food. Numbers are for the portion shown, not per 100 g.
- Estimate portion size from the plate, cutlery and packaging; say so in notes when unsure.
- If the picture shows no food, return {"not_food": true, "notes": "what it shows"}.
- Calories, protein, carbs and fat are plain numbers, never strings or ranges.`;

export const photoPrompt = note =>
  `Estimate the foods, portions and macros of the meal in the attached photo.${note ? `\nThe person adds: ${String(note).slice(0, 300)}` : ''}\n\n${FORMAT}`;

export const textPrompt = description =>
  `Estimate the macros of this meal, described in words: ${String(description).slice(0, 500)}\n\n${FORMAT}`;

/** The one repair round: the previous answer and what was wrong with it. */
export const repairSuffix = (previous, errors) =>
  `\n\n---\n\nYour previous answer was rejected.\nPrevious answer:\n${String(previous || '').slice(0, 4000)}\n\nProblems:\n${errors.map(e => `- ${e}`).join('\n')}\n\nReturn the corrected JSON object only.`;
