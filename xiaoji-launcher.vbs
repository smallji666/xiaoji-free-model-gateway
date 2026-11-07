' XiaoJi Free Model hidden launcher - do not edit by hand
' Args: 1=node.exe path  2=server.mjs path  3=(obsolete) log path
'
' 2026-09-19: the launcher no longer redirects stdout/stderr into a file.
' Reason: server.mjs now owns its own log (logs\xiaoji.log, leveled + size-rolled,
' keeps 5 backups). While cmd held the redirect handle the server could neither
' rename nor truncate the file on Windows, so it could only discard history in
' place. Arg 3 is still accepted (the .bat still passes it) but is ignored.
Dim args, nodePath, serverPath, cmdLine, shell, Q
Q = Chr(34)
Set args = WScript.Arguments
If args.Count < 2 Then
  MsgBox "Usage: cscript //nologo xiaoji-launcher.vbs <node> <server.mjs> [log]", 48, "XiaoJi Free Model"
  WScript.Quit 1
End If
nodePath = args(0)
serverPath = args(1)
Set shell = CreateObject("WScript.Shell")
cmdLine = shell.ExpandEnvironmentStrings("%ComSpec%") & " /c " & Q & Q & nodePath & Q & " " & Q & serverPath & Q & Q
shell.Run cmdLine, 0, False
