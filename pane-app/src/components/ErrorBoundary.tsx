import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Pane error boundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen bg-pane-bg p-8">
          <div className="max-w-md space-y-4">
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
            <button
              onClick={() => this.setState({ error: null })}
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
