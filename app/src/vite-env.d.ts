/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUNDLE_VERSION?: string;
  readonly VITE_PUSH_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
