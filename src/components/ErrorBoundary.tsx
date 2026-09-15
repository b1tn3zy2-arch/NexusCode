import { Component, type ReactNode } from "react";
import { logError } from "../stores/outputStore";

interface Props {
  children: ReactNode;
  /** label shown in the fallback, e.g. "Loop / Continuous" */
  name?: string;
}

interface State {
  error: Error | null;
}

/**
 * Isolates crashes in dynamic panels (loop/continuous/terminal etc.) so one
 * bad render can't red-screen the whole app. Falls back to an inline error
 * with Retry + Reload actions.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    try {
      logError("ui", `Panel crashed (${this.props.name ?? "?"}): ${error.message}`);
    } catch {
      /* ignore */
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="flex flex-col items-start gap-2 rounded-lg border p-3 text-[13px]"
        style={{ borderColor: "rgba(239,68,68,0.4)", color: "var(--text-secondary)" }}
      >
        <span>
          Панель «{this.props.name ?? "?"}» упала:{" "}
          <span className="font-mono text-red-400">{this.state.error.message}</span>
        </span>
        <div className="flex gap-2">
          <button
            className="btn-secondary px-2 py-1 text-[12px]"
            onClick={() => this.setState({ error: null })}
          >
            Повторить
          </button>
          <button
            className="btn-secondary px-2 py-1 text-[12px]"
            onClick={() => window.location.reload()}
          >
            Перезагрузить
          </button>
        </div>
      </div>
    );
  }
}
