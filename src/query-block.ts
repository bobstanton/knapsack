import { MarkdownRenderChild, Notice, setIcon, type App, type TFile } from "obsidian";
import { findFile, isEmpty, noteIn, noteNameFrom, outputFolder, renderMarkdownPreview, renderMessages, renderTemplate, suppliedVariables, type Message, type OutputFolder, type Result } from "./notes";
import type { Field, QuerySettings } from "./settings";
import { messageOf, parseJson } from "./shared";
import { readyVaultQuery } from "./vaultquery";

type Status = "ready" | "exists" | "problem";

type Filter = "all" | Status;

const STATUS_ICONS: Record<Status, string> = { ready: "check", exists: "file", problem: "alert-triangle" };
const FILTER_LABELS: Record<Filter, string> = { all: "All", ready: "Ready", exists: "Existing", problem: "Problems" };
const FILTERS = Object.keys(FILTER_LABELS) as Filter[];
const ROW_HEIGHT = 32;
const SPARE_ROWS = 4;
const PAGE_ROWS = 10;
let blocks = 0;

interface Problem {
  text: string;
  rows?: number[];
}

interface Row {
  result: Result;
  name?: string;
  problems: Problem[];
  tag?: string;
}

interface Frame {
  chips: [Filter, HTMLButtonElement][];
  list: HTMLElement;
  spacer: HTMLElement;
  path: HTMLElement;
  one: HTMLButtonElement;
  all: HTMLButtonElement;
  copy: HTMLButtonElement;
}

type Outcome = "created" | "overwritten" | "existing" | "problems" | "failed";

export function coerce(field: Field, value: unknown): unknown {
  switch (field.kind) {
    case "list":
    case "notes": {
      const parsed = typeof value === "string" ? parseJson(value) : value;

      if (Array.isArray(parsed)) return parsed as unknown[];

      return String(value).split(field.kind === "notes" ? /[\n,]/ : /\n/).map(item => item.trim()).filter(Boolean);
    }
    case "json": {
      const parsed = typeof value === "string" ? parseJson(value) : value;

      if (parsed === undefined) throw new Error(`${field.name} is not valid JSON.`);

      return parsed;
    }
    case "number": {
      const number = Number(value);

      if (value === "" || Number.isNaN(number)) throw new Error(`${field.name} is not a number.`);

      return number;
    }
    case "checkbox":
      return value === true || value === 1 || (typeof value === "string" && /^(true|1|yes)$/i.test(value.trim()));
    default:
      return value;
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function clamp(value: number, last: number): number {
  return Math.max(0, Math.min(value, last));
}

function summary(done: Record<Outcome, number>): string {
  const parts = [
    done.created > 0 || done.overwritten === 0 ? `created ${plural(done.created, "note")}` : "",
    done.overwritten > 0 ? `overwrote ${done.overwritten}` : "",
    done.existing > 0 ? `skipped ${done.existing} that exist${done.existing === 1 ? "s" : ""}` : "",
    done.problems > 0 ? `skipped ${done.problems} with problems` : "",
    done.failed > 0 ? `${done.failed} could not be written` : "",
  ].filter(Boolean).join(", ");

  return `${parts.charAt(0).toUpperCase()}${parts.slice(1)}.`;
}

export class QueryBlock extends MarkdownRenderChild {
  private readonly id = `knapsack-query-${++blocks}`;
  private readonly rowsEl: HTMLElement;
  private readonly currentEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private rows: Row[] = [];
  private statuses: Status[] = [];
  private listed: number[] = [];
  private filter: Filter = "all";
  private index = 0;
  private rowHeight = ROW_HEIGHT;
  private template?: TFile;
  private frame?: Frame;
  private observer?: ResizeObserver;
  private loads = 0;
  private paints = 0;
  private busy = false;

  constructor(private readonly app: App, private readonly settings: QuerySettings, containerEl: HTMLElement, private readonly sourcePath: string) {
    super(containerEl);
    containerEl.empty();
    containerEl.addClass("knapsack-block", "knapsack-query");
    this.rowsEl = containerEl.createDiv({ cls: "knapsack-query-rows" });
    const detail = containerEl.createDiv({ cls: "knapsack-query-detail" });

    this.currentEl = detail.createDiv({ cls: "knapsack-query-current" });
    this.previewEl = detail.createDiv({ cls: "knapsack-preview" });
  }

  onload(): void {
    this.registerEvent(this.app.vault.on("modify", file => { if (file.path === this.template?.path) void this.runQuery(); }));
    this.register(() => this.observer?.disconnect());
    void this.runQuery();
  }

  private showMessage(draw: (el: HTMLElement) => void): void {
    this.paints++;
    this.frame = undefined;
    this.observer?.disconnect();
    this.rowsEl.hide();
    this.currentEl.empty();
    this.previewEl.empty();
    draw(this.previewEl);
  }

  private async runQuery(): Promise<void> {
    const load = ++this.loads;

    const say = (text: string): void => {
      if (load === this.loads && this.rows.length === 0) this.showMessage(el => el.setText(text));
    };

    say("Waiting for VaultQuery…");

    try {
      const template = this.template = findFile(this.app, this.sourcePath, this.settings.template) ?? undefined;

      if (!template) throw new Error(`Template not found: ${this.settings.template}`);
      const api = await readyVaultQuery(this.app);

      say("Loading notes…");
      const rows = await this.build(template, await api.query(this.settings.query, this.sourcePath));

      if (load !== this.loads) return;
      this.rows = rows;

      if (rows.length === 0) {
        this.showMessage(el => el.setText("The query returned no rows."));

        return;
      }

      this.frame = this.buildFrame();
      this.show(this.index);
    } catch (error) {
      if (load !== this.loads) return;
      this.rows = [];
      this.showMessage(el => renderMessages(el, "knapsack-error", "⚠️ Query error", [messageOf(error)]));
    }
  }

  private async build(template: TFile, records: Record<string, unknown>[]): Promise<Row[]> {
    const fields = this.settings.fields ?? [];
    const columns = new Set(records.flatMap(record => Object.keys(record)));
    const defaults = (await suppliedVariables(this.app, this.sourcePath, this.settings.data)).variables;
    const absent = fields.filter(field => field.required && !columns.has(field.name) && isEmpty(defaults[field.name])).map(field => field.name);

    if (records.length > 0 && absent.length > 0) throw new Error(`The query has no ${absent.join(", ")} column, and fields requires ${absent.length === 1 ? "it" : "them"}.`);

    const rows = await Promise.all(records.map(record => this.prepareRow(template, fields, record)));
    const sameName = new Map<string, number[]>();

    rows.forEach((row, index) => {
      if (row.name) sameName.set(row.name.toLowerCase(), [...(sameName.get(row.name.toLowerCase()) ?? []), index]);
    });

    for (const indexes of sameName.values()) {
      if (indexes.length < 2) continue;

      for (const index of indexes) {
        rows[index].problems.push({ text: "Same note name as", rows: indexes.filter(other => other !== index) });
        rows[index].tag ??= "duplicate name";
      }
    }

    return rows;
  }

  private async prepareRow(template: TFile, fields: Field[], record: Record<string, unknown>): Promise<Row> {
    const problems: Problem[] = [];
    let tag: string | undefined;
    const values = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null));

    for (const field of fields) {
      if (!(field.name in values)) continue;

      try {
        values[field.name] = coerce(field, values[field.name]);
      } catch (error) {
        problems.push({ text: messageOf(error) });
        tag ??= `bad ${field.name}`;
        delete values[field.name];
      }
    }

    try {
      const { variables } = await suppliedVariables(this.app, this.sourcePath, this.settings.data, values);
      const result = await renderTemplate(this.app, template, variables);
      const name = noteNameFrom(variables);
      const empty = fields.filter(field => field.required && isEmpty(variables[field.name])).map(field => field.name);

      if (empty.length > 0) problems.push({ text: `Required and empty: ${empty.join(", ")}.` });
      if (!name) problems.push({ text: "No title or name column to name the note after." });
      tag ??= !name ? "no name" : empty.length > 0 ? `no ${empty[0]}` : result.errors.length > 0 ? "template error" : undefined;

      return { result, name, problems: [...problems, ...result.errors.map(text => ({ text }))], tag };
    } catch (error) {
      return { result: { output: "", errors: [], warnings: [], variables: values }, problems: [...problems, { text: messageOf(error) }], tag: tag ?? "error" };
    }
  }

  private status(row: Row, folder: OutputFolder): Status {
    if (row.problems.length > 0 || !row.name) return "problem";

    return noteIn(folder, row.name).exists ? "exists" : "ready";
  }

  private writes(status: Status): boolean {
    return status === "ready" || (status === "exists" && this.settings.existingFile === "overwrite");
  }

  private buildFrame(): Frame {
    this.rowsEl.empty();
    this.currentEl.empty();
    this.rowsEl.show();

    const filters = this.rowsEl.createDiv({ cls: "knapsack-query-filters", attr: { role: "group", "aria-label": "Rows to show" } });
    const chips = FILTERS.map((filter): [Filter, HTMLButtonElement] => {
      const chip = filters.createEl("button", { cls: "knapsack-query-filter", attr: { type: "button", "data-status": filter } });

      chip.addEventListener("click", () => {
        this.filter = filter;
        this.show(this.index);
      });

      return [filter, chip];
    });
    const { list, spacer } = this.buildList();
    const actions = this.rowsEl.createDiv({ cls: "knapsack-query-actions" });
    const all = actions.createEl("button", { attr: { type: "button" } });
    const one = actions.createEl("button", { cls: "mod-cta", attr: { type: "button" } });
    const path = this.currentEl.createSpan({ cls: "knapsack-query-path" });
    const copy = this.currentEl.createEl("button", { text: "Copy", attr: { type: "button" } });

    one.addEventListener("click", () => void this.create([this.rows[this.index]], true));
    all.addEventListener("click", () => void this.create([...this.rows], false));
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.rows[this.index].result.output).then(() => new Notice("Copied the generated Markdown."));
    });

    return { chips, list, spacer, path, one, all, copy };
  }

  private buildList(): Pick<Frame, "list" | "spacer"> {
    const list = this.rowsEl.createDiv({ cls: "knapsack-query-list", attr: { role: "listbox", tabindex: "0", "aria-label": "Rows" } });
    const spacer = list.createDiv({ cls: "knapsack-query-spacer" });
    let drawing = 0;

    list.addEventListener("scroll", () => {
      drawing ||= list.win.requestAnimationFrame(() => {
        drawing = 0;
        this.renderList();
      });
    });
    list.addEventListener("keydown", event => {
      const at = this.listed.indexOf(this.index);
      const last = this.listed.length - 1;
      const moves: Partial<Record<string, number>> = { ArrowDown: at + 1, ArrowUp: at - 1, PageDown: at + PAGE_ROWS, PageUp: at - PAGE_ROWS, Home: 0, End: last };
      const to = moves[event.key];

      if (to === undefined) return;
      event.preventDefault();
      this.show(this.listed[clamp(to, last)]);
    });
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.renderList());
    this.observer.observe(list);

    return { list, spacer };
  }

  private refresh(): void {
    const frame = this.frame;

    if (!frame) return;
    const folder = outputFolder(this.app, this.sourcePath, this.settings);
    const statuses = this.statuses = this.rows.map(row => this.status(row, folder));
    const counts: Record<Filter, number> = { all: statuses.length, ready: 0, exists: 0, problem: 0 };

    for (const status of statuses) counts[status]++;
    if (counts[this.filter] === 0) this.filter = "all";
    this.listed = this.rows.map((_, index) => index).filter(index => this.filter === "all" || statuses[index] === this.filter);
    if (!this.listed.includes(this.index)) this.index = this.listed[0];

    const row = this.rows[this.index];
    const status = statuses[this.index];
    const replaced = this.settings.existingFile === "overwrite" ? counts.exists : 0;

    for (const [filter, chip] of frame.chips) {
      chip.setText(`${FILTER_LABELS[filter]} ${counts[filter]}`);
      chip.ariaPressed = String(filter === this.filter);
      chip.toggle(filter === "all" || counts[filter] > 0);
    }

    frame.path.setText(row.name ? noteIn(folder, row.name).path : `Row ${this.index + 1} of ${this.rows.length}`);
    frame.one.setText(status === "exists" && replaced > 0 ? "Overwrite note" : "Create note");
    frame.one.disabled = this.busy || !this.writes(status);
    frame.all.setText(replaced > 0 ? `Create ${counts.ready}, overwrite ${replaced}` : `Create ${plural(counts.ready, "note")}`);
    frame.all.disabled = this.busy || counts.ready + replaced === 0;
    frame.copy.disabled = !row.result.output.trim();
  }

  private renderList(): void {
    const frame = this.frame;

    if (!frame) return;
    const { list, spacer } = frame;
    const height = list.clientHeight || this.rowHeight * PAGE_ROWS;
    const first = Math.max(0, Math.floor(list.scrollTop / this.rowHeight) - SPARE_ROWS);
    const end = Math.min(this.listed.length, Math.ceil((list.scrollTop + height) / this.rowHeight) + SPARE_ROWS);

    spacer.empty();
    spacer.setCssProps({ "--knapsack-rows": String(this.listed.length) });

    for (let at = first; at < end; at++) {
      const index = this.listed[at];
      const row = this.rows[index];
      const status = this.statuses[index];
      const option = spacer.createDiv({ cls: "knapsack-query-row", attr: {
        role: "option", id: `${this.id}-${index}`, "aria-selected": String(index === this.index), "aria-posinset": at + 1, "aria-setsize": this.listed.length, "data-status": status,
      } });

      option.setCssProps({ "--knapsack-row": String(at) });
      setIcon(option.createSpan({ cls: "knapsack-query-row-icon", attr: { "aria-hidden": "true" } }), STATUS_ICONS[status]);
      option.createSpan({ cls: "knapsack-query-row-name", text: row.name ?? `Row ${index + 1}` });
      if (status !== "ready") option.createSpan({ cls: "knapsack-query-row-note", text: status === "exists" ? "exists" : row.tag ?? "problem" });
      option.addEventListener("click", () => this.show(index));
    }

    list.setAttribute("aria-activedescendant", `${this.id}-${this.index}`);
    const drawn = spacer.firstElementChild?.getBoundingClientRect().height;

    if (drawn && Math.abs(drawn - this.rowHeight) >= 1) {
      this.rowHeight = drawn;
      this.renderList();
    }
  }

  private show(index: number): void {
    const frame = this.frame;

    if (!frame) return;
    this.index = clamp(index, this.rows.length - 1);
    this.refresh();
    const { list } = frame;
    const top = this.listed.indexOf(this.index) * this.rowHeight;

    if (top < list.scrollTop) list.scrollTop = top;
    else if (list.clientHeight > 0 && top + this.rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + this.rowHeight - list.clientHeight;
    this.renderList();
    void this.renderPreview(this.rows[this.index]);
  }

  private message(problem: Problem): Message {
    const rows = problem.rows;

    if (!rows) return problem.text;

    return line => {
      line.appendText(`${problem.text} `);

      rows.forEach((row, at) => {
        if (at > 0) line.appendText(", ");
        line.createEl("button", { cls: "knapsack-query-link", text: `row ${row + 1}`, attr: { type: "button" } }).addEventListener("click", () => this.show(row));
      });
      line.appendText(".");
    };
  }

  private async renderPreview(row: Row): Promise<void> {
    const paint = ++this.paints;
    const el = createDiv();

    renderMessages(el, "knapsack-error", "⚠️ This row cannot be made into a note", row.problems.map(problem => this.message(problem)));
    renderMessages(el, "knapsack-error knapsack-warning", "Template warning", row.result.warnings);
    if (this.settings.preview && row.result.output.trim()) await renderMarkdownPreview(this.app, this.sourcePath, el, this.settings, row.result.output, this);
    if (paint === this.paints) this.previewEl.replaceChildren(el);
  }

  private async write(name: string, output: string, folder: OutputFolder): Promise<TFile> {
    const note = noteIn(folder, name);

    if (!note.exists) return this.app.vault.create(note.path, output);
    const file = this.app.vault.getFileByPath(note.path);

    if (!file) throw new Error(`${note.path} is a folder.`);
    await this.app.vault.modify(file, output);

    return file;
  }

  private async create(rows: Row[], open: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refresh();
    const done: Record<Outcome, number> = { created: 0, overwritten: 0, existing: 0, problems: 0, failed: 0 };
    let written: TFile | undefined;

    try {
      const target = outputFolder(this.app, this.sourcePath, this.settings);

      if (!target.exists) await this.app.vault.createFolder(target.path);

      for (const row of rows) {
        const folder = outputFolder(this.app, this.sourcePath, this.settings);
        const status = this.status(row, folder);

        if (!row.name || !this.writes(status)) {
          done[status === "exists" ? "existing" : "problems"]++;
          continue;
        }

        try {
          written = await this.write(row.name, row.result.output, folder);
          done[status === "exists" ? "overwritten" : "created"]++;
        } catch (error) {
          row.problems.push({ text: `Could not write the note: ${messageOf(error)}` });
          row.tag ??= "not written";
          done.failed++;
        }
      }

      new Notice(summary(done));
    } catch (error) {
      new Notice(messageOf(error));
    } finally {
      this.busy = false;
      this.show(this.index);
    }

    if (open && written) await this.app.workspace.getLeaf("tab").openFile(written);
  }
}
