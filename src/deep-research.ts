import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { getModel, trimPrompt } from './ai/providers.js';
import { systemPrompt } from './prompt.js';

function log(...args: any[]) {
  console.log(...args);
}

export type ResearchProgress = {
  currentDepth: number;
  totalDepth: number;
  currentBreadth: number;
  totalBreadth: number;
  currentQuery?: string;
  totalQueries: number;
  completedQueries: number;
};

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
};

// Erhöhe diesen Wert, wenn du höhere API-Ratenlimits hast
const ConcurrencyLimit = Number(process.env.FIRECRAWL_CONCURRENCY) || 2;

// Initialisiere Firecrawl mit optionalem API-Schlüssel und optionaler Basis-URL
const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

// Nimm eine Nutzeranfrage entgegen und gib eine Liste von SERP-Abfragen zurück
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;
  // Optional, falls vorhanden, wird die Recherche auf den letzten Erkenntnissen aufgebaut
  learnings?: string[];
}) {
  const res = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: `Basierend auf dem folgenden Nutzer-Prompt, erstelle eine Liste von SERP-Abfragen zur Recherche des Themas. Gib maximal ${numQueries} Abfragen zurück, du kannst aber auch weniger angeben, wenn der ursprüngliche Prompt eindeutig ist. Stelle sicher, dass jede Abfrage einzigartig ist und sich von den anderen unterscheidet.
    Gib ausserdem nütliche Metadaten aus, wie Deadlines und Links. Der Prompt lautet: <prompt>${query}</prompt>\n\n${learnings
        ? `Hier sind einige Erkenntnisse aus vorherigen Recherchen, nutze diese, um spezifischere Abfragen zu erstellen: ${learnings.join('\n')}`
        : ''
      }`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('Die SERP-Abfrage'),
            researchGoal: z
              .string()
              .describe(
                'Beschreibe zunächst das Ziel der Recherche, das mit dieser Abfrage verfolgt wird, und gehe anschließend darauf ein, wie die Recherche fortgesetzt werden soll, sobald Ergebnisse vorliegen. Nenne zusätzliche Forschungsrichtungen. Sei dabei so spezifisch wie möglich, insbesondere bei den zusätzlichen Forschungsrichtungen.',
              ),
          }),
        )
        .describe(`Liste von SERP-Abfragen, maximal ${numQueries}`),
    }),
  });
  log(`Erstellt ${res.object.queries.length} Abfragen`, res.object.queries);

  return res.object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(result.data.map(item => item.markdown)).map(content =>
    trimPrompt(content, 25_000),
  );
  log(`Ausgeführt: ${query}, gefunden: ${contents.length} Inhalte`);

  const res = await generateObject({
    model: getModel(),
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: trimPrompt(
      `Basierend auf den folgenden Inhalten einer SERP-Suche für die Abfrage <query>${query}</query>, erstelle eine Liste von Erkenntnissen. Gib maximal ${numLearnings} Erkenntnisse zurück, du kannst aber auch weniger angeben, wenn die Inhalte eindeutig sind. Stelle sicher, dass jede Erkenntnis einzigartig ist und sich von den anderen unterscheidet. Die Erkenntnisse sollten prägnant und auf den Punkt gebracht sein, so detailliert und informationsreich wie möglich. Achte darauf, alle Entitäten wie Personen, Orte, Unternehmen, Produkte, Dinge usw. sowie genaue Kennzahlen, Zahlen oder Daten zu berücksichtigen. Diese Erkenntnisse werden verwendet, um das Thema weiter zu erforschen.\n\n<contents>${contents
        .map(content => `<content>\n${content}\n</content>`)
        .join('\n')}</contents>`,
    ),
    schema: z.object({
      learnings: z.array(z.string()).describe(`Liste von Erkenntnissen, maximal ${numLearnings}`),
      followUpQuestions: z
        .array(z.string())
        .describe(
          `Liste von Folgefragen zur weiteren Erforschung des Themas, maximal ${numFollowUpQuestions}`,
        ),
    }),
  });
  log(`Erstellt ${res.object.learnings.length} Erkenntnisse`, res.object.learnings);

  return res.object;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
}) {
  const learningsString = learnings
    .map(learning => `<learning>\n${learning}\n</learning>`)
    .join('\n');

  const res = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: trimPrompt(
      `Basierend auf dem folgenden Nutzer-Prompt, schreibe einen abschließenden Bericht über das Thema unter Verwendung der gewonnenen Erkenntnisse aus der Recherche. Gestalte den Bericht so detailliert wie möglich, strebe 3 oder mehr Seiten an und schließe ALLE Erkenntnisse ein:\n\n<prompt>${prompt}</prompt>\n\nHier sind alle Erkenntnisse aus vorherigen Recherchen:\n\n<learnings>\n${learningsString}\n</learnings>`,
    ),
    schema: z.object({
      reportMarkdown: z.string().describe('Abschließender Bericht zum Thema in Markdown'),
    }),
  });

  // Füge den Abschnitt der besuchten URLs zum Bericht hinzu
  const urlsSection = `\n\n## Quellen\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  return res.object.reportMarkdown + urlsSection;
}

export async function writeFinalAnswer({
  prompt,
  learnings,
}: {
  prompt: string;
  learnings: string[];
}) {
  const learningsString = learnings
    .map(learning => `<learning>\n${learning}\n</learning>`)
    .join('\n');

  const res = await generateObject({
    model: getModel(),
    system: systemPrompt(),
    prompt: trimPrompt(
      `Basierend auf dem folgenden Nutzer-Prompt, schreibe eine endgültige Antwort zum Thema unter Verwendung der gewonnenen Erkenntnisse aus der Recherche. Halte dich an das im Prompt angegebene Format. Vermeide unnötige Zusätze und liefere ausschließlich die Antwort im vorgegebenen Format. Die Antwort soll so prägnant wie möglich sein – in der Regel nur wenige Worte oder maximal ein Satz. Versuche, das im Prompt angegebene Format einzuhalten (zum Beispiel, wenn der Prompt Latex verwendet, sollte die Antwort in Latex sein. Falls der Prompt mehrere Antwortmöglichkeiten bietet, sollte die Antwort eine dieser Optionen sein).\n\n<prompt>${prompt}</prompt>\n\nHier sind alle Erkenntnisse aus der Recherche, die dir helfen können, den Prompt zu beantworten:\n\n<learnings>\n${learningsString}\n</learnings>`,
    ),
    schema: z.object({
      exactAnswer: z
        .string()
        .describe('Die endgültige Antwort, kurz und prägnant, nur die Antwort ohne zusätzlichen Text'),
    }),
  });

  return res.object.exactAnswer;
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
  onProgress,
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
  onProgress?: (progress: ResearchProgress) => void;
}): Promise<ResearchResult> {
  const progress: ResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  };

  const reportProgress = (update: Partial<ResearchProgress>) => {
    Object.assign(progress, update);
    onProgress?.(progress);
  };

  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });

  reportProgress({
    totalQueries: serpQueries.length,
    currentQuery: serpQueries[0]?.query,
  });

  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await firecrawl.search(serpQuery.query, {
            timeout: 15000,
            limit: 5,
            scrapeOptions: { formats: ['markdown'] },
          });

          // Sammle URLs aus dieser Suche
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            log(`Vertiefe die Recherche, Breite: ${newBreadth}, Tiefe: ${newDepth}`);

            reportProgress({
              currentDepth: newDepth,
              currentBreadth: newBreadth,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });

            const nextQuery = `
            Vorheriges Forschungsziel: ${serpQuery.researchGoal}
            Nachfolgende Forschungsrichtungen: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
              onProgress,
            });
          } else {
            reportProgress({
              currentDepth: 0,
              completedQueries: progress.completedQueries + 1,
              currentQuery: serpQuery.query,
            });
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            log(`Timeout-Fehler bei der Ausführung der Abfrage: ${serpQuery.query}: `, e);
          } else {
            log(`Fehler bei der Ausführung der Abfrage: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            visitedUrls: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
  };
}
