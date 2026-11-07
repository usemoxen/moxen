# Installs Moxen from the latest GitHub release (Windows, x64).
#
#   irm https://github.com/usemoxen/moxen/releases/latest/download/install.ps1 | iex
#
# It finds the latest release, checks the archive against its `.sha256` (and
# stops on a mismatch), runs `self-update --install`, and says how to put
# Moxen on your PATH. macOS uses install.sh instead; Linux and Intel Macs
# have no build.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'usemoxen/moxen'

function Fail([string] $Message) {
  Write-Error "install: $Message"
  exit 1
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  Fail 'this script is for Windows; on macOS (Apple silicon) use install.sh instead.'
}
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  Fail 'no Moxen release for this machine; only Windows x64 has a build.'
}
# GitHub needs TLS 1.2; older Windows PowerShell defaults to less.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
}

Write-Host 'Finding the latest Moxen release...'
try {
  $Latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
} catch {
  Fail 'could not reach GitHub for the latest release.'
}
$Tag = $Latest.tag_name
if (-not $Tag) {
  Fail 'GitHub sent a release the installer cannot read.'
}
$Version = $Tag.TrimStart('v')
$Base = "moxen-$Version-windows-x64"
$Archive = "$Base.zip"
$Checksum = "$Archive.sha256"
$ArchiveUrl = ($Latest.assets | Where-Object { $_.name -eq $Archive } | Select-Object -First 1).browser_download_url
$ChecksumUrl = ($Latest.assets | Where-Object { $_.name -eq $Checksum } | Select-Object -First 1).browser_download_url
if (-not $ArchiveUrl) {
  Fail "release $Tag has no $Archive for this platform."
}
if (-not $ChecksumUrl) {
  Fail "release $Tag has no $Checksum for this platform."
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('moxen-install-' + [System.Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  $ArchivePath = Join-Path $Tmp $Archive
  $ChecksumPath = Join-Path $Tmp $Checksum
  Write-Host "Downloading $Tag ($Archive)..."
  Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $ArchivePath
  Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUrl -OutFile $ChecksumPath

  Write-Host 'Checking the download...'
  $Expected = ((Get-Content -Path $ChecksumPath -TotalCount 1) -split '\s+')[0].ToUpperInvariant()
  $Actual = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($Expected -ne $Actual) {
    Fail "checksum mismatch for $Archive; refusing to install."
  }

  Write-Host 'Unpacking...'
  & tar -xf "$ArchivePath" -C "$Tmp"
  if ($LASTEXITCODE -ne 0) {
    Fail "could not unpack $Archive."
  }

  Write-Host 'Installing...'
  $Entry = Join-Path (Join-Path $Tmp $Base) 'moxen.exe'
  & $Entry self-update --install
  if ($LASTEXITCODE -ne 0) {
    Fail 'self-update --install failed.'
  }
} finally {
  if ($Tmp -and (Test-Path $Tmp)) {
    Remove-Item -Recurse -Force $Tmp
  }
}

Write-Host ''
Write-Host "Installed $Tag. The installer above said how to put Moxen on your PATH;"
Write-Host 'open a new terminal (or update $env:Path first), then run: moxen tui'
Write-Host 'To update later, run: moxen self-update'
