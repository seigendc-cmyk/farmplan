#!/usr/bin/env bash
# Compiles src-tauri/src/hub.rs against a stand-in for the Tauri types and exercises it with a real TCP client
# (CORS preflight, large bodies, size limits, reply routing). Needs only Rust, not the Tauri/GTK toolchain.
set -euo pipefail
cd "$(dirname "$0")"
python3 - <<'PY'
src = open('../../src-tauri/src/hub.rs').read()
src = src.replace("use tauri::{AppHandle, Emitter, State};", "use crate::stub::{AppHandle, Emitter, State};").replace("#[tauri::command]\n", "")
open('src/hub.rs', 'w').write(src)
PY
cargo run -q
