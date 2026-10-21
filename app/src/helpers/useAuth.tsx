import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSession } from "../endpoints/auth/session_GET.schema";
import { postLogout } from "../endpoints/auth/logout_POST.schema";
import { session } from "../lib/session";
import { isOnline, onOnlineChange, onUnauthorized } from "../lib/net";
import { outbox } from "../lib/offline";
import { pushTokenForLogout } from "./pushClient";
import { User } from "./User";

export const AUTH_QUERY_KEY = ["auth", "session"] as const;

type AuthState =
  | { type: "loading" }
  | { type: "authenticated"; user: User }
  | { type: "unauthenticated"; errorMessage?: string };

type AuthContextType = {
  authState: AuthState;
  onLogin: (user: User, token?: string) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// La session est gardée sur le téléphone : l'app s'ouvre connectée même sans réseau.
// Quand le réseau est là, la session est revérifiée (un admin peut l'avoir révoquée).
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(() => (session.token() ? session.user() : null));

  useEffect(() => session.onChange(setUser), []);

  const verify = useCallback(async () => {
    if (!session.token() || !isOnline()) return;
    try {
      const result = await getSession();
      if ("user" in result && result.user) session.saveUser(result.user);
    } catch {
      // Réseau coupé pendant la vérification : on garde la session du téléphone.
    }
  }, []);

  useEffect(() => {
    void verify();
    return onOnlineChange((on) => { if (on) void verify(); });
  }, [verify]);

  // Session révoquée par le serveur (mot de passe réinitialisé, compte supprimé).
  useEffect(() => {
    onUnauthorized(() => {
      if (outbox().length) console.warn("Session expirée avec des actions en attente :", outbox().length);
      session.clear();
      queryClient.clear();
    });
  }, [queryClient]);

  const logout = useCallback(async () => {
    const pushToken = pushTokenForLogout();
    try { await postLogout({}, pushToken ? { headers: { "x-push-token": pushToken } } : undefined); } catch { /* hors ligne : la session est quand même retirée du téléphone */ }
    session.clear();
    queryClient.clear();
  }, [queryClient]);

  const onLogin = useCallback((u: User, token?: string) => {
    if (token) session.save(token, u);
    else session.saveUser(u);
    queryClient.setQueryData(AUTH_QUERY_KEY, u);
  }, [queryClient]);

  const authState: AuthState = user ? { type: "authenticated", user } : { type: "unauthenticated" };

  return <AuthContext.Provider value={{ authState, logout, onLogin }}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error("useAuth must be used within a AuthProvider");
  return context;
};
