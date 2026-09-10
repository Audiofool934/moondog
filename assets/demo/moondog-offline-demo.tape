# Reproduce the public README recording with VHS 0.11.0 or newer.
# The command below uses only Moondog's deterministic synthetic demo data.

Output assets/demo/moondog-offline-demo.gif

Require npm

Set Shell "bash"
Set Theme "Builtin Dark"
Set FontSize 18
Set Width 1240
Set Height 840
Set Padding 28
Set Margin 22
Set MarginFill "#eee8de"
Set BorderRadius 16
Set WindowBar Rings
Set WindowBarSize 36
Set Framerate 20
Set PlaybackSpeed 1.1
Set TypingSpeed 42ms

Type "npm run --silent demo"
Sleep 400ms
Enter
Sleep 2200ms
ScrollUp@18ms 22
Sleep 2600ms
ScrollDown@18ms 22
Sleep 3200ms
