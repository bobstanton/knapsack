import { createEngine, standardFilters } from "knap";

export const engine = createEngine({ filters: standardFilters });

export function describeError(error: { line: number; column: number; message: string }): string {
  return `Line ${error.line}, column ${error.column}: ${error.message}`;
}
