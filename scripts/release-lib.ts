/** Pure rules for release archives (names live in `src/core/release.ts`), shared by `package-release.ts`, `smoke-release.ts` and the release workflow. */

export {
  archiveFileName,
  checksumFileName,
  executableName,
  INSTALL_SCRIPT_POSIX,
  INSTALL_SCRIPT_WINDOWS,
  RELEASE_MARKER,
  RELEASES_REPOSITORY,
  releaseAssetUrl,
  releaseBaseName,
  releaseInstallNotes,
  releaseMarker,
  releaseNotesBody,
  releaseTarget,
  releaseTargetOf,
  tagForVersion,
  tagMismatch,
  packCommand,
  unpackCommand,
} from "../src/core/release.js";
export type { ArchiveCommand, ReleaseArch, ReleaseMarker, ReleaseOs, ReleaseTarget } from "../src/core/release.js";
