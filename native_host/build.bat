@echo off
:: Build script for Windows — creates dist\download_accelerator_host.exe via PyInstaller.
:: Run once; then run install.bat EXTENSION_ID to register with Chrome.
cd /d "%~dp0"

echo Installing dependencies ...
python3 -m pip install -q requests pyinstaller
if errorlevel 1 ( echo ERROR: pip failed. Is Python installed? & pause & exit /b 1 )

echo Building binary ...
python3 -m PyInstaller host.py ^
    --onefile ^
    --name download_accelerator_host ^
    --distpath dist ^
    --workpath build ^
    --specpath build ^
    --hidden-import=requests ^
    --hidden-import=urllib3 ^
    --hidden-import=charset_normalizer ^
    --hidden-import=certifi ^
    --clean ^
    --noconfirm
if errorlevel 1 ( echo ERROR: PyInstaller failed. & pause & exit /b 1 )

echo.
echo [OK] dist\download_accelerator_host.exe ready
echo.
echo Next: install.bat EXTENSION_ID
pause
