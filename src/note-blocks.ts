import { autocompletion, completionStatus, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, Prec, RangeSetBuilder, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { App } from "obsidian";
import { CHOICE_KIND, EXISTING_FILE, FIELD_KINDS } from "./settings";
import { BLOCK_OPEN, FENCE, TEMPLATE_PATH, sortedUnique, tokenMark } from "./shared";
import { getVaultQueryAPI, type SqlCompletionItem, type SqlSyntax } from "vaultquery/api";

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

interface Range {
  from: number;
  to: number;
}

const BLOCK_SCALAR = /^[|>][+-]?\d?$/;

function sqlRange(doc: Text, block: BlockLines): Range | null {
  for (let number = block.first; number <= block.last; number++) {
    const header = doc.line(number);
    const name = /^query:[ \t]*/i.exec(header.text);

    if (!name) continue;
    const value = header.text.slice(name[0].length);
    const scalar = BLOCK_SCALAR.test(value.trim());
    const range = { from: header.from + name[0].length + (/^["']/.test(value) ? 1 : 0), to: header.to };
    let started = !scalar;

    for (let below = number + 1; below <= block.last; below++) {
      const line = doc.line(below);

      if (/^\S/.test(line.text)) break;
      if (line.text === "") continue;
      if (!started) range.from = line.from;
      started = true;
      range.to = line.to;
    }

    return started ? range : null;
  }

  return null;
}

const SQL_TOKEN = /'(?:[^']|'')*'|[A-Za-z_]\w*|\d+(?:\.\d+)?/g;

function colorSql(text: string, from: number, syntax: SqlSyntax | undefined, builder: RangeSetBuilder<Decoration>): void {
  for (const found of text.matchAll(SQL_TOKEN)) {
    const word = found[0].toLowerCase();
    const called = /^\s*\(/.test(text.slice(found.index + word.length));
    const token = word.startsWith("'") ? "string" : /^\d/.test(word) ? "number"
      : called && syntax?.functions.has(word) ? "variable-2" : syntax?.keywords.has(word) ? "keyword" : undefined;

    if (token) builder.add(from + found.index, from + found.index + word.length, tokenMark(token));
  }
}

function colorLine(text: string, from: number, builder: RangeSetBuilder<Decoration>, nameOnly = false): void {
  const line = BLOCK_LINE.exec(text);
  const at = line?.indices?.groups;

  if (!line?.groups || !at) return;
  const [start, end] = at.value.map(index => from + index);
  const token = valueToken(line.groups.value);

  builder.add(from + at.name[0], from + at.name[1], tokenMark("keyword"));
  builder.add(from + at.colon[0], from + at.colon[1], tokenMark("punctuation"));
  if (nameOnly) return;

  if (/^\[\[.*\]\]$/.test(line.groups.value)) {
    builder.add(start, start + 2, tokenMark("punctuation"));
    builder.add(start + 2, end - 2, tokenMark("link"));
    builder.add(end - 2, end, tokenMark("punctuation"));
  } else if (token) builder.add(start, end, tokenMark(token));
}

const coloring = (app: App): Extension => EditorView.decorations.compute([blocks], (state): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  const syntax = getVaultQueryAPI(app)?.sqlSyntax;

  for (const block of state.field(blocks)) {
    const sql = sqlRange(state.doc, block);

    for (let number = block.first; number <= block.last; number++) {
      const line = state.doc.line(number);
      const sqlFrom = sql && line.to >= sql.from && line.from <= sql.to ? Math.max(line.from, sql.from) : null;

      if (sqlFrom === null) colorLine(line.text, line.from, builder);
      else {
        if (sqlFrom > line.from) colorLine(line.text, line.from, builder, true);
        colorSql(state.sliceDoc(sqlFrom, line.to), sqlFrom, syntax, builder);
      }
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
  { label: "template", apply: "template: ", detail: "Knap template file", info: "Path or [[wikilink]] of a .knap or .knap.md file.",
    values: app => paths(app.vault.getFiles().filter(file => TEMPLATE_PATH.test(file.path))) },
  { label: "data", apply: "data:", detail: "Values for the template", info: "name: value on the lines below, or the path of a note whose properties are the values. A field starts from its value. A query uses it where a column is empty.",
    values: (app, typed) => typed ? notes(app) : null },
  { label: "fields", apply: "fields:", detail: "Form inputs, or a query's column types", info: "One per line, as name: type. End a name with * to require it. With a query, sets each column's type and draws no inputs." },
  { label: "query", apply: "query: ", detail: "VaultQuery SQL; one note per row", info: "Each column is a template variable. The title or name column names the note. Requires the VaultQuery plugin. Continue a long query on indented lines." },
  { label: "existingFile", apply: "existingFile: ", detail: "With a query: what happens to a note that already exists",
    values: () => ordered(Object.entries(EXISTING_FILE).map(([label, detail]) => ({ label, detail }))) },
  { label: "outputFolder", apply: "outputFolder: ", detail: "Folder for created notes", info: "Created if missing. Defaults to Obsidian's location for new notes. On a block with no fields or query, adds the Create note button.",
    values: app => paths(app.vault.getAllFolders()) },
  { label: "preview", apply: "preview: ", detail: "Show or hide the generated Markdown",
    values: () => ordered([{ label: "true", detail: "Shows the generated Markdown (default)" }, { label: "false", detail: "Hides the generated Markdown; buttons stay" }]) },
  { label: "render", apply: "render: ", detail: "Preview as formatted Markdown or as its source", info: "Changes the preview only. A created or copied note is always the Markdown source.",
    values: () => ordered([{ label: "true", detail: "Formatted, as in reading view" }, { label: "false", detail: "Markdown source (default)" }]) },
]);
const TYPES = ordered([...Object.entries(FIELD_KINDS).map(([label, description]) => ({ label, ...description })), CHOICE_KIND]);

interface BlockPosition {
  before: string;
  parent: string;
}

function blockPosition(state: EditorState, position: number): BlockPosition | null {
  const line = state.doc.lineAt(position);
  const block = blockAt(state, position);

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

function blockAt(state: EditorState, position: number): BlockLines | undefined {
  const number = state.doc.lineAt(position).number;

  return state.field(blocks, false)?.find(found => number >= found.first && number <= found.last);
}

function sqlRangeAt(state: EditorState, position: number): Range | null {
  const block = blockAt(state, position);
  const range = block ? sqlRange(state.doc, block) : null;

  return range && position >= range.from && position <= range.to ? range : null;
}

function sqlCompletion({ cursorOffset, ...item }: SqlCompletionItem): Completion {
  const insert = item.apply;

  return {
    ...item,
    apply: cursorOffset === undefined ? insert : (view, _completion, from, to) => {
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + cursorOffset }, userEvent: "input.complete" });
    },
  };
}

function sqlSource(app: App) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const range = sqlRangeAt(context.state, context.pos);
    const api = range && getVaultQueryAPI(app);

    if (!range || !api || !("getSqlCompletions" in api)) return null;
    const found = await api.getSqlCompletions({
      sql: context.state.sliceDoc(range.from, range.to),
      cursor: context.pos - range.from,
      explicit: context.explicit,
    });

    if (!found || context.aborted) return null;

    return { from: range.from + found.from, to: range.from + found.to, options: found.items.map(sqlCompletion), validFor: /^[\w.{}]*$/ };
  };
}

export function noteBlocks(app: App): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const position = blockPosition(context.state, context.pos);
    const found = position && options(app, position);

    if (!found || (found.typed === "" && !context.explicit && !/:\s$/.test(position.before))) return null;

    return { from: context.pos - found.typed.length, options: found.options, validFor: /^[^\n]*$/ };
  };

  const sql = sqlSource(app);

  return [
    blocks,
    coloring(app),
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: source }, { autocomplete: sql }]),
    Prec.highest(EditorView.inputHandler.of((view, from, _to, text, insert) => {
      if (text !== "*" || !blockAt(view.state, from)) return false;
      view.dispatch(insert());

      return true;
    })),
    ViewPlugin.fromClass(class {
      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);

        const before = line.text.slice(0, head - line.from);
        const inSql = /[\s,(.]$/.test(before) && sqlRangeAt(update.state, head) !== null;

        if (!(inSql || (/:\s$/.test(before) && blockAt(update.state, head)))) return;
        // Asked for after the update: a setting name just accepted leaves its own list closing during it.
        window.setTimeout(() => { if (completionStatus(update.view.state) === null) startCompletion(update.view); }, 0);
      }
    }),
  ];
}
