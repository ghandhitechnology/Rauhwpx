$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installers = @(Get-ChildItem -Path 'release' -Filter 'Rauhwpx-*.exe' -File)
if ($installers.Count -ne 1) {
  throw "Expected one Rauhwpx installer, found $($installers.Count)."
}

$installDir = Join-Path $env:RUNNER_TEMP 'rauhwpx-package-smoke'
Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue

$installer = Start-Process `
  -FilePath $installers[0].FullName `
  -ArgumentList @('/S', "/D=$installDir") `
  -Wait `
  -PassThru
if ($installer.ExitCode -ne 0) {
  throw "The NSIS installer exited with code $($installer.ExitCode)."
}

$appPath = Join-Path $installDir 'Rauhwpx.exe'
if (-not (Test-Path $appPath -PathType Leaf)) {
  throw "The installed application was not found at $appPath."
}

$app = Start-Process -FilePath $appPath -PassThru
try {
  Start-Sleep -Seconds 15
  $app.Refresh()
  if ($app.HasExited) {
    throw "The installed application exited during startup with code $($app.ExitCode)."
  }
  Write-Host "Installed Rauhwpx stayed healthy through the startup window (PID $($app.Id))."
} finally {
  if (-not $app.HasExited) {
    & taskkill.exe /PID $app.Id /T /F | Out-Host
  }
}
