# Windows 10/11 x64. Run through Install.cmd from the extracted release folder.
$ErrorActionPreference = 'Stop'
$Image = 'tutor-booking-system:windows-x64'
$Container = 'tutor-booking-system'
$Volume = 'tutor-booking-data'
$Port = 8000
$ImageArchive = Join-Path $PSScriptRoot 'tutor-booking-system-image.tar'
$ChecksumFile = Join-Path $PSScriptRoot 'image.sha256'
$ConfigDir = Join-Path $env:ProgramData 'TutorBookingSystem'
$ConfigFile = Join-Path $ConfigDir 'booking.env'
$DockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
$DockerExe = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'

function Invoke-Docker {
    param([string[]]$Arguments)
    & $script:DockerExe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed: $($Arguments[0])" }
}

function Get-DockerOS {
    # Windows PowerShell 5.1 can treat native stderr as a terminating error.
    # Docker may emit stderr while its engine is still starting.
    $ErrorActionPreference = 'Continue'
    $result = & $script:DockerExe info --format '{{.OSType}}' 2>$null
    if ($LASTEXITCODE -eq 0) { return $result }
    return ''
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows computer is required.' }
    if (-not (Test-Path $ImageArchive)) { throw 'Extract the whole ZIP first. The Docker image TAR must be beside Install.ps1.' }
    if (-not (Test-Path $ChecksumFile)) { throw 'The image checksum is missing. Extract the whole ZIP again.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        $child = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
        )
        exit $child.ExitCode
    }

    if (-not (Test-Path $DockerDesktop)) {
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
            throw 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and run this installer again.'
        }
        Write-Host 'Installing Docker Desktop. Internet access is needed for this first-time step.'
        & winget.exe install --id Docker.DockerDesktop --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker Desktop installation did not finish. Complete its setup, restart Windows if requested, then run Install.cmd again.'
        }
    }
    if (-not (Test-Path $DockerExe)) { throw 'Docker Desktop setup is incomplete. Finish setup and run Install.cmd again.' }
    Start-Process $DockerDesktop
    Write-Host 'Waiting for Docker Desktop (Linux containers). Complete any Docker setup prompt on screen.'
    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        $os = Get-DockerOS
        if ($os) {
            if ($os -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then run Install.cmd again.' }
            $ready = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        throw 'Docker is not ready. Complete Docker/WSL setup (restart Windows if requested), open Docker Desktop, then run Install.cmd again.'
    }

    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    # Keep credentials accessible only to administrators and the system account.
    & icacls.exe $ConfigDir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the configuration folder.' }
    if (-not (Test-Path $ConfigFile)) {
        $securePassword = Read-Host 'Choose the admin password (at least 12 characters)' -AsSecureString
        $password = [Net.NetworkCredential]::new('', $securePassword).Password
        if ($password.Length -lt 12 -or $password -match "[\r\n\x00]") { throw 'Use a password of at least 12 characters, with no line breaks.' }
        $settings = @(
            'PORT=8000', 'HOST=0.0.0.0', 'DATABASE_PATH=/app/data/bookings.db',
            'UPLOADS_DIR=/app/data/uploads', 'ADMIN_USERNAME=admin',
            "ADMIN_PASSWORD=$password"
        )
        [IO.File]::WriteAllLines($ConfigFile, $settings, [Text.UTF8Encoding]::new($false))
        $password = $null
        $settings = $null
    } else {
        Write-Host 'Keeping the existing admin password.'
    }

    Write-Host 'Checking the included Docker image...'
    $expectedHash = (Get-Content $ChecksumFile -Raw).Trim()
    $actualHash = (Get-FileHash $ImageArchive -Algorithm SHA256).Hash
    if ($expectedHash -notmatch '^[a-fA-F0-9]{64}$' -or $actualHash -ne $expectedHash) {
        throw 'Image checksum failed. Copy or extract the installation ZIP again.'
    }
    Write-Host 'Loading the included Docker image...'
    Invoke-Docker -Arguments @('load', '--input', $ImageArchive)
    Invoke-Docker -Arguments @('volume', 'create', $Volume)

    $existing = & $DockerExe container ls -a --filter "name=^/$Container$" --format '{{.Names}}'
    if ($LASTEXITCODE -ne 0) { throw 'Could not check the existing installation.' }
    if ($existing -eq $Container) {
        $mount = & $DockerExe inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' $Container
        if ($LASTEXITCODE -ne 0 -or $mount -ne $Volume) {
            throw 'Existing container uses a different data location. Stop here to preserve its data; migrate it before updating.'
        }
        # Replace only the application container; keep the named data volume.
        Invoke-Docker -Arguments @('stop', $Container)
        Invoke-Docker -Arguments @('rm', $Container)
    }

    Invoke-Docker -Arguments @(
        'run', '-d', '--name', $Container, '--restart', 'unless-stopped',
        '--publish', "${Port}:8000", '--env-file', $ConfigFile,
        '--mount', "type=volume,source=$Volume,target=/app/data", $Image
    )

    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $state = & $DockerExe inspect --format '{{.State.Health.Status}}' $Container
        if ($LASTEXITCODE -ne 0) { throw 'Could not read application status.' }
        if ($state -eq 'healthy') { $healthy = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) {
        Invoke-Docker -Arguments @('logs', '--tail', '40', $Container)
        throw 'The application did not become healthy. Check the log above.'
    }

    if (-not (Get-NetFirewallRule -Name 'TutorBookingSystem-LAN' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'TutorBookingSystem-LAN' -DisplayName 'Tutor Booking System (private LAN)' `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet | Out-Null
    }

    # Docker must be running before the container restart policy can take effect.
    $action = New-ScheduledTaskAction -Execute $DockerDesktop
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName 'TutorBookingSystem-StartDocker' -Action $action -Trigger $trigger `
        -Principal $taskPrincipal -Description 'Start Docker Desktop at sign-in for Tutor Booking System.' -Force | Out-Null

    Write-Host ''
    Write-Host "Ready: http://localhost:$Port"
    Write-Host 'Admin username: admin. Use the password you configured.'
    Write-Host "Settings: $ConfigFile"
    Write-Host 'Booking records and receipts are kept in the tutor-booking-data Docker volume.'
    Write-Host 'Docker Desktop will start at Windows sign-in. Keep the PC on while students use the app.'
    Write-Host 'Public internet access needs a separate HTTPS domain/tunnel; localhost is local access.'
    Start-Process "http://localhost:$Port"
    Read-Host 'Press Enter to finish' | Out-Null
    exit 0
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Read-Host 'Press Enter to close' | Out-Null
    exit 1
}
