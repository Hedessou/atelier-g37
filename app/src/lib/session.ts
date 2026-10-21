import type { User } from "../helpers/User";

// Session gardée sur le téléphone : l'app reste connectée même sans réseau, pendant des mois.
const TOKEN_KEY = "g37.token";
const USER_KEY = "g37.user";

type Listener = (user: User | null) => void;
const listeners = new Set<Listener>();

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const session = {
  token(): string | null {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  user(): User | null {
    return read<User>(USER_KEY);
  },
  save(token: string, user: User) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    listeners.forEach((l) => l(user));
  },
  saveUser(user: User) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    listeners.forEach((l) => l(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    // Données de l'atelier et file d'attente propres à ce compte.
    localStorage.removeItem("g37.state");
    localStorage.removeItem("g37.outbox");
    listeners.forEach((l) => l(null));
  },
  onChange(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
