import { autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Annotation, EditorState, Prec, RangeSetBuilder } from "@codemirror/state";
import { EditorView, keymap, showPanel, type Decoration, type DecorationSet } from "@codemirror/view";
import { TextFileView, type WorkspaceLeaf } from "obsidian";
import { knapStreamParser } from "knap/codemirror";
import { TEMPLATE_VIEW, tokenMark } from "./shared";

type EditorTools = typeof import("./editor");

let tools: EditorTools | undefined;
let loading: Promise<void> | undefined;

function loadTools(): Promise<void> {
  return loading ??= import("./editor").then(loaded => { tools = loaded; });
}

function highlight(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const parser = knapStreamParser.startState();
  let from = 0;

  for (const text of state.doc.iterLines()) {
    const stream = { string: text, pos: 0 };

    while (stream.pos < text.length) {
      const start = stream.pos;
      const token = knapStreamParser.token(stream, parser);

      if (stream.pos === start) stream.pos++;
      if (token) builder.add(from + start, from + stream.pos, tokenMark(token));
    }

    from += text.length + 1;
  }

  return builder.finish();
}

const highlighting = EditorView.decorations.compute(["doc"], highlight);

const pairing = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (!tools || view.composing || view.state.selection.ranges.length !== 1 || !insert().isUserEvent("input.type")) return false;
  const paired = tools.pairTemplateInput(view.state.doc.toString(), from, to, text);

  if (!paired) return false;
  view.dispatch({
    changes: { from: paired.from, to: paired.to, insert: paired.insert },
    selection: { anchor: paired.anchor },
    userEvent: paired.insert ? "input.type" : "select",
    scrollIntoView: true,
  });

  return true;
});

const emptyPairBackspace = Prec.highest(keymap.of([{
  key: "Backspace",
  run(view) {
    if (!tools || !view.state.selection.main.empty || view.state.selection.ranges.length !== 1) return false;
    const pair = tools.emptyTemplatePair(view.state.doc.toString(), view.state.selection.main.head);

    if (!pair) return false;
    view.dispatch({ changes: pair, selection: { anchor: pair.from }, userEvent: "delete.backward" });

    return true;
  },
}]));

const validationPanel = showPanel.of(view => {
  const dom = createDiv({ cls: "knapsack-validation" });
  let checked: unknown;
  const refresh = (current: EditorView): void => {
    const doc = tools ? current.state.doc : null;

    if (doc === checked) return;
    checked = doc;
    const errors = doc && tools ? tools.validate(doc.toString()) : "";

    dom.setText(errors);
    dom.toggle(errors !== "");
  };

  refresh(view);

  return { dom, update: update => refresh(update.view) };
});

function completions(context: CompletionContext): CompletionResult | null {
  return tools?.complete(context.state.doc.toString(), context.pos) ?? null;
}

const fromDisk = Annotation.define<boolean>();

export class TemplateView extends TextFileView {
  // Built with the view: a file's contents can arrive before the view is opened, and must never be dropped.
  private readonly editor: EditorView;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl.addClass("knapsack-editor");
    this.editor = new EditorView({ parent: this.contentEl, state: this.editorState("") });
  }

  getViewType(): string {
    return TEMPLATE_VIEW;
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "knap" || extension === "md";
  }

  protected onOpen(): Promise<void> {
    void loadTools().then(() => this.editor.dispatch({}));

    return Promise.resolve();
  }

  protected onClose(): Promise<void> {
    this.editor.destroy();

    return Promise.resolve();
  }

  private editorState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        history(),
        EditorView.lineWrapping,
        highlighting,
        pairing,
        emptyPairBackspace,
        validationPanel,
        autocompletion({ override: [completions] }),
        keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(fromDisk))) this.requestSave();
        }),
      ],
    });
  }

  getViewData(): string {
    return this.editor.state.doc.toString();
  }

  setViewData(data: string, clear: boolean): void {
    if (clear) this.editor.setState(this.editorState(data));
    else if (data !== this.getViewData()) this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data }, annotations: fromDisk.of(true) });
  }

  clear(): void {
    this.editor.setState(this.editorState(""));
  }
}
