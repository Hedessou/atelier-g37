import React from "react";
import { Navigate } from "react-router-dom";
import { ShieldOff } from "lucide-react";
import { useAuth } from "../helpers/useAuth";
import { User } from "../helpers/User";
import { AuthErrorPage } from "./AuthErrorPage";
import { AuthLoadingState } from "./AuthLoadingState";
import styles from "./ProtectedRoute.module.css";

// La session est gardée sur le téléphone : pas d'attente réseau pour ouvrir l'app.
const MakeProtectedRoute: (roles: User["role"][]) => React.FC<{ children: React.ReactNode }> =
  (roles) =>
  ({ children }) => {
    const { authState } = useAuth();
    if (authState.type === "loading") return <AuthLoadingState title="Connexion…" />;
    if (authState.type === "unauthenticated") return <Navigate to="/login" replace />;
    if (!roles.includes(authState.user.role)) {
      return (
        <AuthErrorPage
          title="Accès refusé"
          message={`Accès refusé : ton rôle (${authState.user.role}) ne permet pas d'ouvrir cette page.`}
          icon={<ShieldOff className={styles.accessDeniedIcon} size={64} />}
        />
      );
    }
    return <>{children}</>;
  };

export const AdminRoute = MakeProtectedRoute(["admin"]);
export const UserRoute = MakeProtectedRoute(["user", "admin"]);
