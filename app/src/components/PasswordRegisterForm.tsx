import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as z from "zod";
import {
  Form,
  FormControl,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
  useForm,
} from "./Form";
import { Input } from "./Input";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import styles from "./PasswordRegisterForm.module.css";
import { useAuth } from "../helpers/useAuth";
import {
  schema,
  postRegister,
} from "../endpoints/auth/register_with_password_POST.schema";

export type RegisterFormData = z.infer<typeof schema>;

interface PasswordRegisterFormProps {
  className?: string;
  defaultValues?: Partial<RegisterFormData>;
  lang?: "fr" | "en";
}

export const PasswordRegisterForm: React.FC<PasswordRegisterFormProps> = ({
  className,
  defaultValues,
  lang = "fr",
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { onLogin } = useAuth();
  const navigate = useNavigate();
  const t = (fr: string, en: string) => lang === "fr" ? fr : en;

  const form = useForm({
    schema,
    defaultValues: defaultValues || {
      email: "",
      password: "",
      displayName: "",
    },
  });

  const handleSubmit = async (data: z.infer<typeof schema>) => {
    setError(null);
    setIsLoading(true);

    try {
      const result = await postRegister(data);
      console.log("Registration successful for:", data.email);
      onLogin(result.user, result.token);
      navigate("/");
    } catch (err) {
      console.error("Registration error:", err);

      if (err instanceof Error) {
        const errorMessage = err.message;

        if (errorMessage.includes("Email already in use")) {
          setError(t("Cet e-mail est déjà enregistré. Essaie plutôt de te connecter.", "This email is already registered. Please try logging in instead."));
        } else if (errorMessage.toLowerCase().includes("display name")) {
          setError(t("Indique un nom d'affichage valide et non vide.", "Please provide a valid display name that isn't empty."));
        } else if (
          errorMessage.includes("display") ||
          errorMessage.includes("name")
        ) {
          setError(t("Vérifie ton nom d'affichage : ", "Please check your display name: ") + errorMessage);
        } else {
          setError(errorMessage || t("Inscription impossible. Réessaie.", "Registration failed. Please try again."));
        }
      } else {
        console.log("Unknown error type:", err);
        setError(t("Inscription impossible. Réessaie.", "Registration failed. Please try again."));
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Form {...form}>
      {error && <div className={styles.errorMessage}>{error}</div>}
      <form
        onSubmit={form.handleSubmit((data) =>
          handleSubmit(data as z.infer<typeof schema>)
        )}
        className={`${styles.form} ${className || ""}`}
      >
        <FormItem name="email">
          <FormLabel>{t("E-mail", "Email")}</FormLabel>
          <FormControl>
            <Input
              placeholder="your@email.com"
              value={form.values.email || ""}
              onChange={(e) =>
                form.setValues((prev: any) => ({
                  ...prev,
                  email: e.target.value,
                }))
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>

        <FormItem name="displayName">
          <FormLabel>{t("Nom d'affichage", "Display Name")}</FormLabel>
          <FormControl>
            <Input
              id="register-display-name"
              placeholder={t("Ton nom", "Your Name")}
              value={form.values.displayName || ""}
              onChange={(e) =>
                form.setValues((prev: any) => ({
                  ...prev,
                  displayName: e.target.value,
                }))
              }
            />
          </FormControl>
          <FormDescription>
            {t("Les espaces, emojis et caractères spéciaux sont autorisés", "Spaces, emojis, and special characters are all allowed")}
          </FormDescription>
          <FormMessage />
        </FormItem>

        <FormItem name="password">
          <FormLabel>{t("Mot de passe", "Password")}</FormLabel>
          <FormControl>
            <Input
              type="password"
              placeholder="••••••••"
              value={form.values.password || ""}
              onChange={(e) =>
                form.setValues((prev: any) => ({
                  ...prev,
                  password: e.target.value,
                }))
              }
            />
          </FormControl>
          <FormDescription>
            {t("Au moins 8 caractères avec majuscule, minuscule et chiffre", "At least 8 characters with uppercase, lowercase, and number")}
          </FormDescription>
          <FormMessage />
        </FormItem>

        <Button
          type="submit"
          disabled={isLoading}
          className={styles.submitButton}
        >
          {isLoading ? (
            <>
              <Spinner size="sm" /> {t("Création du compte…", "Creating Account…")}
            </>
          ) : (
            t("Créer le compte", "Create Account")
          )}
        </Button>
      </form>
    </Form>
  );
};

