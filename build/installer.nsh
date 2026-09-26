; Munder Panel: the same exe with --panel, as its own Start menu entry.
; electron-builder calls these macros from its NSIS script (nsis.include).
!macro customInstall
  CreateShortCut "$SMPROGRAMS\Munder Panel.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--panel" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Munder Panel.lnk"
!macroend
