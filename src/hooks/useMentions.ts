import { useCallback, useEffect, useRef, useState } from "react";
import { findApi, type SymbolItem } from "../services/backend";

export interface MentionItem {
  label: string;
  detail?: string;
  insert: string;
  icon: string;
}

export type MentionTrigger = "@" | "#";

export interface MentionState {
  active: boolean;
  trigger: MentionTrigger;
  query: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  items: MentionItem[];
  index: number;
  loading: boolean;
}

const INITIAL: MentionState = {
  active: false,
  trigger: "@",
  query: "",
  lineNumber: 1,
  startColumn: 1,
  endColumn: 1,
  items: [],
  index: 0,
  loading: false,
};

function fileItems(paths: string[]): MentionItem[] {
  return paths.slice(0, 12).map((raw) => {
    // server returns mixed separators + trailing "\" for directories
    const p = raw.replace(/\\/g, "/");
    const isDir = /\/$/.test(p);
    return {
      label: p,
      insert: p.replace(/\/+$/, ""),
      icon: isDir ? "dir" : "file",
      detail: undefined,
    };
  });
}

function symbolItems(syms: SymbolItem[]): MentionItem[] {
  return syms.slice(0, 12).map((s) => ({
    label: s.label,
    insert: s.insert,
    icon: "symbol",
    detail: s.detail,
  }));
}

export function useMentions() {
  const [state, setState] = useState<MentionState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchSeq = useRef(0);

  const fetchItems = useCallback(async (trigger: MentionTrigger, query: string) => {
    const seq = ++fetchSeq.current;
    setState((st) => ({ ...st, loading: true }));
    try {
      let items: MentionItem[];
      if (trigger === "@") {
        items = fileItems(await findApi.files(query));
      } else {
        items = symbolItems(await findApi.symbols(query));
      }
      if (seq !== fetchSeq.current) return;
      setState((st) => ({ ...st, items, loading: false, index: 0 }));
    } catch {
      if (seq !== fetchSeq.current) return;
      setState((st) => ({ ...st, items: [], loading: false }));
    }
  }, []);

  /** Call on every editor content/selection change. */
  const updateFromCursor = useCallback(
    (lineText: string, lineNumber: number, column: number) => {
      // text before cursor on this line
      const before = lineText.slice(0, column - 1);
      const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);

      if (!m) {
        if (stateRef.current.active) setState({ ...INITIAL });
        return;
      }

      const trigger = m[2] as MentionTrigger;
      const query = m[3];
      // m[0] includes the leading boundary ("" at line start, whitespace
      // otherwise); the trigger column sits past it.
      const startColumn = column - m[0].length + m[1].length;

      const prev = stateRef.current;
      const sameContext =
        prev.active &&
        prev.trigger === trigger &&
        prev.query === query &&
        prev.lineNumber === lineNumber &&
        prev.startColumn === startColumn;

      if (sameContext) return;

      setState({
        active: true,
        trigger,
        query,
        lineNumber,
        startColumn,
        endColumn: column,
        items: [],
        index: 0,
        loading: true,
      });
      void fetchItems(trigger, query);
    },
    [fetchItems],
  );

  const close = useCallback(() => setState({ ...INITIAL }), []);

  const move = useCallback((dir: -1 | 1) => {
    setState((st) => {
      if (!st.active || st.items.length === 0) return st;
      const max = st.items.length - 1;
      return { ...st, index: Math.max(0, Math.min(max, st.index + dir)) };
    });
  }, []);

  const setIndex = useCallback((index: number) => {
    setState((st) => (st.active ? { ...st, index } : st));
  }, []);

  /** Stable access to liveness for imperative Monaco callbacks. */
  const isActive = useCallback(() => stateRef.current.active, []);

  const current = useCallback(() => {
    const st = stateRef.current;
    if (!st.active || st.items.length === 0) return null;
    return { item: st.items[Math.min(st.index, st.items.length - 1)], state: st };
  }, []);

  useEffect(() => {
    return () => {
      fetchSeq.current++;
    };
  }, []);

  return { state, updateFromCursor, close, move, setIndex, isActive, current };
}
