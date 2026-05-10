@echo off
:: Uninstaller for the Download Accelerator native messaging host (Windows).
cd /d "%~dp0"

set INSTALL_DIR=%LOCALAPPDATA%\download_accelerator_host

echo Removing registry entry ...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.downloadaccelerator.native_host" /f >nul 2>&1

echo Removing host files ...
if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"

echo.
echo [OK] Download Accelerator native host removed.
echo      Remove the Chrome extension manually at chrome://extensions
pause
