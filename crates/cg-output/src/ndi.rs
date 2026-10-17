//! NDI output (alpha included) through the NDI runtime.
//!
//! The NDI SDK is distributed by Vizrt under its own licence, so it is not
//! linked at build time: the runtime library (installed with NDI Tools, or
//! the SDK redistributable) is loaded when the first NDI output opens. Without
//! it, opening an output returns `OutputError::Unsupported` with where it was
//! looked for. `NDI_LIB_PATH` points to the library explicitly.

use std::ffi::{c_char, c_void, CString};
use std::sync::{Arc, OnceLock};

use cg_render::Frame;
use serde::{Deserialize, Serialize};

use crate::{OutputError, OutputSink};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NdiConfig {
    #[serde(default)]
    pub id: String,
    /// Source name seen by receivers (shown as "HOST (name)").
    pub name: String,
    /// Comma-separated NDI groups ("" = public).
    #[serde(default)]
    pub groups: String,
    /// Send the alpha channel (RGBA) or an opaque picture (RGBX).
    #[serde(default = "yes")]
    pub alpha: bool,
}

fn yes() -> bool {
    true
}

#[repr(C)]
struct SendCreate {
    p_ndi_name: *const c_char,
    p_groups: *const c_char,
    clock_video: bool,
    clock_audio: bool,
}

#[repr(C)]
struct VideoFrameV2 {
    xres: i32,
    yres: i32,
    four_cc: u32,
    frame_rate_n: i32,
    frame_rate_d: i32,
    picture_aspect_ratio: f32,
    frame_format_type: i32,
    timecode: i64,
    p_data: *const u8,
    line_stride_in_bytes: i32,
    p_metadata: *const c_char,
    timestamp: i64,
}

const fn fourcc(s: &[u8; 4]) -> u32 {
    s[0] as u32 | (s[1] as u32) << 8 | (s[2] as u32) << 16 | (s[3] as u32) << 24
}
const FOURCC_RGBA: u32 = fourcc(b"RGBA");
const FOURCC_RGBX: u32 = fourcc(b"RGBX");
const PROGRESSIVE: i32 = 1;
const TIMECODE_SYNTHESIZE: i64 = i64::MAX;

type Instance = *mut c_void;

struct Lib {
    _lib: libloading::Library,
    create: unsafe extern "C" fn(*const SendCreate) -> Instance,
    send: unsafe extern "C" fn(Instance, *const VideoFrameV2),
    destroy: unsafe extern "C" fn(Instance),
}

// The NDI functions are thread-safe; the library handle is only read.
unsafe impl Send for Lib {}
unsafe impl Sync for Lib {}

/// Bundled copies inside applications (NDI Tools installs its runtime in
/// its apps on macOS): `<dir>/*.app/Contents/{Frameworks,MacOS}/libndi*.dylib`,
/// looking one folder deeper for suites such as "NDI Tools".
fn app_bundles(dir: &std::path::Path, depth: u32, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.ends_with(".app") {
            if !name.contains("ndi") && depth == 0 {
                continue;
            }
            for sub in [
                "Contents/Frameworks",
                "Contents/MacOS",
                "Contents/Resources",
            ] {
                if let Ok(files) = std::fs::read_dir(p.join(sub)) {
                    for f in files.flatten() {
                        let n = f.file_name().to_string_lossy().to_string();
                        if n.starts_with("libndi") && n.ends_with(".dylib") {
                            out.push(f.path().to_string_lossy().into_owned());
                        }
                    }
                }
            }
        } else if depth > 0 && p.is_dir() && name.contains("ndi") {
            app_bundles(&p, depth - 1, out);
        }
    }
}

fn candidates() -> Vec<String> {
    let mut c: Vec<String> = std::env::var("NDI_LIB_PATH").into_iter().collect();
    let runtime_dirs: Vec<String> = [
        "NDI_RUNTIME_DIR_V6",
        "NDI_RUNTIME_DIR_V5",
        "NDI_RUNTIME_DIR_V4",
    ]
    .iter()
    .filter_map(|v| std::env::var(v).ok())
    .collect();
    if cfg!(target_os = "windows") {
        for dir in &runtime_dirs {
            c.push(format!("{dir}\\Processing.NDI.Lib.x64.dll"));
        }
        for v in ["6", "5"] {
            c.push(format!(
                "C:\\Program Files\\NDI\\NDI {v} Runtime\\v{v}\\Processing.NDI.Lib.x64.dll"
            ));
            c.push(format!(
                "C:\\Program Files\\NDI\\NDI {v} Tools\\Runtime\\Processing.NDI.Lib.x64.dll"
            ));
        }
        c.push("Processing.NDI.Lib.x64.dll".into());
    } else if cfg!(target_os = "macos") {
        for dir in &runtime_dirs {
            c.push(format!("{dir}/libndi.dylib"));
        }
        c.extend(
            [
                "/usr/local/lib/libndi.dylib",
                "/opt/homebrew/lib/libndi.dylib",
                "/Library/NDI SDK for Apple/lib/macOS/libndi.dylib",
                "/Library/NDI SDK for Apple/lib/macOS/libndi_advanced.dylib",
                "/Library/NDI Advanced SDK for Apple/lib/macOS/libndi_advanced.dylib",
                "libndi.dylib",
            ]
            .map(String::from),
        );
        app_bundles(std::path::Path::new("/Applications"), 1, &mut c);
        if let Some(home) = std::env::var_os("HOME") {
            app_bundles(&std::path::Path::new(&home).join("Applications"), 1, &mut c);
        }
    } else {
        for dir in &runtime_dirs {
            c.push(format!("{dir}/libndi.so.6"));
            c.push(format!("{dir}/libndi.so.5"));
        }
        c.extend([
            "libndi.so.6".into(),
            "libndi.so.5".into(),
            "libndi.so".into(),
            "/usr/local/lib/libndi.so".into(),
        ]);
    }
    c.dedup();
    c
}

fn load() -> Result<Lib, String> {
    let tried = candidates();
    let mut failures = Vec::new();
    for path in &tried {
        // Only report the paths that exist but would not load (a bare name
        // is searched in the system folders).
        let bare = !path.contains('/') && !path.contains('\\');
        // SAFETY: loading the NDI runtime runs its initialisers, which is
        // what the SDK expects of its users.
        let lib = match unsafe { libloading::Library::new(path) } {
            Ok(l) => l,
            Err(e) => {
                if !bare && std::path::Path::new(path).exists() {
                    failures.push(format!("{path}: {e}"));
                }
                continue;
            }
        };
        unsafe {
            let init: libloading::Symbol<unsafe extern "C" fn() -> bool> =
                lib.get(b"NDIlib_initialize\0").map_err(|e| e.to_string())?;
            if !init() {
                return Err("the NDI runtime refused to start (unsupported CPU?)".into());
            }
            let create = *lib
                .get(b"NDIlib_send_create\0")
                .map_err(|e| e.to_string())?;
            let send = *lib
                .get(b"NDIlib_send_send_video_v2\0")
                .map_err(|e| e.to_string())?;
            let destroy = *lib
                .get(b"NDIlib_send_destroy\0")
                .map_err(|e| e.to_string())?;
            tracing::info!(path, "NDI runtime loaded");
            return Ok(Lib {
                _lib: lib,
                create,
                send,
                destroy,
            });
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "NDI runtime found but not loadable ({})",
            failures.join("; ")
        ));
    }
    Err(format!(
        "NDI runtime not found (install the NDI SDK or NDI Tools, or set NDI_LIB_PATH; looked for {})",
        tried.join(", ")
    ))
}

fn lib() -> Result<&'static Lib, OutputError> {
    static LIB: OnceLock<Result<Lib, String>> = OnceLock::new();
    LIB.get_or_init(load)
        .as_ref()
        .map_err(|e| OutputError::Unsupported(e.clone()))
}

pub struct NdiSender {
    config: NdiConfig,
    lib: &'static Lib,
    instance: Instance,
    rate: (i32, i32),
    buf: Arc<Vec<u8>>,
}

// The instance is used from the render thread that owns the sender only.
unsafe impl Send for NdiSender {}

impl NdiSender {
    pub fn open(config: NdiConfig, rate: (u32, u32)) -> Result<Self, OutputError> {
        let lib = lib()?;
        let name = CString::new(config.name.clone())
            .map_err(|_| OutputError::Unsupported("invalid NDI name".into()))?;
        let groups = CString::new(config.groups.clone())
            .map_err(|_| OutputError::Unsupported("invalid NDI groups".into()))?;
        let create = SendCreate {
            p_ndi_name: name.as_ptr(),
            p_groups: if config.groups.trim().is_empty() {
                std::ptr::null()
            } else {
                groups.as_ptr()
            },
            // The playout clock paces the frames.
            clock_video: false,
            clock_audio: false,
        };
        // SAFETY: the strings outlive the call; NDI copies them.
        let instance = unsafe { (lib.create)(&create) };
        if instance.is_null() {
            return Err(OutputError::Unsupported(
                "NDI could not create the source".into(),
            ));
        }
        tracing::info!(name = config.name, "NDI source started");
        Ok(Self {
            config,
            lib,
            instance,
            rate: (rate.0 as i32, rate.1 as i32),
            buf: Arc::new(Vec::new()),
        })
    }
}

/// NDI takes straight (not premultiplied) alpha.
pub fn unpremultiply(rgba: &[u8], out: &mut Vec<u8>, alpha: bool) {
    out.clear();
    out.reserve(rgba.len());
    for p in rgba.as_chunks::<4>().0 {
        let a = p[3] as u32;
        if !alpha || a == 255 || a == 0 {
            out.extend_from_slice(&[p[0], p[1], p[2], if alpha { p[3] } else { 255 }]);
        } else {
            let f = |c: u8| ((c as u32 * 255 + a / 2) / a).min(255) as u8;
            out.extend_from_slice(&[f(p[0]), f(p[1]), f(p[2]), p[3]]);
        }
    }
}

impl OutputSink for NdiSender {
    fn name(&self) -> &str {
        &self.config.name
    }

    fn push(&mut self, frame: &Frame) -> Result<(), OutputError> {
        let buf = Arc::make_mut(&mut self.buf);
        unpremultiply(&frame.data, buf, self.config.alpha);
        let video = VideoFrameV2 {
            xres: frame.width as i32,
            yres: frame.height as i32,
            four_cc: if self.config.alpha {
                FOURCC_RGBA
            } else {
                FOURCC_RGBX
            },
            frame_rate_n: self.rate.0,
            frame_rate_d: self.rate.1,
            picture_aspect_ratio: 0.0,
            frame_format_type: PROGRESSIVE,
            timecode: TIMECODE_SYNTHESIZE,
            p_data: buf.as_ptr(),
            line_stride_in_bytes: frame.width as i32 * 4,
            p_metadata: std::ptr::null(),
            timestamp: 0,
        };
        // SAFETY: synchronous send: NDI has finished with the buffer on return.
        unsafe { (self.lib.send)(self.instance, &video) };
        Ok(())
    }
}

impl Drop for NdiSender {
    fn drop(&mut self) {
        // SAFETY: created by this sender, destroyed once.
        unsafe { (self.lib.destroy)(self.instance) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_alpha() {
        let mut out = Vec::new();
        unpremultiply(&[64, 32, 0, 128, 10, 10, 10, 0], &mut out, true);
        assert_eq!(out, vec![128, 64, 0, 128, 10, 10, 10, 0]);
        unpremultiply(&[64, 32, 0, 128], &mut out, false);
        assert_eq!(out[3], 255);
    }

    #[test]
    fn fourcc_codes() {
        assert_eq!(FOURCC_RGBA, 0x4142_4752);
    }
}
