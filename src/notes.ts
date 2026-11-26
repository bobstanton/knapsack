import { MarkdownRenderer, normalizePath, type App, type MarkdownRenderChild, type TFile } from "obsidian";
import type { Data, Settings } from "./settings";

export interface Result {
  output: string;
  errors: string[];
  warnings: string[];
  variables: Record<string, unknown>;
}

export interface Supplied {
  variables: Record<string, unknown>;
  note?: TFile;
}

export function isEmpty(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

export function findFile(app: App, sourcePath: string, reference: string): TFile | null {
  return app.metadataCache.getFirstLinkpathDest(reference, sourcePath) ?? app.vault.getFileByPath(reference);
}

export async function suppliedVariables(app: App, sourcePath: string, data: Data, over: Record<string, unknown> = {}): Promise<Supplied> {
  const date = new Date().toISOString();

  if (data.from === "note") {
    const note = findFile(app, sourcePath, data.reference);

    if (!note) throw new Error(`Data note not found: ${data.reference}`);

    return { variables: { date, ...app.metadataCache.getFileCache(note)?.frontmatter, ...over }, note };
  }

  const variables: Record<string, unknown> = { date, ...data.values, ...over };
  const computed = Object.entries(data.values).filter((entry): entry is [string, string] => !(entry[0] in over) && typeof entry[1] === "string" && /\{[{%]/.test(entry[1]));

  if (computed.length === 0) return { variables };
  const { engine } = await import("./knap");
  const resolved = await Promise.all(computed.map(async ([name, value]) => [name, await engine.renderOrThrow(value, { variables })] as const));

  return { variables: { ...variables, ...Object.fromEntries(resolved) } };
}

export async function renderTemplate(app: App, template: TFile, variables: Record<string, unknown>): Promise<Result> {
  const { engine, describeError } = await import("./knap");
  const rendered = await engine.render(await app.vault.cachedRead(template), { variables });

  return {
    output: rendered.output,
    errors: rendered.errors.map(describeError),
    warnings: rendered.warnings.map(warning => `Line ${warning.line}, filter ${warning.filter}: ${warning.message}`),
    variables,
  };
}

export function safeName(text: string): string {
  return text.trim().replace(/[\\/:*?"<>|#^[\]]/g, "-");
}

export function noteNameFrom(variables: Record<string, unknown>): string | undefined {
  const named = ["title", "name"]
    .flatMap(wanted => Object.entries(variables).filter(([name]) => name.toLowerCase() === wanted).map(([, value]) => value))
    .find((value): value is string => typeof value === "string" && value.trim() !== "");

  return named === undefined ? undefined : safeName(named);
}

export interface OutputFolder {
  path: string;
  exists: boolean;
  names: Map<string, string>;
}

export function outputFolder(app: App, sourcePath: string, settings: Settings): OutputFolder {
  const wanted = settings.outputFolder ? normalizePath(settings.outputFolder) : app.fileManager.getNewFileParent(sourcePath).path;
  const existing = app.vault.getAllFolders(true).find(folder => folder.path.toLowerCase() === wanted.toLowerCase());

  return { path: existing?.path ?? wanted, exists: Boolean(existing), names: new Map(existing?.children.map(child => [child.name.toLowerCase(), child.name])) };
}

export function noteIn(folder: OutputFolder, name: string): { path: string; exists: boolean } {
  const existing = folder.names.get(`${name}.md`.toLowerCase());

  return { path: normalizePath(`${folder.path}/${existing ?? `${name}.md`}`), exists: existing !== undefined };
}

export type Message = string | ((line: HTMLElement) => void);

export function renderMessages(el: HTMLElement, cls: string, title: string, messages: Message[]): void {
  if (messages.length === 0) return;
  const block = el.createDiv({ cls });

  block.createEl("h3", { text: title });

  for (const message of messages) {
    const line = block.createEl("p");

    if (typeof message === "string") line.setText(message);
    else message(line);
  }
}

export async function renderMarkdownPreview(app: App, sourcePath: string, el: HTMLElement, settings: Settings, output: string, owner: MarkdownRenderChild): Promise<void> {
  const fence = "`".repeat(Math.max(3, ...(output.match(/`+/g) ?? []).map(ticks => ticks.length + 1)));

  await MarkdownRenderer.render(app, settings.render ? output : `${fence}markdown\n${output}\n${fence}`, el.createDiv(), sourcePath, owner);
}
