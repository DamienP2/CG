//! The model finding the people, run on the graphics card when the machine
//! has an ONNX Runtime able to (CUDA, DirectML, CoreML), else on the
//! processor (tract, on several cores).
//!
//! ONNX Runtime is not built in: it is loaded when a camera asks for the
//! graphics card, from `STRATA_ONNXRUNTIME` (or `ORT_DYLIB_PATH`), next to
//! the server, or where the system finds libraries. Without it, or without
//! a graphics card it can use, the processor finds them.

use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tract_linalg::multithread::{multithread_tract_scope, Executor};
use tract_onnx::prelude::*;

/// Where the people are found.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Processor {
    /// The graphics card when there is one ONNX Runtime can use, else the processor.
    #[default]
    Auto,
    Gpu,
    Cpu,
}

/// The model's input and output: one picture of `w` × `h`, RGB from 0 to 1,
/// colour by colour; how much of a person each point is.
pub struct Engine {
    run: Run,
    /// What it runs on, for the page.
    pub device: Device,
}

enum Run {
    Cpu(Arc<TypedRunnableModel>, Executor),
    Gpu(Box<ort::session::Session>),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// "gpu" or "cpu".
    pub kind: &'static str,
    /// The graphics card's runtime ("CUDA", "DirectML", "CoreML").
    #[serde(skip_serializing_if = "String::is_empty")]
    pub provider: String,
    /// The processor's cores used.
    #[serde(skip_serializing_if = "is_zero")]
    pub threads: usize,
    /// Why the graphics card is not used, when it was asked for.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub no_gpu: String,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// The cores a camera's people take: half the machine, four at most (the
/// outputs draw meanwhile).
fn threads() -> usize {
    let n = std::thread::available_parallelism().map_or(2, |n| n.get());
    (n / 2).clamp(1, 4)
}

impl Engine {
    pub fn new(model: &'static [u8], w: usize, h: usize, p: Processor) -> Result<Self, String> {
        let mut no_gpu = String::new();
        if p != Processor::Cpu {
            match gpu(model) {
                Ok((session, provider)) => {
                    return Ok(Self {
                        run: Run::Gpu(Box::new(session)),
                        device: Device {
                            kind: "gpu",
                            provider,
                            ..Device::default()
                        },
                    })
                }
                Err(e) => no_gpu = e,
            }
        }
        let net = cpu(model, w, h).ok_or("The people model cannot be read")?;
        let n = threads();
        let executor = if n > 1 {
            Executor::multithread_with_name(n, "cg-people-net")
        } else {
            Executor::SingleThread
        };
        Ok(Self {
            run: Run::Cpu(net, executor),
            device: Device {
                kind: "cpu",
                threads: n,
                // Auto says nothing when there is no graphics card.
                no_gpu: if p == Processor::Gpu {
                    no_gpu
                } else {
                    String::new()
                },
                ..Device::default()
            },
        })
    }

    /// How much of a person each point of `x` (1 × 3 × h × w) is.
    pub fn run(&mut self, x: Vec<f32>, w: usize, h: usize) -> anyhow::Result<Vec<f32>> {
        match &mut self.run {
            Run::Cpu(net, executor) => {
                let input = tract_ndarray::Array4::from_shape_vec((1, 3, h, w), x)?.into_tensor();
                let out =
                    multithread_tract_scope(executor.clone(), || net.run(tvec!(input.into())))?;
                Ok(out[0]
                    .to_plain_array_view::<f32>()?
                    .iter()
                    .copied()
                    .collect())
            }
            Run::Gpu(session) => {
                let input = ort::value::Tensor::from_array(([1usize, 3, h, w], x))
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let out = session
                    .run(ort::inputs![input])
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let (_, people) = out[0]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                Ok(people.to_vec())
            }
        }
    }
}

/// The model for the processor, read once.
fn cpu(model: &'static [u8], w: usize, h: usize) -> Option<Arc<TypedRunnableModel>> {
    static NET: OnceLock<Option<Arc<TypedRunnableModel>>> = OnceLock::new();
    NET.get_or_init(|| {
        let read = || -> TractResult<Arc<TypedRunnableModel>> {
            tract_onnx::onnx()
                .model_for_read(&mut &model[..])?
                .with_input_fact(0, f32::fact([1, 3, h, w]).into())?
                .into_optimized()?
                .into_runnable()
        };
        read()
            .map_err(|e| tracing::error!("the people model cannot be read: {e}"))
            .ok()
    })
    .clone()
}

/// ONNX Runtime, loaded once.
fn runtime() -> Result<(), String> {
    static LOADED: OnceLock<Result<(), String>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            let named = ["STRATA_ONNXRUNTIME", "ORT_DYLIB_PATH"]
                .iter()
                .filter_map(|k| std::env::var_os(k))
                .map(std::path::PathBuf::from);
            let file = if cfg!(windows) {
                "onnxruntime.dll"
            } else if cfg!(target_os = "macos") {
                "libonnxruntime.dylib"
            } else {
                "libonnxruntime.so"
            };
            let beside = std::env::current_exe()
                .ok()
                .and_then(|e| e.parent().map(|d| [d.join(file), d.join("lib").join(file)]))
                .into_iter()
                .flatten()
                .filter(|p| p.exists());
            // Else where the system finds libraries.
            let path = named.chain(beside).next().unwrap_or_else(|| file.into());
            // ort waits forever on a library it cannot load: looked at first.
            usable(&path)?;
            // A library that is not ONNX Runtime must not stop the server.
            let loaded = std::panic::catch_unwind(|| ort::init_from(&path).map(|b| b.commit()));
            match loaded {
                Ok(Ok(_)) => {
                    tracing::info!("ONNX Runtime loaded from {}", path.display());
                    Ok(())
                }
                Ok(Err(e)) => Err(format!("ONNX Runtime: {e}")),
                Err(_) => Err(format!("ONNX Runtime: {} cannot be used", path.display())),
            }
        })
        .clone()
}

/// The oldest ONNX Runtime the server works with (1.20).
const ORT_MINOR: u32 = 20;

/// The beginning of ONNX Runtime's table of functions.
#[repr(C)]
struct ApiBase {
    get_api: unsafe extern "C" fn(u32) -> *const std::ffi::c_void,
    get_version_string: unsafe extern "C" fn() -> *const std::ffi::c_char,
}

/// Whether `path` is an ONNX Runtime the server can load (its version too).
fn usable(path: &std::path::Path) -> Result<(), String> {
    // SAFETY: loading a library runs its initialisers; the file is ONNX
    // Runtime's, from where the administrator put it (or the system's).
    let lib =
        unsafe { libloading::Library::new(path) }.map_err(|e| format!("ONNX Runtime: {e}"))?;
    // SAFETY: the symbol ONNX Runtime exports, of this type.
    let base = unsafe { lib.get::<unsafe extern "C" fn() -> *const ApiBase>(b"OrtGetApiBase") }
        .map_err(|_| format!("ONNX Runtime: {} is not ONNX Runtime", path.display()))?;
    // SAFETY: it gives its table, which lives as long as the library.
    let version = unsafe {
        let base = base();
        if base.is_null() {
            return Err("ONNX Runtime: no functions".into());
        }
        std::ffi::CStr::from_ptr(((*base).get_version_string)())
            .to_string_lossy()
            .into_owned()
    };
    let minor = version
        .split('.')
        .nth(1)
        .and_then(|m| m.parse::<u32>().ok())
        .unwrap_or(0);
    if minor < ORT_MINOR {
        return Err(format!(
            "ONNX Runtime {version}: 1.{ORT_MINOR} or later is needed"
        ));
    }
    Ok(())
}

/// The model on the first graphics card runtime that takes it.
fn gpu(model: &[u8]) -> Result<(ort::session::Session, String), String> {
    runtime()?;
    use ort::ep;
    let tries: Vec<(&str, ep::ExecutionProviderDispatch)> = if cfg!(target_os = "macos") {
        vec![("CoreML", ep::CoreML::default().build())]
    } else if cfg!(windows) {
        vec![
            ("CUDA", ep::CUDA::default().build()),
            ("DirectML", ep::DirectML::default().build()),
        ]
    } else {
        vec![("CUDA", ep::CUDA::default().build())]
    };
    let mut why = String::from("No graphics card ONNX Runtime can use");
    for (name, provider) in tries {
        let session = ort::session::Session::builder()
            .map_err(|e| e.to_string())
            .and_then(|b| {
                b.with_execution_providers([provider.error_on_failure()])
                    .map_err(|e| e.to_string())
            })
            .and_then(|mut b| b.commit_from_memory(model).map_err(|e| e.to_string()));
        match session {
            Ok(s) => return Ok((s, name.to_string())),
            Err(e) => why = format!("{name}: {e}"),
        }
    }
    Err(why)
}
