// Strongly typed Decision Chaining engine for multi-stage complex decisions.
// Enables sequential, conditional, and branching decision pipelines where
// fast System 1 probability outputs feed subsequent decision nodes in milliseconds.

import { HeuristicDecisionProvider } from "./heuristic.ts";
import { DEFAULT_DECISION_TIMEOUT_MS, DEFAULT_OLLAMA_DECISION_MODEL, DEFAULT_OLLAMA_HOST } from "./providers/ollama.ts";

export interface DecisionStepCriteria {
  readonly [choiceKey: string]: string; // Key -> Description
}

export interface DecisionStepAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
  readonly latencyMs: number;
}

export interface DecisionStepDefinition {
  readonly name: string;
  readonly instructions: string;
  readonly criteria: DecisionStepCriteria;

  /**
   * Optional conditional predicate. If provided and returns false, this step is skipped.
   * Allows branching trees (e.g. only evaluate "mutation_risk" if domain was "code_edit").
   */
  readonly condition?: (previousAnswers: Record<string, DecisionStepAnswer>) => boolean;

  /**
   * Optional state transformer. Allows passing enriched context into the next step.
   */
  readonly transformState?: (baseState: string, previousAnswers: Record<string, DecisionStepAnswer>) => string;
}

export interface DecisionChainDefinition {
  readonly name: string;
  readonly steps: readonly DecisionStepDefinition[];
}

export interface DecisionChainResult {
  readonly chainName: string;
  readonly answers: Record<string, DecisionStepAnswer>;
  readonly finalOutcome: string;
  readonly compositeConfidence: number;
  readonly totalLatencyMs: number;
}

const fallback = new HeuristicDecisionProvider();

export class DecisionChainRunner {
  readonly host: string;
  readonly apiKey?: string;
  model: string;

  constructor(host: string = DEFAULT_OLLAMA_HOST, model: string = DEFAULT_OLLAMA_DECISION_MODEL, apiKey?: string) {
    this.host = host.replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
  }

  /**
   * Executes a multi-stage decision chain.
   * Evaluates steps conditionally and returns structured results with aggregated metrics.
   */
  async run(chain: DecisionChainDefinition, baseState: string, timeoutMs = DEFAULT_DECISION_TIMEOUT_MS): Promise<DecisionChainResult> {
    const chainStart = performance.now();
    const answers: Record<string, DecisionStepAnswer> = {};
    let lastChoice = "unknown";
    let cumulativeConfidence = 1.0;

    for (const step of chain.steps) {
      if (step.condition && !step.condition(answers)) {
        continue;
      }

      const currentState = step.transformState ? step.transformState(baseState, answers) : baseState;
      const stepStart = performance.now();
      const stepAnswer = await this.evaluateSingleStep(step, currentState, timeoutMs);
      const stepLatency = Math.round((performance.now() - stepStart) * 100) / 100;

      const record: DecisionStepAnswer = {
        choice: stepAnswer.choice,
        confidence: stepAnswer.confidence,
        probabilities: stepAnswer.probabilities,
        latencyMs: stepLatency,
      };

      answers[step.name] = record;
      lastChoice = stepAnswer.choice;
      cumulativeConfidence *= stepAnswer.confidence;
    }

    const totalLatency = Math.round((performance.now() - chainStart) * 100) / 100;

    return {
      chainName: chain.name,
      answers,
      finalOutcome: lastChoice,
      compositeConfidence: Math.round(cumulativeConfidence * 100) / 100,
      totalLatencyMs: totalLatency,
    };
  }

  private async evaluateSingleStep(
    step: DecisionStepDefinition,
    stateText: string,
    timeoutMs: number,
  ): Promise<{ choice: string; confidence: number; probabilities: Record<string, number> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(`${this.host}/v1/systemone`, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          state: stateText,
          questions: {
            [step.name]: {
              type: "choice",
              instructions: step.instructions,
              criteria: step.criteria,
            },
          },
        }),
      });

      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = (await res.json()) as {
        answers?: Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
      };

      const ans = data.answers?.[step.name];
      if (!ans?.choice) throw new Error("Empty step answer");

      return {
        choice: ans.choice,
        confidence: typeof ans.confidence === "number" ? ans.confidence : 0.85,
        probabilities: ans.probabilities ?? { [ans.choice]: 1.0 },
      };
    } catch {
      // Infallible fallback heuristic for the step criteria
      const keys = Object.keys(step.criteria);
      const match = keys.find((k) => stateText.toLowerCase().includes(k.toLowerCase())) ?? keys[0] ?? "unknown";
      return {
        choice: match,
        confidence: 0.65,
        probabilities: { [match]: 0.65 },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
