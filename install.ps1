# Installs Moxen from the latest GitHub release (Windows, x64).
#
#   irm https://github.com/usemoxen/moxen/releases/latest/download/install.ps1 | iex
#
# It finds the latest release, checks the archive against its `.sha256` (and
# stops on a mismatch), runs `self-update --install`, and puts Moxen on your
# PATH: it appends ~/.moxen/app/bin to the user's persistent Path
# (deduplicated, via [Environment] so no setx 1024-character truncation), new
# terminals pick it up, and the current shell gets it too. Set
# MOXEN_INSTALL_NO_PATH=1 to skip that step (the smoke test does).
# MOXEN_INSTALL_PATH_ONLY=1 runs only the PATH step, and
# MOXEN_INSTALL_TEST_VALUE=<name> writes that user-environment value instead
# of Path: both for tests.
# macOS uses install.sh instead; Linux and Intel Macs have no build.
#
# Everything runs inside Main, called on the last line, so a truncated download
# defines nothing runnable and installs nothing.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Main {
  $Repo = 'usemoxen/moxen'

  function Fail([string] $Message) {
    Write-Error "install: $Message"
    exit 1
  }

  # Appends the install's bin folder to the user's persistent Path.
  # Idempotent: a Path already holding it is left alone. Prints what changed.
  function Add-MoxenToPath {
    if ($env:MOXEN_INSTALL_NO_PATH -eq '1') {
      Write-Host 'Skipping the PATH step (MOXEN_INSTALL_NO_PATH=1).'
      return
    }
    if (-not $env:USERPROFILE) {
      Fail 'USERPROFILE is not set, so PATH cannot be updated.'
    }
    $Bin = Join-Path $env:USERPROFILE '.moxen\app\bin'
    # Test seam (the smoke test): a throwaway value instead of the real Path.
    $Name = if ($env:MOXEN_INSTALL_TEST_VALUE) { $env:MOXEN_INSTALL_TEST_VALUE } else { 'Path' }
    $Current = [Environment]::GetEnvironmentVariable($Name, 'User')
    if ($null -eq $Current) {
      $Current = ''
    }
    $Found = $false
    foreach ($Entry in ($Current -split ';')) {
      if ($Entry.Trim().TrimEnd('\') -ieq $Bin.TrimEnd('\')) {
        $Found = $true
        break
      }
    }
    if ($Found) {
      Write-Host "PATH step already done: $Bin is on the user Path."
    } else {
      $New = if ($Current -eq '') { $Bin } else { "$Current;$Bin" }
      # [Environment] writes the whole value, so long Paths survive (setx cuts at 1024 characters).
      [Environment]::SetEnvironmentVariable($Name, $New, 'User')
      Write-Host "Added $Bin to the user Path."
    }
    if ($env:MOXEN_INSTALL_TEST_VALUE) {
      Write-Host "Test mode: wrote the '$Name' value instead of Path."
      return
    }
    if (($env:Path -split ';') -notcontains $Bin) {
      $env:Path += ";$Bin"
      Write-Host 'This shell picks it up too.'
    }
    Write-Host 'New terminals pick it up. To undo, remove that folder from the user Path again (Settings, or the Environment Variables dialog).'
  }

  if ($env:MOXEN_INSTALL_PATH_ONLY -eq '1') {
    Add-MoxenToPath
    return
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

  Add-MoxenToPath

  Write-Host ''
  Write-Host "Installed $Tag (PATH step above)."
  Write-Host 'Open a new terminal, then run: moxen'
  Write-Host 'To update later, run: moxen self-update'
}

Main
