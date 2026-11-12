@echo off
chcp 65001 >nul
setlocal
title StemTutor
rem The project folder, taken before the argument loop: 'shift' would change %~dp0.
set "ROOT=%~dp0"
cd /d "%ROOT%"

rem Python environment and data live in a short per-user path (deep paths break DLL loading).
set "ST_HOME=%LOCALAPPDATA%\StemTutor"
if not exist "%ST_HOME%" mkdir "%ST_HOME%"
set "UV_PROJECT_ENVIRONMENT=%ST_HOME%\venv"

set "WITH_SEP="
set "REBUILD="
set "REPAIR="
set "ST_ACTION="
if not defined ST_PORT set "ST_PORT=8765"
:args
if "%~1"=="" goto argsdone
rem The separation choice is remembered next to the project (.with-separation), so it
rem travels with the folder and is visible to every launch.
if /i "%~1"=="--with-separation" (
  type nul > "%ROOT%.with-separation"
  set "ST_ACTION=1"
)
if /i "%~1"=="--without-separation" (
  if exist "%ROOT%.with-separation" del "%ROOT%.with-separation"
  set "ST_ACTION=1"
)
if /i "%~1"=="--repair-separation" (
  type nul > "%ROOT%.with-separation"
  set "REPAIR=--reinstall-package torch --reinstall-package demucs"
  set "ST_ACTION=1"
)
if /i "%~1"=="--rebuild" (
  set "REBUILD=1"
  set "ST_ACTION=1"
)
if /i "%~1"=="--port" (
  if not "%~2"=="" set "ST_PORT=%~2"
  shift
)
shift
goto args
:argsdone
if exist "%ROOT%.with-separation" set "WITH_SEP=--extra separation"

rem Already running: without flags just open it; flags need the environment the running
rem server has loaded, so they only work after closing it. No pipe here: a pipe whose
rem command cannot start (no curl.exe) would abort the whole script.
set "HEALTH=%TEMP%\stemtutor-health-%RANDOM%.json"
curl -s -m 2 -o "%HEALTH%" "http://127.0.0.1:%ST_PORT%/api/health" >nul 2>nul
findstr /c:"engines" "%HEALTH%" >nul 2>nul
set "RUNNING=%errorlevel%"
del "%HEALTH%" >nul 2>nul
if not "%RUNNING%"=="0" goto notrunning
if defined ST_ACTION goto busy
echo StemTutor уже запущен — открываю http://127.0.0.1:%ST_PORT%/
echo Если вы обновили StemTutor или перенесли его папку: закройте окно запущенного сервера
echo (заголовок «StemTutor») и снова запустите start.bat — иначе продолжит работать старая версия.
if not defined ST_NO_BROWSER start "" "http://127.0.0.1:%ST_PORT%/"
exit /b 0
:busy
echo [!] StemTutor уже запущен. Закройте его окно и снова запустите start.bat с теми же флагами.
pause
exit /b 1
:notrunning

set "UV=uv"
call :finduv
if not errorlevel 1 goto uvok
echo [!] Не найден uv — через него ставится Python-окружение StemTutor.
where winget >nul 2>nul
if errorlevel 1 goto nouv
set "ANS="
set /p "ANS=    Установить uv сейчас (winget install astral-sh.uv)? [Y/N] "
if /i not "%ANS%"=="Y" goto nouv
winget install --id astral-sh.uv -e --source winget
call :finduv
if not errorlevel 1 goto uvok
:nouv
echo [!] Установите uv: winget install astral-sh.uv
echo     Потом закройте это окно и запустите start.bat снова.
pause
exit /b 1
:uvok

where ffmpeg >nul 2>nul
if errorlevel 1 call :findffmpeg

if defined WITH_SEP echo Модуль разделения Demucs включён — в первый раз скачивается PyTorch с CUDA, около 2 ГБ.
if defined REPAIR echo Переустанавливаю PyTorch и Demucs.
echo [1/3] Python-окружение %WITH_SEP%
pushd backend
%UV% sync --frozen --python 3.12 %WITH_SEP% %REPAIR%
if errorlevel 1 if defined WITH_SEP (
  echo [!] Модуль разделения не установился — запускаю без него. Повторите start.bat позже или отключите: start.bat --without-separation
  %UV% sync --frozen --python 3.12
)
if errorlevel 1 (
  popd
  echo [!] Не удалось установить зависимости. Проверьте интернет и запустите start.bat ещё раз.
  pause
  exit /b 1
)
popd

if not exist "frontend\dist\index.html" set "REBUILD=1"
if not defined REBUILD goto uiready
where npm >nul 2>nul
if errorlevel 1 (
  echo [!] Нужен Node.js LTS, чтобы собрать интерфейс: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
echo [2/3] Сборка интерфейса
pushd frontend
call npm ci --no-fund --no-audit
if errorlevel 1 goto uifail
call npm run build
if errorlevel 1 goto uifail
popd
goto uidone
:uifail
popd
echo [!] Не удалось собрать интерфейс — ошибки выше.
pause
exit /b 1
:uiready
echo [2/3] Интерфейс уже собран
:uidone

echo [3/3] Запуск: http://127.0.0.1:%ST_PORT%  — закройте это окно, чтобы остановить
set "OPEN=--open"
if defined ST_NO_BROWSER set "OPEN="
pushd backend
%UV% run --no-sync python -m stemtutor serve --port %ST_PORT% %OPEN%
if errorlevel 1 (
  echo [!] StemTutor остановился с ошибкой — подробности выше.
  pause
)
popd
endlocal
goto :eof

rem uv on PATH, in its usual install folders (this window's PATH can predate the install),
rem or installed for Python as a module (pip install --user uv). The exe is used by full path:
rem PATH itself is never expanded inside a block, its quotes and parentheses would break it.
:finduv
where uv >nul 2>nul && exit /b 0
for %%D in ("%USERPROFILE%\.local\bin" "%LOCALAPPDATA%\Microsoft\WinGet\Links" "%USERPROFILE%\.cargo\bin") do (
  if exist "%%~D\uv.exe" (
    set UV="%%~D\uv.exe"
    exit /b 0
  )
)
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\astral-sh.uv_*") do (
  if exist "%%~D\uv.exe" (
    set UV="%%~D\uv.exe"
    exit /b 0
  )
)
py -m uv --version >nul 2>nul && (
  set "UV=py -m uv"
  exit /b 0
)
exit /b 1

rem ffmpeg from winget is found by the app itself even if this window's PATH predates it.
:findffmpeg
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" exit /b 0
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*") do (
  for /d %%E in ("%%~D\*") do (
    if exist "%%~E\bin\ffmpeg.exe" exit /b 0
  )
)
echo [!] Не найден ffmpeg — аудио работать не будет. Установите: winget install Gyan.FFmpeg
exit /b 0
