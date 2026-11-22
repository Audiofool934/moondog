// A film setup window: the harness's stand-in core first, so the app's renderer finds its bridge and
// port, then the shots, then the renderer itself, unchanged, and the pointer's styles.
import "../../app/harness-preload.cjs";
import "./harness-shots.mjs";
import "../../app/renderer/renderer.mjs";
import "../window/host.css";
