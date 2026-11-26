import { parseYaml } from "obsidian";

interface KindDescription {
  detail: string;
  info?: string;
}

export const FIELD_KINDS = {
  text: { detail: "One line of text", info: "Suggests the values notes hold in the property of the same name. To use another property, name it after the type: text Rating." },
  number: { detail: "A number" },
  checkbox: { detail: "A toggle: true or false" },
  date: { detail: "A date, as YYYY-MM-DD" },
  list: { detail: "Several values", info: "One input per item, with suggestions as for text: list Trail difficulty. From a query: a JSON array, or one item per line of text." },
  note: { detail: "The name of a note", info: "Suggests notes. To suggest only a folder's notes, name it after the type: note Parks." },
  notes: { detail: "Note names separated by commas", info: "The template gets them as a list. To suggest only a folder's notes, name it after the type: notes People." },
  json: { detail: "A table or named values, written as JSON", info: "The template gets the value the JSON describes. From a query: a column such as json_group_array(json_array(name, amount))." },
} satisfies Record<string, KindDescription>;

export const CHOICE_KIND: KindDescription & { label: string } = { label: "[first, second]", detail: "One of the listed choices", info: "A dropdown. The first choice starts selected." };

type Kind = keyof typeof FIELD_KINDS;

export type Field = { name: string; required: boolean } & (
  | { kind: "choice"; choices: [string, ...string[]] }
  | { kind: "checkbox" }
  | { kind: "number" | "date" | "json" }
  | { kind: "text" | "list"; property: string }
  | { kind: "note" | "notes"; folder: string });

export type Data =
  | { from: "block"; values: Record<string, unknown> }
  | { from: "note"; reference: string };

export const EXISTING_FILE = {
  skip: "Keeps the existing note (default)",
  overwrite: "Replaces the existing note's content",
};

export type ExistingFile = keyof typeof EXISTING_FILE;

export interface Settings {
  template: string;
  data: Data;
  query?: string;
  existingFile: ExistingFile;
  fields?: Field[];
  outputFolder?: string;
  preview: boolean;
  render: boolean;
}

export type QuerySettings = Settings & { query: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reference(value: unknown): string {
  const text: unknown = Array.isArray(value) ? value.flat(2)[0] : value;

  return typeof text === "string" ? text.trim().replace(/^\[\[(.*?)\]\]$/, "$1") : "";
}

function parseField(label: string, declared: unknown): Field {
  const name = label.replace(/\*$/, "").trim();
  const base = { name, required: name !== label };

  if (Array.isArray(declared)) {
    const [first, ...others] = declared.map(String);

    if (first === undefined) throw new Error(`Field "${name}" needs at least one choice.`);

    return { ...base, kind: "choice", choices: [first, ...others] };
  }

  const [word = "", ...rest] = typeof declared === "string" ? declared.trim().split(/\s+/) : [];
  const kind = word.toLowerCase();
  const argument = rest.join(" ");

  if (kind === "checkbox") return { ...base, kind };
  if (kind === "number" || kind === "date" || kind === "json") return { ...base, kind };
  if (kind === "text" || kind === "list") return { ...base, kind, property: argument || name };
  if (kind === "note" || kind === "notes") return { ...base, kind, folder: argument };

  throw new Error(`Unknown type "${String(declared)}" for field "${name}". Use ${(Object.keys(FIELD_KINDS) as Kind[]).join(", ")}, or a list of choices.`);
}

function parseData(value: unknown): Data {
  if (value == null) return { from: "block", values: {} };
  if (isRecord(value)) return { from: "block", values: value };
  const note = reference(value);

  if (!note) throw new Error("data is a list of names and values, or the path of a note.");

  return { from: "note", reference: note };
}

export function parseSettings(source: string): Settings {
  const parsed: unknown = parseYaml(source);
  const raw = Object.fromEntries(Object.entries(isRecord(parsed) ? parsed : {}).map(([name, value]) => [name.toLowerCase(), value]));

  if (raw.fields != null && !isRecord(raw.fields)) throw new Error("fields lists one input per line, as name: type.");

  const existingFile = raw.existingfile == null ? "skip" : typeof raw.existingfile === "string" ? raw.existingfile.toLowerCase() : "";

  if (raw.query != null && typeof raw.query !== "string") throw new Error("query is one VaultQuery SQL query.");
  if (existingFile !== "skip" && existingFile !== "overwrite") throw new Error(`existingFile is ${Object.keys(EXISTING_FILE).join(" or ")}.`);

  return {
    template: reference(raw.template),
    data: parseData(raw.data),
    query: raw.query?.trim() || undefined,
    existingFile,
    fields: isRecord(raw.fields) ? Object.entries(raw.fields).map(([label, declared]) => parseField(label, declared)) : undefined,
    outputFolder: reference(raw.outputfolder) || undefined,
    preview: raw.preview !== false,
    render: raw.render === true,
  };
}
