// The editor bundle's source: CodeMirror 6 with Markdown and a few code languages. Built into
// src/renderer/vendor/editor.js by `npm run build:editor` (esbuild); the built file is committed so the app needs no
// build step and loads nothing from the network.
import { EditorView, keymap, drawSelection, highlightActiveLine, dropCursor, rectangularSelection, crosshairCursor, lineNumbers, highlightSpecialChars, placeholder } from '@codemirror/view';
import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldKeymap } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { LanguageDescription } from '@codemirror/language';
import { tags as t, styleTags } from '@lezer/highlight';

// YAML front matter (--- ... --- at the very top) as one dim block instead of a setext heading.
const frontMatter = {
  defineNodes: [{ name: 'FrontMatter', block: true }],
  props: [styleTags({ FrontMatter: t.meta })],
  parseBlock: [{
    name: 'FrontMatter', before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text)) return false;
      const start = cx.lineStart;
      let closed = false;
      while (cx.nextLine()) { if (/^(---|\.\.\.)\s*$/.test(line.text)) { closed = true; break; } }
      if (!closed) return false;
      const end = cx.lineStart + line.text.length;
      cx.nextLine();
      cx.addElement(cx.elt('FrontMatter', start, end));
      return true;
    },
  }],
};

const style = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.3em', color: '#ffffff' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.15em', color: '#ffffff' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: '#ffffff' },
  { tag: t.strong, fontWeight: '700', color: '#ffffff' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: '#ffb4a2' },
  { tag: t.monospace, color: '#a8d1ff', fontFamily: 'var(--mono)' },
  { tag: t.quote, color: '#b9b9c1', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: '#8e8e98' },
  { tag: t.list, color: '#ffb4a2' },
  { tag: [t.keyword, t.operatorKeyword], color: '#ff9eb8' },
  { tag: [t.string, t.special(t.string)], color: '#9fe3b4' },
  { tag: [t.number, t.bool, t.null], color: '#f2c27a' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#8e8e98', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#a8d1ff' },
  { tag: [t.typeName, t.className, t.tagName], color: '#c9a0ff' },
  { tag: [t.attributeName, t.propertyName], color: '#f2c27a' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: '#f3f3f4', backgroundColor: 'transparent', fontSize: '14.5px' },
  '.cm-scroller': { fontFamily: 'var(--sans)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '22px 0 40vh', maxWidth: '78ch', margin: '0 auto', caretColor: '#ffb4a2' },
  '.cm-line': { padding: '0 28px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffb4a2', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(255,180,162,0.22)' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#5a5a64' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(122,168,255,0.16)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(242,177,60,0.25)', outline: '1px solid rgba(242,177,60,0.6)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(242,177,60,0.5)' },
  '.cm-panels': { backgroundColor: '#17171b', color: '#f3f3f4', borderTop: '1px solid #3a3a42' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid #3a3a42' },
  '.cm-panel.cm-search': { padding: '8px 10px', fontFamily: 'var(--sans)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: '#101013', border: '1px solid #6f6f7a', color: '#f3f3f4', borderRadius: '0', padding: '3px 6px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'transparent', border: '1px solid #3a3a42', color: '#f3f3f4', borderRadius: '0', padding: '3px 8px' },
  '.cm-placeholder': { color: '#8e8e98' },
  '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
  '.cm-scroller::-webkit-scrollbar-track, .cm-scroller::-webkit-scrollbar-corner': { background: 'transparent' },
  '.cm-scroller::-webkit-scrollbar-thumb': { background: '#34343b', border: '2px solid transparent', backgroundClip: 'content-box' },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': { background: '#4a4a53', backgroundClip: 'content-box' },
}, { dark: true });

const codeLanguages = [
  LanguageDescription.of({ name: 'JavaScript', alias: ['js', 'javascript', 'jsx', 'mjs', 'cjs'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'TypeScript', alias: ['ts', 'typescript', 'tsx'], support: javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: 'JSON', alias: ['json'], support: javascript() }),
  LanguageDescription.of({ name: 'CSS', alias: ['css'], support: css() }),
  LanguageDescription.of({ name: 'HTML', alias: ['html', 'htm', 'xml', 'svg'], support: html() }),
];

function wrap(view, mark) {
  const tr = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2) {
      const inner = text.slice(mark.length, text.length - mark.length);
      return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
    }
    return { changes: { from: range.from, to: range.to, insert: mark + text + mark }, range: EditorSelection.range(range.from + mark.length, range.to + mark.length) };
  });
  view.dispatch(tr);
  return true;
}

export function create(parent, opts = {}) {
  const wrapComp = new Compartment();
  const numbersComp = new Compartment();
  const flags = { wrap: true, numbers: false };
  let silent = false;
  const extensions = [
    highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
    bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    search({ top: true }),
    markdown({ base: markdownLanguage, codeLanguages, addKeymap: true, extensions: [frontMatter] }),
    syntaxHighlighting(style), theme,
    placeholder(opts.placeholder || ''),
    keymap.of([
      { key: 'Mod-b', run: (v) => wrap(v, '**') },
      { key: 'Mod-i', run: (v) => wrap(v, '*') },
      { key: 'Mod-`', run: (v) => wrap(v, '`') },
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of((u) => { if (u.docChanged && !silent && opts.onChange) opts.onChange(); if (u.selectionSet && opts.onCursor) opts.onCursor(); }),
    EditorView.domEventHandlers({
      paste: (e) => {
        const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type));
        if (!files.length || !opts.onFiles) return false;
        e.preventDefault(); opts.onFiles(files, null); return true;
      },
      drop: (e, v) => {
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
        if (!files.length || !opts.onFiles) return false;
        e.preventDefault();
        const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
        opts.onFiles(files, pos == null ? null : pos); return true;
      },
      scroll: () => { if (opts.onScroll) opts.onScroll(); },
    }),
  ];
  const fresh = (doc, anchor = 0) => EditorState.create({
    doc, selection: { anchor: Math.min(anchor, doc.length) },
    extensions: [...extensions, wrapComp.of(flags.wrap ? EditorView.lineWrapping : []), numbersComp.of(flags.numbers ? lineNumbers() : [])],
  });
  // `root`: the editor lives in a shadow root so CodeMirror's styles go in through a constructed style sheet, which the
  // page's strict Content-Security-Policy (no inline <style>) allows.
  const view = new EditorView({ parent, root: opts.root, state: fresh('') });
  return {
    view,
    getText: () => view.state.doc.toString(),
    /** Load a different note: new text, cursor at the start, no undo history from the previous note. */
    load(text) { silent = true; view.setState(fresh(text)); silent = false; view.scrollDOM.scrollTop = 0; },
    /** Replace the whole text in place (a reload after an outside change): undoable, does not count as typing. */
    replaceAll(text) {
      const head = Math.min(view.state.selection.main.head, text.length);
      silent = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: head } });
      silent = false;
    },
    insert(text, pos = null) {
      const at = pos == null ? view.state.selection.main : { from: pos, to: pos };
      view.dispatch({ changes: { from: at.from, to: at.to, insert: text }, selection: { anchor: at.from + text.length }, scrollIntoView: true });
    },
    focus: () => view.focus(),
    gotoLine(line) {
      const n = Math.max(1, Math.min(view.state.doc.lines, line + 1));
      const l = view.state.doc.line(n);
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'start', yMargin: 40 }) });
    },
    topLine() {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4);
      return view.state.doc.lineAt(block.from).number - 1;
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number - 1,
    setWrap(on) { flags.wrap = !!on; view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }); },
    setLineNumbers(on) { flags.numbers = !!on; view.dispatch({ effects: numbersComp.reconfigure(on ? lineNumbers() : []) }); },
  };
}
