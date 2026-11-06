param([switch]$Apply)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$tailscale = (Get-Command tailscale -ErrorAction Stop).Source
$selfJson = & $tailscale status --json
if ($LASTEXITCODE -ne 0) { throw 'Tailscale status failed.' }
$self = ($selfJson | ConvertFrom-Json).Self
$dns = ([string]$self.DNSName).TrimEnd('.')
if (-not $self.Online -or -not $dns) { throw 'Tailscale must be online with a DNS name.' }
$beforeJson = & $tailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve status failed.' }
$before = $beforeJson | ConvertFrom-Json
if ($before.TCP -and $before.TCP.PSObject.Properties['8443']) { throw 'Port 8443 already configured. Preserve the existing service.' }
if ($before.AllowFunnel -and $before.AllowFunnel.PSObject.Properties["${dns}:8443"] -and $before.AllowFunnel.PSObject.Properties["${dns}:8443"].Value) { throw 'Port 8443 has public Funnel enabled. Do not reuse it.' }
$plan = [ordered]@{ dryRun = (-not $Apply); origin = "https://${dns}:8443"; target = 'http://127.0.0.1:17677'; privateTailnetOnly = $true; preserveExisting443 = $true; command = 'tailscale serve --bg --https=8443 http://127.0.0.1:17677'; executed = $false }
if (-not $Apply) { $plan | ConvertTo-Json; exit 0 }
# Explicit -Apply is only for the separately approved ingress change.
$audit = Join-Path $PSScriptRoot '../evidence/mobile-companion-20261106/private-access'
New-Item -ItemType Directory -Path $audit -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
[IO.File]::WriteAllText((Join-Path $audit "serve-before-$stamp.json"), ($beforeJson -join "`n"), (New-Object Text.UTF8Encoding($false)))
& $tailscale serve --bg --https=8443 http://127.0.0.1:17677
if ($LASTEXITCODE -ne 0) { throw 'Serve configuration failed. Review the saved baseline; do not retry automatically.' }
$afterJson = & $tailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Serve verification failed.' }
[IO.File]::WriteAllText((Join-Path $audit "serve-after-$stamp.json"), ($afterJson -join "`n"), (New-Object Text.UTF8Encoding($false)))
$after = $afterJson | ConvertFrom-Json
$service = $after.Web.PSObject.Properties["${dns}:8443"].Value
if (-not $service -or $service.Handlers.PSObject.Properties['/'].Value.Proxy -ne $plan.target) { throw 'Unexpected HTTPS proxy configuration.' }
if ($after.AllowFunnel -and $after.AllowFunnel.PSObject.Properties["${dns}:8443"] -and $after.AllowFunnel.PSObject.Properties["${dns}:8443"].Value) { throw 'Unexpected public exposure. Review configuration immediately.' }
$old443 = if ($before.Web) { $before.Web.PSObject.Properties["${dns}:443"].Value | ConvertTo-Json -Depth 12 -Compress } else { $null }
$new443 = if ($after.Web) { $after.Web.PSObject.Properties["${dns}:443"].Value | ConvertTo-Json -Depth 12 -Compress } else { $null }
if ($old443 -ne $new443) { throw 'Existing port 443 configuration changed unexpectedly.' }
$oldTcp443 = if ($before.TCP) { $before.TCP.PSObject.Properties['443'].Value | ConvertTo-Json -Depth 8 -Compress } else { $null }
$newTcp443 = if ($after.TCP) { $after.TCP.PSObject.Properties['443'].Value | ConvertTo-Json -Depth 8 -Compress } else { $null }
if ($oldTcp443 -ne $newTcp443) { throw 'Existing port 443 listener changed unexpectedly.' }
$oldFunnel443 = if ($before.AllowFunnel) { $before.AllowFunnel.PSObject.Properties["${dns}:443"].Value } else { $null }
$newFunnel443 = if ($after.AllowFunnel) { $after.AllowFunnel.PSObject.Properties["${dns}:443"].Value } else { $null }
if ($oldFunnel443 -ne $newFunnel443) { throw 'Existing port 443 exposure policy changed unexpectedly.' }
$plan.dryRun = $false; $plan.executed = $true
$plan | ConvertTo-Json
