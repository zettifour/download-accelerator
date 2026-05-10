@echo off
:: Uninstaller for the Download Accelerator native messaging host (Windows).
cd /d "%~dp0"

echo Removing registry entries ...
:: Current name
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.downloadaccelerator.native_host" /f >nul 2>&1
:: Legacy name (before rename)
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pdm.native_host" /f >nul 2>&1

echo Removing host files ...
:: Current install dir
if exist "%LOCALAPPDATA%\download_accelerator_host" rmdir /s /q "%LOCALAPPDATA%\download_accelerator_host"
:: Legacy install dir (before rename)
if exist "%LOCALAPPDATA%\pdm_host" rmdir /s /q "%LOCALAPPDATA%\pdm_host"

echo.
echo [OK] Download Accelerator native host removed.
echo      Remove the Chrome extension manually at chrome://extensions
pause
