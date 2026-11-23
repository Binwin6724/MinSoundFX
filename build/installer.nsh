; MinSoundFX NSIS hooks.
; On uninstall, put the user's original default output device back before the
; files are removed, in case MinSoundFX was routing audio when it was closed.
!macro customUnInstall
  IfFileExists "$INSTDIR\MinSoundFX.exe" 0 +2
    ExecWait '"$INSTDIR\MinSoundFX.exe" --restore-audio'
!macroend
