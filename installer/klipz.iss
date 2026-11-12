; KLIPZ Windows installer (Inno Setup 6). Built by `npm run desktop:installer`, which stages
; dist\desktop\stage first and passes /DAppVersion and /DStageDir.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef StageDir
  #define StageDir "..\dist\desktop\stage"
#endif

[Setup]
AppId={{6C5B0E7A-3F1D-4C1B-9A57-6B0F3C2D9E41}
AppName=KLIPZ
AppVersion={#AppVersion}
AppPublisher=KLIPZ
DefaultDirName={localappdata}\Programs\KLIPZ
DefaultGroupName=KLIPZ
DisableProgramGroupPage=yes
; Per-user install: no admin prompt, and the app may write its Next.js cache next to itself.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\dist\desktop
OutputBaseFilename=KLIPZ-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\KLIPZ.exe
UninstallDisplayName=KLIPZ
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Old app code is replaced wholesale on upgrade (user data lives in %USERPROFILE%\.klipz and is untouched).
Type: filesandordirs; Name: "{app}\app"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"

[Icons]
Name: "{group}\KLIPZ"; Filename: "{app}\KLIPZ.exe"
Name: "{autodesktop}\KLIPZ"; Filename: "{app}\KLIPZ.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\KLIPZ.exe"; Description: "Start KLIPZ"; Flags: nowait postinstall skipifsilent

[Messages]
FinishedLabel=KLIPZ is installed. Your projects, connected accounts and settings are kept in %USERPROFILE%\.klipz (uninstalling does not delete them). The first start sets up the video worker, which takes a few minutes.
