@echo off
:: Windows installer for the Download Accelerator native messaging host.
:: Requires dist\download_accelerator_host.exe (run build.bat first).
cd /d "%~dp0"

set EXTENSION_ID=%1
if "%EXTENSION_ID%"=="" (
    echo Usage: install.bat EXTENSION_ID
    echo.
    echo Find the Extension ID at chrome://extensions
    echo ^(Enable Developer mode ^-^> ID below the extension name^)
    pause & exit /b 1
)

if not exist "dist\download_accelerator_host.exe" (
    echo ERROR: dist\download_accelerator_host.exe not found.
    echo Run build.bat first.
    pause & exit /b 1
)

:: ── Copy binary ───────────────────────────────────────────────────────────────
set INSTALL_DIR=%LOCALAPPDATA%\download_accelerator_host
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /y "dist\download_accelerator_host.exe" "%INSTALL_DIR%\download_accelerator_host.exe" >nul
echo [1/3] Binary copied to: %INSTALL_DIR%\download_accelerator_host.exe

:: ── Write manifest JSON via PowerShell (handles backslash escaping) ───────────
set MANIFEST=%INSTALL_DIR%\com.downloadaccelerator.native_host.json

powershell -NoProfile -Command "$m = [ordered]@{ name = 'com.downloadaccelerator.native_host'; description = 'Download Accelerator Native Host'; path = '%INSTALL_DIR%\download_accelerator_host.exe'; type = 'stdio'; allowed_origins = @('chrome-extension://%EXTENSION_ID%/') }; $m | ConvertTo-Json | Set-Content -Path '%MANIFEST%' -Encoding UTF8"

if not exist "%MANIFEST%" (
    echo ERROR: Manifest could not be written!
    pause & exit /b 1
)
echo [2/3] Manifest written to: %MANIFEST%

:: ── Register in Windows registry ──────────────────────────────────────────────
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.downloadaccelerator.native_host" ^
    /ve /t REG_SZ /d "%MANIFEST%" /f >nul
echo [3/3] Registry key set.

echo.
echo [OK] Installed!
echo   Binary:   %INSTALL_DIR%\download_accelerator_host.exe
echo   Manifest: %MANIFEST%
echo.
echo Reload the Chrome extension - done.
pause
