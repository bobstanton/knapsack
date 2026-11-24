import type { CompletionResult } from "@codemirror/autocomplete";
import { describeError, engine } from "./knap";
import { filterSuggestions } from "./vendor/filter-suggestions";
import { templateCompletions } from "./vendor/playground-completions";

export { emptyTemplatePair, pairTemplateInput } from "./vendor/playground-pairs";

export function complete(source: string, position: number): CompletionResult | null {
  const result = templateCompletions(source, position, {}, filterSuggestions);

  return result && result.options.length > 0 ? result : null;
}

export function validate(source: string): string {
  return engine.validate(source).map(describeError).join("\n");
}
