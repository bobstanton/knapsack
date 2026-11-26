import { AbstractInputSuggest, MarkdownRenderChild, Notice, Setting, getAllTags, normalizePath, type App } from "obsidian";
import { findFile, isEmpty, noteIn, noteNameFrom, outputFolder, renderMarkdownPreview, renderMessages, renderTemplate, safeName, suppliedVariables, type Result, type Supplied } from "./notes";
import { parseSettings, type Field, type Settings } from "./settings";
import { MARKDOWN_TEMPLATE_PATH, listItems, messageOf, parseJson, sortedUnique } from "./shared";

type TextField = Exclude<Field, { kind: "choice" | "checkbox" }>;

function readText(field: TextField, text: string): unknown {
  if (field.kind === "number") return text === "" ? undefined : Number(text);

  if (field.kind === "json") {
    const parsed = parseJson(text);

    // Text that is not yet JSON stays as typed. null is JSON.
    return parsed === undefined ? text : parsed;
  }

  return field.kind === "notes" ? listItems(text).filter(Boolean) : text;
}

function showValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");

  return typeof value === "string" ? value : JSON.stringify(value);
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
      const supplied = settings.fields ? await suppliedVariables(this.app, this.sourcePath, settings.data) : undefined;

      if (settings.fields && supplied) this.renderForm(formEl, settings.fields, supplied.variables);
      if (actions) this.renderActions(formEl);
      await this.refresh(supplied);
    } catch (error) {
      renderMessages(this.previewEl, "knapsack-error", "⚠️ Template error", [messageOf(error)]);
    }
  }

  private refresh(supplied?: Supplied): Promise<Result | undefined> {
    return this.pending = this.render(supplied);
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
        case "list":
          this.values[field.name] = this.renderList(setting, field.name, field.property, initial, set);
          break;
        default: {
          const shown = field.kind === "json" && initial != null && typeof initial !== "string" ? JSON.stringify(initial) : showValue(initial);

          this.values[field.name] = readText(field, shown);
          setting.addText(text => {
            text.inputEl.type = field.kind === "number" || field.kind === "date" ? field.kind : "text";
            text.setValue(shown).onChange(value => set(readText(field, value)));
            if (field.kind === "note" || field.kind === "notes") new ValueSuggest(this.app, text.inputEl, () => noteNames(this.app, field.folder), field.kind === "notes");
            if (field.kind === "text") new ValueSuggest(this.app, text.inputEl, () => propertyValues(this.app, field.property), false);
          });
        }
      }
    }
  }

  private renderList(setting: Setting, name: string, property: string, initial: unknown, set: (items: string[]) => void): string[] {
    const list = setting.controlEl.createDiv({ cls: "knapsack-list" });
    const rows = list.createDiv();
    const add = list.createEl("button", { text: "Add item", attr: { type: "button", "aria-label": `Add item to ${name}` } });
    const inputs = new Set<HTMLInputElement>();
    const values = (): string[] => Array.from(inputs, input => input.value.trim()).filter(Boolean);
    let suggestions: string[] | undefined;

    const addRow = (value: string): HTMLInputElement => {
      const row = rows.createDiv({ cls: "knapsack-list-item" });
      const input = row.createEl("input", { type: "text", value, attr: { "aria-label": `${name} item` } });
      const remove = row.createEl("button", { text: "Remove", attr: { type: "button", "aria-label": `Remove item from ${name}` } });
      inputs.add(input);
      input.addEventListener("input", () => set(values()));
      const suggest = new ValueSuggest(this.app, input, () => suggestions ??= propertyValues(this.app, property), false,
        () => Array.from(inputs).filter(other => other !== input).map(other => other.value.trim()));
      remove.addEventListener("click", () => {
        suggest.close();
        inputs.delete(input);
        row.remove();
        if (inputs.size === 0) addRow("").focus();
        else add.focus();
        set(values());
      });
      return input;
    };

    const defaults = Array.isArray(initial) ? initial.map(showValue) : listItems(showValue(initial));
    for (const item of defaults.filter(item => item.trim())) addRow(item);
    if (inputs.size === 0) addRow("");
    add.addEventListener("click", () => addRow("").focus());
    return values();
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

  private async createNote(result: Result): Promise<void> {
    const settings = this.settings;

    if (!settings) return;
    const template = findFile(this.app, this.sourcePath, settings.template);
    const base = noteNameFrom(result.variables) ?? (template ? safeName(template.basename.replace(/\.knap$/i, "")) : "Untitled");
    const folder = outputFolder(this.app, this.sourcePath, settings);
    let note = noteIn(folder, base);

    if (!folder.exists) await this.app.vault.createFolder(folder.path);
    for (let copy = 1; note.exists; copy++) note = noteIn(folder, `${base} ${copy}`);

    await this.app.workspace.getLeaf("tab").openFile(await this.app.vault.create(note.path, result.output));
  }

  private async generate(settings: Settings, resolved?: Supplied): Promise<Result> {
    const template = findFile(this.app, this.sourcePath, settings.template);

    if (!template) throw new Error(`Template not found: ${settings.template}`);
    this.watched = [template.path];
    const supplied = resolved ?? await suppliedVariables(this.app, this.sourcePath, settings.data);
    const result = await renderTemplate(this.app, template, { ...supplied.variables, ...this.values });

    if (supplied.note) this.watched = [template.path, supplied.note.path];

    return result;
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
    renderMessages(this.previewEl, "knapsack-error", "⚠️ Template error", result.errors);
    renderMessages(this.previewEl, "knapsack-error knapsack-warning", "Template warning", result.warnings);
    if (!result.output.trim() || !settings.preview || (settings.fields && !this.edited)) return;
    await renderMarkdownPreview(this.app, this.sourcePath, this.previewEl, settings, result.output, this);
  }
}

class ValueSuggest extends AbstractInputSuggest<string> {
  private options?: string[];

  constructor(app: App, private readonly input: HTMLInputElement, private readonly read: () => string[], private readonly several: boolean, private readonly otherItems?: () => string[]) {
    super(app, input);
  }

  protected getSuggestions(query: string): string[] {
    const items = (this.several ? listItems(query) : [query.trim()]).map(item => item.toLowerCase());
    const typed = items.pop() ?? "";
    const used = new Set([...items, ...(this.otherItems?.() ?? []).map(item => item.toLowerCase())]);

    this.options ??= this.read();

    return this.options.filter(option => {
      const lower = option.toLowerCase();
      return lower.includes(typed) && lower !== typed && !used.has(lower);
    }).slice(0, 50);
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
