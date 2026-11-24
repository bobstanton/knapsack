import { AbstractInputSuggest, MarkdownRenderChild, MarkdownRenderer, Notice, Setting, getAllTags, normalizePath, type App, type TFile } from "obsidian";
import { parseSettings, type Data, type Field, type Settings } from "./settings";
import { MARKDOWN_TEMPLATE_PATH, listItems, messageOf, sortedUnique } from "./shared";

interface Result {
  output: string;
  errors: string[];
  warnings: string[];
  variables: Record<string, unknown>;
}

interface Supplied {
  variables: Record<string, unknown>;
  note?: TFile;
}

type TextField = Exclude<Field, { kind: "choice" | "checkbox" }>;

function isSeveral(field: TextField): boolean {
  return field.kind === "list" || field.kind === "notes";
}

function readText(field: TextField, text: string): unknown {
  if (field.kind === "number") return text === "" ? undefined : Number(text);

  return isSeveral(field) ? listItems(text).filter(Boolean) : text;
}

function showValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");

  return typeof value === "string" ? value : JSON.stringify(value);
}

function isEmpty(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

export class TemplateBlock extends MarkdownRenderChild {
  private readonly values: Record<string, unknown> = {};
  private readonly required = new Map<string, HTMLElement>();
  private settings?: Settings;
  private watched: string[] = [];
  private edited = false;
  private previewEl!: HTMLElement;
  private run = 0;
  private pending: Promise<Result | undefined> = Promise.resolve(undefined);

  constructor(private readonly app: App, private readonly source: string, containerEl: HTMLElement, private readonly sourcePath: string) {
    super(containerEl);
  }

  onload(): void {
    const changed = (file: { path: string }): void => { if (this.watched.includes(file.path)) void this.refresh(); };

    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.metadataCache.on("changed", changed));
    this.containerEl.empty();
    this.containerEl.addClass("knapsack-block");
    const formEl = this.containerEl.createDiv({ cls: "knapsack-form" });

    this.previewEl = this.containerEl.createDiv({ cls: "knapsack-preview" });

    void this.start(formEl);
  }

  private async start(formEl: HTMLElement): Promise<void> {
    try {
      const settings = this.settings = parseSettings(this.source);
      const actions = Boolean(settings.fields ?? settings.outputFolder);

      this.containerEl.toggleClass("knapsack-has-actions", actions);
      const supplied = settings.fields ? await this.variables(settings.data) : undefined;

      if (settings.fields && supplied) this.renderForm(formEl, settings.fields, supplied.variables);
      if (actions) this.renderActions(formEl);
      await this.refresh(supplied);
    } catch (error) {
      this.renderMessages("knapsack-error", "⚠️ Template error", [messageOf(error)]);
    }
  }

  private refresh(supplied?: Supplied): Promise<Result | undefined> {
    return this.pending = this.render(supplied);
  }

  private file(reference: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(reference, this.sourcePath) ?? this.app.vault.getFileByPath(reference);
  }

  private async variables(data: Data): Promise<Supplied> {
    const date = new Date().toISOString();

    if (data.from === "note") {
      const note = this.file(data.reference);

      if (!note) throw new Error(`Data note not found: ${data.reference}`);

      return { variables: { date, ...this.app.metadataCache.getFileCache(note)?.frontmatter }, note };
    }

    const variables: Record<string, unknown> = { date, ...data.values };
    const computed = Object.entries(variables).filter((entry): entry is [string, string] => typeof entry[1] === "string" && /\{[{%]/.test(entry[1]));

    if (computed.length === 0) return { variables };
    const { engine } = await import("./knap");
    const resolved = await Promise.all(computed.map(async ([name, value]) => [name, await engine.renderOrThrow(value, { variables })] as const));

    return { variables: { ...variables, ...Object.fromEntries(resolved) } };
  }

  private renderForm(formEl: HTMLElement, fields: Field[], defaults: Record<string, unknown>): void {
    for (const field of fields) {
      const initial = defaults[field.name];
      const setting = new Setting(formEl).setName(field.required ? `${field.name} *` : field.name);
      const set = (value: unknown): void => {
        this.edited = true;
        this.values[field.name] = value;
        setting.settingEl.removeClass("knapsack-missing");
        void this.refresh();
      };

      setting.settingEl.addClass("knapsack-field");
      setting.settingEl.dataset.field = field.name;
      setting.settingEl.dataset.type = field.kind;

      if (field.required) {
        this.required.set(field.name, setting.settingEl);
        setting.settingEl.dataset.required = "";
      }

      switch (field.kind) {
        case "choice": {
          const chosen = typeof initial === "string" && field.choices.includes(initial) ? initial : field.choices[0];

          this.values[field.name] = chosen;
          setting.addDropdown(dropdown => dropdown.addOptions(Object.fromEntries(field.choices.map(choice => [choice, choice]))).setValue(chosen).onChange(set));
          break;
        }
        case "checkbox":
          this.values[field.name] = initial === true;
          setting.addToggle(toggle => toggle.setValue(initial === true).onChange(set));
          break;
        default: {
          const shown = showValue(initial);

          this.values[field.name] = readText(field, shown);
          setting.addText(text => {
            text.inputEl.type = field.kind === "number" || field.kind === "date" ? field.kind : "text";
            text.setValue(shown).onChange(value => set(readText(field, value)));
            if (field.kind === "note" || field.kind === "notes") new ValueSuggest(this.app, text.inputEl, () => noteNames(this.app, field.folder), isSeveral(field));
            if (field.kind === "text" || field.kind === "list") new ValueSuggest(this.app, text.inputEl, () => propertyValues(this.app, field.property), isSeveral(field));
          });
        }
      }
    }
  }

  private renderActions(formEl: HTMLElement): void {
    const actions = new Setting(formEl);

    actions.settingEl.addClass("knapsack-actions");
    actions.addButton(button => button.setButtonText("Create note").setCta().onClick(() => this.deliver(result => this.createNote(result))));
    actions.addButton(button => button.setButtonText("Copy").onClick(() => this.deliver(async result => {
      await navigator.clipboard.writeText(result.output);
      new Notice("Copied the generated Markdown.");
    })));
  }

  private deliver(use: (result: Result) => void | Promise<void>): void {
    const missing = [...this.required].filter(([name]) => isEmpty(this.values[name]));

    for (const [, row] of missing) row.addClass("knapsack-missing");

    if (missing.length > 0) {
      new Notice(`Fill in ${missing.map(([name]) => name).join(", ")}.`);

      return;
    }

    void this.pending.then(result => {
      if (!result || result.errors.length > 0) new Notice("Fix the template error first.");
      else return use(result);
    }).catch((error: unknown) => new Notice(messageOf(error)));
  }

  private noteName(variables: Record<string, unknown>): string {
    const named = ["title", "name"]
      .flatMap(wanted => Object.entries(variables).filter(([name]) => name.toLowerCase() === wanted).map(([, value]) => value))
      .find((value): value is string => typeof value === "string" && value.trim() !== "");
    const fallback = this.file(this.settings?.template ?? "")?.basename.replace(/\.knap$/i, "") ?? "Untitled";

    return (named?.trim() ?? fallback).replace(/[\\/:*?"<>|#^[\]]/g, "-");
  }

  private async createNote(result: Result): Promise<void> {
    const base = this.noteName(result.variables);
    const wanted = this.settings?.outputFolder ? normalizePath(this.settings.outputFolder) : this.app.fileManager.getNewFileParent(this.sourcePath).path;
    const existing = this.app.vault.getAllFolders(true).find(folder => folder.path.toLowerCase() === wanted.toLowerCase());
    const taken = new Set(existing?.children.map(child => child.name.toLowerCase()));
    let name = `${base}.md`;

    if (!existing) await this.app.vault.createFolder(wanted);
    for (let copy = 1; taken.has(name.toLowerCase()); copy++) name = `${base} ${copy}.md`;

    await this.app.workspace.getLeaf("tab").openFile(await this.app.vault.create(normalizePath(`${existing?.path ?? wanted}/${name}`), result.output));
  }

  private renderMessages(cls: string, title: string, messages: string[]): void {
    if (messages.length === 0) return;
    const block = this.previewEl.createDiv({ cls });

    block.createEl("h3", { text: title });
    for (const message of messages) block.createEl("p", { text: message });
  }

  private async generate(settings: Settings, resolved?: Supplied): Promise<Result> {
    const template = this.file(settings.template);

    if (!template) throw new Error(`Template not found: ${settings.template}`);
    this.watched = [template.path];
    const supplied = resolved ?? await this.variables(settings.data);
    const variables = { ...supplied.variables, ...this.values };
    const { engine, describeError } = await import("./knap");
    const rendered = await engine.render(await this.app.vault.cachedRead(template), { variables });

    if (supplied.note) this.watched = [template.path, supplied.note.path];

    return {
      output: rendered.output,
      errors: rendered.errors.map(describeError),
      warnings: rendered.warnings.map(warning => `Line ${warning.line}, filter ${warning.filter}: ${warning.message}`),
      variables,
    };
  }

  private async render(supplied?: Supplied): Promise<Result | undefined> {
    const settings = this.settings;

    if (!settings) return undefined;
    const run = ++this.run;
    const result = await this.generate(settings, supplied).catch((error: unknown): Result => ({ output: "", errors: [messageOf(error)], warnings: [], variables: {} }));

    if (run === this.run) await this.show(settings, result);

    return result;
  }

  private async show(settings: Settings, result: Result): Promise<void> {
    this.previewEl.empty();
    this.renderMessages("knapsack-error", "⚠️ Template error", result.errors);
    this.renderMessages("knapsack-error knapsack-warning", "Template warning", result.warnings);
    if (!result.output.trim() || !settings.preview || (settings.fields && !this.edited)) return;
    const fence = "`".repeat(Math.max(3, ...(result.output.match(/`+/g) ?? []).map(ticks => ticks.length + 1)));

    await MarkdownRenderer.render(this.app, settings.render ? result.output : `${fence}markdown\n${result.output}\n${fence}`, this.previewEl.createDiv(), this.sourcePath, this);
  }
}

class ValueSuggest extends AbstractInputSuggest<string> {
  private options?: string[];

  constructor(app: App, private readonly input: HTMLInputElement, private readonly read: () => string[], private readonly several: boolean) {
    super(app, input);
  }

  protected getSuggestions(query: string): string[] {
    const items = (this.several ? listItems(query) : [query.trim()]).map(item => item.toLowerCase());
    const typed = items.pop() ?? "";

    this.options ??= this.read();

    return this.options.filter(option => option.toLowerCase().includes(typed) && option.toLowerCase() !== typed && !items.includes(option.toLowerCase())).slice(0, 50);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  selectSuggestion(value: string): void {
    const kept = this.several ? listItems(this.input.value).slice(0, -1) : [];

    this.setValue(this.several ? `${[...kept, value].join(", ")}, ` : value);
    this.input.dispatchEvent(new Event("input"));
    if (!this.several) this.close();
  }
}

function noteNames(app: App, folder: string): string[] {
  const prefix = folder ? `${normalizePath(folder).toLowerCase()}/` : "";

  return sortedUnique(app.vault.getMarkdownFiles()
    .filter(file => file.path.toLowerCase().startsWith(prefix) && !MARKDOWN_TEMPLATE_PATH.test(file.path))
    .map(file => file.basename));
}

function propertyValues(app: App, property: string): string[] {
  const wanted = property.toLowerCase();

  return sortedUnique(app.vault.getMarkdownFiles().flatMap(file => {
    const cache = app.metadataCache.getFileCache(file);
    const held = Object.entries<unknown>(cache?.frontmatter ?? {})
      .filter(([name]) => name.toLowerCase() === wanted)
      .flatMap(([, value]) => Array.isArray(value) ? value as unknown[] : [value])
      .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      .map(String);
    const tags = wanted === "tags" && cache ? (getAllTags(cache) ?? []).map(tag => tag.replace(/^#/, "")) : [];

    return [...held, ...tags];
  }));
}
