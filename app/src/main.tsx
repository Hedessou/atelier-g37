import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./base.css";
import { installNetwork } from "./lib/net";
import { installLinkHandling } from "./lib/links";
import { initUpdater } from "./lib/updater";
import { restorePush } from "./helpers/pushClient";
import { AuthProvider } from "./helpers/useAuth";
import { ThemeModeProvider } from "./helpers/themeMode";
import { TooltipProvider } from "./components/Tooltip";
import { SonnerToaster } from "./components/SonnerToaster";
import { UserRoute } from "./components/ProtectedRoute";
import { RealtimeBridge } from "./components/RealtimeBridge";
import { P2PBridge } from "./components/P2PBridge";
import { CallOverlay } from "./components/CallOverlay";
import { G37App } from "./components/G37App";
import LoginPage from "./pages/login";
import RegisterPage from "./pages/register";
import ForgotPasswordPage from "./pages/mot-de-passe-oublie";
import AdminPage from "./pages/admin";
import indexStyles from "./pages/_index.module.css";

installNetwork();
installLinkHandling();
void initUpdater();
void restorePush();

if (Capacitor.isNativePlatform()) {
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  StatusBar.setBackgroundColor({ color: "#0f1b2d" }).catch(() => {});
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 1000, networkMode: "always" } },
});

function Workshop() {
  return (
    <UserRoute>
      <RealtimeBridge />
      <P2PBridge />
      <main className={indexStyles.page}>
        <G37App />
      </main>
      <CallOverlay />
    </UserRoute>
  );
}

function Root() {
  React.useEffect(() => {
    SplashScreen.hide().catch(() => {});
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeModeProvider>
          <TooltipProvider>
            <HashRouter>
              <Routes>
                <Route path="/" element={<Workshop />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/mot-de-passe-oublie" element={<ForgotPasswordPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </HashRouter>
            <SonnerToaster position="top-center" />
          </TooltipProvider>
        </ThemeModeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
