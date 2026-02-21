import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection, keymap } from "@codemirror/view";
import { bracketMatching, foldGutter, syntaxHighlighting, HighlightStyle, indentOnInput } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { search, searchKeymap } from "@codemirror/search";
import { loadLanguageForFile } from "../lib/language-loader";
import { getFileName } from "../lib/file-utils";

// Theme uses CSS variables — responds to data-theme switching automatically
const paneTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--pane-editor-bg)",
      color: "var(--pane-text)",
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: "var(--pane-font-size)",
      height: "100%",
      lineHeight: "1.7",
    },
    ".cm-scroller": {
      overflow: "auto",
      padding: "8px 0",
    },
    ".cm-gutters": {
      backgroundColor: "var(--pane-editor-gutter)",
      color: "var(--pane-editor-gutter-text)",
      borderRight: "1px solid var(--pane-editor-gutter-border)",
      paddingRight: "8px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--pane-editor-active-line)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--pane-editor-active-line)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--pane-editor-selection) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--pane-editor-cursor)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--pane-editor-search-match)",
      outline: "1px solid var(--pane-editor-search-match-border)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--pane-editor-search-match-active)",
      outline: "1px solid var(--pane-editor-search-match-active-border)",
    },
    ".cm-foldGutter": {
      color: "var(--pane-editor-gutter-text)",
    },
    ".cm-line": {
      padding: "0 16px 0 8px",
    },
  },
  { dark: true },
);

const paneHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--pane-syn-keyword)" },
  { tag: tags.string, color: "var(--pane-syn-string)" },
  { tag: tags.number, color: "var(--pane-syn-number)" },
  { tag: tags.comment, color: "var(--pane-syn-comment)", fontStyle: "italic" },
  { tag: tags.function(tags.variableName), color: "var(--pane-syn-function)" },
  { tag: tags.definition(tags.variableName), color: "var(--pane-syn-function)" },
  { tag: tags.typeName, color: "var(--pane-syn-type)" },
  { tag: tags.operator, color: "var(--pane-syn-operator)" },
  { tag: tags.propertyName, color: "var(--pane-syn-property)" },
  { tag: tags.bool, color: "var(--pane-syn-number)" },
  { tag: tags.null, color: "var(--pane-syn-number)" },
  { tag: tags.className, color: "var(--pane-syn-type)" },
  { tag: tags.tagName, color: "var(--pane-syn-tag)" },
  { tag: tags.attributeName, color: "var(--pane-syn-attribute)" },
  { tag: tags.regexp, color: "var(--pane-syn-operator)" },
  { tag: tags.variableName, color: "var(--pane-syn-property)" },
]);

function loadLanguage(view: EditorView, compartment: Compartment, filePath: string) {
  const filename = getFileName(filePath);
  loadLanguageForFile(filename)
    .then((lang) => {
      // Guard: view might have been destroyed by the time the language loads
      try {
        if (view.dom?.parentNode) {
          view.dispatch({
            effects: compartment.reconfigure(lang ? [lang] : []),
          });
        }
      } catch {
        // View was destroyed — ignore
      }
    })
    .catch(() => {
      // Language loading failed — editor works fine without syntax highlighting
    });
}

export function useCodeMirror(
  containerRef: React.RefObject<HTMLDivElement | null>,
  content: string | null,
  filePath: string | null,
  onChange?: (content: string) => void,
) {
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const prevPathRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current || content === null) return;

    // Create editor if it doesn't exist yet
    if (!viewRef.current) {
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.(update.state.doc.toString());
        }
      });

      const state = EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightSpecialChars(),
          bracketMatching(),
          closeBrackets(),
          foldGutter(),
          drawSelection(),
          indentOnInput(),
          history(),
          search(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          paneTheme,
          syntaxHighlighting(paneHighlight),
          langCompartment.current.of([]),
          EditorView.lineWrapping,
          updateListener,
          EditorState.tabSize.of(2),
        ],
      });

      viewRef.current = new EditorView({
        state,
        parent: containerRef.current,
      });
      prevPathRef.current = filePath;

      if (filePath) {
        loadLanguage(viewRef.current, langCompartment.current, filePath);
      }
      return;
    }

    // Editor exists — replace content when file changes OR when content is different from current
    const currentContent = viewRef.current.state.doc.toString();
    const fileChanged = filePath !== prevPathRef.current;
    const contentChanged = content !== currentContent;

    if (fileChanged || contentChanged) {
      const view = viewRef.current;

      // Replace entire document content
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });

      // Update language if file changed
      if (fileChanged) {
        prevPathRef.current = filePath;
        if (filePath) {
          loadLanguage(view, langCompartment.current, filePath);
        }
      }
    }
  }, [content, filePath, containerRef]);

  // Cleanup on unmount — also handles StrictMode double-mount
  useEffect(() => {
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, []);

  return viewRef;
}
