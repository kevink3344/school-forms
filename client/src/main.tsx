import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { AccessRequestsProvider } from "./context/AccessRequestsContext";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {/* Inside AuthProvider (the bell is admin-only) and inside
            BrowserRouter (it re-reads on navigation) — but ABOVE <App />, so the
            badge survives every route change instead of resetting to zero. */}
        <AccessRequestsProvider>
          <App />
        </AccessRequestsProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
