import { generateObject } from 'ai';
import { z } from 'zod';

import { getModel } from './ai/providers';
import { systemPrompt } from './prompt';

export async function generateFeedback({
  query,
  numQuestions = 3,
}: {
  query: string;
  numQuestions?: number;
}) {
  const userFeedback = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: `Basierend auf der folgenden Nutzeranfrage, stelle einige Folgefragen, um die Forschungsrichtung zu klären. Gib maximal ${numQuestions} Fragen zurück, du kannst aber auch weniger zurückgeben, wenn die ursprüngliche Anfrage eindeutig ist: <query>${query}</query>`,
    schema: z.object({
      questions: z
        .array(z.string())
        .describe(`Folgefragen zur Klärung der Forschungsrichtung, maximal ${numQuestions}`),
    }),
  });

  return userFeedback.object.questions.slice(0, numQuestions);
}
