// The film's listening room: its host first, so the app's renderer finds its bridge and port, then the
// renderer itself, unchanged, then the styles for the pointer and the resting traffic lights.
import "./room-host.mjs";
import "../../app/renderer/renderer.mjs";
import "../window/host.css";
