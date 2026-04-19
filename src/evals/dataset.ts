import fs from "node:fs";

import { z } from "zod";

import { EventKindSchema, ProposedActionSchema } from "../schemas";
import type { EvalDataset } from "./types";

const EvalDatasetSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      minTailEvents: z.number().int().positive().optional(),
      events: z.array(
        z.object({
          kind: EventKindSchema,
          payload: z.record(z.any()),
          spanId: z.string().optional(),
          parentSpanId: z.string().optional(),
          ts: z.string().optional(),
          id: z.string().optional()
        })
      ),
      expected: z.object({
        nextAction: z.string().optional(),
        requiredConstraints: z.array(z.string()).optional(),
        requiredArtifacts: z.array(z.string()).optional(),
        candidateActions: z.array(ProposedActionSchema).optional(),
        sideEffectActions: z.array(ProposedActionSchema).optional()
      })
    })
  )
});

export function loadEvalDataset(filePath: string): EvalDataset {
  const raw = fs.readFileSync(filePath, "utf8");
  return EvalDatasetSchema.parse(JSON.parse(raw));
}
