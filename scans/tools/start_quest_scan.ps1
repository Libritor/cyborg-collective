# Scan an object with the Quest 3S, get a Gaussian splat of it and a file for the printer.
#   .\start_quest_scan.ps1                  # with the right controller: trigger on the object, walk round it, B
#   .\start_quest_scan.ps1 -HandsFree 120   # no controller: look at the object, walk round it (saves by itself)
#   .\start_quest_scan.ps1 -View            # only show the last result again (laptop + Quest Browser)
#   .\start_quest_scan.ps1 -Live -Publish   # the whole chain to the website (see below)
#
# Before running: the headset on USB. Put it on when the script says so; if it shows "press the power button to
# enable cameras", press it once (the script waits; it does not get round that screen).
# What comes out: Downloads\quest_scans\<name>\ : the splat, <name>_print.stl, <name>_h2c.3mf (sliced for the
# Bambu H2C, PLA), pictures in renders\, numbers in summary.json. Nothing is sent to the printer: open the 3MF in
# Bambu Studio yourself.
#
# Without -Live or -Publish everything stays on this computer. Both send to the public site 6ense.com:
#   -Live      while you scan, a rough untrained view of what the headset sees appears under "Live now"
#   -Publish   afterwards, the trained splat (compressed), its solid and its print files go on 6ense.com/scans/;
#              the camera pictures do not. -Title and -Note set its words; take it off again with
#              python questbag\scan_publish.py --remove <id>
param([int]$HandsFree = 0, [double]$SaveAfter = 0, [int]$Steps = 8000, [double]$PrintMm = 120, [switch]$NoInstall, [switch]$View,
      [switch]$Live, [switch]$Publish, [string]$Title = "", [string]$Note = "",
      [string]$Python = (Join-Path $env:USERPROFILE "anaconda3\python.exe"))

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($View) { & $Python -I (Join-Path $here "questbag\scan_view.py") --quest; exit $LASTEXITCODE }
$run = @("-I", (Join-Path $here "questbag\scan_session.py"), "--steps", "$Steps", "--print-mm", "$PrintMm")
if ($HandsFree -gt 0) { $run += @("--hands-free", "$HandsFree") }
if ($SaveAfter -gt 0) { $run += @("--save-after", "$SaveAfter") }
if ($NoInstall) { $run += "--no-install" }
if ($Live) { $run += "--live" }
if ($Publish) { $run += "--publish" }
if ($Title) { $run += @("--title", $Title) }      # PowerShell quotes an argument with spaces by itself; no quote marks inside it
if ($Note) { $run += @("--note", $Note) }
& $Python @run
exit $LASTEXITCODE
