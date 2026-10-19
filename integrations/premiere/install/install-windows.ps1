# Installs the Strata panel for Premiere Pro (current user).
# Usage: right-click > Run with PowerShell (from the unzipped folder)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\io.pulsecg.premiere"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($item in "CSXS", "host", "index.html", "panel.js", "panel.css", ".debug") {
  Copy-Item -Recurse -Force (Join-Path $here $item) $dest
}
# The panel is not signed by Adobe Exchange: allow unsigned extensions.
foreach ($v in 9..13) {
  New-Item -Force -Path "HKCU:\Software\Adobe\CSXS.$v" | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.$v" -Name PlayerDebugMode -Value "1"
}
Write-Host "Installed in $dest"
Write-Host "Restart Premiere Pro, then open Window > Extensions > Strata."
