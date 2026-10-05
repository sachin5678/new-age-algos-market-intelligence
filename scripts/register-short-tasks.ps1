# Registers the two twice-daily short-factory tasks. Idempotent — re-run to
# update after moving the repo. Tasks run in YOUR interactive session (free,
# no service account): Mon-Fri 09:00 story, 16:15 recap (IST machine clock).
$repo = Split-Path -Parent $PSScriptRoot
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Register-ShortTask {
    param(
        [string]$Name,
        [string]$Description,
        [string]$TaskType,
        [string]$Time   # 'HH:mm' local
    )
    $now = Get-Date
    $start = [datetime]::ParseExact("$(Get-Date -Date $now -Format 'yyyy-MM-dd') $Time", 'yyyy-MM-dd HH:mm', $null)
    if ($start -le $now) { $start = $start.AddDays(1) }
    $startStr = $start.ToString('yyyy-MM-ddTHH:mm:ss') + '+05:30'

    $argLine = "-NoProfile -ExecutionPolicy Bypass -File &quot;$repo\scripts\scheduled-short.ps1&quot; -Type $TaskType"

    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$Description</Description>
    <URI>\$Name</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startStr</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <DaysOfWeek><Monday /><Tuesday /><Wednesday /><Thursday /><Friday /></DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$argLine</Arguments>
      <WorkingDirectory>$repo</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

    $tmp = Join-Path $env:TEMP "$Name.xml"
    $xml | Out-File -FilePath $tmp -Encoding unicode
    schtasks /Create /TN $Name /XML $tmp /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed for $Name" }
    Write-Host "  + $Name  ($TaskType, Mon-Fri $Time) -> $Description"
}

Write-Host "Registering short-factory tasks (repo: $repo)..."
Register-ShortTask -Name 'NewAgeShorts-Story' -TaskType 'story' -Time '09:00' `
    -Description 'Market to Short factory: morning story short (Hinglish) + YouTube upload'
Register-ShortTask -Name 'NewAgeShorts-Recap' -TaskType 'recap' -Time '16:15' `
    -Description 'Market to Short factory: after-close market recap short (Hinglish) + YouTube upload'
Write-Host 'Done. Query with:  schtasks /Query /TN NewAgeShorts-Story /V /FO LIST'
