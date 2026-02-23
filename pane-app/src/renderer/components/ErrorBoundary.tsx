import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };


  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Pane error boundary caught:", error, info.componentStack);
    this.setState({ stack: info.componentStack || "" });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen bg-pane-bg p-8">
          <div className="max-w-lg space-y-4 max-h-screen overflow-y-auto">
            <p
              className="text-pane-text font-mono"
              style={{ fontSize: "var(--pane-font-size)" }}
            >
              something broke
            </p>
            <pre
              className="text-pane-text-secondary font-mono whitespace-pre-wrap break-words"
              style={{ fontSize: "var(--pane-font-size-xs)" }}
            >
              {this.state.error.message}
            </pre>
            {(this.state as any).stack && (
              <pre
                className="text-pane-text-secondary/60 font-mono whitespace-pre-wrap break-words border border-pane-border p-3 max-h-[300px] overflow-y-auto"
                style={{ fontSize: "10px" }}
              >
                {(this.state as any).stack}
              </pre>
            )}
            <button
              onClick={() => this.setState({ error: null, stack: "" })}
              className="text-pane-text-secondary font-mono hover:text-pane-text tracking-[0.1em]"
              style={{ fontSize: "var(--pane-font-size-sm)" }}
            >
              try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
