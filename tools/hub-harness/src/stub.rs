use serde::Serialize;
use std::sync::{mpsc::Sender, Arc, Mutex};
pub trait Emitter { fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>; }
#[derive(Clone)] pub struct AppHandle { pub tx: Arc<Mutex<Sender<String>>> }
impl Emitter for AppHandle { fn emit<S: Serialize + Clone>(&self, _e: &str, p: S) -> Result<(), String> { self.tx.lock().unwrap().send(serde_json::to_string(&p).unwrap()).map_err(|e| e.to_string()) } }
pub struct State<'a, T>(pub &'a T);
impl<'a, T> std::ops::Deref for State<'a, T> { type Target = T; fn deref(&self) -> &T { self.0 } }
