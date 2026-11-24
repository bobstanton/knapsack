import { Decoration } from "@codemirror/view";

export const TEMPLATE_VIEW = "knapsack-template";
export const TEMPLATE_PATH = /\.knap(\.md)?$/i;
export const MARKDOWN_TEMPLATE_PATH = /\.knap\.md$/i;

export const FENCE = /^\s*(`{3,}|~{3,})/;
export const BLOCK_OPEN = /^\s*(`{3,}|~{3,})knapsack\s*$/;

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function listItems(text: string): string[] {
  return text.split(",").map(item => item.trim());
}

const marks = new Map<string, Decoration>();

export function tokenMark(token: string): Decoration {
  const mark = marks.get(token) ?? Decoration.mark({ class: `knapsack-${token}` });

  marks.set(token, mark);

  return mark;
}
