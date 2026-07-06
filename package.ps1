# Build distribution zip (self-contained: no Python needed on the recipient's PC).
# Excludes the private key (key.pem) and internal notes.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$stage = Join-Path $env:TEMP "ko-spellcheck-dist"
$out = Join-Path $root "ko-spellcheck-dist.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "extension") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "host") | Out-Null

# extension: full copy (the manifest 'key' field is a PUBLIC key, safe to distribute)
Copy-Item (Join-Path $root "extension\*") (Join-Path $stage "extension") -Recurse

# host: only the compiled exe. No host.py / run_host.bat / Python needed on recipient PC.
Copy-Item (Join-Path $root "host\host.exe") (Join-Path $stage "host")

# root distribution files
Copy-Item (Join-Path $root "install.bat")   $stage
Copy-Item (Join-Path $root "uninstall.bat") $stage
# Korean-named guide copied via pattern to avoid literal-encoding issues in PS 5.1
Get-ChildItem -Path $root -Filter "*.txt" | Where-Object { $_.Name -notmatch "manifest_key" } | Copy-Item -Destination $stage

# Explicitly NOT included: key.pem, manifest_key.txt, host.log, host.py, SETUP.md, design doc.

if (Test-Path $out) { Remove-Item $out -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $out
Remove-Item $stage -Recurse -Force

Write-Output "Created: $out"
