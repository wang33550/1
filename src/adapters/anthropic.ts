import Anthropic from "@anthropic-ai/sdk";

import type { ModelAdapter, SendTurnInput, SendTurnResult } from "../types";

export class AnthropicAdapter implements ModelAdapter {
  private readonly client: Anthropic;

  constructor(
    apiKey = process.env.ANTHROPIC_API_KEY,
    baseURL = process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_BASE_URL
  ) {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
    this.client = new Anthropic({
      apiKey,
      ...(baseURL ? { baseURL } : {})
    });
  }

  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: input.maxOutputTokens ?? 2048,
      temperature: input.temperature,
      system: [input.systemPrompt, input.runtimePacket].filter(Boolean).join("\n\n"),
      messages: [
        {
          role: "user",
          content: input.userInput
        }
      ]
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      text,
      raw: response
    };
  }
}
