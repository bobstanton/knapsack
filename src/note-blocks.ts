import { autocompletion, completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, RangeSetBuilder, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { App } from "obsidian";
import { CHOICE_KIND, FIELD_KINDS } from "./settings";
import { BLOCK_OPEN, FENCE, TEMPLATE_PATH, sortedUnique, tokenMark } from "./shared";

interface BlockLines {
  first: number;
  last: number;
}

function findBlocks(doc: Text): BlockLines[] {
  const blocks: BlockLines[] = [];
  let opened = 0;
  let number = 0;

  for (const text of doc.iterLines()) {
    number++;

    if (opened && FENCE.test(text)) {
      blocks.push({ first: opened + 1, last: number - 1 });
      opened = 0;
    } else if (!opened && BLOCK_OPEN.test(text)) opened = number;
  }

  return opened ? [...blocks, { first: opened + 1, last: doc.lines }] : blocks;
}

const blocks = StateField.define<readonly BlockLines[]>({
  create: state => findBlocks(state.doc),
  update: (found, transaction) => transaction.docChanged ? findBlocks(transaction.newDoc) : found,
});

const BLOCK_LINE = /^\s*(?:-\s+)?(?<name>[\w.-]+\*?)(?<colon>:)\s*(?<value>.*?)\s*$/d;

function valueToken(value: string): string | undefined {
  if (/^(true|false|null)$/.test(value)) return "atom";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number";

  return /^(["']).*\1$/.test(value) ? "string" : undefined;
}

function colorLine(text: string, from: number, builder: RangeSetBuilder<Decoration>): void {
  const line = BLOCK_LINE.exec(text);
  const at = line?.indices?.groups;

  if (!line?.groups || !at) return;
  const [start, end] = at.value.map(index => from + index);
  const token = valueToken(line.groups.value);

  builder.add(from + at.name[0], from + at.name[1], tokenMark("keyword"));
  builder.add(from + at.colon[0], from + at.colon[1], tokenMark("punctuation"));

  if (/^\[\[.*\]\]$/.test(line.groups.value)) {
    builder.add(start, start + 2, tokenMark("punctuation"));
    builder.add(start + 2, end - 2, tokenMark("link"));
    builder.add(end - 2, end, tokenMark("punctuation"));
  } else if (token) builder.add(start, end, tokenMark(token));
}

const coloring = EditorView.decorations.compute([blocks], (state): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();

  for (const block of state.field(blocks)) {
    for (let number = block.first; number <= block.last; number++) {
      const line = state.doc.line(number);

      colorLine(line.text, line.from, builder);
    }
  }

  return builder.finish();
});

function ordered<Entry extends Completion>(entries: Entry[]): Entry[] {
  return entries.map((entry, index) => ({ ...entry, boost: entries.length - index }));
}

function paths(found: { path: string }[]): Completion[] {
  return sortedUnique(found.map(file => file.path)).map(label => ({ label }));
}

function notes(app: App): Completion[] {
  return paths(app.vault.getMarkdownFiles().filter(file => !TEMPLATE_PATH.test(file.path)));
}

interface SettingCompletion extends Completion {
  values?: (app: App, typed: string) => Completion[] | null;
}

const SETTINGS = ordered<SettingCompletion>([
  { label: "template", apply: "template: ", detail: "Knap template file", info: "Vault path or [[wikilink]] of a .knap or .knap.md file.",
    values: app => paths(app.vault.getFiles().filter(file => TEMPLATE_PATH.test(file.path))) },
  { label: "data", apply: "data:", detail: "Template variables", info: "Names and values on the lines below, or the path of a note whose properties supply them.",
    values: (app, typed) => typed ? notes(app) : null },
  { label: "fields", apply: "fields:", detail: "Form inputs", info: "One input per line, as name: type. A name ending in * is required." },
  { label: "outputFolder", apply: "outputFolder: ", detail: "Folder for created notes", info: "Adds a Create note button. The folder is created when missing.",
    values: app => paths(app.vault.getAllFolders()) },
  { label: "preview", apply: "preview: ", detail: "Show or hide the generated Markdown",
    values: () => ordered([{ label: "true", detail: "Shows the generated Markdown (default)" }, { label: "false", detail: "Hides the generated Markdown" }]) },
  { label: "render", apply: "render: ", detail: "Preview as source or as formatted Markdown",
    values: () => ordered([{ label: "true", detail: "Formatted Markdown" }, { label: "false", detail: "Markdown source (default)" }]) },
]);
const TYPES = ordered([...Object.entries(FIELD_KINDS).map(([label, description]) => ({ label, ...description })), CHOICE_KIND]);

interface BlockPosition {
  before: string;
  parent: string;
}

function blockPosition(state: EditorState, position: number): BlockPosition | null {
  const line = state.doc.lineAt(position);
  const block = state.field(blocks, false)?.find(found => line.number >= found.first && line.number <= found.last);

  if (!block) return null;
  const before = line.text.slice(0, position - line.from);

  for (let number = line.number - 1; number >= block.first; number--) {
    const parent = /^([A-Za-z]+):/.exec(state.doc.line(number).text)?.[1];

    if (parent) return { before, parent: parent.toLowerCase() };
  }

  return { before, parent: "" };
}

function options(app: App, position: BlockPosition): { typed: string; options: Completion[] } | null {
  const setting = /^([A-Za-z]*)$/.exec(position.before);
  const value = /^([A-Za-z]+):\s*(.*)$/.exec(position.before);
  const type = position.parent === "fields" ? /^\s+[^:]+:\s*([A-Za-z]*)$/.exec(position.before) : null;

  if (setting) return { typed: setting[1], options: SETTINGS };
  if (type) return { typed: type[1], options: TYPES };
  if (!value) return null;
  const found = SETTINGS.find(known => known.label.toLowerCase() === value[1].toLowerCase())?.values?.(app, value[2]);

  return found ? { typed: value[2], options: found } : null;
}

export function noteBlocks(app: App): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const position = blockPosition(context.state, context.pos);
    const found = position && options(app, position);

    if (!found || (found.typed === "" && !context.explicit && !/:\s$/.test(position.before))) return null;

    return { from: context.pos - found.typed.length, options: found.options, validFor: /^[^\n]*$/ };
  };

  return [
    blocks,
    coloring,
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    ViewPlugin.fromClass(class {
      update(update: ViewUpdate): void {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);

        if (!update.docChanged || !/:\s$/.test(line.text.slice(0, head - line.from)) || !blockPosition(update.state, head)) return;
        // Asked for after the update: a setting name just accepted leaves its own list closing during it.
        window.setTimeout(() => { if (completionStatus(update.view.state) === null) startCompletion(update.view); }, 0);
      }
    }),
  ];
}
