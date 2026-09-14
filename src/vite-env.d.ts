/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_ARTDADDY_RELEASE?: string;
  readonly VITE_ARTDADDY_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by vite.config.ts from package.json — `artdaddy@<version>`. */
declare const __ARTDADDY_RELEASE__: string;
