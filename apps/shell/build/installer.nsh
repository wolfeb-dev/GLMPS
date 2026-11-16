; Tell Explorer the file associations and icons changed so it rebuilds its icon
; cache for the new exe (SHCNE_ASSOCCHANGED = 0x08000000), not the stale one.
!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
