#!/bin/sh
# Installs Moxen from the latest GitHub release (macOS, Apple silicon).
#
#   curl -fsSL https://github.com/usemoxen/moxen/releases/latest/download/install.sh | sh
#
# It finds the latest release, installs Bun first when it is missing, checks the
# archive against its .sha256 (and stops on a mismatch), runs self-update
# --install, and says how to put Moxen on your PATH. Linux and Intel Macs have
# no build; Windows uses install.ps1 instead.
set -eu

REPO="usemoxen/moxen"

fail() {
  echo "install: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT) fail "this script is for macOS; on Windows run install.ps1 instead." ;;
  *) fail "no Moxen release for $(uname -s); only macOS (Apple silicon) and Windows (x64) have builds." ;;
esac

[ "$(uname -m)" = "arm64" ] || fail "no Moxen release for this Mac; only Apple silicon (arm64) has a build, Intel Macs do not."

command -v curl >/dev/null 2>&1 || fail "curl is required to download the release."
command -v shasum >/dev/null 2>&1 || fail "shasum is required to check the download."

echo "Finding the latest Moxen release..."
release_json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" || fail "could not reach GitHub for the latest release."
tag="$(printf '%s' "$release_json" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d '"' -f 4)"
[ -n "$tag" ] || fail "GitHub sent a release the installer cannot read."
version="${tag#v}"
base="moxen-${version}-macos-arm64"
archive="${base}.tar.gz"
checksum="${archive}.sha256"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is missing, installing it first (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash || fail "the Bun install failed."
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "bun is still missing after its install."
fi

tmp="$(mktemp -d -t moxen-install.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading ${tag} (${archive})..."
curl -fsSL -o "$tmp/$archive" "https://github.com/${REPO}/releases/download/${tag}/${archive}" || fail "could not download ${archive}."
curl -fsSL -o "$tmp/$checksum" "https://github.com/${REPO}/releases/download/${tag}/${checksum}" || fail "could not download ${checksum}."

echo "Checking the download..."
(cd "$tmp" && shasum -a 256 -c "$checksum") || fail "checksum mismatch for ${archive}; refusing to install."

echo "Unpacking..."
tar -xzf "$tmp/$archive" -C "$tmp" || fail "could not unpack ${archive}."

echo "Installing..."
bun "$tmp/$base/dist/cli/index.js" self-update --install || fail "self-update --install failed."

trap - EXIT INT TERM
rm -rf "$tmp"

echo ""
echo "Installed ${tag}. The installer above said how to put Moxen on your PATH;"
echo "open a new terminal (or export PATH first), then run: moxen tui"
echo "To update later, run: moxen self-update"
