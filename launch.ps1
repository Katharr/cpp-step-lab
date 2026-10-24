$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONNOUSERSITE = '1'
Remove-Item Env:PYTHONHOME, Env:PYTHONPATH -ErrorAction SilentlyContinue
$labPython = $null
foreach ($labCandidate in @('runtime/python/python.exe', '.venv/Scripts/python.exe')) {
    $labPath = Join-Path $PSScriptRoot $labCandidate
    if (Test-Path -LiteralPath $labPath) { $labPython = $labPath; break }
}
if (-not $labPython) {
    $labCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($labCommand -and $labCommand.Source -notlike '*WindowsApps*') { $labPython = $labCommand.Source }
}
if (-not $labPython) {
    Write-Host '未找到 Python。推荐复制发布包的完整 runtime 目录；或执行 winget install -e --id Python.Python.3.14 后重试。'
    exit 1
}
& $labPython (Join-Path $PSScriptRoot 'launch.py') @args
exit $LASTEXITCODE
