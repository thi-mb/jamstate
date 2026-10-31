// Brains for Node scripts (replay, bake-off). Keys come from the environment,
// never from files: TYPESAFE_API_KEY (Jev), ANTHROPIC_API_KEY or JAMSTATE_ANTHROPIC_API_KEY (Claude),
// JAMSTATE_LLM_KEY (OpenAI-compatible, optional).
import { ClaudeBrain, DEFAULT_CLAUDE_MODEL } from "../src/core/brain/claude";
import { JevBrain } from "../src/core/brain/jev";
import { OpenAIBrain } from "../src/core/brain/openai";
import { RulesBrain, type BrainProvider } from "../src/core/brain";

export interface BrainArgs {
  url?: string;
  model?: string;
  claudeModel?: string;
  jevModel?: string;
}

export const BRAIN_NAMES = ["rules", "openai", "claude", "jev"];

export function nodeBrain(name: string, a: BrainArgs = {}): BrainProvider {
  switch (name) {
    case "rules":
      return new RulesBrain();
    case "llm":
    case "openai":
    case "qwen":
      return new OpenAIBrain({
        url: a.url ?? process.env.JAMSTATE_LLM_URL ?? "http://127.0.0.1:8080/v1",
        model: a.model ?? process.env.JAMSTATE_LLM_MODEL ?? "leader",
        apiKey: process.env.JAMSTATE_LLM_KEY,
        label: name === "qwen" ? "Qwen" : undefined,
      });
    case "claude": {
      const key = process.env.ANTHROPIC_API_KEY ?? process.env.JAMSTATE_ANTHROPIC_API_KEY;
      if (!key) throw new Error("set ANTHROPIC_API_KEY (or JAMSTATE_ANTHROPIC_API_KEY) for the Claude brain");
      return new ClaudeBrain({ apiKey: key, model: a.claudeModel ?? DEFAULT_CLAUDE_MODEL });
    }
    case "jev": {
      const key = process.env.TYPESAFE_API_KEY;
      if (!key) throw new Error("set TYPESAFE_API_KEY for the Jev brain");
      return new JevBrain({ apiKey: key, model: a.jevModel });
    }
    default:
      throw new Error(`unknown brain "${name}" (${BRAIN_NAMES.join(", ")})`);
  }
}
