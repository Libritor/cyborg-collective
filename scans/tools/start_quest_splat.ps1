# The Quest 3S as a splat sensor: puts the current app on the headset, starts it in splat mode, records what it
# sees on this computer (Downloads\quest_splats\<stamp>) and sends it to 6ense.com, where it is drawn in 3-D.
#   .\start_quest_splat.ps1                 # until Ctrl-C or the stop file
#   .\start_quest_splat.ps1 -Seconds 120    # two minutes
#   .\start_quest_splat.ps1 -NoRelay        # record only, nothing leaves this computer
# Stop from another window:  New-Item STOP_SPLAT   (in this script's folder)
#
# Before running: the headset on USB, awake and past its "press the power button to enable cameras" screen
# (that needs a finger on the headset). Whoever and whatever the headset looks at goes on a public page as
# coloured blobs two centimetres across: tell the people in the room, or use -NoRelay.
# In the headset the right thumbstick click turns the sensor off and on; the status line says how much was sent.
param([double]$Seconds = 0, [switch]$NoRelay, [switch]$NoInstall, [string]$Python = (Join-Path $env:USERPROFILE "anaconda3\python.exe"))

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$apk = Join-Path $env:USERPROFILE "Mersivity\MersivityQuest\Builds\PrintWhatISee.apk"
$stop = Join-Path $here "STOP_SPLAT"

$dev = (adb devices | Select-String -Pattern "\tdevice$" | Select-Object -First 1)
if (-not $dev) { Write-Host "No headset on adb: plug it in by USB and allow debugging inside the headset."; exit 1 }
$awake = (adb shell dumpsys power | Select-String "mWakefulness=" | Select-Object -First 1)
if ("$awake" -notmatch "Awake") { Write-Host "The headset is asleep: put it on (or press its power button), then run this again."; exit 2 }
$top = (adb shell dumpsys activity activities | Select-String "topResumedActivity" | Select-Object -First 1)
if ("$top" -match "SensorLock") { Write-Host "The headset is at its privacy screen: press its power button once, then run this again."; exit 2 }

if (-not $NoInstall) {
    if (-not (Test-Path $apk)) { Write-Host "No build at $apk : run questbag\printsee_build.ps1 first."; exit 3 }
    Write-Host "putting the current build on the headset..."
    $out = adb install -r $apk 2>&1
    if ("$out" -notmatch "Success") { Write-Host "install failed: $out"; exit 3 }
}
if (Test-Path $stop) { Remove-Item $stop -Confirm:$false }      # this launcher's own stop flag, left from the last run

$run = @((Join-Path $here "questbag\quest_splat.py"), "--stop-file", $stop)
if ($Seconds -gt 0) { $run += @("--seconds", "$Seconds") }
if ($NoRelay) { $run += @("--relay", "off") }
& $Python @run
