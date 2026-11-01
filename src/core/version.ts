import manifest from "../../package.json" with { type: "json" };

/** Build identity shared by the CLI and the server's bundled release notes. */
export const APP_VERSION = manifest.version;
