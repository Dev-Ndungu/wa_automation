$workspacePath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $workspacePath

# A previous local copy can remain alive after an interrupted terminal. It is
# safe to replace a Node process on this app's fixed API port; do not touch a
# non-Node process that may belong to another application.
$portListener = Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portListener) {
  $portProcess = Get-Process -Id $portListener.OwningProcess -ErrorAction Stop
  if ($portProcess.ProcessName -ne 'node') {
    throw "Port 3001 is being used by $($portProcess.ProcessName), not WA Control. Close that application first."
  }
  Write-Host "Stopping the older WA Control service on port 3001..."
  Stop-Process -Id $portListener.OwningProcess -Force
  Start-Sleep -Seconds 1
}

# Build the React dashboard without Vite's development server. This keeps the
# dashboard and API in one dependable local process at http://127.0.0.1:3001.
$esbuildPath = Join-Path $workspacePath 'node_modules\esbuild\node_modules\@esbuild\win32-x64\esbuild.exe'
$webSourcePath = Join-Path $workspacePath 'apps\web\src\main.tsx'
$webOutputPath = Join-Path $workspacePath 'apps\web\dist\assets\index.js'
& $esbuildPath $webSourcePath '--bundle' '--format=esm' '--platform=browser' '--target=es2022' '--jsx=automatic' "--outfile=$webOutputPath" '--loader:.tsx=tsx' '--loader:.css=css'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& node.exe 'node_modules/typescript/bin/tsc' '-p' 'apps/api/tsconfig.json'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Dashboard and API are starting at http://127.0.0.1:3001'
& node.exe 'apps/api/dist/server.js'
