#[path = "../../../src/domain/playlist_playback/path_fairness.rs"]
mod path_fairness;

#[cfg(test)]
#[path = "../../../src/domain/playlist_playback/path_fairness.test.rs"]
mod path_fairness_test;

use path_fairness::{CompositionConfig, FairnessConfig, build_real_data_report};
use std::env;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), String> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(20)
        .build_global()
        .map_err(|error| format!("failed to initialize the probe worker pool: {error}"))?;
    let mut arguments = env::args().skip(1);
    let stable_path = arguments
        .next()
        .map(PathBuf::from)
        .or_else(default_stable_path)
        .ok_or_else(|| "pass the stable.json path as the first argument".to_string())?;
    let output_path = arguments.next().map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from("outputs/audio_style_trajectory_dynamics/rust_lifted_flow_spacing_probe.json")
    });
    let report = build_real_data_report(
        &stable_path,
        &FairnessConfig::default(),
        &CompositionConfig::default(),
    )?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create probe output directory `{}`: {error}",
                parent.display()
            )
        })?;
    }
    let encoded = serde_json::to_vec_pretty(&report)
        .map_err(|error| format!("failed to encode Rust probe report: {error}"))?;
    fs::write(&output_path, encoded).map_err(|error| {
        format!(
            "failed to write Rust probe report `{}`: {error}",
            output_path.display()
        )
    })?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "output": output_path,
            "status": report["status"],
            "structural_receipt": report["structural_receipt"],
            "delta": report["delta"],
            "paired_seed_style_delta": report["paired_seed_style_delta"],
        }))
        .map_err(|error| format!("failed to encode Rust probe summary: {error}"))?
    );
    Ok(())
}

fn default_stable_path() -> Option<PathBuf> {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("slisic/audio-style-stable-model/stable.json"))
}
