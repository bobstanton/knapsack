import { around } from "monkey-around";
import { Plugin, WorkspaceLeaf, loadPrism, type TFile, type ViewState } from "obsidian";
import { registerKnap as registerCodeMirrorMode } from "knap/codemirror";
import { registerKnap as registerPrismGrammar } from "knap/prism";
import { TemplateBlock } from "./block";
import { noteBlocks } from "./note-blocks";
import { MARKDOWN_TEMPLATE_PATH, TEMPLATE_PATH, TEMPLATE_VIEW } from "./shared";
import { TemplateView } from "./template-view";
import "./styles.css";

export default class KnapsackPlugin extends Plugin {
  onload(): void {
    this.registerView(TEMPLATE_VIEW, leaf => new TemplateView(leaf));
    this.registerExtensions(["knap"], TEMPLATE_VIEW);
    this.routeMarkdownTemplates();
    this.registerEditorExtension(noteBlocks(this.app));
    this.registerMarkdownCodeBlockProcessor("knapsack", (source, el, ctx) => ctx.addChild(new TemplateBlock(this.app, source, el, ctx.sourcePath)));

    void loadPrism().then((prism: { languages: Record<string, unknown> }) => {
      registerPrismGrammar(prism);
      this.register(() => delete prism.languages.knap);
    });
    const codeMirror = (window as { CodeMirror?: Parameters<typeof registerCodeMirrorMode>[0] }).CodeMirror;

    if (codeMirror) registerCodeMirrorMode(codeMirror);
  }

  private routeMarkdownTemplates(): void {
    const show = (type: string, from: string): void => {
      for (const leaf of this.app.workspace.getLeavesOfType(from)) {
        const file = (leaf.view as { file?: TFile | null }).file;

        if (file && MARKDOWN_TEMPLATE_PATH.test(file.path)) void leaf.setViewState({ ...leaf.getViewState(), type });
      }
    };

    const viewFor = (type: string, file: unknown): string => {
      if (typeof file !== "string") return type;
      if (type === "markdown" && MARKDOWN_TEMPLATE_PATH.test(file)) return TEMPLATE_VIEW;

      return type === TEMPLATE_VIEW && !TEMPLATE_PATH.test(file) ? "markdown" : type;
    };

    this.register(() => show("markdown", TEMPLATE_VIEW));
    this.register(around(WorkspaceLeaf.prototype, {
      setViewState(next) {
        return function (this: WorkspaceLeaf, state: ViewState, ...rest) {
          const type = viewFor(state.type, state.state?.file);

          return next.call(this, type === state.type ? state : { ...state, type }, ...rest);
        };
      },
    }));
    this.app.workspace.onLayoutReady(() => show(TEMPLATE_VIEW, "markdown"));
  }
}
