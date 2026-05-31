import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/globals.css";


// ── Global unhandled promise rejection handler ───────────────────────────
// Prevent renderer crashes from unhandled promise rejections.
// Log with full stack trace for diagnosis.
window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  console.error("[renderer] Unhandled rejection:", reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason));
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
