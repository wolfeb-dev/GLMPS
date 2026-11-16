# scripts/register-nightly-task.ps1
#
# Register the nightly autonomous run as a Windows Scheduled Task.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nightly-task.ps1 -RepoRoot <runtime-checkout> -At 10pm
#
# Why this file exists: the task was registered by hand on 2026-08-21
# (glmps-74) and a task that lives only in one machine's Task
# Scheduler is not reproducible. This is the definition, in the repo.
#
# It was the only Scheduled Task left once the wiki moved into the kernel
# (D-W6, 2026-09); its ExecutionTimeLimit is 4 hours because a nightly run
# launches an agent session (GLMPS_NIGHTLY_ITEM_TIMEOUT_MS defaults to one hour
# per item), and it runs at 22:00 to match `nightly.hour`.
#
# The run is safe to schedule before it has ever executed because every stop is
# a clean exit 0: kill switch engaged, config disabled, another run holding the
# lock, or nothing allowlisted. A scheduled task therefore never reports
# failure for a night that was correctly skipped.
#
# TO STOP THE NEXT RUN, either:
#   * create <stateDir>\nightly\nightly.kill   (no config edit, no restart), or
#   * set nightly.enabled to false in config.json.
# Both were verified working when this was first registered.

param(
  [string]$TaskName = 'GLMPS Nightly Run',
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$NodeExe  = 'C:\Program Files\nodejs\node.exe',
  [string]$At       = '10pm'
)

$script = Join-Path $RepoRoot 'scripts\nightly-run.mjs'
if (-not (Test-Path $script)) { throw "nightly-run.mjs not found at $script" }
if (-not (Test-Path $NodeExe)) { throw "node.exe not found at $NodeExe" }

$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$script`"" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
# StartWhenAvailable so a night the machine was asleep runs on the next resume
# rather than being silently skipped. IgnoreNew so a long run is never stacked
# by the following night's trigger.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object NextRunTime
