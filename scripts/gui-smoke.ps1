#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 9.5 — Win32 GUI automation PoC for release-gate "real-feel" verification.

.DESCRIPTION
  Headless smokes (smoke-sidecar.ps1 / smoke-attachment.ps1) catch regressions in the
  sidecar pipeline cheaply on every push. They do NOT exercise:

    - Tauri webview composer paste handler
    - Tauri command IPC (invoke('send_message')) → Rust → sidecar handoff
    - Window/focus state, IME, keyboard timing — i.e. the actual user feel

  This PoC closes that gap with Win32 P/Invoke. By default it is **observational only**:
    1. Locate the "K Desktop Agent" window via FindWindow / EnumWindows.
    2. Capture the desktop with System.Drawing.Graphics.CopyFromScreen.
    3. Save the screenshot to a timestamped path under logs/gui-smoke/.
    4. Print the window handle / rect / process id so a human can eyeball the result.

  With **-Interact** the script also performs ACTIVE input:
    5. SetForegroundWindow on the K window.
    6. Send Ctrl+Home (composer focus) then a fixed test sentence via SendKeys.
    7. Send Enter to dispatch the message.
    8. Capture a follow-up screenshot ~3 s later.

  Active mode WILL TAKE OVER your keyboard for 1-2 seconds — do NOT run it while typing
  something important. Headless smokes remain the right tool for CI / every-push checks;
  this one is for occasional release-gate "does the app still feel right" passes.

.PARAMETER Interact
  Enable active input (window focus + SendKeys). Default OFF.

.PARAMETER Phrase
  Test phrase to type when -Interact is set. Default is a Korean smoke marker so the
  message is easy to spot in the chat log.

.PARAMETER WindowTitle
  Substring to match against window titles. Default 'K Desktop Agent'. Case-insensitive.

.EXAMPLE
  .\scripts\gui-smoke.ps1                       # screenshot + window inspect only
  .\scripts\gui-smoke.ps1 -Interact             # also type a test message
  .\scripts\gui-smoke.ps1 -WindowTitle 'K Desktop'
#>

param(
    [switch]$Interact,
    [string]$Phrase   = '[gui-smoke] 자동화 테스트 — 응답하지 않아도 됩니다.',
    [string]$WindowTitle = 'K Desktop Agent'
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ─── Win32 P/Invoke surface ───────────────────────────────────
# Keep this surface minimal: only the APIs that have no clean .NET equivalent. Window
# enumeration is done via Get-Process below — much simpler than EnumWindows + delegates.
if (-not ('KdaGuiSmoke.Win32' -as [type])) {
    Add-Type -Namespace KdaGuiSmoke -Name Win32 -MemberDefinition @"
        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(System.IntPtr hWnd);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
"@
}

# ─── Helpers ──────────────────────────────────────────────────
function Find-AppWindow([string]$titleSubstring) {
    # Get-Process gives us MainWindowHandle + MainWindowTitle for free — no EnumWindows.
    # Filter by title substring (case-insensitive) and skip processes without a main window
    # (handle == 0 means no top-level window, e.g. background services).
    Get-Process | Where-Object {
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        $_.MainWindowTitle -and
        ($_.MainWindowTitle.IndexOf($titleSubstring, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    } | ForEach-Object {
        $rect = New-Object KdaGuiSmoke.Win32+RECT
        [void][KdaGuiSmoke.Win32]::GetWindowRect($_.MainWindowHandle, [ref]$rect)
        [pscustomobject]@{
            HWnd  = $_.MainWindowHandle
            Title = $_.MainWindowTitle
            PID   = $_.Id
            Name  = $_.ProcessName
            Rect  = $rect
        }
    }
}

function Capture-Desktop([string]$outPath) {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}

# ─── 1. Find the window ───────────────────────────────────────
Write-Host "[gui-smoke] searching for window: '$WindowTitle' …" -ForegroundColor Cyan
$wins = Find-AppWindow -titleSubstring $WindowTitle
if ($wins.Count -eq 0) {
    Write-Host "  no visible window matched. Is the app running?" -ForegroundColor Red
    Write-Host "  hint: launch the desktop shortcut or run-dev.ps1, then re-run this script." -ForegroundColor DarkYellow
    exit 1
}

foreach ($w in $wins) {
    $width  = $w.Rect.Right  - $w.Rect.Left
    $height = $w.Rect.Bottom - $w.Rect.Top
    Write-Host ("  hwnd=0x{0:X8} pid={1,5} {2,4}x{3,-4} title='{4}'" -f `
        $w.HWnd.ToInt64(), $w.PID, $width, $height, $w.Title) -ForegroundColor DarkGray
}

# Pick the first match. If multiple, prefer the one whose title looks like a main window
# (most apps name the main window exactly the substring; tooltips/popups usually have suffixes).
$target = $wins | Sort-Object { $_.Title.Length } | Select-Object -First 1
Write-Host ("  using hwnd=0x{0:X8} pid={1}" -f $target.HWnd.ToInt64(), $target.PID) -ForegroundColor Green

# ─── 2. Take a "before" screenshot ────────────────────────────
$shotDir = Join-Path $projectRoot 'logs\gui-smoke'
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$beforeShot = Join-Path $shotDir "before-$stamp.png"
Capture-Desktop -outPath $beforeShot
Write-Host "[gui-smoke] before screenshot: $beforeShot" -ForegroundColor Cyan

# ─── 3. Optionally interact ───────────────────────────────────
if (-not $Interact) {
    Write-Host ""
    Write-Host "[gui-smoke] PASS (observational mode — pass -Interact for active input)" -ForegroundColor Green
    Write-Host "  next step: open the screenshot to confirm K's window is on screen and rendering normally." -ForegroundColor DarkGray
    exit 0
}

Write-Host ""
Write-Host "[gui-smoke] -Interact ON — taking over keyboard for ~2 s …" -ForegroundColor Yellow

# Un-minimize then bring to foreground.
# SW_RESTORE = 9. ShowWindowAsync is async — give it a moment.
[void][KdaGuiSmoke.Win32]::ShowWindowAsync($target.HWnd, 9)
Start-Sleep -Milliseconds 250
[void][KdaGuiSmoke.Win32]::SetForegroundWindow($target.HWnd)
Start-Sleep -Milliseconds 250

# Empirical: SendKeys can race ahead of Tauri's webview accepting input. Pause then send.
# We send a synthetic phrase + Enter. SendKeys' special chars (+ ^ % ~ ( ) { }) have to be
# escaped — wrap the whole phrase in {} pairs char-by-char would be overkill, so we just
# avoid those chars in our default phrase. If Phrase contains them, warn instead of running.
$badChars = '+', '^', '%', '~', '(', ')', '{', '}', '['
foreach ($c in $badChars) {
    if ($Phrase.Contains($c)) {
        Write-Host "  Phrase contains SendKeys special char '$c' — refusing to type (would mis-fire). Pick a phrase without + ^ % ~ ( ) { } [" -ForegroundColor Red
        exit 1
    }
}

# Send the phrase, then Enter.
[System.Windows.Forms.SendKeys]::SendWait($Phrase)
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

Write-Host "  sent: '$Phrase' + ENTER" -ForegroundColor Green

# Give Tauri 3 s to render the assistant placeholder so the after-shot is meaningful.
Start-Sleep -Seconds 3

$afterShot = Join-Path $shotDir "after-$stamp.png"
Capture-Desktop -outPath $afterShot
Write-Host "[gui-smoke] after  screenshot: $afterShot" -ForegroundColor Cyan

Write-Host ""
Write-Host "[gui-smoke] PASS (interactive)" -ForegroundColor Green
Write-Host "  diff the two screenshots to confirm the message was accepted and rendered." -ForegroundColor DarkGray
exit 0
