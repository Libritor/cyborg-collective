# Builds Print What I See (with the splat sensor) for the Quest: Unity in batch mode, about nine minutes.
# Watches the disk while it runs and stops Unity rather than let C: fill up.
#   powershell -ExecutionPolicy Bypass -File printsee_build.ps1 [-MinFreeMb 700]
# Check the scripts first, in seconds:  python Assets/PrintSee/Editor/compile_check.py   (in the Unity project)
param([int]$MinFreeMb = 700)

$unity = "C:\Program Files\Unity\Hub\Editor\6000.3.8f1\Editor\Unity.exe"
$proj = Join-Path $env:USERPROFILE "Mersivity\MersivityQuest"
$log = Join-Path $env:USERPROFILE "Mersivity\unity_printsee_build.log"
$apk = Join-Path $proj "Builds\PrintWhatISee.apk"

if (Get-Process Unity -ErrorAction SilentlyContinue) { "Unity is already running: close it first (one editor per project)"; exit 2 }
$before = if (Test-Path $apk) { (Get-Item $apk).LastWriteTime } else { [datetime]::MinValue }
$p = Start-Process -FilePath $unity -PassThru -ArgumentList @("-projectPath", "`"$proj`"", "-buildTarget", "Android", "-batchmode", "-quit",
                                                             "-executeMethod", "PrintSeeBuild.BuildAPK", "-logFile", "`"$log`"")
$t0 = Get-Date
while (-not $p.HasExited) {
    Start-Sleep -Seconds 10
    $free = (Get-PSDrive C).Free / 1MB
    if ($free -lt $MinFreeMb) {
        Stop-Process -Id $p.Id -Force
        "STOPPED: only {0:N0} MB left on C: after {1:N1} min" -f $free, ((Get-Date) - $t0).TotalMinutes
        exit 3
    }
}
$ok = (Test-Path $apk) -and ((Get-Item $apk).LastWriteTime -gt $before)
$state = if ($ok) { "rebuilt, {0:N1} MB" -f ((Get-Item $apk).Length / 1MB) } else { "NOT rebuilt" }
"Unity exit code {0} after {1:N1} min; APK {2}; C: free {3:N0} MB" -f $p.ExitCode, ((Get-Date) - $t0).TotalMinutes, $state, ((Get-PSDrive C).Free / 1MB)
Select-String -Path $log -Pattern "error CS", "Build completed", "BuildFailedException", "\[PrintSee\]", "Build Finished", "Result:" |
    Select-Object -Last 12 | ForEach-Object { $_.Line }
if (-not $ok -or $p.ExitCode -ne 0) { exit 1 }
