; Слойка: тихая доустановка системных пререквизитов при установке.
; Установщики лежат в build/win-prereqs (tools/fetch-win-prereqs.mjs)
; и вшиваются в инсталлер на этапе сборки.

!macro customInstall
  SetRegView 64

  ; ── Microsoft Visual C++ Redistributable x64 ──
  ; Без него не импортируется PyTorch (WinError 126 на fbgemm.dll).
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} ${Errors}
  ${OrIf} $0 <> 1
    DetailPrint "Установка Microsoft Visual C++ Redistributable (x64)…"
    File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "${BUILD_RESOURCES_DIR}\win-prereqs\vc_redist.x64.exe"
    ; Установщику нужны права администратора — ExecShellWait поднимет UAC.
    ExecShellWait "" "$PLUGINSDIR\vc_redist.x64.exe" "/install /passive /norestart"
  ${EndIf}

  ; ── Python 3.10+ (для функций локального ИИ) ──
  ; Ищем 64-битный CPython 3.10–3.13 в реестре (для пользователя и системный).
  StrCpy $R0 "0"
  ReadRegStr $1 HKCU "Software\Python\PythonCore\3.10\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKCU "Software\Python\PythonCore\3.11\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKCU "Software\Python\PythonCore\3.12\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKCU "Software\Python\PythonCore\3.13\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.10\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.11\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.12\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}
  ReadRegStr $1 HKLM "SOFTWARE\Python\PythonCore\3.13\InstallPath" ""
  ${If} $1 != ""
    StrCpy $R0 "1"
  ${EndIf}

  ${If} $R0 == "0"
    DetailPrint "Установка Python 3.11 (для локального ИИ)…"
    File "/oname=$PLUGINSDIR\python-3.11.9-amd64.exe" "${BUILD_RESOURCES_DIR}\win-prereqs\python-3.11.9-amd64.exe"
    ; Тихая установка в профиль пользователя: без UAC, с PATH и py-launcher.
    ExecWait '"$PLUGINSDIR\python-3.11.9-amd64.exe" /quiet InstallAllUsers=0 InstallLauncherAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0' $2
    DetailPrint "Python: код установки $2"
  ${EndIf}
!macroend
