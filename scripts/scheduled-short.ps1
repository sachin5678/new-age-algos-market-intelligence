param(
    [ValidateSet('story', 'recap')]
    [string]$Type = 'story',
    [string]$Lang = 'hinglish',
    [switch]$NoRefresh
)

# Twice-daily Market -> Short factory runner (used by the NewAgeShorts-*
# Windows scheduled tasks). Everything it touches is free:
#   refresh  -> local pipeline in --dry-run (fetch + store, no sends)
#   render   -> make-short.mjs (edge-tts + Chrome + ffmpeg)
#   publish  -> YouTube Data API v3 (--upload) + backfill of any older runs
$ErrorActionPreference = 'Continue'
# node writes UTF-8; decode it as UTF-8 (not the OEM codepage) so arrows and
# dashes in the per-run logs stay readable.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'logs') | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$log = Join-Path $repo "logs\scheduled-$Type-$stamp.log"

function Log([string]$m) {
    Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}
function Invoke-Logged([string[]]$CmdArgs, [string]$Label) {
    Log $Label
    $out = & node @CmdArgs 2>&1
    $code = $LASTEXITCODE
    $out | Out-File -FilePath $log -Append -Encoding utf8
    Log "$Label -> exit=$code"
    return $code
}

Log "=== scheduled $Type short (lang=$Lang) start ==="

$refreshExit = 'skipped'
if (-not $NoRefresh) {
    $refreshExit = Invoke-Logged @('src\index.js', '--mode', 'intraday', '--job-type', 'market-check', '--dry-run') `
        'refresh: market-check --dry-run (fetch + store, no sends)'
}

# Render + publish this run. Exit 0 = fine (incl. auth-pending / holiday skip),
# 1 = render failure, 3 = upload failure (video still on disk).
$shortExit = Invoke-Logged @('scripts\make-short.mjs', '--type', $Type, '--lang', $Lang, '--upload') `
    "render+upload: make-short --type $Type --lang $Lang --upload"

# Publish anything older that never made it up (no-op when nothing pending).
$backfillExit = Invoke-Logged @('scripts\make-short.mjs', '--upload-all') 'backfill: make-short --upload-all'

Log "=== done (refresh=$refreshExit short=$shortExit backfill=$backfillExit) ==="

# Keep only the newest 40 scheduled logs.
Get-ChildItem -Path (Join-Path $repo 'logs') -Filter 'scheduled-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 40 |
    Remove-Item -Force -ErrorAction SilentlyContinue

exit $shortExit
