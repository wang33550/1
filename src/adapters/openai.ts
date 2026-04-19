import OpenAI from "openai";

import type { ModelAdapter, SendTurnInput, SendTurnResult } from "../types";

export class OpenAIAdapter implements ModelAdapter {
  private readonly client: OpenAI;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required");
    }
    this.client = new OpenAI({ apiKey });
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const response = await this.client.responses.create({
      model: input.model,
      max_output_tokens: input.maxOutputTokens,
      temperature: input.temperature,
      input: [
        ...(input.systemPrompt
          ? [
              {
                role: "system" as const,
                content: [{ type: "input_text" as const, text: input.systemPrompt }]
              }
            ]
          : []),
        {
          role: "system" as const,
          content: [{ type: "input_text" as const, text: input.runtimePacket }]
        },
        {
          role: "user" as const,
          content: [{ type: "input_text" as const, text: input.userInput }]
        }
      ]
    });

    return {
      text: response.output_text,
      raw: response
    };
  }
}
