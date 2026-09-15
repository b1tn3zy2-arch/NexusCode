// Voice input: microphone capture + Whisper transcription.
// cpal::Stream is !Send, so the stream lives on a dedicated recording thread
// controlled via a command channel. Transcription shells out to a local
// whisper.cpp binary; frontend falls back to Web Speech API when unavailable.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum VoiceStatus {
    Idle,
    Listening,
    Processing,
    Transcribing,
    Done(String),
    Error(String),
}

enum RecCmd {
    Start,
    Stop,
}

struct RecorderHandle {
    tx: std::sync::mpsc::Sender<RecCmd>,
    done: Arc<AtomicBool>,
    result: Arc<Mutex<Option<Result<Vec<u8>, String>>>>,
}

pub struct VoiceInput {
    recorder: Mutex<Option<RecorderHandle>>,
    status: Mutex<VoiceStatus>,
}

impl VoiceInput {
    pub fn new() -> Self {
        Self {
            recorder: Mutex::new(None),
            status: Mutex::new(VoiceStatus::Idle),
        }
    }

    fn set_status(&self, s: VoiceStatus) {
        if let Ok(mut st) = self.status.lock() {
            *st = s;
        }
    }
}

fn spawn_recorder() -> Result<RecorderHandle, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let (tx, rx) = std::sync::mpsc::channel::<RecCmd>();
    let done = Arc::new(AtomicBool::new(false));
    let done2 = done.clone();
    let result: Arc<Mutex<Option<Result<Vec<u8>, String>>>> = Arc::new(Mutex::new(None));
    let result2 = result.clone();

    std::thread::spawn(move || {
        // Lazily created on Start; kept alive until Stop.
        let mut stream_slot: Option<cpal::Stream> = None;
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let mut sr: u32 = 16000;
        let mut ch: u16 = 1;
        // Device/config must outlive the stream.
        #[allow(clippy::type_complexity)]
        let mut keep: Option<(cpal::Device, cpal::SupportedStreamConfig)> = None;

        loop {
            match rx.recv() {
                Ok(RecCmd::Start) => {
                    samples.lock().unwrap().clear();

                    let host = cpal::default_host();
                    let Some(device) = host.default_input_device() else {
                        *result2.lock().unwrap() = Some(Err("No microphone found".into()));
                        done2.store(true, Ordering::SeqCst);
                        continue;
                    };
                    let Ok(config) = device.default_input_config() else {
                        *result2.lock().unwrap() = Some(Err("Microphone config error".into()));
                        done2.store(true, Ordering::SeqCst);
                        continue;
                    };
                    sr = config.sample_rate().0;
                    ch = config.channels();
                    let config_for_stream = config.clone();

                    let err_fn = move |err| log_voice(&format!("stream error: {err}"));
                    let buf = samples.clone();

                    use cpal::SampleFormat;
                    let build = match config.sample_format() {
                        SampleFormat::F32 => device.build_input_stream(
                            &config_for_stream.into(),
                            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                                if let Ok(mut b) = buf.try_lock() {
                                    b.extend_from_slice(data);
                                }
                            },
                            err_fn,
                            None,
                        ),
                        SampleFormat::I16 => device.build_input_stream(
                            &config_for_stream.into(),
                            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                                if let Ok(mut b) = buf.try_lock() {
                                    b.extend(data.iter().map(|&s| s as f32 / 32768.0));
                                }
                            },
                            err_fn,
                            None,
                        ),
                        SampleFormat::U16 => device.build_input_stream(
                            &config_for_stream.into(),
                            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                                if let Ok(mut b) = buf.try_lock() {
                                    b.extend(data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0));
                                }
                            },
                            err_fn,
                            None,
                        ),
                        other => {
                            *result2.lock().unwrap() =
                                Some(Err(format!("Unsupported sample format: {other:?}")));
                            done2.store(true, Ordering::SeqCst);
                            continue;
                        }
                    };

                    match build {
                        Ok(s) => {
                            if let Err(e) = s.play() {
                                *result2.lock().unwrap() =
                                    Some(Err(format!("Stream play failed: {e}")));
                                done2.store(true, Ordering::SeqCst);
                                continue;
                            }
                            stream_slot = Some(s);
                            keep = Some((device, config));
                        }
                        Err(e) => {
                            *result2.lock().unwrap() =
                                Some(Err(format!("Stream build failed: {e}")));
                            done2.store(true, Ordering::SeqCst);
                        }
                    }
                }
                Ok(RecCmd::Stop) => {
                    // Dropping the stream stops callbacks; keep device/config
                    // alive until after the drop.
                    drop(stream_slot.take());
                    drop(keep.take());

                    let data = samples.lock().unwrap().clone();
                    if data.is_empty() {
                        *result2.lock().unwrap() = Some(Err("No audio captured".into()));
                    } else {
                        *result2.lock().unwrap() = Some(encode_wav(&data, sr, ch));
                    }
                    done2.store(true, Ordering::SeqCst);
                    break;
                }
                Err(_) => {
                    done2.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    });

    Ok(RecorderHandle { tx, done, result })
}

fn encode_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|e| format!("WAV encode failed: {e}"))?;
        for &s in samples {
            writer
                .write_sample(s)
                .map_err(|e| format!("WAV write failed: {e}"))?;
        }
        writer.finalize().map_err(|e| format!("WAV finalize failed: {e}"))?;
    }
    Ok(cursor.into_inner())
}

fn log_voice(msg: &str) {
    crate::log_line(&format!("voice: {msg}"));
}

#[tauri::command]
pub async fn voice_start(state: tauri::State<'_, VoiceInput>) -> Result<(), String> {
    let handle = spawn_recorder()?;
    handle.tx.send(RecCmd::Start).map_err(|e| e.to_string())?;

    let mut slot = state.recorder.lock().map_err(|e| e.to_string())?;
    *slot = Some(handle);
    state.set_status(VoiceStatus::Listening);
    Ok(())
}

#[tauri::command]
pub async fn voice_stop(state: tauri::State<'_, VoiceInput>) -> Result<VoiceStatus, String> {
    let handle = {
        let mut slot = state.recorder.lock().map_err(|e| e.to_string())?;
        slot.take()
    };

    let Some(handle) = handle else {
        let msg = "Not recording".to_string();
        state.set_status(VoiceStatus::Error(msg.clone()));
        return Err(msg);
    };

    state.set_status(VoiceStatus::Processing);

    let _ = handle.tx.send(RecCmd::Stop);

    // Wait for the recorder thread (max 5s)
    for _ in 0..500 {
        if handle.done.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let wav = match handle.result.lock().unwrap().take() {
        Some(Ok(w)) => w,
        Some(Err(e)) => {
            state.set_status(VoiceStatus::Error(e.clone()));
            return Err(e);
        }
        None => {
            let msg = "Recording timed out".to_string();
            state.set_status(VoiceStatus::Error(msg.clone()));
            return Err(msg);
        }
    };

    state.set_status(VoiceStatus::Transcribing);

    match transcribe(wav).await {
        Ok(text) => {
            state.set_status(VoiceStatus::Done(text.clone()));
            Ok(VoiceStatus::Done(text))
        }
        Err(e) => {
            state.set_status(VoiceStatus::Error(e.clone()));
            Err(e)
        }
    }
}

async fn transcribe(wav: Vec<u8>) -> Result<String, String> {
    let whisper =
        find_whisper_binary().ok_or_else(|| "Whisper binary not found".to_string())?;
    let model =
        find_model(None).ok_or_else(|| "Whisper model not found (ggml-*.bin)".to_string())?;

    let temp = std::env::temp_dir().join("nexuscode-voice.wav");
    tokio::fs::write(&temp, &wav)
        .await
        .map_err(|e| format!("Temp write failed: {e}"))?;

    let mut cmd = tokio::process::Command::new(&whisper);
    cmd.args([
        "-m",
        model.to_string_lossy().as_ref(),
        "-f",
        temp.to_string_lossy().as_ref(),
        "--no-timestamps",
        "-nt",
        "-otxt",
    ]);
    no_window(&mut cmd);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Whisper run failed: {e}"))?;

    let _ = tokio::fs::remove_file(&temp).await;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Whisper failed: {}", err.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(windows)]
fn no_window(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut tokio::process::Command) {}

#[tauri::command]
pub async fn voice_status(state: tauri::State<'_, VoiceInput>) -> Result<VoiceStatus, String> {
    let st = state.status.lock().map_err(|e| e.to_string())?;
    Ok(st.clone())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableVoices {
    pub whisper_binary: bool,
    pub whisper_model: bool,
}

#[tauri::command]
pub async fn voice_check_availability() -> AvailableVoices {
    AvailableVoices {
        whisper_binary: find_whisper_binary().is_some(),
        whisper_model: find_model(None).is_some(),
    }
}

/// Locate a whisper-cli executable next to the app binary or in PATH.
fn find_whisper_binary() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if let Some(dir) = exe.parent() {
        for name in ["whisper-cli.exe", "whisper-cli", "whisper"] {
            let c = dir.join(name);
            if c.exists() {
                return Some(c);
            }
        }
    }
    which("whisper-cli").or_else(|| which("whisper"))
}

fn which(name: &str) -> Option<std::path::PathBuf> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let paths = std::env::var("PATH").ok()?;
    for p in std::env::split_paths(&paths) {
        let candidate = p.join(format!("{name}{suffix}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Find ggml model: %APPDATA%/nexuscode/models/ggml-*.bin (largest wins).
fn find_model(explicit: Option<&str>) -> Option<std::path::PathBuf> {
    if let Some(m) = explicit {
        let p = std::path::PathBuf::from(m);
        if p.exists() {
            return Some(p);
        }
    }
    let base = if cfg!(windows) {
        std::env::var("APPDATA").ok()?
    } else {
        std::env::var("HOME").ok()?
    };
    let models_dir = std::path::Path::new(&base).join("nexuscode").join("models");
    let entries = std::fs::read_dir(models_dir).ok()?;
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("ggml-") && name.ends_with(".bin") {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
                best = Some((size, e.path()));
            }
        }
    }
    best.map(|(_, p)| p)
}
