// The window's document: the host first, so the app's renderer finds its bridge and port, then the
// renderer itself, unchanged, then the few styles for what the page draws in the app's place.
import "./host.mjs";
import "../../app/renderer/renderer.mjs";
import "./host.css";
