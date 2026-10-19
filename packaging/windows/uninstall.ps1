# Removes the Strata service and program files. Data in %ProgramData%\PulseCG is kept unless -Purge.
param([switch]$Purge)
$ErrorActionPreference = "Continue"
$prefix = Join-Path $env:ProgramFiles "PulseCG"
& (Join-Path $prefix "cg-server.exe") service uninstall
Remove-Item -Recurse -Force $prefix -ErrorAction SilentlyContinue
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
[Environment]::SetEnvironmentVariable("Path", (($machinePath -split ";") | Where-Object { $_ -ne $prefix }) -join ";", "Machine")
if ($Purge) { Remove-Item -Recurse -Force (Join-Path $env:ProgramData "PulseCG") -ErrorAction SilentlyContinue }
Write-Host "Strata removed."
