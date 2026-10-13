/** Version comparison shared by every provider that has a floor (the vocabulary itself lives in the kernel: `catalog/update.ts`). */

export { compareSemver, parseSemver, versionNumber as parseVersionNumber } from "../catalog/update.js";
